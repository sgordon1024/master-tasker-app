// Code folder scanner. Free, local and read-only: it runs git, gh and reads files, nothing else.
// It turns "what changed in your code folders since the last review" into one bounded JSON digest
// that the scheduled review reads. It never writes inside the folders it watches.
//
//   node automation/devscan.ts scan [--since-days N]   print a digest of changes since the last ack
//   node automation/devscan.ts ack <scanId>            mark that digest as reviewed (moves the cursor)
//   node automation/devscan.ts projects                list every tracked folder
//
// It watches no folders until you name some: `npm run review:setup -- --folders "<folder>:<folder>"`
// saves them to devscan/folders.txt in the data folder (one per line). MT_DEV_ROOTS, a
// colon-separated list, overrides that file. Each folder's subfolders are the projects it tracks.
//
// Folders are tracked by filesystem identity (device + inode), which survives renames and moves
// within the disk. Git history is the fallback, for a folder that was re-cloned or moved across disks.
// The cursor only moves on ack, so a failed review run loses nothing: the next scan covers both periods.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DATA_DIR } from './env.ts';

const HOME = os.homedir();
const STATE_FILE = path.join(DATA_DIR, 'devscan', 'state.json');
/** The code folders to watch, one per line. Empty or missing means none. */
export const FOLDERS_FILE = path.join(DATA_DIR, 'devscan', 'folders.txt');
const CLAUDE_DIR = process.env.MT_CLAUDE_PROJECTS_DIR ?? path.join(HOME, '.claude', 'projects');
const USE_GH = process.env.MT_DEVSCAN_GH !== '0';
/** Sessions started with this marker are the review itself and are never fed back in. */
export const REVIEW_MARKER = '[master-tasker-review]';

const expand = (p: string) => path.resolve(process.env.INIT_CWD ?? process.cwd(), p.replace(/^~(?=$|\/)/, HOME));

/** The folders to watch: MT_DEV_ROOTS if set, else the saved list. None by default. */
export function devRoots(): string[] {
  if (process.env.MT_DEV_ROOTS !== undefined) return process.env.MT_DEV_ROOTS.split(':').filter(Boolean).map(expand);
  try {
    return fs.readFileSync(FOLDERS_FILE, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map(expand);
  } catch {
    return [];
  }
}

/** Saves the folders to watch. Each one must exist. An empty list watches nothing. */
export function writeDevRoots(folders: string[]) {
  const list = [...new Set(folders.map((f) => f.trim()).filter(Boolean).map(expand))];
  for (const f of list) if (!fs.existsSync(f) || !fs.statSync(f).isDirectory()) throw new Error(`No folder at ${f}`);
  fs.mkdirSync(path.dirname(FOLDERS_FILE), { recursive: true });
  fs.writeFileSync(FOLDERS_FILE, `# Code folders the daily review watches, one per line.\n${list.map((f) => `${f}\n`).join('')}`);
  return list;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', 'coverage', 'vendor', 'Pods', 'DerivedData', '.venv', 'venv', '__pycache__', '.gradle', '.idea', 'target', '.dart_tool', 'test-results', 'playwright-report', '.expo', '.vercel']);
const PLAN_FILE = /^(todo|plan|plans|roadmap|notes|tasks|next|status|handoff|progress|backlog)([\w .-]*)\.(md|txt)$/i;
const DAY = 24 * 3600_000;
const LIMITS = { commits: 15, files: 12, planItems: 25, sessions: 5, asks: 6, askChars: 300, replyChars: 700, otherSessions: 8, walkEntries: 4000 };

// ─── State ───

interface Entry {
  id: string;
  name: string;
  path: string;
  paths: string[]; // every path this folder has had, newest last
  fsKey: string; // `${dev}:${ino}`
  kind: 'git' | 'folder';
  parentId: string | null; // set for repos nested inside a non-git folder
  rootCommit: string | null;
  remote: string | null; // "owner/repo"
  firstSeen: string;
  lastSeen: string;
  goneSince: string | null;
  announcedPath: string | null; // the path the last acknowledged review saw
  ackedUntil: string | null;
}
interface State {
  version: 1;
  projects: Record<string, Entry>;
  ackedUntil: string | null;
  pending: { scanId: string; until: string; ids: string[] } | null;
}

function loadState(): State {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { version: 1, projects: {}, ackedUntil: null, pending: null };
  }
}
function saveState(s: State) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

// ─── Helpers ───

function run(cmd: string, args: string[], cwd?: string, timeout = 15_000): string | null {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}
// core.fsmonitor off: a repo's own config can name a program for git status to run, and the scan never runs it.
const git = (cwd: string, ...args: string[]) => run('git', ['-c', 'core.quotepath=off', '-c', 'core.fsmonitor=false', ...args], cwd);

export function normalizeRemote(url: string | null): string | null {
  if (!url) return null;
  const m = url.trim().match(/github\.com[:/]+([^/]+)\/([^/]+?)(\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : url.trim().toLowerCase();
}

const SECRET_PATTERNS: RegExp[] = [
  /mt_[A-Za-z0-9]{32}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-(ant-)?[A-Za-z0-9_-]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];
const SECRET_ASSIGNMENT = /\b(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi;
export function redact(s: string): string {
  let out = s;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted]');
  return out.replace(SECRET_ASSIGNMENT, (_m, k: string, sep: string) => `${k}${sep}[redacted]`);
}
const clip = (s: string, n: number) => {
  const t = redact(s.replace(/\s+/g, ' ').trim());
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const iso = (d: Date | number) => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');

// ─── Discovery ───

interface Found {
  path: string;
  name: string;
  fsKey: string;
  kind: 'git' | 'folder';
  parentPath: string | null;
}

function isRepo(dir: string) {
  return fs.existsSync(path.join(dir, '.git'));
}

function findNestedRepos(dir: string, depth: number, out: string[]) {
  if (depth === 0) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (isRepo(p)) out.push(p);
    else findNestedRepos(p, depth - 1, out);
  }
}

function discover(): Found[] {
  const found: Found[] = [];
  const add = (p: string, kind: Found['kind'], parentPath: string | null) => {
    const st = fs.statSync(p);
    found.push({ path: p, name: parentPath ? `${path.basename(parentPath)} / ${path.relative(parentPath, p)}` : path.basename(p), fsKey: `${st.dev}:${st.ino}`, kind, parentPath });
  };
  for (const root of devRoots()) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const p = path.join(root, e.name);
      if (isRepo(p)) {
        add(p, 'git', null);
        continue;
      }
      add(p, 'folder', null);
      const nested: string[] = [];
      findNestedRepos(p, 2, nested);
      for (const n of nested) add(n, 'git', p);
    }
  }
  return found;
}

function rootCommit(dir: string) {
  return git(dir, 'rev-list', '--max-parents=0', '--max-count=1', 'HEAD');
}

/** Match folders on disk to known projects: same inode first, then same git history at a path that no longer exists. */
function reconcile(state: State, now: string) {
  const found = discover();
  const byKey = new Map(Object.values(state.projects).map((p) => [p.fsKey, p]));
  const seen = new Set<string>();
  const pathToId = new Map<string, string>();
  const fresh: Found[] = [];
  for (const f of found) {
    const hit = byKey.get(f.fsKey);
    if (hit && !seen.has(hit.id)) {
      seen.add(hit.id);
      pathToId.set(f.path, hit.id);
      update(hit, f);
    } else fresh.push(f);
  }
  for (const f of fresh) {
    const rc = f.kind === 'git' ? rootCommit(f.path) : null;
    const remote = f.kind === 'git' ? normalizeRemote(git(f.path, 'remote', 'get-url', 'origin')) : null;
    // Re-cloned, or moved across disks: same history, same remote, and the old folder is gone.
    const moved = rc
      ? Object.values(state.projects).find((p) => !seen.has(p.id) && p.rootCommit === rc && p.remote === remote && !fs.existsSync(p.path))
      : undefined;
    const entry: Entry = moved ?? {
      id: `dp_${crypto.randomBytes(6).toString('hex')}`,
      name: f.name,
      path: f.path,
      paths: [],
      fsKey: f.fsKey,
      kind: f.kind,
      parentId: null,
      rootCommit: rc,
      remote,
      firstSeen: now,
      lastSeen: now,
      goneSince: null,
      announcedPath: null,
      ackedUntil: null,
    };
    state.projects[entry.id] = entry;
    seen.add(entry.id);
    pathToId.set(f.path, entry.id);
    update(entry, f);
    entry.fsKey = f.fsKey;
  }
  for (const f of found) {
    const e = state.projects[pathToId.get(f.path)!];
    e.parentId = f.parentPath ? (pathToId.get(f.parentPath) ?? null) : null;
  }
  for (const p of Object.values(state.projects)) {
    if (!seen.has(p.id) && !p.goneSince) p.goneSince = now;
  }
  function update(e: Entry, f: Found) {
    e.name = f.name;
    e.kind = f.kind;
    if (e.path !== f.path || !e.paths.includes(f.path)) e.paths = [...e.paths.filter((x) => x !== f.path), f.path].slice(-10);
    e.path = f.path;
    e.lastSeen = now;
    e.goneSince = null;
    if (f.kind === 'git') {
      e.remote = normalizeRemote(git(f.path, 'remote', 'get-url', 'origin'));
      e.rootCommit = e.rootCommit ?? rootCommit(f.path);
    }
  }
}

// ─── Per-project detail ───

function newestFiles(dir: string, sinceMs: number, excludeDirs: Set<string>) {
  const out: { file: string; at: number }[] = [];
  let budget = LIMITS.walkEntries;
  const walk = (d: string, depth: number) => {
    if (depth > 6 || budget <= 0) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (--budget <= 0) return;
      if (e.name.startsWith('.') && e.name !== '.claude') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !excludeDirs.has(p) && e.name !== 'worktrees') walk(p, depth + 1);
      } else if (e.isFile()) {
        try {
          const m = fs.statSync(p).mtimeMs;
          if (m > sinceMs) out.push({ file: path.relative(dir, p), at: m });
        } catch {}
      }
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => b.at - a.at);
}

function planItems(dir: string, sinceMs: number, firstLook: boolean) {
  const candidates: string[] = [];
  for (const sub of ['', 'docs', 'plans', 'notes']) {
    try {
      for (const f of fs.readdirSync(path.join(dir, sub))) if (PLAN_FILE.test(f)) candidates.push(path.join(dir, sub, f));
    } catch {}
  }
  const out: { file: string; open: string[]; done: number }[] = [];
  for (const file of candidates) {
    try {
      const st = fs.statSync(file);
      if (!firstLook && st.mtimeMs <= sinceMs) continue;
      if (st.size > 512 * 1024) continue;
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      const open = lines.filter((l) => /^\s*[-*]\s+\[ \]/.test(l)).map((l) => clip(l.replace(/^\s*[-*]\s+\[ \]\s*/, ''), 200));
      const done = lines.filter((l) => /^\s*[-*]\s+\[[xX]\]/.test(l)).length;
      if (open.length || done) out.push({ file: path.relative(dir, file), open: open.slice(0, LIMITS.planItems), done });
    } catch {}
  }
  return out;
}

function worktreeOf(dir: string) {
  const common = git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const own = git(dir, 'rev-parse', '--path-format=absolute', '--git-dir');
  return common && own && common !== own ? path.dirname(common) : undefined;
}

function gitDetail(dir: string, since: string, mainCheckout: string | undefined) {
  const branch = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
  const me = git(dir, 'config', 'user.email');
  // A worktree shares history with its main checkout, so it only reports its own branch.
  const log = git(dir, 'log', ...(mainCheckout ? ['HEAD'] : ['--all']), `--since=${since}`, `--max-count=${LIMITS.commits}`, '--format=%h%x1f%cI%x1f%ae%x1f%D%x1f%s');
  const sinceMs = Date.parse(since);
  const commits = (log ? log.split('\n') : [])
    .filter(Boolean)
    .map((l) => {
      const [hash, at, email, refs, subject] = l.split('\x1f');
      return { hash, at, mine: !!me && email === me, refs: refs || undefined, subject: clip(subject, 160) };
    })
    // git's --since works in whole seconds; the cursor is exact.
    .filter((c) => Date.parse(c.at) >= sinceMs);
  const status = git(dir, 'status', '--porcelain=v1', '-uall');
  const changed = status ? status.split('\n').filter(Boolean) : [];
  const lastCommitAt = git(dir, 'log', '-1', '--format=%cI');
  const branches = (git(dir, 'for-each-ref', '--sort=-committerdate', '--count=6', '--format=%(refname:short)%1f%(committerdate:iso-strict)', 'refs/heads') ?? '')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [name, at] = l.split('\x1f');
      return { name, at };
    });
  return {
    branch,
    lastCommitAt,
    commits,
    uncommitted: changed.length ? { count: changed.length, files: changed.slice(0, LIMITS.files).map((l) => l.slice(3)) } : undefined,
    branches: mainCheckout ? undefined : branches,
    worktreeOf: mainCheckout,
  };
}

// ─── Claude Code sessions ───

interface SessionDigest {
  sessionId: string;
  title?: string;
  cwd: string;
  startedAt: string;
  lastAt: string;
  asks: string[];
  lastReply?: string;
  /** Master Tasker task ids mentioned in the thread: strong evidence it is about those tasks. */
  mentionsTasks?: string[];
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n');
  return '';
}
const looksInjected = (t: string) => /^\s*<(system-reminder|command-|local-command|task-notification|ci-monitor-event|user-prompt-submit-hook)/.test(t) || t.startsWith('Caveat:');

function readSession(file: string, sinceMs: number): SessionDigest | null {
  let raw: string;
  try {
    const st = fs.statSync(file);
    if (st.mtimeMs <= sinceMs || st.size > 64 * 1024 * 1024) return null;
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let d: SessionDigest | null = null;
  let firstUser = true;
  let lastReply = '';
  const refs = new Set<string>();
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type === 'custom-title' && o.customTitle) {
      if (d) d.title = clip(o.customTitle, 120);
      else d = { sessionId: o.sessionId, title: clip(o.customTitle, 120), cwd: '', startedAt: '', lastAt: '', asks: [] };
      continue;
    }
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    if (o.isSidechain || o.isMeta || o.isCompactSummary) continue;
    if (!d) d = { sessionId: o.sessionId, cwd: o.cwd ?? '', startedAt: o.timestamp ?? '', lastAt: '', asks: [] };
    if (!d.cwd && o.cwd) d.cwd = o.cwd;
    if (!d.startedAt && o.timestamp) d.startedAt = o.timestamp;
    const text = textOf(o.message?.content);
    if (text && !looksInjected(text)) for (const m of text.matchAll(/\bt_[A-Za-z0-9]{14}\b/g)) refs.add(m[0]);
    if (o.type === 'user') {
      if (!text || looksInjected(text)) continue;
      if (firstUser && text.includes(REVIEW_MARKER)) return null;
      firstUser = false;
      if (Date.parse(o.timestamp) > sinceMs) d.asks.push(clip(text.replace(/<\/?pasted_content[^>]*>/g, ''), LIMITS.askChars));
    } else if (text && Date.parse(o.timestamp) > sinceMs) lastReply = text;
    if (o.timestamp) d.lastAt = o.timestamp;
  }
  if (!d || (!d.asks.length && !lastReply)) return null;
  d.asks = d.asks.slice(-LIMITS.asks);
  if (lastReply) d.lastReply = clip(lastReply, LIMITS.replyChars);
  if (refs.size) d.mentionsTasks = [...refs];
  return d;
}

function sessionsSince(sinceMs: number): SessionDigest[] {
  const out: SessionDigest[] = [];
  let dirs: string[];
  try {
    dirs = fs.readdirSync(CLAUDE_DIR);
  } catch {
    return out;
  }
  for (const dir of dirs) {
    let files: string[];
    try {
      files = fs.readdirSync(path.join(CLAUDE_DIR, dir)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const s = readSession(path.join(CLAUDE_DIR, dir, f), sinceMs);
      if (s) out.push(s);
    }
  }
  return out.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

// ─── GitHub ───

interface PR {
  repo: string;
  number: number;
  title: string;
  state: string;
  merged?: boolean;
  draft?: boolean;
  url: string;
  updatedAt: string;
}
function ghSearch(args: string[], warnings: string[]): PR[] {
  const out = run('gh', ['search', 'prs', ...args, '--limit', '50', '--json', 'repository,number,title,state,url,updatedAt,isDraft'], undefined, 30_000);
  if (out === null) {
    warnings.push(`gh search prs ${args.join(' ')} failed (offline or not signed in)`);
    return [];
  }
  try {
    return (JSON.parse(out) as any[]).map((p) => ({ repo: String(p.repository?.nameWithOwner ?? '').toLowerCase(), number: p.number, title: clip(p.title, 160), state: p.state, draft: p.isDraft || undefined, url: p.url, updatedAt: p.updatedAt }));
  } catch {
    warnings.push('gh returned unreadable output');
    return [];
  }
}

// ─── Scan ───

export function scan(opts: { sinceDays?: number; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const nowIso = iso(now);
  const state = loadState();
  reconcile(state, nowIso);
  const firstRun = !state.ackedUntil;
  const defaultSince = iso(now.getTime() - (opts.sinceDays ?? 10) * DAY);
  const since = opts.sinceDays !== undefined ? defaultSince : (state.ackedUntil ?? defaultSince);
  const sinceMs = Date.parse(since);
  const warnings: string[] = [];

  const live = Object.values(state.projects).filter((p) => !p.goneSince);
  const childDirs = new Map<string, Set<string>>();
  for (const p of live) if (p.parentId) (childDirs.get(p.parentId) ?? childDirs.set(p.parentId, new Set()).get(p.parentId)!).add(p.path);

  // Sessions, mapped to the deepest project whose current or past path contains the session's folder.
  const sessions = sessionsSince(sinceMs);
  const owner = (cwd: string) => {
    let best: Entry | undefined;
    let bestLen = -1;
    for (const p of Object.values(state.projects)) {
      for (const pp of p.paths) {
        if ((cwd === pp || cwd.startsWith(pp + path.sep)) && pp.length > bestLen) {
          best = p;
          bestLen = pp.length;
        }
      }
    }
    return best;
  };
  const sessionsBy = new Map<string, SessionDigest[]>();
  const otherSessions: SessionDigest[] = [];
  for (const s of sessions) {
    const p = owner(s.cwd);
    if (p) (sessionsBy.get(p.id) ?? sessionsBy.set(p.id, []).get(p.id)!).push(s);
    else otherSessions.push(s);
  }

  // GitHub: four searches cover every repo at once.
  let prs: { mineUpdated: PR[]; mineOpen: PR[]; mergedRecently: PR[]; reviewRequests: PR[] } = { mineUpdated: [], mineOpen: [], mergedRecently: [], reviewRequests: [] };
  if (USE_GH) {
    const d = since.slice(0, 19);
    prs = {
      mineUpdated: ghSearch(['--author', '@me', '--updated', `>=${d}`], warnings),
      mineOpen: ghSearch(['--author', '@me', '--state', 'open'], warnings),
      mergedRecently: ghSearch(['--author', '@me', '--merged', '--updated', `>=${d}`], warnings),
      reviewRequests: ghSearch(['--review-requested', '@me', '--state', 'open'], warnings),
    };
    const merged = new Set(prs.mergedRecently.map((p) => p.url));
    for (const p of prs.mineUpdated) if (merged.has(p.url)) p.merged = true;
  }
  const allPRs = new Map<string, PR>();
  for (const p of [...prs.mineUpdated, ...prs.mineOpen, ...prs.mergedRecently]) allPRs.set(p.url, { ...allPRs.get(p.url), ...p, merged: p.merged ?? allPRs.get(p.url)?.merged });
  const prsByRepo = new Map<string, PR[]>();
  for (const p of allPRs.values()) (prsByRepo.get(p.repo) ?? prsByRepo.set(p.repo, []).get(p.repo)!).push(p);
  const claimedRepos = new Set<string>();
  // When several folders share a remote (clones, worktrees), PRs are listed once, on the main checkout.
  const prOwner = new Map<string, string>();
  for (const p of live.filter((x) => x.remote).sort((a, b) => Number(!!worktreeOf(a.path)) - Number(!!worktreeOf(b.path)) || a.path.length - b.path.length)) {
    if (!prOwner.has(p.remote!)) prOwner.set(p.remote!, p.id);
  }

  const active: unknown[] = [];
  const quiet: { name: string; lastActivity: string | null }[] = [];
  const staleWork: unknown[] = [];
  for (const p of live.sort((a, b) => a.name.localeCompare(b.name))) {
    // On the very first run everything is "new", so only real activity counts then.
    const isNew = !p.announcedPath && !firstRun;
    const pSince = p.ackedUntil && !isNew ? since : firstRun ? since : defaultSince;
    const pSinceMs = Date.parse(pSince);
    const wt = p.kind === 'git' ? worktreeOf(p.path) : undefined;
    const g = p.kind === 'git' ? gitDetail(p.path, pSince, wt) : undefined;
    // Git already says what changed in a repo; file times are only needed for plain folders.
    const files = p.kind === 'folder' ? newestFiles(p.path, pSinceMs, childDirs.get(p.id) ?? new Set()) : [];
    const ss = (sessionsBy.get(p.id) ?? []).slice(0, LIMITS.sessions);
    const busy = !!(g?.commits.length || files.length || ss.length);
    const plans = planItems(p.path, pSinceMs, isNew || (!p.announcedPath && busy));
    const repoPRs = p.remote && prOwner.get(p.remote) === p.id ? (prsByRepo.get(p.remote) ?? []) : [];
    if (p.remote && repoPRs.length) claimedRepos.add(p.remote);
    const sameRepoAs = p.remote ? live.filter((o) => o.id !== p.id && o.remote === p.remote).map((o) => o.name) : [];
    const renamedFrom = p.announcedPath && p.announcedPath !== p.path ? p.announcedPath : undefined;
    const changed = !!(g?.commits.length || files.length || plans.length || ss.length || repoPRs.some((r) => Date.parse(r.updatedAt) > pSinceMs) || isNew || renamedFrom);
    const lastActivity = [g?.lastCommitAt, files[0] ? iso(files[0].at) : null, ss[0]?.lastAt].filter(Boolean).sort().pop() ?? null;
    if (g?.uncommitted && lastActivity && Date.parse(lastActivity) < now.getTime() - 7 * DAY && !changed) {
      staleWork.push({ project: p.name, id: p.id, uncommittedFiles: g.uncommitted.count, branch: g.branch, lastActivity });
    }
    if (!changed) {
      quiet.push({ name: p.name, lastActivity });
      continue;
    }
    active.push({
      id: p.id,
      name: p.name,
      path: p.path,
      kind: p.kind,
      ...(isNew ? { isNew: true } : {}),
      ...(renamedFrom ? { renamedFrom } : {}),
      ...(p.parentId ? { insideFolder: state.projects[p.parentId]?.name } : {}),
      ...(p.remote ? { remote: p.remote } : {}),
      ...(sameRepoAs.length ? { sameRepoAs } : {}),
      lastActivity,
      ...(g
        ? {
            branch: g.branch,
            ...(g.worktreeOf ? { worktreeOf: g.worktreeOf } : {}),
            commits: g.commits,
            ...(g.uncommitted ? { uncommitted: g.uncommitted } : {}),
            ...(g.branches ? { branches: g.branches } : {}),
          }
        : {}),
      ...(files.length ? { changedFiles: { count: files.length, newest: files.slice(0, LIMITS.files).map((f) => f.file) } } : {}),
      ...(plans.length ? { planFiles: plans } : {}),
      ...(repoPRs.length ? { pullRequests: repoPRs } : {}),
      ...(ss.length ? { claudeSessions: ss } : {}),
    });
  }
  const gone = Object.values(state.projects)
    .filter((p) => p.goneSince && p.announcedPath)
    .map((p) => ({ id: p.id, name: p.name, lastPath: p.path, goneSince: p.goneSince }));
  const unmatchedPRs = [...allPRs.values()].filter((p) => !claimedRepos.has(p.repo));

  const scanId = `scan_${nowIso.replace(/[-:]/g, '').replace('T', '_').slice(0, 15)}_${crypto.randomBytes(3).toString('hex')}`;
  state.pending = { scanId, until: now.toISOString(), ids: live.map((p) => p.id) };
  saveState(state);
  return {
    scanId,
    since,
    until: nowIso,
    firstRun,
    roots: devRoots(),
    counts: { tracked: live.length, active: active.length, quiet: quiet.length },
    active,
    quiet,
    staleWork,
    gone,
    githubOther: { pullRequestsInReposNotOnThisMac: unmatchedPRs, reviewRequests: prs.reviewRequests },
    claudeSessionsOutsideDevFolders: otherSessions.slice(0, LIMITS.otherSessions),
    warnings,
  };
}

export function ack(scanId: string) {
  const state = loadState();
  if (!state.pending || state.pending.scanId !== scanId) throw new Error(`No pending scan with id ${scanId}. Run scan again.`);
  const { until, ids } = state.pending;
  for (const id of ids) {
    const p = state.projects[id];
    if (!p) continue;
    p.ackedUntil = until;
    p.announcedPath = p.path;
  }
  // Folders reported as gone have now been seen by a review; forget them after 30 days.
  for (const p of Object.values(state.projects)) {
    if (p.goneSince && p.announcedPath && Date.parse(p.goneSince) < Date.parse(until) - 30 * DAY) delete state.projects[p.id];
    else if (p.goneSince) p.announcedPath = null;
  }
  state.ackedUntil = until;
  state.pending = null;
  saveState(state);
  return { acked: scanId, until };
}

export function listProjects() {
  const state = loadState();
  reconcile(state, iso(new Date()));
  saveState(state);
  return Object.values(state.projects)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => ({ id: p.id, name: p.name, path: p.path, kind: p.kind, remote: p.remote, gone: !!p.goneSince, previousPaths: p.paths.slice(0, -1) }));
}

// ─── CLI ───

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'scan') {
      const i = rest.indexOf('--since-days');
      const out = scan(i >= 0 ? { sinceDays: Number(rest[i + 1]) } : {});
      process.stdout.write(JSON.stringify(out, null, 1) + '\n');
    } else if (cmd === 'ack' && rest[0]) {
      process.stdout.write(JSON.stringify(ack(rest[0])) + '\n');
    } else if (cmd === 'projects') {
      process.stdout.write(JSON.stringify(listProjects(), null, 1) + '\n');
    } else {
      process.stderr.write('Usage: devscan.ts scan [--since-days N] | ack <scanId> | projects\n');
      process.exit(2);
    }
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
  }
}
