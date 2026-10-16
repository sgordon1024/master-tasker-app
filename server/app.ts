import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { backupDatabase, listBackups, openDatabase, pruneBackups, replaceDatabaseFile, schemaVersion, verifyBackup, type DB } from './db.ts';
import { log } from './log.ts';
import { runAsk } from './ask.ts';
import { appThreadLink, createClaudeApp, type ScheduledRoutine } from './claudeApp.ts';
import { createIntegrations, REPO } from './integrations.ts';
import { createSources } from './sources.ts';
import { createThreadIndex, matchSubtask, type ThreadMarker } from './threads.ts';
import { AppError, clientCtx, createService, systemCtx, userCtx, type Ctx, type ExportFile, type Service } from './service.ts';
import type { Config } from './config.ts';
import {
  zAreaCreate,
  zAreaPatch,
  zAreaDelete,
  zNoteAppend,
  zProjectCreate,
  zProjectPatch,
  zProposalAnswer,
  zProposalEnvelope,
  zSettingsPatch,
  zSetup,
  zStatus,
  zSubtaskCreate,
  zComplete,
  zSubtaskOrder,
  zSubtaskPatch,
  zTaskQuery,
  zTaskUpdate,
  zAskCreate,
  zYouFlag,
  zRoutinePatch,
  zSourceRequest,
  zAcceptAll,
  type LiveEvent,
  type Task,
} from '../shared/schema.ts';
import type { z } from 'zod';

const VERSION = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'package.json'), 'utf8')).version as string;
const MAX_BODY = 5 * 1024 * 1024;
const IDEMPOTENCY_TTL_MS = 7 * 24 * 3600_000;
const TOKEN_TEXT = /mt_[A-Za-z0-9]{32}/g;
const ALREADY_CREATED = JSON.stringify({ error: { code: 'conflict', message: 'This connection was already created, and its token is shown only once. Make a new one.' } });

/**
 * What a retry with the same Idempotency-Key gets back. Tokens are never kept: a new connection's answer becomes
 * "already created", so a retry doesn't make a second one, and any other token in an answer is blanked out.
 */
function keptAnswer(status: number, result: unknown, response: string): { status: number; response: string } {
  if (typeof (result as { token?: unknown } | null)?.token === 'string') return { status: 409, response: ALREADY_CREATED };
  return { status, response: response.replace(TOKEN_TEXT, 'mt_hidden') };
}

interface Req {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  ctx: Ctx;
  raw: http.IncomingMessage;
}
type Handler = (req: Req) => unknown | Promise<unknown>;
interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
  /** Routes only you (the browser UI) can call. Tokens get 403. */
  userOnly: boolean;
}

function parseBody<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw new AppError(422, 'validation', r.error.issues[0]?.message ?? 'Invalid input', {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
};

export const serverPidFile = (config: Config) => path.join(config.dataDir, 'server.pid');

/** The pid of a live server process using this data directory, if any. */
export function runningServerPid(config: Config): number | null {
  try {
    const { pid } = JSON.parse(fs.readFileSync(serverPidFile(config), 'utf8'));
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

export interface App {
  server: http.Server;
  service: Service;
  config: Config;
  listen(): Promise<number>;
  close(): Promise<void>;
  backupNow(reason: string): string;
}

/** What a new thread on a task starts with: the /master-tasker command, the task id, and where to start. */
export function claudePrompt(taskId: string, subtask?: string, continueFrom?: string): string {
  return continueFrom
    ? `/master-tasker ${taskId} The last thread on this ("${continueFrom.replace(/"/g, "'").slice(0, 80)}") stopped. Read the ticket again, then keep going with the next open subtask that isn't flagged for me, in the ticket's current order.`
    : `/master-tasker ${taskId}${subtask ? ` Start with the subtask: "${subtask.replace(/"/g, "'")}"` : ''}`;
}

/**
 * claude://code/new opens a new Code thread in the desktop app, in that folder, with the message filled in.
 * q and folder are the parameters Claude documents for it ("Open Claude Desktop with a link", support.claude.com).
 * Claude asks you to confirm a folder that comes from a link, and never sends the message for you.
 */
export function claudeLink(taskId: string, subtask: string | undefined, folder: string, continueFrom?: string): string {
  return `claude://code/new?q=${encodeURIComponent(claudePrompt(taskId, subtask, continueFrom))}&folder=${encodeURIComponent(folder)}`;
}

const WORKSPACE_README = `# Master Tasker's folder for Claude threads

This folder is only for Claude threads. Work on this with Claude starts new Claude threads in this folder, so Claude doesn't get your whole home folder. Other AI assistants don't use it.

It can stay empty. If Claude makes files while it works on a task, they may land here, and you can delete them.
Leave the folder itself: Master Tasker makes it again if it's gone.
`;

/** Where new Claude threads on a task start: <data folder>/workspace, made when first needed, with a short README. */
export function claudeWorkspace(dataDir: string): string {
  const dir = path.join(dataDir, 'workspace');
  fs.mkdirSync(dir, { recursive: true });
  const readme = path.join(dir, 'README.md');
  if (!fs.existsSync(readme)) fs.writeFileSync(readme, WORKSPACE_README, { mode: 0o644 });
  return dir;
}

export function createApp(config: Config): App {
  let db: DB = openDatabase(config.dbPath, { backupDir: config.backupDir });
  const service = createService(db);
  const claudeApp = createClaudeApp(config.claudeAppDir);
  const sources = createSources({ stateFile: config.sourcesFile });
  // Where new threads on a task open when no earlier thread on it says where: a folder of their own, not your home folder.
  const workspace = () => claudeWorkspace(config.dataDir);
  // Which tickets a routine is tied to: task ids in its instructions or its saved state, and tasks whose notes name it.
  const ticketsFor = (r: ScheduledRoutine): string[] => {
    const ids = new Set(r.prompt.match(/\bt_[A-Za-z0-9_-]{8,}\b/g) ?? []);
    try {
      const st = fs.readFileSync(path.join(path.dirname(r.file), 'state.json'), 'utf8');
      for (const m of st.match(/\bt_[A-Za-z0-9_-]{8,}\b/g) ?? []) ids.add(m);
    } catch {}
    const named = service.db().prepare("SELECT id FROM tasks WHERE deleted_at IS NULL AND instr(notes, ?) > 0").all(r.id) as { id: string }[];
    for (const n of named) ids.add(n.id);
    const exists = service.db().prepare('SELECT 1 FROM tasks WHERE id = ? AND deleted_at IS NULL');
    return [...ids].filter((id) => exists.get(id));
  };
  // "Done: <subtask>" ticks off a subtask Claude finished. "Needs you: <what>" flags a subtask, or the task, for you.
  // Only on tasks the thread is linked to. Never ticks off something flagged for you, and Pause all automation stops it.
  const applyMarkers = (thread: { sessionId: string; title: string }, markers: ThreadMarker[]) => {
    if (service.getSettings().automationPaused) return;
    const ctx: Ctx = { actor: { kind: 'system', id: `claude-thread:${thread.sessionId}`, label: `Claude (${thread.title.slice(0, 40)})` }, client: null };
    const taskIds = threads.linkedOpenTasks(thread.sessionId);
    for (const m of markers) {
      try {
        // "Needs you: <the ask> | <why>": the part after the bar is the context you see under it.
        const [said, ...why] = m.kind === 'needs-you' ? m.text.split(' | ') : [m.text];
        const detail = why.join(' | ').trim() || undefined;
        let applied = false;
        for (const id of taskIds) {
          const task = service.getTask(ctx, id);
          const open = task.subtasks.filter((s) => !s.done && (m.kind === 'needs-you' || !s.needsYou));
          const hit = matchSubtask(said, open);
          if (!hit) continue;
          if (m.kind === 'done') service.updateSubtask(ctx, id, hit, { done: true });
          else service.flagForYou(ctx, id, { subtask: hit, detail, sessionId: thread.sessionId });
          applied = true;
          break;
        }
        // "Needs you" that isn't a subtask goes on the task, when it's clear which one.
        if (!applied && m.kind === 'needs-you') {
          const named = taskIds.find((id) => said.includes(id));
          const id = named ?? (taskIds.length === 1 ? taskIds[0] : null);
          const text = said.replace(/\bt_[A-Za-z0-9]{14}\b:?\s*/g, '').trim().slice(0, 500);
          if (id && text) service.flagForYou(ctx, id, { text, detail, sessionId: thread.sessionId });
        }
      } catch (err) {
        log.warn('thread marker not applied', { err: String(err), kind: m.kind });
      }
    }
  };
  const threads = createThreadIndex(() => service.db(), config.claudeProjectsDir, { onMarkers: applyMarkers });
  // Reading ~/.claude/projects only happens once you turn on thread linking (Settings > AI assistants).
  const syncThreads = (o: { maxAgeMs?: number } = {}) => (service.getSettings().threadLinking ? threads.sync(o) : Promise.resolve());
  // Catch up on Claude threads in the background, so the first task you open doesn't wait.
  const threadTimer = setTimeout(() => syncThreads({ maxAgeMs: 0 }).catch((err) => log.error('thread sync failed', { err: String(err) })), 3000);
  threadTimer.unref();
  let listeningPort = config.port;
  const integrations = createIntegrations({
    config,
    service,
    port: () => listeningPort,
    onChange: () => service.events.emit('event', { type: 'integrations', seq: service.currentSeq() } satisfies LiveEvent),
  });
  if (config.seedSamples && service.seedIfEmpty()) log.info('seeded labeled sample data');
  // MT_FIRST_RUN=0 skips the setup screen and keeps the sample data, for tests and the demo.
  if (!config.firstRun && !service.getSettings().setupDone) service.completeSetup(systemCtx('setup'), {});

  const startedAt = Date.now();
  const pidFile = serverPidFile(config);
  const sseClients = new Set<http.ServerResponse>();
  let lastBackupAt: string | null = listBackups(config.backupDir)[0]?.createdAt ?? null;

  function backupNow(reason: string): string {
    const file = backupDatabase(service.db(), config.backupDir, reason);
    lastBackupAt = new Date().toISOString();
    pruneBackups(config.backupDir, config.backupKeep);
    log.info('backup written', { file, reason });
    return file;
  }

  // Automatic backups. Checked every 10 minutes so a Mac waking from sleep catches up promptly.
  const lastAuto = () => listBackups(config.backupDir).find((b) => b.reason.startsWith('auto'))?.createdAt;
  const maybeAutoBackup = () => {
    try {
      const last = lastAuto();
      if (!last || Date.now() - Date.parse(last) > config.backupIntervalHours * 3600_000) backupNow('auto');
    } catch (err) {
      log.error('automatic backup failed', { err: String(err) });
    }
  };
  maybeAutoBackup();
  const backupTimer = setInterval(maybeAutoBackup, 10 * 60_000);
  backupTimer.unref();

  // Old idempotency records are only useful for retries.
  const pruneIdem = () => service.db().prepare('DELETE FROM idempotency WHERE created_at < ?').run(new Date(Date.now() - IDEMPOTENCY_TTL_MS).toISOString());
  pruneIdem();
  // Answers kept before tokens were left out of them, and any in a restored backup.
  const scrubIdem = () => {
    const rows = service.db().prepare("SELECT actor_id, key, status, response FROM idempotency WHERE instr(response, 'mt_') > 0").all() as { actor_id: string; key: string; status: number; response: string }[];
    const update = service.db().prepare('UPDATE idempotency SET status = ?, response = ? WHERE actor_id = ? AND key = ?');
    for (const r of rows) {
      let result: unknown = null;
      try {
        result = JSON.parse(r.response);
      } catch {}
      const kept = keptAnswer(r.status, result, r.response);
      if (kept.response !== r.response) update.run(kept.status, kept.response, r.actor_id, r.key);
    }
  };
  scrubIdem();
  const idemTimer = setInterval(pruneIdem, 6 * 3600_000);
  idemTimer.unref();

  // ─── Live events ───
  const broadcast = (e: LiveEvent) => {
    const payload = `id: ${e.seq}\nevent: change\ndata: ${JSON.stringify(e)}\n\n`;
    for (const res of sseClients) res.write(payload);
  };
  service.events.on('event', broadcast);
  const heartbeat = setInterval(() => {
    const payload = `event: ping\ndata: ${JSON.stringify({ seq: service.currentSeq(), t: new Date().toISOString() })}\n\n`;
    for (const res of sseClients) res.write(payload);
  }, 15_000);
  heartbeat.unref();

  // ─── Routes ───
  const routes: Route[] = [];
  const route = (method: string, pathPattern: string, handler: Handler, opts: { userOnly?: boolean } = {}) => {
    const keys: string[] = [];
    const pattern = new RegExp(
      `^${pathPattern.replace(/:([a-zA-Z]+)/g, (_, k) => {
        keys.push(k);
        return '([^/]+)';
      })}$`,
    );
    routes.push({ method, pattern, keys, handler, userOnly: opts.userOnly ?? false });
  };
  const user = { userOnly: true };

  /** A Mac notification when an assistant finishes a task. Text goes in as arguments, never into the script. */
  function notifyFinished(task: Task) {
    if (!config.notifyBin || !service.getSettings().macNotify) return;
    const script = 'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv) subtitle (item 3 of argv)\nend run';
    const why = task.finishedBy?.why ? task.finishedBy.why.slice(0, 160) : 'Open For you to look it over.';
    const who = task.finishedBy?.by?.trim() || 'Your assistant';
    const title = `${who.slice(0, 60)} finished a task${task.finishedBy?.sessionId ? ' · thread ready to archive' : ''}`;
    // `--` ends osascript's options, so text that starts with a dash stays text.
    execFile(config.notifyBin, ['-e', script, '--', title, why, task.title.slice(0, 120)], { timeout: 10_000 }, (err) => {
      if (err) log.warn('notification failed', { err: err.message });
    });
  }

  // Daily review status, read from the files automation/review.ts writes. The app never runs the review itself.
  route('GET', '/api/review/status', () => {
    const dir = path.join(config.dataDir, 'review');
    const read = (f: string) => {
      try {
        return fs.readFileSync(path.join(dir, f), 'utf8');
      } catch {
        return null;
      }
    };
    const log = (read('log.jsonl') ?? '').trim().split('\n').filter(Boolean);
    let lastRun: { at: string; summary?: string } | null = null;
    try {
      lastRun = log.length ? JSON.parse(log[log.length - 1]) : null;
    } catch {}
    let current: { startedAt: string } | null = null;
    try {
      current = JSON.parse(read('current.json') ?? 'null');
    } catch {}
    const stale = current ? Date.now() - Date.parse(current.startedAt) > 2 * 3600_000 : false;
    return {
      configured: read('token') !== null,
      lastRun,
      running: current && !stale ? current : null,
      unfinished: current && stale ? current : null,
    };
  }, user);

  route('GET', '/api/health', () => ({
    ok: true,
    version: VERSION,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    schemaVersion: schemaVersion(service.db()),
    seq: service.currentSeq(),
    liveConnections: sseClients.size,
    lastBackupAt,
    db: (service.db().prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check,
  }));
  const healthRoute = routes[routes.length - 1]; // the route registered just above

  route('GET', '/api/whoami', ({ ctx }) => ({
    actor: ctx.actor,
    // What the person wants assistants to call them. Empty: say "you".
    ownerName: service.getSettings().ownerName,
    scopes: ctx.client?.scopes ?? { areas: '*', unfiled: true, perms: ['read', 'create', 'update', 'complete', 'propose', 'start'] },
    limits: ctx.client?.limits ?? null,
    paused: ctx.client ? ctx.client.paused || service.getSettings().automationPaused : false,
  }));

  route('GET', '/api/sync', ({ ctx, query }) => {
    const since = query.get('since');
    return service.sync(ctx, since === null || since === '' ? null : Number(since));
  }, user);

  route('GET', '/api/tasks', ({ ctx, query }) => {
    const statuses = query.getAll('status');
    const parsed = parseBody(zTaskQuery, {
      q: query.get('q') ?? undefined,
      status: statuses.length > 1 ? statuses : statuses[0],
      areaId: query.get('areaId') ?? undefined,
      projectId: query.get('projectId') ?? undefined,
      includeDone: query.get('includeDone') === 'true' ? true : undefined,
      limit: query.get('limit') ? Number(query.get('limit')) : undefined,
    });
    if (parsed.status) [parsed.status].flat().forEach((s) => zStatus.parse(s));
    return service.listTasks(ctx, parsed);
  });
  route('POST', '/api/tasks', ({ ctx, body }) => service.createTask(ctx, body));
  route('GET', '/api/tasks/:id', ({ ctx, params }) => ({ task: service.getTask(ctx, params.id) }));
  // Claude Code threads that mention this task. Thread titles and folders stay with you, not with connections.
  route('GET', '/api/tasks/:id/threads', async ({ ctx, params, query }) => {
    service.getTask(ctx, params.id);
    await syncThreads({ maxAgeMs: query.get('refresh') === '1' ? 0 : 10_000 });
    return { threads: threads.forTask(params.id) };
  }, user);
  // For the /master-tasker skill: earlier threads on this ticket and the end of the latest one, so a new
  // thread starts with the full story. Only Claude connections (and you), and only threads linked to this ticket.
  route('GET', '/api/tasks/:id/history', async ({ ctx, params, query }) => {
    if (ctx.actor.kind !== 'user' && ctx.client?.kind !== 'claude') throw new AppError(403, 'forbidden', 'Only Claude connections can read thread history');
    service.getTask(ctx, params.id);
    await syncThreads({ maxAgeMs: 0 });
    const skip = query.get('except') ?? '';
    const list = threads.forTask(params.id).filter((t) => t.sessionId !== skip);
    // How each earlier thread ended, newest first, sharing one budget so the newest gets the most room.
    const conversations = [];
    let left = 20_000;
    for (const t of list) {
      if (left < 1500) break;
      const d = await threads.digest(params.id, t.sessionId, left);
      if (!d?.messages.length) continue;
      conversations.push(d);
      left -= d.messages.reduce((n, m) => n + m.text.length, 0);
    }
    return {
      threads: list.map((t) => ({ title: t.title, folder: t.cwd, startedAt: t.startedAt, lastActiveAt: t.lastActiveAt, resume: t.resumeCommand })),
      latest: conversations[0] ?? null,
      conversations,
    };
  });
  // What Claude is doing on each In progress task. Polled by the UI while something is in progress.
  route('GET', '/api/progress', async () => {
    await syncThreads({ maxAgeMs: 5000 });
    return { progress: threads.progress() };
  }, user);
  route('POST', '/api/tasks/:id/threads/:sessionId/unlink', ({ ctx, params }) => {
    service.getTask(ctx, params.id);
    if (!threads.hide(params.id, params.sessionId)) throw new AppError(404, 'not_found', 'That thread is not linked to this task');
    return { threads: threads.forTask(params.id) };
  }, user);
  route('PATCH', '/api/tasks/:id', ({ ctx, params, body }) => {
    const { baseRev, patch } = parseBody(zTaskUpdate, body);
    const wasOpen = ctx.client && patch.status === 'done' ? service.getTask(ctx, params.id).status !== 'done' : false;
    const task = service.updateTask(ctx, params.id, baseRev, patch);
    if (wasOpen && task.finishedBy) notifyFinished(task);
    return { task };
  });
  route('POST', '/api/tasks/:id/start', ({ ctx, params }) => ({ task: service.startTask(ctx, params.id) }));
  route('POST', '/api/tasks/:id/stop', ({ ctx, params }) => ({ task: service.stopTask(ctx, params.id) }));
  route('POST', '/api/tasks/:id/complete', ({ ctx, params, body }) => {
    const before = service.getTask(ctx, params.id);
    const task = service.completeTask(ctx, params.id, parseBody(zComplete, body ?? {}));
    if (ctx.client && before.status !== 'done' && task.finishedBy) notifyFinished(task);
    return { task };
  });
  route('POST', '/api/tasks/:id/finished/seen', ({ ctx, params }) => ({ task: service.seenFinished(ctx, params.id) }), user);
  route('POST', '/api/tasks/:id/reopen', ({ ctx, params }) => ({ task: service.reopenTask(ctx, params.id) }));
  route('POST', '/api/tasks/:id/notes', ({ ctx, params, body }) => ({ task: service.appendNote(ctx, params.id, parseBody(zNoteAppend, body).text) }));
  route('POST', '/api/tasks/:id/subtasks', ({ ctx, params, body }) => ({ task: service.addSubtask(ctx, params.id, parseBody(zSubtaskCreate, body).title) }));
  route('POST', '/api/tasks/:id/needs-you', ({ ctx, params, body }) => ({ task: service.flagForYou(ctx, params.id, parseBody(zYouFlag, body)) }));
  // A link that opens a new Claude Code thread on this task (or one subtask), already running the skill.
  route('GET', '/api/tasks/:id/claude-link', ({ ctx, params, query }) => {
    const task = service.getTask(ctx, params.id);
    const sub = query.get('subtask') ? task.subtasks.find((s) => s.id === query.get('subtask')) : undefined;
    if (query.get('subtask') && !sub) throw new AppError(404, 'not_found', 'Subtask not found');
    // Where its last thread ran, unless that was your home folder, which earlier versions used.
    const last = service.threadForItem(task.id, 'task');
    const folder = last?.cwd && fs.existsSync(last.cwd) && path.resolve(last.cwd) !== os.homedir() ? last.cwd : workspace();
    // ?continue=1: a new thread that picks up where the ticket's last thread stopped.
    const from = query.get('continue') ? threads.forTask(task.id)[0]?.title || 'the last thread' : undefined;
    // prompt: the same message, to paste into Claude Code in Terminal when there's no Claude app.
    return { url: claudeLink(task.id, sub?.title, folder, from), folder, prompt: claudePrompt(task.id, sub?.title, from) };
  }, user);
  // Opens an existing thread in the Claude app, when the app knows it.
  route('GET', '/api/claude/open', ({ query }) => {
    const id = claudeApp.appSessionId(query.get('session') ?? '');
    return { url: id ? appThreadLink(id) : null };
  }, user);

  // Sources: every scheduled routine, what it reads and your switches.
  route('GET', '/api/sources', ({ ctx }) => {
    // Repeating routines first, then one-offs, soonest first.
    const order = (r: ScheduledRoutine) => (r.cron ? 0 : r.fireAt ?? Infinity);
    const routines = claudeApp.routines().sort((a, b) => order(a) - order(b)).map((r) => {
      const info = sources.describe(r, ticketsFor);
      const run = claudeApp.lastRun(r.id);
      const tickets = info.ticketIds.flatMap((id) => {
        try {
          const t = service.getTask(ctx, id);
          return [{ id: t.id, title: t.title, status: t.status }];
        } catch {
          return [];
        }
      });
      return { ...info, tickets, lastRunLink: run ? appThreadLink(run) : null };
    });
    return { routines };
  }, user);
  route('PATCH', '/api/sources/:id', ({ params, body }) => {
    const change = parseBody(zRoutinePatch, body);
    const r = claudeApp.routines().find((x) => x.id === params.id);
    if (!r) throw new AppError(404, 'not_found', 'Routine not found');
    try {
      sources.set(r, change);
    } catch (err) {
      throw new AppError(400, 'bad_request', (err as Error).message);
    }
    const again = claudeApp.routines().find((x) => x.id === params.id) ?? r;
    return { routine: sources.describe(again, ticketsFor) };
  }, user);
  // "Add a source": you describe it in plain words, and a new Claude thread sets it up with you.
  route('POST', '/api/sources/request', ({ ctx, body }) => {
    const { text } = parseBody(zSourceRequest, body);
    const { task } = service.createTask(ctx, {
      title: `Add a source: ${text.length > 60 ? `${text.slice(0, 57)}...` : text}`,
      notes: `You want a scheduled routine to read a new source.\n\nWhat you said: ${text}\n\nWork out which routine (or a new one), what it should read and how. Ask before connecting any account or changing a routine's instructions.`,
      status: 'today',
    });
    return { task, url: claudeLink(task.id, undefined, REPO), prompt: claudePrompt(task.id) };
  }, user);
  route('GET', '/api/tasks/:id/asks', ({ ctx, params }) => ({ asks: service.listAsks(ctx, params.id) }), user);
  // You ask, Claude answers in the background (read-only), and the app picks the answer up.
  route('POST', '/api/tasks/:id/asks', ({ ctx, params, body }) => {
    const { item, question } = parseBody(zAskCreate, body);
    const task = service.getTask(ctx, params.id);
    if (item !== 'task' && !task.subtasks.some((s) => s.id === item)) throw new AppError(404, 'not_found', 'Subtask not found');
    // Check first, so nobody types a question that can't be answered.
    const claudeBin = integrations.claudeBin();
    if (!claudeBin) throw new AppError(409, 'conflict', 'Ask needs Claude Code on this Mac. Set it up in Settings, under AI assistants.', { needs: 'claude-code' });
    const thread = service.threadForItem(task.id, item);
    const ask = service.startAsk(ctx, task.id, item, question, thread?.sessionId ?? '');
    runAsk({ claudeBin, task, item, question, thread, name: service.getSettings().ownerName })
      .then((answer) => service.finishAsk(ask.id, 'done', answer))
      .catch((err) => service.finishAsk(ask.id, 'error', (err as Error).message))
      .catch((err) => log.warn('ask not saved', { err: String(err) }));
    return { ask };
  }, user);
  route('PUT', '/api/tasks/:id/subtasks/order', ({ ctx, params, body }) => ({ task: (({ ids, ordered }) => service.reorderSubtasks(ctx, params.id, ids, ordered))(parseBody(zSubtaskOrder, body)) }));
  route('PATCH', '/api/tasks/:id/subtasks/:sid', ({ ctx, params, body }) => ({ task: service.updateSubtask(ctx, params.id, params.sid, parseBody(zSubtaskPatch, body)) }));
  route('DELETE', '/api/tasks/:id/subtasks/:sid', ({ ctx, params }) => ({ task: service.deleteSubtask(ctx, params.id, params.sid) }));
  route('DELETE', '/api/tasks/:id', ({ ctx, params }) => ({ task: service.deleteTask(ctx, params.id) }), user);
  route('POST', '/api/tasks/:id/restore', ({ ctx, params }) => ({ task: service.restoreTask(ctx, params.id) }), user);
  route('GET', '/api/trash', ({ ctx }) => ({ tasks: service.listTrash(ctx) }), user);
  route('DELETE', '/api/trash/:id', ({ ctx, params }) => {
    service.purgeTask(ctx, params.id);
    return { ok: true };
  }, user);
  route('POST', '/api/samples/clear', ({ ctx }) => service.clearSamples(ctx), user);

  route('GET', '/api/areas', ({ ctx }) => ({ areas: service.listAreas(ctx), projects: service.listProjects(ctx) }));
  route('POST', '/api/areas', ({ ctx, body }) => ({ area: service.createArea(ctx, parseBody(zAreaCreate, body)) }), user);
  route('PATCH', '/api/areas/:id', ({ ctx, params, body }) => ({ area: service.updateArea(ctx, params.id, parseBody(zAreaPatch, body)) }), user);
  route('DELETE', '/api/areas/:id', ({ ctx, params, body }) => service.deleteArea(ctx, params.id, parseBody(zAreaDelete, body ?? {})), user);
  route('POST', '/api/projects', ({ ctx, body }) => ({ project: service.createProject(ctx, parseBody(zProjectCreate, body)) }), user);
  route('PATCH', '/api/projects/:id', ({ ctx, params, body }) => ({ project: service.updateProject(ctx, params.id, parseBody(zProjectPatch, body)) }), user);

  route('GET', '/api/proposals', ({ ctx, query }) => {
    const status = (query.get('status') ?? 'pending') as 'pending' | 'all';
    if (!['pending', 'accepted', 'rejected', 'duplicate', 'all'].includes(status)) throw new AppError(422, 'validation', 'Unknown status');
    return { proposals: service.listProposals(ctx, status, Number(query.get('limit') ?? 100)) };
  });
  route('POST', '/api/proposals', ({ ctx, body }) => service.createProposal(ctx, parseBody(zProposalEnvelope, body)));
  route('POST', '/api/proposals/:id/accept', ({ ctx, params }) => service.acceptProposal(ctx, params.id), user);
  // Accept all: every pending suggestion from one connection (or the ones you can see, by id). Questions need an answer, so they stay.
  route('POST', '/api/proposals/accept-all', ({ ctx, body }) => {
    const { clientId, ids } = parseBody(zAcceptAll, body);
    const want = ids ? new Set(ids) : null;
    const pending = service.listProposals(ctx, 'pending', 200).filter((p) => p.clientId === clientId && p.body.kind !== 'question' && (!want || want.has(p.id)));
    // Oldest first, so later suggestions apply on top of earlier ones.
    pending.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    let accepted = 0;
    const failed: { id: string; message: string }[] = [];
    for (const p of pending) {
      try {
        service.acceptProposal(ctx, p.id);
        accepted++;
      } catch (err) {
        failed.push({ id: p.id, message: err instanceof Error ? err.message : String(err) });
      }
    }
    return { accepted, failed };
  }, user);
  route('POST', '/api/proposals/:id/answer', ({ ctx, params, body }) => ({ proposal: service.answerProposal(ctx, params.id, parseBody(zProposalAnswer, body).answer) }), user);
  route('POST', '/api/proposals/:id/withdraw', ({ ctx, params, body }) => ({ proposal: service.withdrawProposal(ctx, params.id, typeof (body as any)?.why === 'string' ? (body as any).why : '') }));
  route('POST', '/api/proposals/:id/reject', ({ ctx, params }) => ({ proposal: service.rejectProposal(ctx, params.id) }), user);

  // A connection with a token file can show its settings again: they name the file, never the token.
  route('GET', '/api/clients', ({ ctx }) => ({
    clients: service.listClients(ctx).map((c) => {
      const tokenFile = c.revokedAt ? undefined : integrations.tokenFileFor(c.id);
      return tokenFile ? { ...c, tokenFile } : c;
    }),
  }), user);
  route('POST', '/api/clients', ({ ctx, body }) => {
    const made = service.createClient(ctx, body);
    if ((body as { tokenFile?: unknown }).tokenFile !== true) return made;
    // The app's Settings asks for a token file, so the settings it shows to paste name the file, not the token.
    try {
      return { ...made, client: { ...made.client, tokenFile: integrations.saveConnectionToken(made.client.id, made.token) } };
    } catch (err) {
      integrations.revokeConnection(ctx, made.client.id);
      throw err;
    }
  }, user);
  route('PATCH', '/api/clients/:id', ({ ctx, params, body }) => ({ client: service.updateClient(ctx, params.id, body) }), user);
  route('POST', '/api/clients/:id/revoke', ({ ctx, params }) => ({ client: integrations.revokeConnection(ctx, params.id) }), user);

  route('GET', '/api/settings', () => ({ settings: service.getSettings() }), user);
  // First-run setup: your name, starter areas and sample tasks. It only swaps the samples while nothing is yours yet.
  route('POST', '/api/setup', ({ ctx, body }) => service.completeSetup(ctx, parseBody(zSetup, body ?? {})), user);
  route('PATCH', '/api/settings', ({ ctx, body }) => {
    const patch = parseBody(zSettingsPatch, body);
    const settings = service.updateSettings(ctx, patch);
    // The next look at threads reads them: nothing has been read yet while it was off.
    // It's your choice now, so Remove from Claude Code leaves it as you set it.
    if (patch.threadLinking !== undefined) {
      integrations.forgetLinkingBySetup();
      integrations.invalidate();
    }
    return { settings };
  }, user);

  // ─── Claude setup, in Settings > AI assistants ───
  route('GET', '/api/integrations', ({ query }) => ({ integrations: integrations.detect(query.get('refresh') === '1') }), user);
  route('POST', '/api/integrations/claude-code', ({ ctx }) => integrations.setupClaudeCode(ctx), user);
  route('DELETE', '/api/integrations/claude-code', ({ ctx }) => integrations.removeClaudeCode(ctx), user);
  route('POST', '/api/integrations/claude-desktop', ({ ctx }) => integrations.addDesktop(ctx), user);
  route('DELETE', '/api/integrations/claude-desktop', ({ ctx }) => integrations.removeDesktop(ctx), user);

  route('GET', '/api/activity', ({ ctx, query }) => ({
    activity: service.listActivity(ctx, {
      entityId: query.get('entityId') ?? undefined,
      limit: query.get('limit') ? Number(query.get('limit')) : undefined,
      beforeId: query.get('beforeId') ? Number(query.get('beforeId')) : undefined,
    }),
  }), user);

  route('GET', '/api/export', ({ ctx }) => service.exportAll(ctx), user);
  route('POST', '/api/import', ({ ctx, body }) => {
    const file = backupNow('pre-import');
    return { ...service.importMerge(ctx, body as ExportFile), backup: path.basename(file) };
  }, user);

  route('GET', '/api/backups', () => ({
    backups: listBackups(config.backupDir).map(({ name, bytes, createdAt, reason }) => ({ name, bytes, createdAt, reason })),
    dir: config.backupDir,
  }), user);
  route('POST', '/api/backups', () => ({ name: path.basename(backupNow('manual')) }), user);
  route('POST', '/api/backups/restore', ({ ctx, body }) => {
    const name = (body as { name?: unknown })?.name;
    const match = listBackups(config.backupDir).find((b) => b.name === name);
    if (!match) throw new AppError(404, 'not_found', 'Backup not found');
    const check = verifyBackup(match.file);
    if (!check.ok) throw new AppError(422, 'validation', `Backup failed verification: ${check.problem}`);
    // Swap the database under the running server. Everything here is synchronous,
    // so no other request can run in the middle.
    service.db().close();
    let safetyBackup: string | null = null;
    try {
      safetyBackup = replaceDatabaseFile(config.dbPath, match.file, config.backupDir).safetyBackup;
    } finally {
      db = openDatabase(config.dbPath, { backupDir: config.backupDir });
      service.swapDb(db);
    }
    scrubIdem();
    log.info('database restored', { from: match.name, safetyBackup, by: ctx.actor.label });
    service.events.emit('event', { type: 'reset', seq: service.currentSeq() } satisfies LiveEvent);
    return { restored: match.name, tasks: check.tasks, safetyBackup: safetyBackup ? path.basename(safetyBackup) : null };
  }, user);

  // ─── Request handling ───
  const allowedHosts = new Set<string>();
  const allowedOrigins = new Set<string>();
  const allowPort = (port: number) => {
    for (const h of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
      allowedHosts.add(h);
      allowedOrigins.add(`http://${h}`);
    }
  };
  allowPort(config.port);
  if (config.dev) allowPort(5180); // Vite dev server proxy

  function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    const json = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
    res.end(json);
  }
  function sendError(res: http.ServerResponse, err: unknown) {
    if (err instanceof AppError) return send(res, err.status, { error: { code: err.code, message: err.message, ...err.extra } });
    log.error('unhandled error', { err: err instanceof Error ? err.stack : String(err) });
    send(res, 500, { error: { code: 'internal', message: 'Something went wrong on the server' } });
  }

  async function readBody(req: http.IncomingMessage): Promise<{ raw: string; json: unknown }> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) throw new AppError(413 as number, 'bad_request', 'Request body too large');
      chunks.push(chunk as Buffer);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw) return { raw, json: undefined };
    try {
      return { raw, json: JSON.parse(raw) };
    } catch {
      throw new AppError(400, 'bad_request', 'Body must be JSON');
    }
  }

  function identify(req: http.IncomingMessage, mutating: boolean): Ctx {
    const sid = req.headers['x-session-id'];
    const sessionId = typeof sid === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(sid) ? sid : null;
    return { ...identifyActor(req, mutating), sessionId };
  }

  function identifyActor(req: http.IncomingMessage, mutating: boolean): Ctx {
    const claimed = typeof req.headers['x-actor-name'] === 'string' ? req.headers['x-actor-name'] : null;
    const auth = req.headers.authorization;
    if (auth) {
      const m = /^Bearer (.+)$/.exec(auth);
      const client = m ? service.authenticate(m[1].trim()) : null;
      if (!client) throw new AppError(401, 'unauthorized', 'Invalid or revoked token');
      return clientCtx(client, claimed);
    }
    // No token: this must be the browser UI on this Mac.
    const site = req.headers['sec-fetch-site'];
    if (site === 'cross-site') throw new AppError(403, 'forbidden', 'Cross-site requests are not allowed');
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) throw new AppError(403, 'forbidden', 'Unknown origin');
    if (mutating && req.headers['x-master-tasker'] !== 'web') {
      throw new AppError(401, 'unauthorized', 'Use a connection token (Authorization: Bearer mt_...)');
    }
    return userCtx(claimed);
  }

  /** A path with a broken %-escape gets a 400 instead of an error. */
  function decodePath(p: string): string | null {
    try {
      return decodeURIComponent(p);
    } catch {
      return null;
    }
  }

  function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: { code: 'bad_request', message: 'Method not allowed' } });
    if (!fs.existsSync(config.distDir)) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Master Tasker UI is not built yet. Run: npm run build');
    }
    const decoded = decodePath(pathname);
    if (decoded === null) return send(res, 400, { error: { code: 'bad_request', message: 'Bad path' } });
    let file = path.normalize(path.join(config.distDir, decoded));
    if (!file.startsWith(config.distDir + path.sep) && file !== config.distDir) return send(res, 403, { error: { code: 'forbidden', message: 'Forbidden' } });
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(config.distDir, 'index.html');
    const ext = path.extname(file);
    const immutable = file.includes(`${path.sep}assets${path.sep}`);
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...(ext === '.html'
        ? { 'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" }
        : {}),
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  function openEvents(req: http.IncomingMessage, res: http.ServerResponse) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ seq: service.currentSeq(), t: new Date().toISOString() })}\n\n`);
    sseClients.add(res);
    req.socket.setKeepAlive(true);
    const drop = () => sseClients.delete(res);
    req.on('close', drop);
    res.on('error', drop);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const host = req.headers.host ?? '';
    // Blocks DNS-rebinding: a hostile page cannot reach us through a name that resolves to 127.0.0.1.
    if (!allowedHosts.has(host)) return send(res, 421, { error: { code: 'forbidden', message: 'Unexpected Host header' } });
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);

    const method = req.method ?? 'GET';
    const mutating = method !== 'GET' && method !== 'HEAD';
    try {
      // Health answers without identifying the caller, so the health check works with no headers.
      if (url.pathname === '/api/health') return send(res, 200, healthRoute.handler({} as Req));
      const ctx = identify(req, mutating);
      if (url.pathname === '/api/events' && method === 'GET') {
        if (ctx.client) throw new AppError(403, 'forbidden', 'Live events are for the app UI');
        return openEvents(req, res);
      }
      let matched: Route | undefined;
      let params: Record<string, string> = {};
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = r.pattern.exec(url.pathname);
        if (m) {
          matched = r;
          params = Object.fromEntries(
            r.keys.map((k, i) => {
              const v = decodePath(m[i + 1]);
              if (v === null) throw new AppError(400, 'bad_request', 'Bad path');
              return [k, v];
            }),
          );
          break;
        }
      }
      if (!matched) throw new AppError(404, 'not_found', 'No such endpoint');
      if (matched.userOnly && ctx.client) throw new AppError(403, 'forbidden', 'Only you can do this from the app');

      const { raw, json } = mutating ? await readBody(req) : { raw: '', json: undefined };

      // Idempotency: a retried request with the same key returns the original result instead of repeating the write.
      const key = req.headers['idempotency-key'];
      const idemKey = mutating && typeof key === 'string' && key.length > 0 ? key.slice(0, 200) : null;
      const db = service.db();
      const bodyHash = idemKey ? crypto.createHash('sha256').update(`${method} ${url.pathname}\n${raw}`).digest('hex') : '';
      if (idemKey) {
        const prior = db.prepare('SELECT * FROM idempotency WHERE actor_id = ? AND key = ?').get(ctx.actor.id, idemKey) as
          | { body_hash: string; status: number; response: string }
          | undefined;
        if (prior) {
          if (prior.body_hash !== bodyHash) throw new AppError(422, 'idempotency_mismatch', 'This Idempotency-Key was already used for a different request');
          res.writeHead(prior.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'idempotent-replay': 'true' });
          return res.end(prior.response);
        }
      }

      let status = 200;
      let result: unknown;
      try {
        result = await matched.handler({ method, path: url.pathname, params, query: url.searchParams, body: json, ctx, raw: req });
        if (method === 'POST' && (result as { task?: unknown; deduplicated?: boolean })?.deduplicated === false) status = 201;
      } catch (err) {
        // Remember deterministic failures too, so a retry gets the same answer. Never cache 5xx, 423 or 429.
        if (idemKey && err instanceof AppError && err.status < 500 && err.status !== 423 && err.status !== 429 && err.status !== 409) {
          const body = JSON.stringify({ error: { code: err.code, message: err.message, ...err.extra } });
          service.db().prepare('INSERT OR REPLACE INTO idempotency (actor_id, key, method, path, body_hash, status, response, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(ctx.actor.id, idemKey, method, url.pathname, bodyHash, err.status, body, new Date().toISOString());
        }
        throw err;
      }
      const response = JSON.stringify(result ?? { ok: true });
      if (idemKey) {
        const kept = keptAnswer(status, result, response);
        service.db().prepare('INSERT OR REPLACE INTO idempotency (actor_id, key, method, path, body_hash, status, response, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(ctx.actor.id, idemKey, method, url.pathname, bodyHash, kept.status, kept.response, new Date().toISOString());
      }
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(response);
    } catch (err) {
      sendError(res, err);
    }
  });
  server.keepAliveTimeout = 65_000;

  return {
    server,
    service,
    config,
    backupNow,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          const addr = server.address();
          const port = typeof addr === 'object' && addr ? addr.port : config.port;
          listeningPort = port;
          allowPort(port);
          // Lets the CLI know a server owns this database, even if it is hung.
          fs.writeFileSync(pidFile, JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString() }));
          resolve(port);
        });
      }),
    close: () =>
      new Promise((resolve) => {
        clearInterval(heartbeat);
        clearInterval(backupTimer);
        clearInterval(idemTimer);
        clearTimeout(threadTimer);
        for (const res of sseClients) res.end();
        sseClients.clear();
        server.close(() => {
          try {
            const owner = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
            if (owner.pid === process.pid) fs.rmSync(pidFile, { force: true });
          } catch {
            // no pid file
          }
          try {
            service.db().close();
          } catch {
            // already closed
          }
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
