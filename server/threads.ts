// Links Claude Code threads to tasks. Claude Code saves every thread as a .jsonl file under
// ~/.claude/projects. When a thread mentions a task id (usually because you pasted the task's
// "Copy for Claude" reference), the thread is linked to that task. A thread can mention many
// tasks, and a task can be mentioned in many threads.
//
// Local and read-only: nothing leaves this Mac, no AI is involved, and thread files are never
// changed. Files are read incrementally, so after the first pass only new lines are read.
import fs from 'node:fs';
import path from 'node:path';
import { tx, type DB } from './db.ts';
import type { ClaudeThread, Status, TaskProgress } from '../shared/schema.ts';
import { REVIEW_MARKER, redact } from '../automation/devscan.ts';

const TASK_REF = /\bt_[A-Za-z0-9]{14}\b/g;
const CHUNK = 4 * 1024 * 1024;
/** Cheap check before parsing: only titles and conversation lines matter. */
const RELEVANT = /"type"\s*:\s*"(?:user|assistant|custom-title)"/;

const clip = (s: string, n: number) => {
  const t = redact(s.replace(/<\/?pasted_content[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  // Text blocks only. Tool results are output Claude read, not something said in the thread.
  if (Array.isArray(content)) return content.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n');
  return '';
}
/** What Claude ran: tool inputs. A command run on a task id means the thread is working on that task. */
function toolInputsOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content.filter((p) => p?.type === 'tool_use' && p.input).map((p) => JSON.stringify(p.input)).join('\n');
}
const looksInjected = (t: string) => /^\s*<(system-reminder|command-|local-command|task-notification|ci-monitor-event|user-prompt-submit-hook)/.test(t) || t.startsWith('Caveat:');

interface ThreadRow {
  session_id: string;
  file: string;
  title: string;
  custom_title: number;
  cwd: string;
  started_at: string | null;
  last_active_at: string | null;
  is_review: number;
  read_offset: number;
  user_turns: number;
  last_reply: string;
  last_reply_at: string | null;
  now_on: string;
  now_on_at: string | null;
  decision: string;
  decision_at: string | null;
}

function* jsonlFiles(dir: string): Generator<string> {
  let projects: string[];
  try {
    projects = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const p of projects) {
    let files: string[];
    try {
      files = fs.readdirSync(path.join(dir, p));
    } catch {
      continue;
    }
    // Top-level files only. Subfolders hold subagent runs, which belong to their parent thread.
    for (const f of files) if (f.endsWith('.jsonl')) yield path.join(dir, p, f);
  }
}

/** Reads complete new lines from `offset`, a chunk at a time so the server stays responsive. */
async function readNewLines(file: string, offset: number, size: number): Promise<{ lines: string[]; next: number }> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const lines: string[] = [];
    let pos = offset;
    let carry = '';
    while (pos < size) {
      const buf = Buffer.alloc(Math.min(CHUNK, size - pos));
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (bytesRead <= 0) break;
      pos += bytesRead;
      const parts = (carry + buf.subarray(0, bytesRead).toString('utf8')).split('\n');
      carry = parts.pop() ?? '';
      // Only lines that can matter are kept, so a large first read stays small in memory.
      for (const l of parts) if (RELEVANT.test(l)) lines.push(l);
    }
    // An unfinished last line is left for next time.
    return { lines, next: pos - Buffer.byteLength(carry, 'utf8') };
  } finally {
    await fh.close();
  }
}

/** A "Done:" or "Needs you:" line Claude wrote in a linked thread. */
export interface ThreadMarker {
  kind: 'done' | 'needs-you';
  text: string;
  at: string;
}

export function createThreadIndex(
  getDb: () => DB,
  dir: string,
  opts: { now?: () => Date; onMarkers?: (thread: { sessionId: string; title: string }, markers: ThreadMarker[]) => void } = {},
) {
  const now = opts.now ?? (() => new Date());
  let lastSync = 0;
  let running: Promise<void> | null = null;

  async function syncFile(getDb: () => DB, file: string, st: fs.Stats, existing: ThreadRow | undefined, taskExists: (id: string) => boolean) {
    const sessionId = path.basename(file, '.jsonl');
    const row: ThreadRow = existing ?? { session_id: sessionId, file, title: '', custom_title: 0, cwd: '', started_at: null, last_active_at: null, is_review: 0, read_offset: 0, user_turns: 0, last_reply: '', last_reply_at: null, now_on: '', now_on_at: null, decision: '', decision_at: null };
    if (st.size < row.read_offset) row.read_offset = 0; // the file was rewritten: start over
    if (st.size === row.read_offset && existing) return;
    const { lines, next } = await readNewLines(file, row.read_offset, st.size);
    const db = getDb();
    const refs = new Map<string, { count: number; at: string }>();
    const markers: ThreadMarker[] = [];
    for (const line of lines) {
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.type === 'custom-title' && typeof o.customTitle === 'string' && o.customTitle.trim()) {
        row.title = clip(o.customTitle, 120);
        row.custom_title = 1;
        continue;
      }
      if (o.type !== 'user' && o.type !== 'assistant') continue;
      if (o.isSidechain || o.isMeta || o.isCompactSummary) continue;
      const at: string = o.timestamp ?? now().toISOString();
      if (!row.cwd && o.cwd) row.cwd = o.cwd;
      if (!row.started_at) row.started_at = at;
      if (!row.last_active_at || at > row.last_active_at) row.last_active_at = at;
      const addRefs = (t: string) => {
        for (const m of t.matchAll(TASK_REF)) {
          const r = refs.get(m[0]) ?? { count: 0, at };
          r.count++;
          if (at > r.at) r.at = at;
          refs.set(m[0], r);
        }
      };
      if (o.type === 'assistant') addRefs(toolInputsOf(o.message?.content));
      const text = textOf(o.message?.content);
      if (!text || looksInjected(text)) continue;
      if (o.type === 'user') {
        // The daily review mentions every task. Its own threads are not "working on" anything.
        if (row.user_turns === 0 && text.includes(REVIEW_MARKER)) row.is_review = 1;
        if (row.user_turns === 0 && !row.custom_title) row.title = clip(text, 80);
        row.user_turns++;
      } else {
        row.last_reply = clip(text, 280);
        row.last_reply_at = at;
        const nowOn = lastMarked(text, 'Now on');
        if (nowOn) [row.now_on, row.now_on_at] = [clip(nowOn, 160), at];
        for (const [label, t] of markedLines(text, ['Done', 'Needs you'])) markers.push({ kind: label === 'Done' ? 'done' : 'needs-you', text: t, at });
        const decision = lastMarked(text, 'Decision');
        if (decision) [row.decision, row.decision_at] = [clip(decision, 240), at];
      }
      addRefs(text);
    }
    row.read_offset = next;
    tx(db, () => {
      db.prepare(
        `INSERT INTO claude_threads (session_id, file, title, custom_title, cwd, started_at, last_active_at, is_review, read_offset, user_turns,
           last_reply, last_reply_at, now_on, now_on_at, decision, decision_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET file = excluded.file, title = excluded.title, custom_title = excluded.custom_title, cwd = excluded.cwd,
           started_at = excluded.started_at, last_active_at = excluded.last_active_at, is_review = excluded.is_review,
           read_offset = excluded.read_offset, user_turns = excluded.user_turns, last_reply = excluded.last_reply, last_reply_at = excluded.last_reply_at,
           now_on = excluded.now_on, now_on_at = excluded.now_on_at, decision = excluded.decision, decision_at = excluded.decision_at`,
      ).run(row.session_id, file, row.title, row.custom_title, row.cwd, row.started_at, row.last_active_at, row.is_review, row.read_offset, row.user_turns,
        row.last_reply, row.last_reply_at, row.now_on, row.now_on_at, row.decision, row.decision_at);
      if (row.is_review) return;
      const link = db.prepare(
        `INSERT INTO task_threads (task_id, session_id, first_seen_at, last_mentioned_at, mentions) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(task_id, session_id) DO UPDATE SET mentions = mentions + excluded.mentions,
           last_mentioned_at = MAX(last_mentioned_at, excluded.last_mentioned_at)`,
      );
      const seen = now().toISOString();
      for (const [taskId, r] of refs) if (taskExists(taskId)) link.run(taskId, row.session_id, seen, r.at, r.count);
    });
    // Old lines (a first read of a long thread) are history, not instructions for today.
    const recent = markers.filter((m) => Date.parse(m.at) > now().getTime() - 24 * 3600_000);
    if (!row.is_review && recent.length && opts.onMarkers) opts.onMarkers({ sessionId: row.session_id, title: readableTitle(db, row) }, recent);
  }

  /** Open tasks this thread is linked to (not unlinked, not done). */
  function linkedOpenTasks(sessionId: string): string[] {
    return (
      getDb()
        .prepare(
          `SELECT t.id FROM task_threads tt JOIN tasks t ON t.id = tt.task_id
           WHERE tt.session_id = ? AND tt.hidden = 0 AND t.status != 'done' AND t.deleted_at IS NULL ORDER BY tt.last_mentioned_at DESC`,
        )
        .all(sessionId) as { id: string }[]
    ).map((r) => r.id);
  }

  /**
   * Reads anything new in the thread files. Cheap when nothing changed, and throttled so opening
   * tasks quickly doesn't repeat work. Concurrent callers share one pass.
   */
  function sync({ maxAgeMs = 10_000 } = {}): Promise<void> {
    if (running) return running;
    const t = now().getTime();
    if (t - lastSync < maxAgeMs) return Promise.resolve();
    lastSync = t;
    running = syncAll().finally(() => {
      running = null;
    });
    return running;
  }

  async function syncAll() {
    const db = getDb();
    const oldest = (db.prepare('SELECT MIN(created_at) AS at FROM tasks').get() as { at: string | null }).at;
    if (!oldest) return;
    // A thread can only mention a task id after the task exists, so older files are skipped.
    const floor = Date.parse(oldest) - 3600_000;
    const known = new Map((db.prepare('SELECT * FROM claude_threads').all() as unknown as ThreadRow[]).map((r) => [r.session_id, r]));
    const taskExists = (id: string) => !!getDb().prepare('SELECT 1 FROM tasks WHERE id = ?').get(id);
    for (const file of jsonlFiles(dir)) {
      let st: fs.Stats;
      try {
        st = await fs.promises.stat(file);
      } catch {
        continue;
      }
      const existing = known.get(path.basename(file, '.jsonl'));
      if (!existing && st.mtimeMs < floor) continue;
      if (existing && existing.read_offset === st.size) continue;
      try {
        await syncFile(getDb, file, st, existing, taskExists);
      } catch {
        // One unreadable file shouldn't stop the rest. It is retried next time.
      }
    }
  }

  function forTask(taskId: string): ClaudeThread[] {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT c.*, tt.first_seen_at, tt.mentions FROM task_threads tt JOIN claude_threads c ON c.session_id = tt.session_id
         WHERE tt.task_id = ? AND tt.hidden = 0 AND c.is_review = 0 ORDER BY c.last_active_at DESC`,
      )
      .all(taskId) as unknown as (ThreadRow & { first_seen_at: string; mentions: number })[];
    const others = db.prepare(
      `SELECT t.id, t.title, t.status FROM task_threads tt JOIN tasks t ON t.id = tt.task_id
       WHERE tt.session_id = ? AND tt.task_id != ? AND tt.hidden = 0 AND t.deleted_at IS NULL ORDER BY t.title`,
    );
    return rows.map((r) => ({
      sessionId: r.session_id,
      title: readableTitle(db, r),
      cwd: r.cwd,
      startedAt: r.started_at,
      lastActiveAt: r.last_active_at,
      firstSeenAt: r.first_seen_at,
      mentions: r.mentions,
      otherTasks: others.all(r.session_id, taskId) as unknown as { id: string; title: string; status: Status }[],
      resumeCommand: resumeCommand(r.cwd, r.session_id),
    }));
  }

  /**
   * For each In progress task: which subtask Claude is on and its latest decision or reply,
   * from the most recently active linked thread.
   */
  function progress(): TaskProgress[] {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT t.id AS task_id, c.* FROM tasks t
         JOIN task_threads tt ON tt.task_id = t.id AND tt.hidden = 0
         JOIN claude_threads c ON c.session_id = tt.session_id AND c.is_review = 0
         WHERE t.status = 'doing' AND t.deleted_at IS NULL
         ORDER BY t.id, c.last_active_at DESC`,
      )
      .all() as unknown as (ThreadRow & { task_id: string })[];
    const subs = db.prepare('SELECT id, title, done FROM subtasks WHERE task_id = ? ORDER BY position');
    const out: TaskProgress[] = [];
    const byTask = new Map<string, (ThreadRow & { task_id: string })[]>();
    for (const r of rows) byTask.set(r.task_id, [...(byTask.get(r.task_id) ?? []), r]);
    for (const [taskId, threads] of byTask) {
      const open = (subs.all(taskId) as unknown as { id: string; title: string; done: number }[]).filter((x) => !x.done);
      const latest = threads[0];
      // The newest "Now on:" across this task's threads that names one of its subtasks.
      let subtaskId: string | null = null;
      for (const th of [...threads].sort((a, b) => (b.now_on_at ?? '').localeCompare(a.now_on_at ?? ''))) {
        const hit = th.now_on && matchSubtask(th.now_on, open);
        if (hit) {
          subtaskId = hit;
          break;
        }
      }
      const useDecision = latest.decision && latest.decision_at && latest.decision_at >= (latest.last_reply_at ?? '');
      const note = useDecision ? latest.decision : latest.last_reply;
      out.push({
        taskId,
        subtaskId,
        note,
        noteKind: useDecision ? 'decision' : 'reply',
        noteAt: (useDecision ? latest.decision_at : latest.last_reply_at) ?? latest.last_active_at,
        activeAt: latest.last_active_at,
        sessionId: latest.session_id,
        threadTitle: readableTitle(db, latest),
      });
    }
    return out;
  }

  /**
   * The end of a thread's conversation, as plain text, so a new thread on the same ticket starts with the
   * whole story. What was said only (no tool output), newest last, up to `budget` characters.
   */
  async function digest(taskId: string, sessionId: string, budget = 14_000): Promise<{ file: string; title: string; messages: { role: 'you' | 'claude'; at: string; text: string }[]; truncated: boolean } | null> {
    const db = getDb();
    const r = db
      .prepare('SELECT c.* FROM task_threads tt JOIN claude_threads c ON c.session_id = tt.session_id WHERE tt.task_id = ? AND tt.session_id = ? AND tt.hidden = 0 AND c.is_review = 0')
      .get(taskId, sessionId) as ThreadRow | undefined;
    if (!r) return null;
    let size = 0;
    try {
      size = (await fs.promises.stat(r.file)).size;
    } catch {
      return null;
    }
    // The last 8 MB is plenty for the end of any conversation.
    const from = Math.max(0, size - 8 * 1024 * 1024);
    const { lines } = await readNewLines(r.file, from, size);
    const all: { role: 'you' | 'claude'; at: string; text: string }[] = [];
    for (const line of lines) {
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if ((o.type !== 'user' && o.type !== 'assistant') || o.isSidechain || o.isMeta || o.isCompactSummary) continue;
      let text = textOf(o.message?.content).trim();
      // A slash command like /master-tasker shows up wrapped in tags. Keep what you typed with it.
      const args = /<command-name>([^<]*)<\/command-name>[\s\S]*?<command-args>([\s\S]*?)<\/command-args>/.exec(text);
      if (args) text = `${args[1].trim()} ${args[2].trim()}`.trim();
      if (!text || looksInjected(text)) continue;
      all.push({ role: o.type === 'user' ? 'you' : 'claude', at: o.timestamp ?? '', text: redact(text.length > 4000 ? `${text.slice(0, 4000)}…` : text) });
    }
    const out: typeof all = [];
    let used = 0;
    for (let i = all.length - 1; i >= 0; i--) {
      used += all[i].text.length;
      if (used > budget && out.length) break;
      out.unshift(all[i]);
    }
    return { file: r.file, title: readableTitle(db, r), messages: out, truncated: out.length < all.length || from > 0 };
  }

  /** Unlinks a thread from a task. It stays unlinked even if the thread mentions the task again. */
  function hide(taskId: string, sessionId: string): boolean {
    return getDb().prepare('UPDATE task_threads SET hidden = 1 WHERE task_id = ? AND session_id = ?').run(taskId, sessionId).changes > 0;
  }

  return { sync, forTask, digest, hide, progress, linkedOpenTasks };
}

/** A thread named after its first message reads better with task names than with task ids. */
export function readableTitle(db: DB, r: Pick<ThreadRow, 'title' | 'custom_title'>): string {
  if (r.custom_title) return r.title;
  const title = (id: string) => (db.prepare('SELECT title FROM tasks WHERE id = ?').get(id) as { title: string } | undefined)?.title;
  const t = r.title
    .replace(/^Master Tasker task (t_[A-Za-z0-9]{14}):\s*/, '')
    .replace(TASK_REF, (id) => {
      const name = title(id);
      return name ? `“${name}”` : 'a task';
    });
  return t.trim() || 'Untitled thread';
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
export function resumeCommand(cwd: string, sessionId: string): string {
  // Thread ids come from file names, so anything unusual is quoted before it lands in a command you paste.
  const id = /^[A-Za-z0-9-]+$/.test(sessionId) ? sessionId : shellQuote(sessionId);
  return `${cwd ? `cd ${shellQuote(cwd)} && ` : ''}claude --resume ${id}`;
}

/** Marked lines in the order they were written, as [label, text]. */
export function markedLines(text: string, labels: string[]): [string, string][] {
  const re = new RegExp(`^[\\s>*_-]*(?:\\*\\*)?(${labels.join('|')}):(?:\\*\\*)?\\s*(.+)$`, 'gim');
  return [...text.matchAll(re)]
    .map((m) => [labels.find((l) => l.toLowerCase() === m[1].toLowerCase())!, m[2].replace(/\*\*/g, '').trim()] as [string, string])
    .filter(([, t]) => t);
}

/** Text after the last "Now on:" or "Decision:" line, allowing markdown bold or a bullet in front. */
export function lastMarked(text: string, label: string): string | null {
  const re = new RegExp(`^[\\s>*_-]*(?:\\*\\*)?${label}:(?:\\*\\*)?\\s*(.+)$`, 'gim');
  let last: string | null = null;
  for (const m of text.matchAll(re)) last = m[1].replace(/\*\*/g, '').trim();
  return last || null;
}

const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2));
/** Finds the open subtask a "Now on:" line names: exact or contained text first, then mostly the same words. */
export function matchSubtask(said: string, open: { id: string; title: string }[]): string | null {
  const s = said.toLowerCase().trim();
  const exact = open.find((o) => s.includes(o.title.toLowerCase().trim()) || o.title.toLowerCase().includes(s));
  if (exact) return exact.id;
  const sw = words(said);
  let best: { id: string; score: number } | null = null;
  for (const o of open) {
    const ow = words(o.title);
    if (!ow.size) continue;
    const shared = [...ow].filter((w) => sw.has(w)).length;
    const score = shared / ow.size;
    if (score >= 0.6 && (!best || score > best.score)) best = { id: o.id, score };
  }
  return best?.id ?? null;
}
