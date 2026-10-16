// The scheduled review's only door into Master Tasker. It uses a read-and-propose connection,
// so a review suggests edits but never makes them. It can start a task, and finish one it has proof for. The token lives in a file only you can read.
// The daily review is optional, and aimed at people who keep code on this Mac. See docs/REVIEW.md.
//
//   npm run review:setup [-- --folders "<folder>:<folder>"] [--suggest-only]
//                                              create the "Daily review" connection, save its token, and print the routine to schedule
//   node automation/review.ts start            gather tasks, suggestions, answers and the code folder digest into one file
//   node automation/review.ts context          tasks and suggestions only, for other routines (no folder scan, no run)
//   node automation/review.ts propose <file>   send a JSON array of suggestions (see docs/REVIEW.md)
//   node automation/review.ts start-task <id>  move a task into In progress (needs the narrow "start" permission)
//   node automation/review.ts complete <id> --why "PR #12 merged" [--link url]   mark it done, with proof (needs "complete")
//   node automation/review.ts finish <scanId>  mark the run done so the next one starts from here
//   node automation/review.ts status           show the last runs
//
// Env: MT_DATA_DIR and MASTER_TASKER_URL (or MT_PORT), the same as the server. See automation/env.ts.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { STATUSES, zProposalEnvelope, type Area, type Project, type Proposal, type Task } from '../shared/schema.ts';
import { ack, devRoots, FOLDERS_FILE, scan, writeDevRoots } from './devscan.ts';
import { BASE, DATA_DIR, REPO, checkLocal, createConnection, envPrefix, readTokenFile, shq, tokenStatus, writeTokenFile } from './env.ts';

export const REVIEW_DIR = path.join(DATA_DIR, 'review');
export const TOKEN_FILE = path.join(REVIEW_DIR, 'token');
const RUNS_DIR = path.join(REVIEW_DIR, 'runs');
const LOG_FILE = path.join(REVIEW_DIR, 'log.jsonl');
/** Present while a run is between start and finish, so the app can show "running". */
const CURRENT_FILE = path.join(REVIEW_DIR, 'current.json');
const SESSION = `review-${crypto.randomBytes(6).toString('hex')}`;
const SETUP = 'Set up the daily review with: npm run review:setup (in the Master Tasker folder). See docs/REVIEW.md.';

const token = () => readTokenFile(TOKEN_FILE, `No review token at ${TOKEN_FILE}. ${SETUP}`);

async function call<T>(method: string, p: string, body?: unknown, key?: string): Promise<T> {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      authorization: `Bearer ${token()}`,
      'x-session-id': SESSION,
      'x-actor-name': 'daily-review',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => {
    throw new Error(`Master Tasker is not reachable at ${BASE}. Is the service running?`);
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (res.status === 401) throw Object.assign(new Error(`The Daily review connection was revoked or deleted. ${SETUP}`), { status: 401, data });
  if (!res.ok) throw Object.assign(new Error(data?.error?.message ?? `HTTP ${res.status}`), { status: res.status, data });
  return data as T;
}

function compactTask(t: Task, areas: Map<string, string>, projects: Map<string, string>) {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    area: t.areaId ? areas.get(t.areaId) : null,
    project: t.projectId ? projects.get(t.projectId) : null,
    priority: t.priority === 'none' ? undefined : t.priority,
    due: t.dueDate ?? undefined,
    nextAction: t.nextAction || undefined,
    waitingOn: t.waitingOn || undefined,
    notes: t.notes ? (t.notes.length > 600 ? `${t.notes.slice(0, 599)}…` : t.notes) : undefined,
    subtasks: t.subtasks.length ? t.subtasks.map((s) => `${s.done ? '[x]' : '[ ]'} ${s.title}`) : undefined,
    links: t.links.length ? t.links.map((l) => l.url) : undefined,
    rev: t.rev,
    updatedAt: t.updatedAt,
    completedAt: t.completedAt ?? undefined,
  };
}

const PAUSED = { paused: true, message: 'Automation is paused in Master Tasker. Stop here and do nothing.' } as const;

/** Tasks, areas and this connection's suggestions: what any routine needs before it suggests. */
async function gather() {
  checkLocal();
  const me = await call<{ actor: { label: string }; ownerName?: string; paused: boolean }>('GET', '/api/whoami');
  if (me.paused) return null;
  const { areas, projects } = await call<{ areas: Area[]; projects: Project[] }>('GET', '/api/areas');
  const areaNames = new Map(areas.map((a) => [a.id, a.name]));
  const projectNames = new Map(projects.map((p) => [p.id, p.name]));
  const tasks: Task[] = [];
  for (const s of STATUSES) {
    const r = await call<{ tasks: Task[] }>('GET', `/api/tasks?status=${s}&limit=50${s === 'done' ? '&includeDone=true' : ''}`);
    tasks.push(...r.tasks);
  }
  const proposals = (await call<{ proposals: Proposal[] }>('GET', '/api/proposals?status=all&limit=100')).proposals;
  const monthAgo = Date.now() - 30 * 24 * 3600_000;
  return {
    connection: me.actor.label,
    // What the user wants to be called. Empty when they didn't say. It helps spot them in email and Slack.
    user: { name: me.ownerName ?? '' },
    generatedAt: new Date().toISOString(),
    areas: areas.filter((a) => !a.archived).map((a) => ({ id: a.id, name: a.name, projects: projects.filter((p) => p.areaId === a.id && !p.archived).map((p) => ({ id: p.id, name: p.name })) })),
    tasks: tasks.filter((t) => t.status !== 'done').map((t) => compactTask(t, areaNames, projectNames)),
    recentlyDone: tasks.filter((t) => t.status === 'done').map((t) => compactTask(t, areaNames, projectNames)),
    mySuggestions: {
      pending: proposals.filter((p) => p.status === 'pending').map(slimProposal),
      answeredQuestions: proposals.filter((p) => p.body.kind === 'question' && p.status === 'accepted' && Date.parse(p.resolvedAt ?? '') > monthAgo).map(slimProposal),
      resolvedLast30Days: proposals.filter((p) => p.status !== 'pending' && p.body.kind !== 'question' && Date.parse(p.resolvedAt ?? p.lastSeenAt) > monthAgo).map(slimProposal),
    },
  };
}

export async function start() {
  const base = await gather();
  if (!base) return PAUSED;
  const digest = scan();
  const run = { scanId: digest.scanId, ...base, development: digest };
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  const file = path.join(RUNS_DIR, `${digest.scanId}.json`);
  fs.writeFileSync(file, JSON.stringify(run, null, 1), { mode: 0o600 });
  fs.writeFileSync(CURRENT_FILE, JSON.stringify({ scanId: digest.scanId, startedAt: run.generatedAt }));
  pruneRuns();
  return {
    file,
    scanId: digest.scanId,
    openTasks: run.tasks.length,
    pendingSuggestions: run.mySuggestions.pending.length,
    newAnswers: run.mySuggestions.answeredQuestions.length,
    devFoldersWithActivity: digest.counts.active,
    devFoldersTracked: digest.counts.tracked,
  };
}

/**
 * The same tasks and suggestions as start, for routines other than the daily review (a meeting notes routine, say).
 * No dev folder scan and no run, so the daily review's window and "running" state are untouched.
 */
export async function context() {
  const base = await gather();
  if (!base) return PAUSED;
  fs.mkdirSync(REVIEW_DIR, { recursive: true });
  const file = path.join(REVIEW_DIR, 'context.json');
  fs.writeFileSync(file, JSON.stringify(base, null, 1), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return { file, openTasks: base.tasks.length, pendingSuggestions: base.mySuggestions.pending.length, newAnswers: base.mySuggestions.answeredQuestions.length };
}

function slimProposal(p: Proposal) {
  return { id: p.id, status: p.status, kind: p.body.kind, dedupeKey: p.dedupeKey, body: p.body, reason: p.reason, answer: p.answer ?? undefined, resolvedAt: p.resolvedAt ?? undefined };
}

function pruneRuns() {
  const files = fs.readdirSync(RUNS_DIR).filter((f) => f.endsWith('.json')).sort();
  for (const f of files.slice(0, -20)) fs.rmSync(path.join(RUNS_DIR, f));
}

export async function propose(file: string) {
  checkLocal();
  const items = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(items)) throw new Error('Expected a JSON array of suggestions');
  if (items.length > 40) throw new Error('At most 40 suggestions per run. Keep only the most useful ones.');
  const results = [];
  for (const [i, item] of items.entries()) {
    const parsed = zProposalEnvelope.safeParse(item);
    if (!parsed.success) {
      results.push({ index: i, ok: false, error: parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ') });
      continue;
    }
    if (!parsed.data.dedupeKey) {
      results.push({ index: i, ok: false, error: 'dedupeKey is required, so the same thing is never suggested twice' });
      continue;
    }
    const key = crypto.createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex').slice(0, 40);
    try {
      const r = await call<{ proposal: Proposal; deduplicated: boolean; suppressed: boolean }>('POST', '/api/proposals', parsed.data, key);
      results.push({ index: i, ok: true, id: r.proposal.id, status: r.proposal.status, deduplicated: r.deduplicated, suppressed: r.suppressed, answer: r.proposal.answer ?? undefined });
    } catch (e) {
      const err = e as Error & { status?: number };
      results.push({ index: i, ok: false, error: err.message });
      if (err.status === 423 || err.status === 429) break; // paused or over the daily limit: stop
    }
  }
  return { sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
}

/** The one direct change a review may make: In progress only, never done, never out of In progress. */
export async function startTask(id: string) {
  checkLocal();
  if (!/^t_[A-Za-z0-9]{6,40}$/.test(id)) throw new Error('Expected a task id like t_...');
  const r = await call<{ task: Task }>('POST', `/api/tasks/${id}/start`);
  return { id: r.task.id, title: r.task.title, status: r.task.status };
}

/** Marks a task done when there's proof: a merged PR, a "done" or "sent" from you, a receipt. You get notified. */
export async function completeTask(id: string, why: string, link?: string) {
  checkLocal();
  if (!/^t_[A-Za-z0-9]{6,40}$/.test(id)) throw new Error('Expected a task id like t_...');
  if (!why.trim()) throw new Error('Say why it is done: --why "PR #12 merged"');
  const r = await call<{ task: Task }>('POST', `/api/tasks/${id}/complete`, { why: why.trim().slice(0, 500), ...(link ? { link } : {}) });
  return { id: r.task.id, title: r.task.title, status: r.task.status };
}

export async function withdraw(id: string, why: string) {
  checkLocal();
  if (!/^pr_[A-Za-z0-9]{6,40}$/.test(id)) throw new Error('Expected a suggestion id like pr_...');
  if (!why.trim()) throw new Error('Say why it is out of date: --why "PR #66 merged"');
  const r = await call<{ proposal: Proposal }>('POST', `/api/proposals/${id}/withdraw`, { why: why.trim().slice(0, 500) });
  return { id: r.proposal.id, status: r.proposal.status };
}

export function finish(scanId: string, summary: Record<string, unknown> = {}) {
  const r = ack(scanId);
  fs.mkdirSync(REVIEW_DIR, { recursive: true });
  fs.appendFileSync(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), scanId, ...summary }) + '\n');
  fs.rmSync(CURRENT_FILE, { force: true });
  return r;
}

const PERMS = ['read', 'propose', 'start', 'complete'];
const PERM_WORDS: Record<string, string> = { read: 'read', propose: 'suggest changes', start: 'start tasks', complete: 'finish tasks it has proof for' };
const and = (l: string[]) => (l.length > 1 ? `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}` : l[0]);

/**
 * npm run review:setup. Makes the "Daily review" connection (or keeps a working one), saves its
 * token so only you can read it, saves the code folders to watch, and prints the routine to schedule.
 * A token that no longer works (its connection was revoked or deleted) is replaced.
 */
export async function setup(opts: { folders?: string[]; suggestOnly?: boolean } = {}) {
  checkLocal();
  const up = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok, () => false);
  if (!up) throw new Error(`Master Tasker isn't running at ${BASE}. Start it with ./scripts/service.sh start, then run this again.`);
  const said: string[] = [];
  let existing: string | null = null;
  if (fs.existsSync(TOKEN_FILE)) {
    fs.chmodSync(TOKEN_FILE, 0o600);
    try {
      existing = readTokenFile(TOKEN_FILE, '');
    } catch {}
  }
  const status = existing ? await tokenStatus(existing) : null;
  if (status === 'down') throw new Error(`Master Tasker stopped answering at ${BASE}. Try again in a moment.`);
  if (status === 'ok') {
    said.push(`The "Daily review" connection already works. Kept its token at ${TOKEN_FILE}.`);
    said.push('To change what it may do, remove its access in Settings > AI assistants and run this again.');
  } else {
    const perms = opts.suggestOnly ? ['read', 'propose'] : PERMS;
    const { token: t } = await createConnection('Daily review', { areas: '*', unfiled: true, perms });
    writeTokenFile(TOKEN_FILE, t);
    if (status === 'revoked') said.push('The old review token no longer worked (its connection was revoked or deleted), so I made a new one.');
    said.push(`Created the "Daily review" connection. It can ${and(perms.map((p) => PERM_WORDS[p]))}, in every area.`);
    said.push(`Its token is saved at ${TOKEN_FILE}, readable only by you.`);
  }
  if (opts.folders) writeDevRoots(opts.folders);
  const roots = devRoots();
  said.push(
    roots.length
      ? `Code folders it watches: ${roots.join(', ')} (saved in ${FOLDERS_FILE}).`
      : `Code folders: none, so it won't look at git or plan files. To add some, run: npm run review:setup -- --folders "<folder>:<another folder>"`,
  );
  const cmd = `${envPrefix()}node ${shq(path.join(REPO, 'automation', 'review.ts'))}`;
  const routine = [
    '[master-tasker-review] Run the Master Tasker daily review.',
    `Read ${shq(path.join(REPO, 'docs', 'REVIEW.md'))} and follow its "Instructions for the review run" section exactly.`,
    'Wherever it says `node automation/review.ts`, run this instead, word for word:',
    `${cmd}`,
  ].join('\n');
  return [
    'Daily review is set up.',
    '',
    ...said.map((l) => `  ${l}`),
    '',
    'Last step: schedule it in the Claude desktop app.',
    '  1. Add a new scheduled task.',
    '  2. Name it "Master Tasker daily review".',
    `  3. Set its folder to ${REPO}`,
    '  4. Pick when it runs. Twice a day, at 8am and 2pm, works well.',
    '  5. Paste this as its instructions:',
    '',
    '----------------------------------------',
    routine,
    '----------------------------------------',
    '',
    'Pause it any time in Master Tasker: Settings > Automation.',
  ].join('\n');
}

function status() {
  try {
    return fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-10).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, arg, ...rest] = process.argv.slice(2);
  const out = (v: unknown) => process.stdout.write(JSON.stringify(v, null, 1) + '\n');
  (async () => {
    if (cmd === 'setup') {
      const i = [arg, ...rest].indexOf('--folders');
      const all = [arg, ...rest];
      const folders = i >= 0 ? (all[i + 1] ?? '').split(':').filter(Boolean) : undefined;
      process.stdout.write(`${await setup({ folders, suggestOnly: all.includes('--suggest-only') })}\n`);
    } else if (cmd === 'start') out(await start());
    else if (cmd === 'context') out(await context());
    else if (cmd === 'propose' && arg) out(await propose(arg));
    else if (cmd === 'start-task' && arg) out(await startTask(arg));
    else if (cmd === 'complete' && arg) {
      const flag = (name: string) => {
        const i = rest.indexOf(name);
        return i >= 0 ? rest[i + 1] : undefined;
      };
      out(await completeTask(arg, flag('--why') ?? '', flag('--link')));
    }
    else if (cmd === 'withdraw' && arg) {
      const i = rest.indexOf('--why');
      out(await withdraw(arg, i >= 0 ? rest[i + 1] ?? '' : ''));
    }
    else if (cmd === 'finish' && arg) {
      const i = rest.indexOf('--summary');
      out(finish(arg, i >= 0 ? { summary: rest[i + 1] } : {}));
    } else if (cmd === 'status') out(status());
    else {
      process.stderr.write('Usage: review.ts setup [--folders "<folder>:<folder>"] [--suggest-only] | start | context | propose <file.json> | start-task <taskId> | complete <taskId> --why "..." [--link url] | withdraw <proposalId> --why "..." | finish <scanId> [--summary "..."] | status\n');
      process.exit(2);
    }
  })().catch((e) => {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
  });
}
