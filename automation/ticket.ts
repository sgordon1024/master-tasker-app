// The /master-tasker skill's door into Master Tasker. A Claude thread uses it to fill out a
// ticket, plan its subtasks, move it into In progress, and tick subtasks off as it works.
// It uses its own connection ("Claude threads"), so everything it does shows up under that name
// in Activity, and it can never clear "Needs you" or check off a subtask that needs you.
// The skill runs it through claude/skills/master-tasker/ticket, which knows where this repo,
// the data folder and node are.
//
//   ticket get <taskId>                 the ticket, areas and projects to file it in, and the user's name
//   ticket fill <taskId> <file.json>    set title, notes, area, project, priority, due, next action
//   ticket plan <taskId> <file.json> [--ordered]
//                                       replace the open subtasks with an ordered plan; --ordered locks
//                                       the order when the steps must happen in that sequence
//   ticket start <taskId>               move it into In progress
//   ticket done <taskId> <subtask>      check off a subtask (title or id)
//   ticket needs-you <taskId> <text> [--why "<context>"]
//                                       flag a subtask (title or id), or the whole task, for you, with the why
//   ticket note <taskId> <text>         add a note
//   ticket complete <taskId> [what got done]   mark it done, only when every subtask is done and none need you. You get notified
//
// Env: MT_DATA_DIR and MASTER_TASKER_URL (or MT_PORT), the same as the server. See automation/env.ts.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRIORITIES, type Area, type Project, type Subtask, type Task } from '../shared/schema.ts';
import { BASE, DATA_DIR, checkLocal, readTokenFile } from './env.ts';

export const TOKEN_FILE = path.join(DATA_DIR, 'claude', 'token');
const SESSION = `ticket-${crypto.randomBytes(6).toString('hex')}`;
const SETUP = 'In Master Tasker, open Settings > AI assistants and press Set up Claude Code. Or run ./scripts/install-skill.sh in the Master Tasker folder.';

/** How the ticket steps reach the app. The skill uses the token file below; the MCP server passes its own. */
export type Call = <T>(method: string, p: string, body?: unknown) => Promise<T>;

const token = () => readTokenFile(TOKEN_FILE, `No Claude threads token at ${TOKEN_FILE}. ${SETUP}`);

const call: Call = async <T,>(method: string, p: string, body?: unknown): Promise<T> => {
  checkLocal();
  const res = await fetch(BASE + p, {
    method,
    headers: {
      authorization: `Bearer ${token()}`,
      'x-session-id': SESSION,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'idempotency-key': crypto.randomUUID() } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => {
    throw new Error(`Master Tasker is not reachable at ${BASE}. Is it running? Check with ./scripts/service.sh status in the Master Tasker folder.`);
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (res.status === 401) throw Object.assign(new Error(`The Claude threads connection was revoked or deleted. ${SETUP}`), { status: 401 });
  if (!res.ok) throw Object.assign(new Error(data?.error?.message ?? `HTTP ${res.status}`), { status: res.status });
  return data as T;
};

const checkId = (id: string | undefined) => {
  if (!id || !/^t_[A-Za-z0-9]{14}$/.test(id)) throw new Error('Expected a task id like t_...');
  return id;
};
const getTask = async (id: string) => (await call<{ task: Task }>('GET', `/api/tasks/${checkId(id)}`)).task;
const readJson = (file: string) => JSON.parse(file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8'));

/** A ticket with nothing in it but a title. The skill fills these out first. */
export const isEmpty = (t: Task) => !t.notes.trim() && !t.nextAction.trim() && t.subtasks.length === 0 && t.links.length === 0;

function compact(t: Task, areas: Area[], projects: Project[]) {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    area: areas.find((a) => a.id === t.areaId)?.name ?? null,
    project: projects.find((p) => p.id === t.projectId)?.name ?? null,
    priority: t.priority,
    due: t.dueDate,
    nextAction: t.nextAction,
    waitingOn: t.waitingOn,
    needsYou: t.needsYou,
    notes: t.notes,
    links: t.links,
    subtasks: t.subtasks.map((s) => ({ id: s.id, title: s.title, done: s.done, needsYou: s.needsYou })),
    /** Your answers to things that needed you, newest last. Sent from the Reply button in the app. */
    replies: t.notes.split(/\n{2,}/).filter((p) => p.includes('You replied to "')).map((p) => p.trim()),
    rev: t.rev,
    empty: isEmpty(t),
  };
}

interface History {
  threads: { title: string; folder: string; startedAt: string | null; lastActiveAt: string | null; resume: string }[];
  latest: Conversation | null;
  conversations?: Conversation[];
}
interface Conversation {
  file: string;
  title: string;
  messages: { role: string; at: string; text: string }[];
  truncated: boolean;
}

async function get(id: string) {
  // This thread's own id, so its history leaves itself out.
  const self = process.env.CLAUDE_CODE_SESSION_ID ?? '';
  const [task, { areas, projects }, history, me] = await Promise.all([
    getTask(id),
    call<{ areas: Area[]; projects: Project[] }>('GET', '/api/areas'),
    call<History>('GET', `/api/tasks/${id}/history${self ? `?except=${encodeURIComponent(self)}` : ''}`).catch(() => null),
    call<{ ownerName?: string }>('GET', '/api/whoami').catch(() => null),
  ]);
  return {
    // Who you're working for: what they want to be called. Empty when they didn't say.
    user: { name: me?.ownerName ?? '' },
    task: compact(task, areas, projects),
    // Earlier Claude threads on this ticket, newest first, and how the latest one ended. Read it before you start.
    history: history && history.threads.length
      ? {
          earlierThreads: history.threads,
          // Newest first. Each is how that thread ended; read its transcript file for the earlier part.
          conversations: (history.conversations ?? (history.latest ? [history.latest] : [])).map((c) => ({
            thread: c.title,
            transcript: c.file,
            note: c.truncated ? 'Only the end is shown. Read the transcript file for the earlier part if you need it.' : undefined,
            said: c.messages.map((m) => `[${m.role} ${m.at.slice(0, 16)}] ${m.text}`),
          })),
        }
      : null,
    areas: areas.filter((a) => !a.archived).map((a) => ({ id: a.id, name: a.name, mode: a.mode, projects: projects.filter((p) => p.areaId === a.id && !p.archived).map((p) => ({ id: p.id, name: p.name })) })),
  };
}

/** Accepts area and project by name or id, so the skill doesn't have to juggle ids. */
async function fill(id: string, input: Record<string, unknown>) {
  const task = await getTask(id);
  const { areas, projects } = await call<{ areas: Area[]; projects: Project[] }>('GET', '/api/areas');
  const byName = <T extends { id: string; name: string }>(list: T[], v: unknown) =>
    typeof v === 'string' ? list.find((x) => x.id === v || x.name.toLowerCase() === v.toLowerCase()) : undefined;
  const patch: Record<string, unknown> = {};
  for (const k of ['title', 'notes', 'nextAction', 'dueDate', 'waitingOn'] as const) if (input[k] !== undefined) patch[k] = input[k];
  if (input.priority !== undefined) {
    if (!PRIORITIES.includes(input.priority as never)) throw new Error(`priority must be one of ${PRIORITIES.join(', ')}`);
    patch.priority = input.priority;
  }
  if (input.links !== undefined) patch.links = input.links;
  if (input.area !== undefined) {
    const a = input.area === null ? null : byName(areas, input.area);
    if (a === undefined) throw new Error(`No area called "${input.area}". Areas: ${areas.map((x) => x.name).join(', ')}`);
    patch.areaId = a?.id ?? null;
    if (!input.project) patch.projectId = null;
  }
  if (input.project !== undefined) {
    const p = input.project === null ? null : byName(projects, input.project);
    if (p === undefined) throw new Error(`No project called "${input.project}". Only use projects that already exist.`);
    patch.projectId = p?.id ?? null;
    if (p && patch.areaId === undefined) patch.areaId = p.areaId;
  }
  if (!Object.keys(patch).length) throw new Error('Nothing to fill in');
  const r = await call<{ task: Task }>('PATCH', `/api/tasks/${id}`, { baseRev: task.rev, patch });
  return compact(r.task, areas, projects);
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function findSubtask(task: Task, said: string): Subtask | undefined {
  const exact = task.subtasks.find((s) => s.id === said) ?? task.subtasks.find((s) => norm(s.title) === norm(said));
  if (exact) return exact;
  const hits = task.subtasks.filter((s) => norm(s.title).includes(norm(said)) || norm(said).includes(norm(s.title)));
  return hits.length === 1 ? hits[0] : undefined;
}

export type PlanItem = string | { title: string; needsYou?: boolean };

/**
 * Makes the open subtasks match the plan, in order. Finished subtasks stay, first. Open
 * subtasks that need you are never removed. Others not in the plan are removed.
 * A plan item that's already been ticked off stays done: it's never added back as a new open one.
 */
export async function planSubtasks(call: Call, id: string, items: PlanItem[], ordered = false) {
  if (!Array.isArray(items) || !items.length) throw new Error('Expected a JSON array of subtasks, in order');
  const wanted = items.map((i) => (typeof i === 'string' ? { title: i.trim(), needsYou: false } : { title: String(i?.title ?? '').trim(), needsYou: Boolean(i?.needsYou) }));
  if (wanted.some((w) => !w.title)) throw new Error('Every subtask needs a title');
  let task = (await call<{ task: Task }>('GET', `/api/tasks/${checkId(id)}`)).task;
  const kept = new Set<string>();
  const order: string[] = [];
  const finished = new Set(task.subtasks.filter((x) => x.done).map((x) => norm(x.title)));
  const skipped: string[] = [];
  for (const w of wanted) {
    let s = task.subtasks.find((x) => !kept.has(x.id) && !x.done && norm(x.title) === norm(w.title));
    if (!s && finished.has(norm(w.title))) {
      skipped.push(w.title);
      continue;
    }
    if (!s) {
      task = (await call<{ task: Task }>('POST', `/api/tasks/${id}/subtasks`, { title: w.title })).task;
      s = task.subtasks[task.subtasks.length - 1];
    }
    if (w.needsYou && !s.needsYou) task = (await call<{ task: Task }>('PATCH', `/api/tasks/${id}/subtasks/${s.id}`, { needsYou: true })).task;
    kept.add(s.id);
    order.push(s.id);
  }
  for (const s of task.subtasks) {
    if (s.done || kept.has(s.id)) continue;
    if (s.needsYou) {
      kept.add(s.id);
      order.push(s.id);
    } else task = (await call<{ task: Task }>('DELETE', `/api/tasks/${id}/subtasks/${s.id}`)).task;
  }
  const done = task.subtasks.filter((s) => s.done).map((s) => s.id);
  task = (await call<{ task: Task }>('PUT', `/api/tasks/${id}/subtasks/order`, { ids: [...done, ...order], ordered })).task;
  const list = task.subtasks.map((s) => `${s.done ? '[x]' : s.needsYou ? '[you]' : '[ ]'} ${s.title}`);
  return skipped.length ? { subtasks: list, alreadyDone: skipped } : list;
}

async function done(id: string, said: string) {
  const task = await getTask(id);
  const s = findSubtask(task, said);
  if (!s) throw new Error(`No single subtask matches "${said}". Subtasks: ${task.subtasks.map((x) => x.title).join(' | ')}`);
  if (s.done) return { already: true, subtask: s.title };
  if (s.needsYou) throw new Error(`"${s.title}" needs you. Only you can check it off.`);
  await call('PATCH', `/api/tasks/${id}/subtasks/${s.id}`, { done: true });
  return { done: s.title };
}

/** The thread running this command, so the app can show where a flag came from and you can ask it about it. */
const threadId = () => (/^[A-Za-z0-9-]{8,64}$/.test(process.env.CLAUDE_CODE_SESSION_ID ?? '') ? process.env.CLAUDE_CODE_SESSION_ID : undefined);

/**
 * Flags an open subtask (title or id) for you, or the whole task when nothing matches, with the why.
 * A subtask you already ticked off is never turned back into a flag.
 */
export async function flagNeedsYou(call: Call, id: string, said: string, why?: string, sessionId?: string) {
  const task = (await call<{ task: Task }>('GET', `/api/tasks/${checkId(id)}`)).task;
  const s = findSubtask({ ...task, subtasks: task.subtasks.filter((x) => !x.done) }, said) ?? findSubtask(task, said);
  const detail = why?.trim() || undefined;
  if (s && !s.done) {
    await call('POST', `/api/tasks/${id}/needs-you`, { subtask: s.id, detail, sessionId });
    return { flagged: 'subtask', subtask: s.title, why: detail };
  }
  // You already ticked it off. Don't turn it into a new flag.
  if (s?.done) return { already: true, subtask: s.title };
  await call('POST', `/api/tasks/${id}/needs-you`, { text: said.slice(0, 500), detail, sessionId });
  return { flagged: 'task', text: said, why: detail };
}

async function complete(id: string, why?: string) {
  const task = await getTask(id);
  const open = task.subtasks.filter((s) => !s.done);
  if (open.length) throw new Error(`Not done yet. Open subtasks: ${open.map((s) => (s.needsYou ? `${s.title} (needs you)` : s.title)).join(' | ')}`);
  if (task.needsYou) throw new Error(`The task needs you: ${task.needsYou}`);
  const sessionId = threadId();
  const r = await call<{ task: Task }>('POST', `/api/tasks/${id}/complete`, { ...(why ? { why: why.slice(0, 500) } : {}), ...(sessionId ? { sessionId } : {}) });
  return { id: r.task.id, status: r.task.status };
}

// Run as a command, also through a link to this file or its folder.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, id, ...rest] = process.argv.slice(2);
  const arg = rest.join(' ').trim();
  const out = (v: unknown) => process.stdout.write(JSON.stringify(v, null, 1) + '\n');
  (async () => {
    if (cmd === 'get') out(await get(checkId(id)));
    else if (cmd === 'fill' && arg) out(await fill(checkId(id), readJson(arg)));
    else if (cmd === 'plan' && arg) out(await planSubtasks(call, checkId(id), readJson(rest.filter((r) => r !== '--ordered').join(' ').trim()), rest.includes('--ordered')));
    else if (cmd === 'start') out((await call<{ task: Task }>('POST', `/api/tasks/${checkId(id)}/start`)).task.status);
    else if (cmd === 'done' && arg) out(await done(checkId(id), arg));
    else if (cmd === 'needs-you' && arg) {
      const i = rest.indexOf('--why');
      const what = (i >= 0 ? rest.slice(0, i) : rest).join(' ').trim();
      out(await flagNeedsYou(call, checkId(id), what, i >= 0 ? rest.slice(i + 1).join(' ') : undefined, threadId()));
    }
    else if (cmd === 'note' && arg) out((await call<{ task: Task }>('POST', `/api/tasks/${checkId(id)}/notes`, { text: arg })).task.notes.slice(-200));
    else if (cmd === 'complete') out(await complete(checkId(id), arg || undefined));
    else {
      process.stderr.write('Usage: ticket get|start|complete <taskId> | fill|plan <taskId> <file.json|-> | done|needs-you|note <taskId> <text>\n');
      process.exit(2);
    }
  })().catch((e) => {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
  });
}
