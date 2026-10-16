// The one place that reads and writes task data. HTTP routes (used by both the UI and the
// MCP server) are thin wrappers around these functions, so validation, scope checks,
// revision checks and activity logging happen exactly once.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { StatementSync } from 'node:sqlite';
import { tx, type DB } from './db.ts';
import {
  LIMITS,
  STATUS_LABELS,
  PRIORITY_LABELS,
  TASK_ID_RE,
  zClientCreate,
  zClientPatch,
  zTaskCreate,
  zTaskPatchFields,
  zId,
  type Actor,
  type ActivityEntry,
  type Area,
  type AreaMode,
  type Ask,
  type YouContext,
  type YouFlag,
  type ClientInfo,
  type ClientKind,
  type ClientLimits,
  type ClientScopes,
  type LiveEvent,
  type Permission,
  type Project,
  type Proposal,
  type ProposalBody,
  type ProposalEnvelope,
  type Settings,
  type SetupInput,
  type StarterAreas,
  type Status,
  type Subtask,
  type SyncPayload,
  type Task,
  type TaskCreate,
  type TaskPatchFields,
  type TaskQuery,
} from '../shared/schema.ts';
import type { z } from 'zod';
import { readableTitle, resumeCommand } from './threads.ts';

// ─── Errors ───

export type ErrorCode =
  | 'bad_request'
  | 'validation'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'idempotency_mismatch'
  | 'id_taken'
  | 'paused'
  | 'rate_limited'
  | 'internal';

export class AppError extends Error {
  status: number;
  code: ErrorCode;
  extra: Record<string, unknown>;
  constructor(status: number, code: ErrorCode, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const notFound = (what: string) => new AppError(404, 'not_found', `${what} not found`);
const forbidden = (msg: string) => new AppError(403, 'forbidden', msg);

// ─── Identity ───

export interface ClientRecord {
  id: string;
  name: string;
  kind: ClientKind;
  scopes: ClientScopes;
  limits: ClientLimits;
  paused: boolean;
  revokedAt: string | null;
}

export interface Ctx {
  actor: Actor;
  client: ClientRecord | null;
  /** Per-tab / per-process id. Your own back-to-back edits never conflict with each other. */
  sessionId?: string | null;
}

export const userCtx = (claimedName?: string | null): Ctx => ({
  actor: { kind: 'user', id: 'local-ui', label: 'You', claimedName: claimedName ?? null },
  client: null,
});

export const systemCtx = (job: string): Ctx => ({
  actor: { kind: 'system', id: `system:${job}`, label: 'System' },
  client: null,
});

export function clientCtx(client: ClientRecord, claimedName?: string | null): Ctx {
  return {
    actor: {
      kind: 'client',
      id: client.id,
      // The connection's own name, e.g. "Cursor". Its kind stays in clientKind.
      label: client.name,
      clientKind: client.kind,
      claimedName: claimedName ? claimedName.slice(0, 80) : null,
    },
    client,
  };
}

export const DEFAULT_LIMITS: ClientLimits = { writesPerDay: 200, proposalsPerDay: 100 };

// ─── Helpers ───

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export function randomToken(len: number): string {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % 62];
  return out;
}
export const newId = (prefix: string) => `${prefix}_${randomToken(14)}`;
export const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export function localDay(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw new AppError(422, 'validation', r.error.issues[0]?.message ?? 'Invalid input', {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// The area palette, the same as web/src/areaColors.ts. New areas take them in turn.
const AREA_COLORS = ['#526AC3', '#8A57AE', '#AC5701', '#058379', '#867003', '#AB4A7D', '#3F842E', '#077CA4'];

// ─── Row shapes ───

interface TaskRow {
  id: string;
  title: string;
  notes: string;
  area_id: string | null;
  project_id: string | null;
  status: Status;
  prev_status: Status | null;
  started_from: Status | null;
  priority: Task['priority'];
  due_date: string | null;
  next_action: string;
  waiting_on: string;
  links: string;
  position: number;
  rev: number;
  seq: number;
  is_sample: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  deleted_at: string | null;
  created_by: string;
  created_by_id: string;
  external_key: string | null;
  needs_you: string;
  subtasks_ordered: number;
  finished_by: string | null;
}

const FIELD_TO_COLUMN: Record<keyof TaskPatchFields, keyof TaskRow> = {
  title: 'title',
  notes: 'notes',
  areaId: 'area_id',
  projectId: 'project_id',
  status: 'status',
  priority: 'priority',
  dueDate: 'due_date',
  nextAction: 'next_action',
  waitingOn: 'waiting_on',
  links: 'links',
  position: 'position',
  needsYou: 'needs_you',
};

const FIELD_LABELS: Record<string, string> = {
  title: 'title',
  notes: 'notes',
  areaId: 'area',
  projectId: 'project',
  status: 'status',
  priority: 'priority',
  dueDate: 'due date',
  nextAction: 'next action',
  waitingOn: 'waiting on',
  links: 'links',
  position: 'order',
  needsYou: 'needs you',
  subtasks: 'subtasks',
};

/** Fields where a concurrent change is not a conflict (ordering is last-writer-wins, nothing is lost). */
const NON_CONFLICTING = new Set(['position']);

export interface Service {
  readonly events: EventEmitter;
  db(): DB;
  swapDb(next: DB): void;
  authenticate(token: string): ClientRecord | null;

  sync(ctx: Ctx, since: number | null): SyncPayload;
  currentSeq(): number;
  listTasks(ctx: Ctx, query: TaskQuery): { tasks: Task[]; total: number; truncated: boolean };
  getTask(ctx: Ctx, id: string): Task;
  createTask(ctx: Ctx, input: unknown, opts?: { isSample?: boolean; externalKey?: string | null; viaProposal?: string }): { task: Task; deduplicated: boolean };
  updateTask(ctx: Ctx, id: string, baseRev: number, patch: unknown): Task;
  completeTask(ctx: Ctx, id: string, proof?: { why?: string; link?: string; sessionId?: string }): Task;
  /** You've seen that an assistant finished it. */
  seenFinished(ctx: Ctx, id: string): Task;
  reopenTask(ctx: Ctx, id: string): Task;
  startTask(ctx: Ctx, id: string): Task;
  stopTask(ctx: Ctx, id: string): Task;
  appendNote(ctx: Ctx, id: string, text: string, label?: string): Task;
  addSubtask(ctx: Ctx, taskId: string, title: string): Task;
  updateSubtask(ctx: Ctx, taskId: string, subtaskId: string, patch: { title?: string; done?: boolean; needsYou?: boolean }): Task;
  deleteSubtask(ctx: Ctx, taskId: string, subtaskId: string): Task;
  reorderSubtasks(ctx: Ctx, taskId: string, ids: string[] | undefined, ordered?: boolean): Task;
  /** Flags a subtask or the task for you, with the why and the thread that raised it. */
  flagForYou(ctx: Ctx, taskId: string, flag: YouFlag): Task;
  listAsks(ctx: Ctx, taskId: string): Ask[];
  /** Records your question. The caller runs Claude and calls finishAsk. */
  startAsk(ctx: Ctx, taskId: string, item: string, question: string, sessionId: string): Ask;
  finishAsk(id: string, status: 'done' | 'error', answer: string): void;
  /** The thread to ask about an item: the one that raised it, else the task's latest linked thread. */
  threadForItem(taskId: string, item: string): { sessionId: string; cwd: string } | null;
  deleteTask(ctx: Ctx, id: string): Task;
  restoreTask(ctx: Ctx, id: string): Task;
  purgeTask(ctx: Ctx, id: string): void;
  listTrash(ctx: Ctx): Task[];
  clearSamples(ctx: Ctx): { tasks: number; ids: string[] };

  listAreas(ctx: Ctx): Area[];
  createArea(ctx: Ctx, input: { name: string; color?: string; mode?: AreaMode }): Area;
  updateArea(ctx: Ctx, id: string, patch: { name?: string; color?: string; position?: number; archived?: boolean; mode?: AreaMode }): Area;
  deleteArea(ctx: Ctx, id: string, input: { moveTo?: string | null }): { moved: number };
  listProjects(ctx: Ctx): Project[];
  createProject(ctx: Ctx, input: { areaId: string; name: string }): Project;
  updateProject(ctx: Ctx, id: string, patch: { name?: string; areaId?: string; position?: number; archived?: boolean }): Project;

  createProposal(ctx: Ctx, env: ProposalEnvelope): { proposal: Proposal; deduplicated: boolean; suppressed: boolean };
  listProposals(ctx: Ctx, status?: Proposal['status'] | 'all', limit?: number): Proposal[];
  acceptProposal(ctx: Ctx, id: string): { proposal: Proposal; task: Task | null };
  answerProposal(ctx: Ctx, id: string, answer: string): Proposal;
  rejectProposal(ctx: Ctx, id: string): Proposal;
  withdrawProposal(ctx: Ctx, id: string, why: string): Proposal;

  listClients(ctx: Ctx): ClientInfo[];
  createClient(ctx: Ctx, input: unknown): { client: ClientInfo; token: string };
  updateClient(ctx: Ctx, id: string, patch: unknown): ClientInfo;
  revokeClient(ctx: Ctx, id: string): ClientInfo;

  getSettings(): Settings;
  updateSettings(ctx: Ctx, patch: Partial<Settings>): Settings;
  listActivity(ctx: Ctx, opts: { entityId?: string; limit?: number; beforeId?: number }): ActivityEntry[];

  /**
   * First-run setup: saves your name and marks setup done. With `areas` and `samples` it also swaps the sample
   * areas and tasks for the ones you picked, but only while the database holds nothing but what the seed made.
   */
  completeSetup(ctx: Ctx, input: SetupInput): { settings: Settings; reshaped: boolean };
  seedIfEmpty(): boolean;
  exportAll(ctx: Ctx): ExportFile;
  importMerge(ctx: Ctx, data: ExportFile): { areas: number; projects: number; tasks: number; skipped: number };
}

export interface ExportFile {
  format: 'master-tasker-export';
  version: 1;
  exportedAt: string;
  areas: Area[];
  projects: Project[];
  tasks: Task[];
}

export function createService(initialDb: DB, opts: { now?: () => Date } = {}): Service {
  let db = initialDb;
  const now = opts.now ?? (() => new Date());
  const iso = () => now().toISOString();
  const events = new EventEmitter();
  events.setMaxListeners(200);
  let stmts = new Map<string, StatementSync>();
  const q = (sql: string) => {
    let s = stmts.get(sql);
    if (!s) {
      s = db.prepare(sql);
      stmts.set(sql, s);
    }
    return s;
  };

  // Events are emitted after commit, so listeners never see rolled-back state.
  let outbox: LiveEvent[] = [];
  const emit = (e: LiveEvent) => {
    if (db.isTransaction) outbox.push(e);
    else events.emit('event', e);
  };
  const write = <T>(fn: () => T): T => {
    const before = outbox.length;
    try {
      const out = tx(db, fn);
      if (!db.isTransaction) {
        const pending = outbox;
        outbox = [];
        for (const e of pending) events.emit('event', e);
      }
      return out;
    } catch (err) {
      outbox = outbox.slice(0, before);
      throw err;
    }
  };

  const nextSeq = (): number => (q("UPDATE counters SET value = value + 1 WHERE name = 'seq' RETURNING value").get() as { value: number }).value;
  const currentSeq = (): number => (q("SELECT value FROM counters WHERE name = 'seq'").get() as { value: number }).value;

  // ─── Settings ───
  function getSettings(): Settings {
    const get = (key: string) => (q('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
    // Thread linking reads ~/.claude/projects, so it stays off until you turn it on (migration 10 kept it on for existing installs).
    // Setup is done once you finish or skip it (migration 13 marked installs already in use).
    return {
      automationPaused: get('automationPaused') === 'true',
      macNotify: get('macNotify') !== 'false',
      threadLinking: get('threadLinking') === 'true',
      setupDone: get('setupDone') === 'true',
      ownerName: get('ownerName') ?? '',
      startedWithSamples: get('startedWithSamples') !== 'false',
    };
  }
  const putSetting = (key: string, value: string) => q('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);

  // ─── Activity ───
  function logActivity(
    ctx: Ctx,
    entry: { entityType: ActivityEntry['entityType']; entityId: string; action: string; changes?: Record<string, [unknown, unknown]> | null; rev?: number | null; summary: string; countsAsWrite?: boolean },
  ) {
    const at = iso();
    q(
      `INSERT INTO activity (at, day, actor_kind, actor_id, actor_label, client_kind, claimed_name, session_id, entity_type, entity_id, action, changes, rev, summary, counts_as_write)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      at,
      localDay(now()),
      ctx.actor.kind,
      ctx.actor.id,
      ctx.actor.label,
      ctx.actor.clientKind ?? null,
      ctx.actor.claimedName ?? null,
      ctx.sessionId ?? null,
      entry.entityType,
      entry.entityId,
      entry.action,
      entry.changes ? JSON.stringify(entry.changes) : null,
      entry.rev ?? null,
      entry.summary,
      entry.countsAsWrite === false ? 0 : 1,
    );
  }

  // ─── Permissions and scope ───
  function requirePerm(ctx: Ctx, perm: Permission) {
    if (!ctx.client) return;
    if (!ctx.client.scopes.perms.includes(perm)) throw forbidden(`This connection does not have "${perm}" permission`);
  }
  function requireUser(ctx: Ctx) {
    if (ctx.actor.kind !== 'user' && ctx.actor.kind !== 'system') throw forbidden('Only you can do this from the app');
  }
  function canSeeArea(ctx: Ctx, areaId: string | null): boolean {
    if (!ctx.client) return true;
    const s = ctx.client.scopes;
    if (areaId === null) return s.unfiled;
    return s.areas === '*' || s.areas.includes(areaId);
  }
  function requireArea(ctx: Ctx, areaId: string | null) {
    if (!canSeeArea(ctx, areaId)) {
      throw forbidden(areaId === null ? 'This connection cannot access unfiled Inbox items' : 'This connection is not allowed in that area');
    }
  }
  function usageToday(clientId: string) {
    const day = localDay(now());
    const writes = (q('SELECT count(*) AS n FROM activity WHERE actor_id = ? AND day = ? AND counts_as_write = 1').get(clientId, day) as { n: number }).n;
    const proposals = (q('SELECT count(*) AS n FROM proposals WHERE client_id = ? AND day = ?').get(clientId, day) as { n: number }).n;
    return { writes, proposals };
  }
  function checkAutomationAllowed(ctx: Ctx, kind: 'write' | 'proposal') {
    if (!ctx.client) return;
    if (getSettings().automationPaused) throw new AppError(423, 'paused', 'Automation is paused in Master Tasker settings');
    if (ctx.client.paused) throw new AppError(423, 'paused', 'This connection is paused in Master Tasker settings');
    const usage = usageToday(ctx.client.id);
    if (kind === 'write' && usage.writes >= ctx.client.limits.writesPerDay) {
      throw new AppError(429, 'rate_limited', `Daily write limit reached (${ctx.client.limits.writesPerDay})`);
    }
    if (kind === 'proposal' && usage.proposals >= ctx.client.limits.proposalsPerDay) {
      throw new AppError(429, 'rate_limited', `Daily proposal limit reached (${ctx.client.limits.proposalsPerDay})`);
    }
  }

  // ─── Mapping ───
  function subtasksFor(ids: string[]): Map<string, Subtask[]> {
    const map = new Map<string, Subtask[]>();
    if (ids.length === 0) return map;
    const rows: { id: string; task_id: string; title: string; done: number; position: number; needs_you: number }[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const placeholders = chunk.map(() => '?').join(',');
      rows.push(
        ...(db.prepare(`SELECT id, task_id, title, done, position, needs_you FROM subtasks WHERE task_id IN (${placeholders}) ORDER BY position`).all(...chunk) as typeof rows),
      );
    }
    for (const r of rows) {
      const list = map.get(r.task_id) ?? [];
      list.push({ id: r.id, title: r.title, done: r.done === 1, position: r.position, needsYou: r.needs_you === 1 });
      map.set(r.task_id, list);
    }
    return map;
  }
  function contextFor(ids: string[]): Map<string, Record<string, YouContext>> {
    const map = new Map<string, Record<string, YouContext>>();
    if (ids.length === 0) return map;
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = db
        .prepare(
          `SELECT y.task_id, y.item, y.detail, y.session_id, y.at, c.title, c.custom_title, c.cwd FROM you_context y
           LEFT JOIN claude_threads c ON c.session_id = y.session_id WHERE y.task_id IN (${chunk.map(() => '?').join(',')})`,
        )
        .all(...chunk) as { task_id: string; item: string; detail: string; session_id: string; at: string; title: string | null; custom_title: number | null; cwd: string | null }[];
      for (const r of rows) {
        const rec = map.get(r.task_id) ?? {};
        const known = r.title !== null;
        rec[r.item] = {
          detail: r.detail,
          at: r.at,
          sessionId: r.session_id,
          threadTitle: known ? readableTitle(db, { title: r.title!, custom_title: r.custom_title ?? 0 } as never) : '',
          resumeCommand: known ? resumeCommand(r.cwd ?? '', r.session_id) : '',
        };
        map.set(r.task_id, rec);
      }
    }
    return map;
  }
  function toTask(r: TaskRow, subs: Subtask[], youContext: Record<string, YouContext> = {}): Task {
    return {
      id: r.id,
      title: r.title,
      notes: r.notes,
      areaId: r.area_id,
      projectId: r.project_id,
      status: r.status,
      priority: r.priority,
      dueDate: r.due_date,
      nextAction: r.next_action,
      waitingOn: r.waiting_on,
      needsYou: r.needs_you ?? '',
      youContext,
      links: JSON.parse(r.links),
      subtasks: subs,
      subtasksOrdered: r.subtasks_ordered === 1,
      finishedBy: r.finished_by ? JSON.parse(r.finished_by) : null,
      prevStatus: r.prev_status ?? null,
      startedFrom: r.started_from ?? null,
      position: r.position,
      rev: r.rev,
      seq: r.seq,
      isSample: r.is_sample === 1,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      completedAt: r.completed_at,
      deletedAt: r.deleted_at,
      createdBy: r.created_by,
    };
  }
  function toTasks(rows: TaskRow[]): Task[] {
    const subs = subtasksFor(rows.map((r) => r.id));
    const ctxs = contextFor(rows.map((r) => r.id));
    return rows.map((r) => toTask(r, subs.get(r.id) ?? [], ctxs.get(r.id)));
  }
  const taskRow = (id: string) => q('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
  const loadTask = (id: string): Task => toTasks([taskRow(id)!])[0];

  const toArea = (r: any): Area => ({ id: r.id, name: r.name, color: r.color, position: r.position, archived: r.archived === 1, isSample: r.is_sample === 1, mode: r.mode === 'work' ? 'work' : 'personal' });
  const toProject = (r: any): Project => ({ id: r.id, areaId: r.area_id, name: r.name, position: r.position, archived: r.archived === 1, isSample: r.is_sample === 1 });
  const areaRow = (id: string) => q('SELECT * FROM areas WHERE id = ?').get(id) as any;
  const projectRow = (id: string) => q('SELECT * FROM projects WHERE id = ?').get(id) as any;

  function visibleTaskRow(ctx: Ctx, id: string, { allowDeleted = false } = {}): TaskRow {
    const row = taskRow(id);
    if (!row || (row.deleted_at && !allowDeleted) || !canSeeArea(ctx, row.area_id)) throw notFound('Task');
    return row;
  }

  function topPosition(status: Status): number {
    const r = q('SELECT min(position) AS p FROM tasks WHERE status = ? AND deleted_at IS NULL').get(status) as { p: number | null };
    return r.p === null ? 0 : r.p - 1;
  }

  function nameOf(kind: 'area' | 'project', id: unknown): string {
    if (typeof id !== 'string') return 'none';
    const r = kind === 'area' ? areaRow(id) : projectRow(id);
    return r?.name ?? id;
  }

  /** "Oct 20", or "Oct 20, 2027" outside this year. Activity reads in words, not ISO dates. */
  function dayInWords(day: string): string {
    const [y, m, d] = day.split('-').map(Number);
    if (!y || !m || !d) return day;
    const sameYear = y === new Date(now()).getFullYear();
    return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
  }

  /** "Moved Next → Today, priority High on “Title”". Sentence case: the first word only. */
  function describeChanges(changes: Record<string, [unknown, unknown]>): string {
    const parts = Object.entries(changes).map(([field, [from, to]]) => {
      const label = FIELD_LABELS[field] ?? field;
      if (field === 'status') return `moved ${STATUS_LABELS[from as Status]} → ${STATUS_LABELS[to as Status]}`;
      if (field === 'priority') return `priority ${PRIORITY_LABELS[to as Task['priority']]}`;
      if (field === 'areaId') return `area → ${nameOf('area', to)}`;
      if (field === 'projectId') return `project → ${nameOf('project', to)}`;
      if (field === 'dueDate') return to ? `due ${dayInWords(String(to))}` : 'cleared due date';
      if (field === 'title') return `renamed to “${String(to).slice(0, 60)}”`;
      if (field === 'position') return 'reordered';
      return `edited ${label}`;
    });
    const text = parts.join(', ');
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  /** Resolve area/project consistency. Returns the final pair. */
  function resolvePlacement(areaId: string | null | undefined, projectId: string | null | undefined, current: { areaId: string | null; projectId: string | null }) {
    let nextArea = areaId === undefined ? current.areaId : areaId;
    let nextProject = projectId === undefined ? current.projectId : projectId;
    if (projectId) {
      const p = projectRow(projectId);
      if (!p) throw new AppError(422, 'validation', 'Project does not exist', { issues: [{ path: 'projectId', message: 'Unknown project' }] });
      if (areaId !== undefined && areaId !== null && areaId !== p.area_id) {
        throw new AppError(422, 'validation', 'Project belongs to a different area', { issues: [{ path: 'projectId', message: 'Project is in another area' }] });
      }
      nextArea = p.area_id;
    } else if (areaId !== undefined && nextProject) {
      // Area changed without a project: drop a project that no longer fits.
      const p = projectRow(nextProject);
      if (!p || p.area_id !== nextArea) nextProject = null;
    }
    if (nextArea && !areaRow(nextArea)) {
      throw new AppError(422, 'validation', 'Area does not exist', { issues: [{ path: 'areaId', message: 'Unknown area' }] });
    }
    return { areaId: nextArea, projectId: nextProject };
  }

  // ─── Task writes ───

  function createTask(ctx: Ctx, input: unknown, o: { isSample?: boolean; externalKey?: string | null; viaProposal?: string } = {}) {
    requirePerm(ctx, 'create');
    const data: TaskCreate = parse(zTaskCreate, input);
    if (data.status === 'done') requirePerm(ctx, 'complete');
    let areaIn = data.areaId;
    if (areaIn === undefined && !data.projectId && ctx.client) {
      const areas = ctx.client.scopes.areas;
      if (Array.isArray(areas) && areas.length === 1) areaIn = areas[0];
      else if (!ctx.client.scopes.unfiled) throw new AppError(422, 'validation', 'Choose an area for this task', { issues: [{ path: 'areaId', message: 'Required for this connection' }] });
    }
    const placement = resolvePlacement(areaIn ?? null, data.projectId ?? null, { areaId: null, projectId: null });
    requireArea(ctx, placement.areaId);

    return write(() => {
      checkAutomationAllowed(ctx, 'write');
      // Duplicate guard for assistants: same title, same area, same connection, within 10 minutes.
      if (ctx.client) {
        const since = new Date(now().getTime() - 10 * 60_000).toISOString();
        const dup = q(
          `SELECT * FROM tasks WHERE created_by_id = ? AND lower(title) = lower(?) AND area_id IS ? AND deleted_at IS NULL AND created_at >= ? LIMIT 1`,
        ).get(ctx.client.id, data.title, placement.areaId, since) as TaskRow | undefined;
        if (dup) return { task: toTasks([dup])[0], deduplicated: true };
      }
      if (data.id && q('SELECT 1 FROM tasks WHERE id = ?').get(data.id)) throw new AppError(409, 'id_taken', 'That task id is already in use');
      const id = data.id ?? newId('t');
      const at = iso();
      const seq = nextSeq();
      const status = data.status ?? 'inbox';
      const position = data.position ?? topPosition(status);
      const createdBy = o.viaProposal ? `${ctx.actor.label} via ${o.viaProposal}` : ctx.actor.label;
      q(
        `INSERT INTO tasks (id, title, notes, area_id, project_id, status, priority, due_date, next_action, waiting_on, links, position, rev, seq, is_sample, created_at, updated_at, completed_at, created_by, created_by_id, external_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        data.title,
        data.notes ?? '',
        placement.areaId,
        placement.projectId,
        status,
        data.priority ?? 'none',
        data.dueDate ?? null,
        data.nextAction ?? '',
        data.waitingOn ?? '',
        JSON.stringify(data.links ?? []),
        position,
        seq,
        o.isSample ? 1 : 0,
        at,
        at,
        status === 'done' ? at : null,
        createdBy,
        ctx.actor.id,
        o.externalKey ?? null,
      );
      (data.subtasks ?? []).forEach((title, i) => {
        q('INSERT INTO subtasks (id, task_id, title, done, position, created_at) VALUES (?, ?, ?, 0, ?, ?)').run(newId('s'), id, title, i, at);
      });
      logActivity(ctx, {
        entityType: 'task',
        entityId: id,
        action: 'created',
        rev: 1,
        summary: `Created “${data.title.slice(0, 80)}”${o.viaProposal ? ` (proposed by ${o.viaProposal})` : ''}`,
      });
      const task = loadTask(id);
      emit({ type: 'task', seq, task });
      return { task, deduplicated: false };
    });
  }

  function applyTaskChanges(
    ctx: Ctx,
    row: TaskRow,
    patch: TaskPatchFields,
    o: { baseRev: number | null; action?: string; summary?: string },
  ): Task {
    const current = toTasks([row])[0];
    const placement = resolvePlacement(patch.areaId, patch.projectId, { areaId: row.area_id, projectId: row.project_id });
    const next: TaskPatchFields = { ...patch };
    if (patch.areaId !== undefined || patch.projectId !== undefined) {
      next.areaId = placement.areaId;
      next.projectId = placement.projectId;
      requireArea(ctx, placement.areaId);
    }

    // Only fields that actually change matter.
    const changes: Record<string, [unknown, unknown]> = {};
    for (const [field, value] of Object.entries(next) as [keyof TaskPatchFields, unknown][]) {
      const before = (current as unknown as Record<string, unknown>)[field];
      if (!same(before, value)) changes[field] = [before, value];
    }
    if (changes.status && next.position === undefined) {
      const pos = topPosition(next.status as Status);
      changes.position = [current.position, pos];
    }
    if (Object.keys(changes).length === 0) return current;

    if (o.baseRev !== null && o.baseRev !== row.rev) {
      if (o.baseRev > row.rev) throw new AppError(400, 'bad_request', 'baseRev is ahead of the server');
      const touched = new Set<string>();
      const rows = q("SELECT changes, actor_id, session_id FROM activity WHERE entity_type = 'task' AND entity_id = ? AND rev > ?").all(row.id, o.baseRev) as {
        changes: string | null;
        actor_id: string;
        session_id: string | null;
      }[];
      for (const r of rows) {
        // Your own earlier edits from this same tab or process are not a conflict.
        if (ctx.sessionId && r.session_id === ctx.sessionId && r.actor_id === ctx.actor.id) continue;
        if (r.changes) for (const f of Object.keys(JSON.parse(r.changes))) touched.add(f);
      }
      const collisions = Object.keys(changes).filter((f) => touched.has(f) && !NON_CONFLICTING.has(f));
      if (collisions.length > 0) {
        throw new AppError(409, 'conflict', `Someone else changed ${collisions.map((f) => FIELD_LABELS[f] ?? f).join(', ')} since you loaded this task`, {
          current,
          fields: collisions,
        });
      }
    }

    // "Needs you" waits for you: an assistant can raise it but never clear it.
    if (changes.needsYou && !changes.needsYou[1] && ctx.actor.kind !== 'user') throw forbidden('Only you can clear "Needs you"');
    if (changes.needsYou && !changes.needsYou[1]) q("DELETE FROM you_context WHERE task_id = ? AND item = 'task'").run(row.id);
    if (changes.status?.[1] === 'done') requirePerm(ctx, 'complete');
    if (changes.status?.[0] === 'done') requirePerm(ctx, 'complete');

    const at = iso();
    const seq = nextSeq();
    const rev = row.rev + 1;
    const sets: string[] = ['rev = ?', 'seq = ?', 'updated_at = ?'];
    const values: (string | number | null)[] = [rev, seq, at];
    for (const [field, [, to]] of Object.entries(changes)) {
      const col = FIELD_TO_COLUMN[field as keyof TaskPatchFields];
      sets.push(`${col} = ?`);
      values.push(field === 'links' ? JSON.stringify(to) : (to as string | number | null));
    }
    if (changes.status) {
      const [from, to] = changes.status as [Status, Status];
      if (to === 'done') {
        sets.push('completed_at = ?', 'prev_status = ?');
        values.push(at, from);
      } else if (from === 'done') {
        sets.push('completed_at = NULL');
      }
      // Coming back from Done keeps what it was started from.
      if (to === 'doing' && from !== 'done') {
        sets.push('started_from = ?');
        values.push(from);
      }
    }
    db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values, row.id);
    if (changes.status?.[1] === 'done') closeProposalsFor(ctx, row.id, 'the task is done');
    const onlyReorder = Object.keys(changes).every((f) => f === 'position');
    logActivity(ctx, {
      entityType: 'task',
      entityId: row.id,
      action: o.action ?? (onlyReorder ? 'reordered' : 'updated'),
      changes,
      rev,
      summary: o.summary ?? `${describeChanges(changes)} on “${current.title.slice(0, 60)}”`,
      countsAsWrite: true,
    });
    const task = loadTask(row.id);
    emit({ type: 'task', seq, task });
    return task;
  }

  function updateTask(ctx: Ctx, id: string, baseRev: number, patchIn: unknown): Task {
    requirePerm(ctx, 'update');
    const patch = parse(zTaskPatchFields, patchIn);
    if (!Number.isInteger(baseRev) || baseRev < 1) throw new AppError(422, 'validation', 'baseRev is required');
    return write(() => {
      checkAutomationAllowed(ctx, 'write');
      const row = visibleTaskRow(ctx, id);
      // An assistant moving a task to Done is finishing it: the same checks as completeTask, and it waits in For you.
      if (ctx.client && patch.status === 'done' && row.status !== 'done') {
        requirePerm(ctx, 'complete');
        finishByClient(ctx, row, {}, patch.needsYou);
      }
      return applyTaskChanges(ctx, row, patch, { baseRev });
    });
  }

  /** An assistant only finishes what's actually finished, and says so, so you can look it over in For you. */
  function finishByClient(ctx: Ctx, row: TaskRow, proof: { why?: string; link?: string; sessionId?: string }, needsYou?: string) {
    const client = ctx.client!;
    const open = q('SELECT title, needs_you FROM subtasks WHERE task_id = ? AND done = 0 ORDER BY position').all(row.id) as { title: string; needs_you: number }[];
    if (open.length) throw new AppError(409, 'conflict', `Not done yet. Open subtasks: ${open.map((s) => (s.needs_you ? `${s.title} (needs you)` : s.title)).join(' | ')}`);
    if (row.needs_you || needsYou) throw new AppError(409, 'conflict', `The task needs you: ${row.needs_you || needsYou}`);
    // A connection that can't edit tasks (the daily review) must say how it knows.
    if (!client.scopes.perms.includes('update') && !proof.why) throw new AppError(422, 'validation', 'Say why it is done: the merged PR, the message, the receipt');
    const by = { by: client.name, why: proof.why ?? '', link: proof.link ?? '', sessionId: proof.sessionId ?? '', at: iso() };
    q('UPDATE tasks SET finished_by = ? WHERE id = ?').run(JSON.stringify(by), row.id);
  }

  function completeTask(ctx: Ctx, id: string, proof: { why?: string; link?: string; sessionId?: string } = {}): Task {
    requirePerm(ctx, 'complete');
    return write(() => {
      checkAutomationAllowed(ctx, 'write');
      const row = visibleTaskRow(ctx, id);
      if (row.status === 'done') return loadTask(id);
      if (ctx.client) {
        finishByClient(ctx, row, proof);
      } else {
        q('UPDATE tasks SET finished_by = NULL WHERE id = ?').run(id);
      }
      return applyTaskChanges(ctx, row, { status: 'done' }, { baseRev: null, action: 'completed', summary: `Completed “${row.title.slice(0, 80)}”${proof.why ? `: ${proof.why.slice(0, 200)}` : ''}` });
    });
  }

  function seenFinished(ctx: Ctx, id: string): Task {
    requireUser(ctx);
    return write(() => {
      const row = visibleTaskRow(ctx, id);
      if (!row.finished_by) return loadTask(id);
      q('UPDATE tasks SET finished_by = NULL WHERE id = ?').run(id);
      return touchTask(ctx, row, 'finishedBy', 'unseen', 'seen', 'task_updated', `Looked over “${row.title.slice(0, 80)}”`);
    });
  }

  function reopenTask(ctx: Ctx, id: string): Task {
    requirePerm(ctx, 'complete');
    return write(() => {
      checkAutomationAllowed(ctx, 'write');
      const row = visibleTaskRow(ctx, id);
      if (row.status !== 'done') return loadTask(id);
      q('UPDATE tasks SET finished_by = NULL WHERE id = ?').run(id);
      const to: Status = row.prev_status && row.prev_status !== 'done' ? row.prev_status : 'next';
      return applyTaskChanges(ctx, row, { status: to }, { baseRev: null, action: 'reopened', summary: `Reopened “${row.title.slice(0, 80)}” to ${STATUS_LABELS[to]}` });
    });
  }

  /** Move a task into In progress. Narrow on purpose: the "start" permission allows this and nothing else. */
  function startTask(ctx: Ctx, id: string): Task {
    if (ctx.client && !ctx.client.scopes.perms.includes('update')) requirePerm(ctx, 'start');
    return write(() => {
      checkAutomationAllowed(ctx, 'write');
      const row = visibleTaskRow(ctx, id);
      if (row.status === 'doing') return loadTask(id);
      if (row.status === 'done') throw new AppError(409, 'conflict', 'That task is done. Reopen it first.');
      return applyTaskChanges(ctx, row, { status: 'doing', position: topPosition('doing') }, { baseRev: null, action: 'started', summary: `Started “${row.title.slice(0, 80)}”` });
    });
  }

  /** Take a task out of In progress, back to where it was before you started it. */
  function stopTask(ctx: Ctx, id: string): Task {
    requirePerm(ctx, 'update');
    return write(() => {
      checkAutomationAllowed(ctx, 'write');
      const row = visibleTaskRow(ctx, id);
      if (row.status !== 'doing') return loadTask(id);
      const to: Status = row.started_from && row.started_from !== 'doing' && row.started_from !== 'done' ? row.started_from : 'today';
      return applyTaskChanges(ctx, row, { status: to }, { baseRev: null, action: 'stopped', summary: `Stopped “${row.title.slice(0, 80)}”, back to ${STATUS_LABELS[to]}` });
    });
  }

  /** Bump a task's rev/seq for a change that is not a plain field patch (notes append, subtasks). */
  function touchTask(ctx: Ctx, row: TaskRow, field: string, from: unknown, to: unknown, action: string, summary: string): Task {
    const at = iso();
    const seq = nextSeq();
    const rev = row.rev + 1;
    q('UPDATE tasks SET rev = ?, seq = ?, updated_at = ? WHERE id = ?').run(rev, seq, at, row.id);
    logActivity(ctx, { entityType: 'task', entityId: row.id, action, changes: { [field]: [from, to] }, rev, summary });
    const task = loadTask(row.id);
    emit({ type: 'task', seq, task });
    return task;
  }

  function appendNote(ctx: Ctx, id: string, textIn: string, label?: string): Task {
    requirePerm(ctx, 'update');
    const text = String(textIn ?? '').trim();
    if (!text || text.length > LIMITS.noteAppend) throw new AppError(422, 'validation', `Note must be 1 to ${LIMITS.noteAppend} characters`);
    return write(() => {
      checkAutomationAllowed(ctx, 'write');
      const row = visibleTaskRow(ctx, id);
      const stampLine = `[${localDay(now())} · ${label ?? ctx.actor.label}]`;
      const notes = `${row.notes}${row.notes ? '\n\n' : ''}${stampLine} ${text}`;
      if (notes.length > LIMITS.notes) throw new AppError(422, 'validation', 'Notes are full for this task');
      q('UPDATE tasks SET notes = ? WHERE id = ?').run(notes, id);
      return touchTask(ctx, row, 'notes', null, text, 'note_added', `Added a note to “${row.title.slice(0, 60)}”`);
    });
  }

  function subtaskSummary(taskId: string) {
    return (q('SELECT title, done, needs_you FROM subtasks WHERE task_id = ? ORDER BY position').all(taskId) as { title: string; done: number; needs_you: number }[]).map(
      (s) => `${s.done ? '[x]' : '[ ]'} ${s.title}${s.needs_you && !s.done ? ' (needs you)' : ''}`,
    );
  }

  function addSubtask(ctx: Ctx, taskId: string, titleIn: string): Task {
    requirePerm(ctx, 'update');
    const title = String(titleIn ?? '').trim();
    if (!title || title.length > LIMITS.shortText) throw new AppError(422, 'validation', 'Subtask title is required');
    return write(() => {
      checkAutomationAllowed(ctx, 'write');
      const row = visibleTaskRow(ctx, taskId);
      const count = (q('SELECT count(*) AS n, max(position) AS p FROM subtasks WHERE task_id = ?').get(taskId) as { n: number; p: number | null });
      if (count.n >= LIMITS.subtasks) throw new AppError(422, 'validation', 'Too many subtasks');
      const before = subtaskSummary(taskId);
      q('INSERT INTO subtasks (id, task_id, title, done, position, created_at) VALUES (?, ?, ?, 0, ?, ?)').run(newId('s'), taskId, title, (count.p ?? -1) + 1, iso());
      return touchTask(ctx, row, 'subtasks', before, subtaskSummary(taskId), 'subtask_added', `Added subtask “${title.slice(0, 60)}”`);
    });
  }

  function updateSubtask(ctx: Ctx, taskId: string, subtaskId: string, patch: { title?: string; done?: boolean; needsYou?: boolean }): Task {
    requirePerm(ctx, 'update');
    return write(() => {
      checkAutomationAllowed(ctx, 'write');
      const row = visibleTaskRow(ctx, taskId);
      const sub = q('SELECT * FROM subtasks WHERE id = ? AND task_id = ?').get(subtaskId, taskId) as { title: string; done: number; needs_you: number } | undefined;
      if (!sub) throw notFound('Subtask');
      const isUser = ctx.actor.kind === 'user';
      // A subtask flagged for you waits for you to check it off.
      if (!isUser && sub.needs_you && patch.done) throw forbidden('This subtask needs you. Only you can check it off.');
      if (!isUser && sub.needs_you && patch.needsYou === false) throw forbidden('Only you can clear "Needs you"');
      const title = patch.title ?? sub.title;
      const done = patch.done === undefined ? sub.done === 1 : patch.done;
      // Checking it off is how you clear the flag.
      const needsYou = done && !sub.done ? false : patch.needsYou ?? sub.needs_you === 1;
      if (title === sub.title && done === (sub.done === 1) && needsYou === (sub.needs_you === 1)) return loadTask(taskId);
      const before = subtaskSummary(taskId);
      q('UPDATE subtasks SET title = ?, done = ?, needs_you = ? WHERE id = ?').run(title, done ? 1 : 0, needsYou ? 1 : 0, subtaskId);
      if (!needsYou) q('DELETE FROM you_context WHERE task_id = ? AND item = ?').run(taskId, subtaskId);
      const verb =
        patch.done !== undefined && done !== (sub.done === 1) ? (done ? 'Checked off' : 'Unchecked') :
        patch.needsYou !== undefined && needsYou !== (sub.needs_you === 1) ? (needsYou ? 'Flagged for you:' : 'Cleared the flag on') :
        'Renamed subtask';
      return touchTask(ctx, row, 'subtasks', before, subtaskSummary(taskId), 'subtask_updated', `${verb} “${title.slice(0, 60)}”`);
    });
  }

  function flagForYou(ctx: Ctx, taskId: string, flag: YouFlag): Task {
    requirePerm(ctx, 'update');
    return write(() => {
      checkAutomationAllowed(ctx, 'write');
      const row = visibleTaskRow(ctx, taskId);
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const subs = (q('SELECT id, title, done, needs_you FROM subtasks WHERE task_id = ? ORDER BY position').all(taskId) as { id: string; title: string; done: number; needs_you: number }[]).filter((s) => !s.done);
      let sub: (typeof subs)[number] | undefined;
      if (flag.subtask) {
        const said = norm(flag.subtask);
        sub = subs.find((s) => s.id === flag.subtask) ?? subs.find((s) => norm(s.title) === said);
        if (!sub) {
          const hits = subs.filter((s) => norm(s.title).includes(said) || said.includes(norm(s.title)));
          sub = hits.length === 1 ? hits[0] : undefined;
        }
        if (!sub && !flag.text) throw notFound('Open subtask');
      }
      const item = sub ? sub.id : 'task';
      const text = sub ? '' : (flag.text ?? flag.subtask ?? '').replace(/\bt_[A-Za-z0-9]{14}\b:?\s*/g, '').trim().slice(0, LIMITS.shortText);
      if (!sub && !text) throw new AppError(422, 'validation', 'Say what needs you');
      const prev = q('SELECT detail, session_id FROM you_context WHERE task_id = ? AND item = ?').get(taskId, item) as { detail: string; session_id: string } | undefined;
      const detail = flag.detail ?? prev?.detail ?? '';
      const sessionId = flag.sessionId ?? prev?.session_id ?? '';
      q(
        `INSERT INTO you_context (task_id, item, detail, session_id, at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(task_id, item) DO UPDATE SET detail = excluded.detail, session_id = excluded.session_id, at = excluded.at`,
      ).run(taskId, item, detail, sessionId, iso());
      const contextChanged = !prev || prev.detail !== detail || prev.session_id !== sessionId;
      if (sub) {
        if (!sub.needs_you) return updateSubtask(ctx, taskId, sub.id, { needsYou: true });
      } else if (row.needs_you !== text) {
        return applyTaskChanges(ctx, row, { needsYou: text }, { baseRev: null, action: 'updated', summary: `Needs you: “${text.slice(0, 60)}”` });
      }
      return contextChanged ? touchTask(ctx, row, 'needsYou', null, detail, 'updated', `Added why it needs you on “${row.title.slice(0, 60)}”`) : loadTask(taskId);
    });
  }

  const toAsk = (r: any): Ask => ({ id: r.id, taskId: r.task_id, item: r.item, question: r.question, answer: r.answer, status: r.status, createdAt: r.created_at, answeredAt: r.answered_at });
  function listAsks(ctx: Ctx, taskId: string): Ask[] {
    requireUser(ctx);
    visibleTaskRow(ctx, taskId);
    return (q('SELECT * FROM asks WHERE task_id = ? ORDER BY created_at').all(taskId) as any[]).map(toAsk);
  }
  function startAsk(ctx: Ctx, taskId: string, item: string, question: string, sessionId: string): Ask {
    requireUser(ctx);
    visibleTaskRow(ctx, taskId);
    const running = (q("SELECT count(*) AS n FROM asks WHERE status = 'running'").get() as { n: number }).n;
    if (running >= 2) throw new AppError(429, 'rate_limited', 'Claude is already answering two questions. Try again in a moment.');
    const id = newId('q');
    q("INSERT INTO asks (id, task_id, item, question, status, session_id, created_at) VALUES (?, ?, ?, ?, 'running', ?, ?)").run(id, taskId, item, question, sessionId, iso());
    return toAsk(q('SELECT * FROM asks WHERE id = ?').get(id));
  }
  function finishAsk(id: string, status: 'done' | 'error', answer: string) {
    q('UPDATE asks SET status = ?, answer = ?, answered_at = ? WHERE id = ?').run(status, answer.slice(0, 20_000), iso(), id);
  }
  function threadForItem(taskId: string, item: string): { sessionId: string; cwd: string } | null {
    const own = q(
      `SELECT c.session_id, c.cwd FROM you_context y JOIN claude_threads c ON c.session_id = y.session_id WHERE y.task_id = ? AND y.item = ?`,
    ).get(taskId, item) as { session_id: string; cwd: string } | undefined;
    const r =
      own ??
      (q(
        `SELECT c.session_id, c.cwd FROM task_threads tt JOIN claude_threads c ON c.session_id = tt.session_id
         WHERE tt.task_id = ? AND tt.hidden = 0 AND c.is_review = 0 ORDER BY c.last_active_at DESC LIMIT 1`,
      ).get(taskId) as { session_id: string; cwd: string } | undefined);
    return r ? { sessionId: r.session_id, cwd: r.cwd } : null;
  }

  /** Puts the subtasks in the given order. Every subtask must be listed exactly once. */
  function reorderSubtasks(ctx: Ctx, taskId: string, ids: string[] | undefined, ordered?: boolean): Task {
    requirePerm(ctx, 'update');
    return write(() => {
      checkAutomationAllowed(ctx, 'write');
      let row = visibleTaskRow(ctx, taskId);
      let task: Task | null = null;
      if (ordered !== undefined && ordered !== (row.subtasks_ordered === 1)) {
        q('UPDATE tasks SET subtasks_ordered = ? WHERE id = ?').run(ordered ? 1 : 0, taskId);
        task = touchTask(ctx, row, 'subtasksOrdered', !ordered, ordered, 'task_updated', ordered ? 'Set the subtasks in order' : 'Unlocked the subtask order');
        row = visibleTaskRow(ctx, taskId);
      }
      if (!ids) return task ?? loadTask(taskId);
      const current = (q('SELECT id FROM subtasks WHERE task_id = ? ORDER BY position').all(taskId) as { id: string }[]).map((r) => r.id);
      if (ids.length !== current.length || new Set(ids).size !== ids.length || ids.some((id) => !current.includes(id))) {
        throw new AppError(422, 'validation', 'List every subtask of this task exactly once');
      }
      if (ids.every((id, i) => id === current[i])) return loadTask(taskId);
      const before = subtaskSummary(taskId);
      ids.forEach((id, i) => q('UPDATE subtasks SET position = ? WHERE id = ?').run(i, id));
      return touchTask(ctx, row, 'subtasks', before, subtaskSummary(taskId), 'subtask_updated', 'Reordered subtasks');
    });
  }

  function deleteSubtask(ctx: Ctx, taskId: string, subtaskId: string): Task {
    requirePerm(ctx, 'update');
    return write(() => {
      checkAutomationAllowed(ctx, 'write');
      const row = visibleTaskRow(ctx, taskId);
      const sub = q('SELECT title, done, needs_you FROM subtasks WHERE id = ? AND task_id = ?').get(subtaskId, taskId) as { title: string; done: number; needs_you: number } | undefined;
      if (!sub) throw notFound('Subtask');
      // Removing a step that waits for you would clear it, and only you clear "Needs you".
      if (ctx.actor.kind !== 'user' && sub.needs_you && !sub.done) throw forbidden('This subtask needs you. Only you can remove it.');
      const before = subtaskSummary(taskId);
      q('DELETE FROM subtasks WHERE id = ?').run(subtaskId);
      q('DELETE FROM you_context WHERE task_id = ? AND item = ?').run(taskId, subtaskId);
      return touchTask(ctx, row, 'subtasks', before, subtaskSummary(taskId), 'subtask_deleted', `Removed subtask “${sub.title.slice(0, 60)}”`);
    });
  }

  function setDeleted(ctx: Ctx, id: string, deleted: boolean): Task {
    requireUser(ctx);
    return write(() => {
      const row = visibleTaskRow(ctx, id, { allowDeleted: true });
      if (Boolean(row.deleted_at) === deleted) return loadTask(id);
      const at = iso();
      const seq = nextSeq();
      const rev = row.rev + 1;
      q('UPDATE tasks SET deleted_at = ?, rev = ?, seq = ?, updated_at = ? WHERE id = ?').run(deleted ? at : null, rev, seq, at, id);
      if (deleted) closeProposalsFor(ctx, id, 'the task is in Trash');
      logActivity(ctx, {
        entityType: 'task',
        entityId: id,
        action: deleted ? 'deleted' : 'restored',
        changes: { deletedAt: [row.deleted_at, deleted ? at : null] },
        rev,
        summary: `${deleted ? 'Moved to Trash' : 'Restored from Trash'}: “${row.title.slice(0, 80)}”`,
      });
      const task = loadTask(id);
      emit({ type: 'task', seq, task });
      return task;
    });
  }

  function purgeTask(ctx: Ctx, id: string) {
    requireUser(ctx);
    write(() => {
      const row = taskRow(id);
      if (!row) throw notFound('Task');
      if (!row.deleted_at) throw new AppError(400, 'bad_request', 'Move the task to Trash first');
      q('DELETE FROM subtasks WHERE task_id = ?').run(id);
      q('DELETE FROM tasks WHERE id = ?').run(id);
      logActivity(ctx, { entityType: 'task', entityId: id, action: 'purged', summary: `Deleted forever: “${row.title.slice(0, 80)}”` });
      emit({ type: 'activity', seq: currentSeq() });
    });
  }

  function clearSamples(ctx: Ctx) {
    requireUser(ctx);
    return write(() => {
      const rows = q('SELECT id FROM tasks WHERE is_sample = 1 AND deleted_at IS NULL').all() as { id: string }[];
      for (const r of rows) setDeleted(ctx, r.id, true);
      return { tasks: rows.length, ids: rows.map((r) => r.id) };
    });
  }

  // ─── Reads ───

  function listTasks(ctx: Ctx, query: TaskQuery) {
    requirePerm(ctx, 'read');
    const where: string[] = ['deleted_at IS NULL'];
    const params: (string | number)[] = [];
    if (query.status) {
      const list = Array.isArray(query.status) ? query.status : [query.status];
      where.push(`status IN (${list.map(() => '?').join(',')})`);
      params.push(...list);
    } else if (!query.includeDone) {
      where.push("status != 'done'");
    }
    if (query.areaId) {
      where.push('area_id = ?');
      params.push(query.areaId);
    }
    if (query.projectId) {
      where.push('project_id = ?');
      params.push(query.projectId);
    }
    if (ctx.client) {
      const s = ctx.client.scopes;
      const parts: string[] = [];
      if (s.areas === '*') parts.push('area_id IS NOT NULL');
      else if (s.areas.length) {
        parts.push(`area_id IN (${s.areas.map(() => '?').join(',')})`);
        params.push(...s.areas);
      }
      if (s.unfiled) parts.push('area_id IS NULL');
      where.push(parts.length ? `(${parts.join(' OR ')})` : '0');
    }
    let order = "CASE status WHEN 'doing' THEN 0 WHEN 'today' THEN 1 WHEN 'inbox' THEN 2 WHEN 'next' THEN 3 WHEN 'waiting' THEN 4 ELSE 5 END, position";
    const orderParams: string[] = [];
    if (query.q) {
      const like = `%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push("(title LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\' OR next_action LIKE ? ESCAPE '\\' OR waiting_on LIKE ? ESCAPE '\\')");
      params.push(like, like, like, like);
      order = `(title LIKE ? ESCAPE '\\') DESC, ${order}`;
      orderParams.push(like);
    }
    const limit = Math.min(query.limit ?? LIMITS.searchDefault, LIMITS.searchMax);
    const whereSql = where.join(' AND ');
    const total = (db.prepare(`SELECT count(*) AS n FROM tasks WHERE ${whereSql}`).get(...params) as { n: number }).n;
    const rows = db.prepare(`SELECT * FROM tasks WHERE ${whereSql} ORDER BY ${order} LIMIT ?`).all(...params, ...orderParams, limit) as unknown as TaskRow[];
    return { tasks: toTasks(rows), total, truncated: total > rows.length };
  }

  function getTask(ctx: Ctx, id: string): Task {
    requirePerm(ctx, 'read');
    return toTasks([visibleTaskRow(ctx, id)])[0];
  }

  function listAreas(ctx: Ctx): Area[] {
    return (q('SELECT * FROM areas ORDER BY position').all() as any[]).map(toArea).filter((a) => canSeeArea(ctx, a.id));
  }
  function listProjects(ctx: Ctx): Project[] {
    return (q('SELECT * FROM projects ORDER BY position').all() as any[]).map(toProject).filter((p) => canSeeArea(ctx, p.areaId));
  }

  function pendingProposalCount(): number {
    return (q("SELECT count(*) AS n FROM proposals WHERE status = 'pending'").get() as { n: number }).n;
  }

  function sync(ctx: Ctx, since: number | null): SyncPayload {
    requireUser(ctx);
    // Read inside one transaction so seq and rows are consistent.
    db.exec('BEGIN');
    try {
      const seq = currentSeq();
      const rows = (since === null
        ? q('SELECT * FROM tasks WHERE deleted_at IS NULL').all()
        : q('SELECT * FROM tasks WHERE seq > ?').all(since)) as unknown as TaskRow[];
      return {
        seq,
        full: since === null,
        tasks: toTasks(rows),
        areas: listAreas(ctx),
        projects: listProjects(ctx),
        pendingProposals: pendingProposalCount(),
        settings: getSettings(),
        serverTime: iso(),
      };
    } finally {
      db.exec('COMMIT');
    }
  }

  function listTrash(ctx: Ctx): Task[] {
    requireUser(ctx);
    return toTasks(q('SELECT * FROM tasks WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 500').all() as unknown as TaskRow[]);
  }

  // ─── Areas and projects (you manage these; assistants read them) ───

  function createArea(ctx: Ctx, input: { name: string; color?: string; mode?: AreaMode }): Area {
    requireUser(ctx);
    return write(() => {
      const id = newId('a');
      const at = iso();
      const seq = nextSeq();
      const pos = ((q('SELECT max(position) AS p FROM areas').get() as { p: number | null }).p ?? -1) + 1;
      const count = (q('SELECT count(*) AS n FROM areas').get() as { n: number }).n;
      q('INSERT INTO areas (id, name, color, position, created_at, updated_at, seq, mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        id, input.name, input.color ?? AREA_COLORS[count % AREA_COLORS.length], pos, at, at, seq, input.mode ?? 'personal',
      );
      logActivity(ctx, { entityType: 'area', entityId: id, action: 'created', summary: `Created area “${input.name}”` });
      const area = toArea(areaRow(id));
      emit({ type: 'area', seq, area });
      return area;
    });
  }

  function updateArea(ctx: Ctx, id: string, patch: { name?: string; color?: string; position?: number; archived?: boolean; mode?: AreaMode }): Area {
    requireUser(ctx);
    return write(() => {
      const r = areaRow(id);
      if (!r) throw notFound('Area');
      const seq = nextSeq();
      q('UPDATE areas SET name = ?, color = ?, position = ?, archived = ?, mode = ?, updated_at = ?, seq = ? WHERE id = ?').run(
        patch.name ?? r.name, patch.color ?? r.color, patch.position ?? r.position,
        patch.archived === undefined ? r.archived : patch.archived ? 1 : 0, patch.mode ?? r.mode, iso(), seq, id,
      );
      const summary =
        patch.mode && patch.mode !== r.mode ? `Moved area “${r.name}” to ${patch.mode === 'work' ? 'Work' : 'Personal'}`
        : patch.archived !== undefined && patch.archived !== (r.archived === 1) ? `${patch.archived ? 'Archived' : 'Restored'} area “${r.name}”`
        : patch.name && patch.name !== r.name ? `Renamed area “${r.name}” to “${patch.name}”`
        : patch.color && patch.color !== r.color ? `Changed the color of area “${r.name}”`
        : `Updated area “${patch.name ?? r.name}”`;
      logActivity(ctx, { entityType: 'area', entityId: id, action: 'updated', summary });
      const area = toArea(areaRow(id));
      emit({ type: 'area', seq, area });
      return area;
    });
  }

  /** Delete an area. One with tasks needs somewhere for them to go: another area (its projects move too) or null for Unfiled. */
  function deleteArea(ctx: Ctx, id: string, input: { moveTo?: string | null }): { moved: number } {
    requireUser(ctx);
    return write(() => {
      const r = areaRow(id);
      if (!r) throw notFound('Area');
      const moveTo = input.moveTo;
      if (moveTo === id) throw new AppError(422, 'validation', 'Move the tasks to a different area');
      if (moveTo && !areaRow(moveTo)) throw new AppError(422, 'validation', 'Area does not exist');
      const live = q('SELECT * FROM tasks WHERE area_id = ? AND deleted_at IS NULL').all(id) as unknown as TaskRow[];
      if (live.length && moveTo === undefined) {
        throw new AppError(409, 'conflict', `“${r.name}” still has ${live.length} ${live.length === 1 ? 'task' : 'tasks'}. Choose where they go.`, { tasks: live.length });
      }
      const target = moveTo ?? null;
      const where = target ? nameOf('area', target) : 'Unfiled';
      // Projects follow their tasks into the new area. With nowhere to go, they go.
      const projects = q('SELECT id FROM projects WHERE area_id = ?').all(id) as { id: string }[];
      if (target) {
        for (const p of projects) {
          const seq = nextSeq();
          q('UPDATE projects SET area_id = ?, updated_at = ?, seq = ? WHERE id = ?').run(target, iso(), seq, p.id);
          emit({ type: 'project', seq, project: toProject(projectRow(p.id)) });
        }
      }
      for (const t of live) {
        applyTaskChanges(ctx, t, { areaId: target, projectId: target ? t.project_id : null }, { baseRev: null, summary: `Moved to ${where} when “${r.name}” was deleted` });
      }
      // Tasks in Trash keep a valid place to be restored to.
      q('UPDATE tasks SET area_id = ?, project_id = CASE WHEN ? IS NULL THEN NULL ELSE project_id END, seq = ? WHERE area_id = ? AND deleted_at IS NOT NULL').run(target, target, nextSeq(), id);
      if (!target) q('DELETE FROM projects WHERE area_id = ?').run(id);
      q('DELETE FROM areas WHERE id = ?').run(id);
      logActivity(ctx, {
        entityType: 'area',
        entityId: id,
        action: 'deleted',
        summary: live.length ? `Deleted area “${r.name}” and moved ${live.length} ${live.length === 1 ? 'task' : 'tasks'} to ${where}` : `Deleted area “${r.name}”`,
      });
      emit({ type: 'area-deleted', seq: nextSeq(), id });
      return { moved: live.length };
    });
  }

  function createProject(ctx: Ctx, input: { areaId: string; name: string }): Project {
    requireUser(ctx);
    return write(() => {
      if (!areaRow(input.areaId)) throw new AppError(422, 'validation', 'Area does not exist');
      const id = newId('p');
      const at = iso();
      const seq = nextSeq();
      const pos = ((q('SELECT max(position) AS p FROM projects WHERE area_id = ?').get(input.areaId) as { p: number | null }).p ?? -1) + 1;
      q('INSERT INTO projects (id, area_id, name, position, created_at, updated_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, input.areaId, input.name, pos, at, at, seq);
      logActivity(ctx, { entityType: 'project', entityId: id, action: 'created', summary: `Created project “${input.name}”` });
      const project = toProject(projectRow(id));
      emit({ type: 'project', seq, project });
      return project;
    });
  }

  function updateProject(ctx: Ctx, id: string, patch: { name?: string; areaId?: string; position?: number; archived?: boolean }): Project {
    requireUser(ctx);
    return write(() => {
      const r = projectRow(id);
      if (!r) throw notFound('Project');
      if (patch.areaId && !areaRow(patch.areaId)) throw new AppError(422, 'validation', 'Area does not exist');
      const seq = nextSeq();
      q('UPDATE projects SET name = ?, area_id = ?, position = ?, archived = ?, updated_at = ?, seq = ? WHERE id = ?').run(
        patch.name ?? r.name, patch.areaId ?? r.area_id, patch.position ?? r.position,
        patch.archived === undefined ? r.archived : patch.archived ? 1 : 0, iso(), seq, id,
      );
      if (patch.areaId && patch.areaId !== r.area_id) {
        // Tasks follow their project into the new area.
        const rows = q('SELECT * FROM tasks WHERE project_id = ?').all(id) as unknown as TaskRow[];
        for (const t of rows) applyTaskChanges(ctx, t, { areaId: patch.areaId, projectId: id }, { baseRev: null, summary: `Moved with project to ${nameOf('area', patch.areaId)}` });
      }
      logActivity(ctx, { entityType: 'project', entityId: id, action: 'updated', summary: `Updated project “${patch.name ?? r.name}”` });
      const project = toProject(projectRow(id));
      emit({ type: 'project', seq, project });
      return project;
    });
  }

  // ─── Proposals: the review queue ───

  function toProposal(r: any): Proposal {
    const client = q('SELECT name, kind FROM clients WHERE id = ?').get(r.client_id) as { name: string; kind: ClientKind } | undefined;
    return {
      id: r.id,
      clientId: r.client_id,
      clientLabel: client ? client.name : 'Unknown connection',
      body: JSON.parse(r.body),
      reason: r.reason,
      confidence: r.confidence,
      dedupeKey: r.dedupe_key,
      sourceUrl: r.source_url,
      status: r.status,
      seenCount: r.seen_count,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      resolvedAt: r.resolved_at,
      resolvedTaskId: r.resolved_task_id,
      areaId: r.area_id,
      answer: r.answer ?? null,
    };
  }

  function validateProposalTarget(ctx: Ctx, body: ProposalBody): string | null {
    if (body.kind === 'create') {
      const data = parse(zTaskCreate, body.task);
      let areaId = data.areaId;
      if (areaId === undefined && !data.projectId && ctx.client) {
        const areas = ctx.client.scopes.areas;
        if (Array.isArray(areas) && areas.length === 1) areaId = areas[0];
      }
      const placement = resolvePlacement(areaId ?? null, data.projectId ?? null, { areaId: null, projectId: null });
      requireArea(ctx, placement.areaId);
      return placement.areaId;
    }
    if (body.kind === 'question') {
      if (body.taskId) return visibleTaskRow(ctx, body.taskId).area_id;
      const areaId = body.areaId ?? null;
      if (areaId && !q('SELECT 1 FROM areas WHERE id = ?').get(areaId)) throw notFound('Area');
      requireArea(ctx, areaId);
      return areaId;
    }
    const row = visibleTaskRow(ctx, body.taskId);
    if (body.kind === 'update') {
      const patch = parse(zTaskPatchFields, body.patch);
      if (patch.areaId !== undefined || patch.projectId !== undefined) {
        const placement = resolvePlacement(patch.areaId, patch.projectId, { areaId: row.area_id, projectId: row.project_id });
        requireArea(ctx, placement.areaId);
      }
    }
    return row.area_id;
  }

  function createProposal(ctx: Ctx, env: ProposalEnvelope) {
    requirePerm(ctx, 'propose');
    if (!ctx.client) throw new AppError(400, 'bad_request', 'Proposals come from connections. Edit the task directly instead.');
    const client = ctx.client;
    const areaId = validateProposalTarget(ctx, env.proposal);
    return write(() => {
      const at = iso();
      if (env.dedupeKey) {
        const existing = q('SELECT * FROM proposals WHERE client_id = ? AND dedupe_key = ?').get(client.id, env.dedupeKey) as any;
        if (existing) {
          const rejectedRecently = existing.status === 'rejected' && Date.parse(existing.resolved_at) > now().getTime() - 30 * 24 * 3600_000;
          if (existing.status === 'pending') {
            q('UPDATE proposals SET body = ?, reason = ?, confidence = ?, source_url = ?, seen_count = seen_count + 1, last_seen_at = ? WHERE id = ?').run(
              JSON.stringify(env.proposal), env.reason ?? existing.reason, env.confidence ?? existing.confidence, env.sourceUrl ?? existing.source_url, at, existing.id,
            );
            return { proposal: toProposal(q('SELECT * FROM proposals WHERE id = ?').get(existing.id)), deduplicated: true, suppressed: false };
          }
          if (existing.status !== 'rejected' || rejectedRecently) {
            q('UPDATE proposals SET seen_count = seen_count + 1, last_seen_at = ? WHERE id = ?').run(at, existing.id);
            return { proposal: toProposal(q('SELECT * FROM proposals WHERE id = ?').get(existing.id)), deduplicated: true, suppressed: true };
          }
          // Rejected more than 30 days ago: let it come back for review.
          checkAutomationAllowed(ctx, 'proposal');
          q("UPDATE proposals SET body = ?, reason = ?, confidence = ?, source_url = ?, status = 'pending', seen_count = seen_count + 1, created_at = ?, day = ?, last_seen_at = ?, resolved_at = NULL, area_id = ? WHERE id = ?").run(
            JSON.stringify(env.proposal), env.reason ?? '', env.confidence ?? null, env.sourceUrl ?? null, at, localDay(now()), at, areaId, existing.id,
          );
          emit({ type: 'proposals', seq: currentSeq(), pending: pendingProposalCount() });
          return { proposal: toProposal(q('SELECT * FROM proposals WHERE id = ?').get(existing.id)), deduplicated: false, suppressed: false };
        }
      }
      checkAutomationAllowed(ctx, 'proposal');
      const id = newId('pr');
      let status: Proposal['status'] = 'pending';
      let resolvedTask: string | null = null;
      if (env.proposal.kind === 'create' && env.dedupeKey) {
        const t = q('SELECT id FROM tasks WHERE external_key = ?').get(`${client.id}:${env.dedupeKey}`) as { id: string } | undefined;
        if (t) {
          status = 'duplicate';
          resolvedTask = t.id;
        }
      }
      q(
        `INSERT INTO proposals (id, client_id, body, reason, confidence, dedupe_key, source_url, status, seen_count, created_at, day, last_seen_at, resolved_task_id, area_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      ).run(id, client.id, JSON.stringify(env.proposal), env.reason ?? '', env.confidence ?? null, env.dedupeKey ?? null, env.sourceUrl ?? null, status, at, localDay(now()), at, resolvedTask, areaId);
      logActivity(ctx, { entityType: 'proposal', entityId: id, action: 'proposed', summary: `Proposed: ${describeProposal(env.proposal)}`, countsAsWrite: false });
      emit({ type: 'proposals', seq: currentSeq(), pending: pendingProposalCount() });
      return { proposal: toProposal(q('SELECT * FROM proposals WHERE id = ?').get(id)), deduplicated: status === 'duplicate', suppressed: false };
    });
  }

  function describeProposal(b: ProposalBody): string {
    switch (b.kind) {
      case 'create':
        return `new task “${b.task.title.slice(0, 60)}”`;
      case 'update':
        return `edit ${Object.keys(b.patch).map((f) => FIELD_LABELS[f] ?? f).join(', ')}`;
      case 'complete':
        return 'mark a task done';
      case 'reopen':
        return 'reopen a task';
      case 'note':
        return 'add a note';
      case 'question':
        return `asked “${b.question.slice(0, 80)}”`;
    }
  }

  function listProposals(ctx: Ctx, status: Proposal['status'] | 'all' = 'pending', limit = 100): Proposal[] {
    const lim = Math.min(Math.max(limit, 1), 200);
    const rows = (status === 'all'
      ? q('SELECT * FROM proposals ORDER BY created_at DESC LIMIT ?').all(lim)
      : q('SELECT * FROM proposals WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, lim)) as any[];
    return rows.map(toProposal).filter((p) => !ctx.client || p.clientId === ctx.client.id);
  }

  function acceptProposal(ctx: Ctx, id: string) {
    requireUser(ctx);
    return write(() => {
      const r = q('SELECT * FROM proposals WHERE id = ?').get(id) as any;
      if (!r) throw notFound('Proposal');
      if (r.status !== 'pending') throw new AppError(409, 'conflict', `Proposal is already ${r.status}`);
      const p = toProposal(r);
      const via = p.clientLabel;
      let task: Task | null = null;
      const b = p.body;
      if (b.kind === 'question') throw new AppError(400, 'bad_request', 'Answer the question instead of accepting it');
      if (b.kind === 'create') {
        task = createTask(ctx, b.task, { externalKey: p.dedupeKey ? `${p.clientId}:${p.dedupeKey}` : null, viaProposal: via }).task;
      } else {
        const row = taskRow(b.taskId);
        if (!row || row.deleted_at) throw new AppError(409, 'conflict', 'The task this proposal targets no longer exists');
        if (b.kind === 'update') task = applyTaskChanges(ctx, row, parse(zTaskPatchFields, b.patch), { baseRev: null, summary: `Accepted edit from ${via} on “${row.title.slice(0, 60)}”` });
        if (b.kind === 'complete') task = row.status === 'done' ? loadTask(row.id) : applyTaskChanges(ctx, row, { status: 'done' }, { baseRev: null, action: 'completed', summary: `Completed “${row.title.slice(0, 60)}” (proposed by ${via})` });
        if (b.kind === 'reopen') task = row.status !== 'done' ? loadTask(row.id) : applyTaskChanges(ctx, row, { status: row.prev_status && row.prev_status !== 'done' ? row.prev_status : 'next' }, { baseRev: null, action: 'reopened', summary: `Reopened “${row.title.slice(0, 60)}” (proposed by ${via})` });
        if (b.kind === 'note') task = appendNote(ctx, row.id, b.text, `${via}, accepted by you`);
      }
      q("UPDATE proposals SET status = 'accepted', resolved_at = ?, resolved_task_id = ? WHERE id = ?").run(iso(), task?.id ?? null, id);
      logActivity(ctx, { entityType: 'proposal', entityId: id, action: 'accepted', summary: `Accepted proposal from ${via}: ${describeProposal(b)}` });
      emit({ type: 'proposals', seq: currentSeq(), pending: pendingProposalCount() });
      return { proposal: toProposal(q('SELECT * FROM proposals WHERE id = ?').get(id)), task };
    });
  }

  function answerProposal(ctx: Ctx, id: string, answer: string): Proposal {
    requireUser(ctx);
    return write(() => {
      const r = q('SELECT * FROM proposals WHERE id = ?').get(id) as any;
      if (!r) throw notFound('Proposal');
      const p = toProposal(r);
      if (p.body.kind !== 'question') throw new AppError(400, 'bad_request', 'Only questions can be answered');
      if (r.status !== 'pending') throw new AppError(409, 'conflict', `Question is already ${r.status === 'accepted' ? 'answered' : r.status}`);
      q("UPDATE proposals SET status = 'accepted', answer = ?, resolved_at = ? WHERE id = ?").run(answer, iso(), id);
      logActivity(ctx, { entityType: 'proposal', entityId: id, action: 'answered', summary: `Answered ${p.clientLabel}: “${p.body.question.slice(0, 60)}”` });
      emit({ type: 'proposals', seq: currentSeq(), pending: pendingProposalCount() });
      return toProposal(q('SELECT * FROM proposals WHERE id = ?').get(id));
    });
  }

  /** Suggestions about a finished or trashed task are out of date. Close them so they don't sit in Review. Reopen suggestions stay. */
  function closeProposalsFor(ctx: Ctx, taskId: string, why: string) {
    const rows = q("SELECT id FROM proposals WHERE status = 'pending' AND json_extract(body, '$.taskId') = ? AND json_extract(body, '$.kind') != 'reopen'").all(taskId) as { id: string }[];
    if (!rows.length) return;
    const at = iso();
    for (const r of rows) q("UPDATE proposals SET status = 'rejected', resolved_at = ? WHERE id = ?").run(at, r.id);
    logActivity(ctx, { entityType: 'task', entityId: taskId, action: 'proposals_closed', summary: `Closed ${rows.length} out-of-date suggestion${rows.length === 1 ? '' : 's'}: ${why}` });
    emit({ type: 'proposals', seq: currentSeq(), pending: pendingProposalCount() });
  }

  /** A connection takes back its own suggestion when it's no longer true. */
  function withdrawProposal(ctx: Ctx, id: string, why: string): Proposal {
    if (!ctx.client) throw new AppError(400, 'bad_request', 'Reject it instead.');
    const client = ctx.client;
    return write(() => {
      const r = q('SELECT * FROM proposals WHERE id = ?').get(id) as any;
      if (!r || r.client_id !== client.id) throw notFound('Proposal');
      if (r.status !== 'pending') throw new AppError(409, 'conflict', `Proposal is already ${r.status}`);
      q("UPDATE proposals SET status = 'rejected', resolved_at = ? WHERE id = ?").run(iso(), id);
      const p = toProposal(r);
      logActivity(ctx, { entityType: 'proposal', entityId: id, action: 'withdrawn', summary: `Withdrew a suggestion (${describeProposal(p.body)})${why ? `: ${why.slice(0, 200)}` : ''}` });
      emit({ type: 'proposals', seq: currentSeq(), pending: pendingProposalCount() });
      return toProposal(q('SELECT * FROM proposals WHERE id = ?').get(id));
    });
  }

  function rejectProposal(ctx: Ctx, id: string): Proposal {
    requireUser(ctx);
    return write(() => {
      const r = q('SELECT * FROM proposals WHERE id = ?').get(id) as any;
      if (!r) throw notFound('Proposal');
      if (r.status !== 'pending') throw new AppError(409, 'conflict', `Proposal is already ${r.status}`);
      q("UPDATE proposals SET status = 'rejected', resolved_at = ? WHERE id = ?").run(iso(), id);
      const p = toProposal(r);
      logActivity(ctx, { entityType: 'proposal', entityId: id, action: 'rejected', summary: `Rejected proposal from ${p.clientLabel}: ${describeProposal(p.body)}` });
      emit({ type: 'proposals', seq: currentSeq(), pending: pendingProposalCount() });
      return toProposal(q('SELECT * FROM proposals WHERE id = ?').get(id));
    });
  }

  // ─── Connections (scoped tokens) ───

  function clientRecord(r: any): ClientRecord {
    return { id: r.id, name: r.name, kind: r.kind, scopes: JSON.parse(r.scopes), limits: JSON.parse(r.limits), paused: r.paused === 1, revokedAt: r.revoked_at };
  }
  function clientInfo(r: any): ClientInfo {
    const rec = clientRecord(r);
    return { ...rec, createdAt: r.created_at, lastUsedAt: r.last_used_at, usageToday: usageToday(r.id) };
  }

  const lastTouched = new Map<string, number>();
  function authenticate(token: string): ClientRecord | null {
    if (!/^mt_[A-Za-z0-9]{32}$/.test(token)) return null;
    const r = q('SELECT * FROM clients WHERE token_hash = ?').get(hashToken(token)) as any;
    if (!r || r.revoked_at) return null;
    const t = now().getTime();
    if ((lastTouched.get(r.id) ?? 0) < t - 60_000) {
      lastTouched.set(r.id, t);
      q('UPDATE clients SET last_used_at = ? WHERE id = ?').run(iso(), r.id);
    }
    return clientRecord(r);
  }

  function listClients(ctx: Ctx): ClientInfo[] {
    requireUser(ctx);
    return (q('SELECT * FROM clients ORDER BY revoked_at IS NOT NULL, created_at').all() as any[]).map(clientInfo);
  }

  function createClient(ctx: Ctx, input: unknown) {
    requireUser(ctx);
    const data = parse(zClientCreate, input);
    if (Array.isArray(data.scopes.areas)) for (const a of data.scopes.areas) if (!areaRow(a)) throw new AppError(422, 'validation', `Unknown area ${a}`);
    return write(() => {
      const id = newId('c');
      const token = `mt_${randomToken(32)}`;
      q('INSERT INTO clients (id, name, kind, token_hash, scopes, limits, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        id, data.name, data.kind, hashToken(token), JSON.stringify(data.scopes), JSON.stringify(data.limits ?? DEFAULT_LIMITS), iso(),
      );
      logActivity(ctx, { entityType: 'client', entityId: id, action: 'created', summary: `Gave “${data.name}” access` });
      emit({ type: 'clients', seq: currentSeq() });
      return { client: clientInfo(q('SELECT * FROM clients WHERE id = ?').get(id)), token };
    });
  }

  function updateClient(ctx: Ctx, id: string, patchIn: unknown): ClientInfo {
    requireUser(ctx);
    const patch = parse(zClientPatch, patchIn);
    // Same checks as creating one.
    if (patch.scopes && Array.isArray(patch.scopes.areas)) for (const a of patch.scopes.areas) if (!areaRow(a)) throw new AppError(422, 'validation', `Unknown area ${a}`);
    return write(() => {
      const r = q('SELECT * FROM clients WHERE id = ?').get(id) as any;
      if (!r) throw notFound('Connection');
      if (r.revoked_at && (patch.scopes || patch.limits || patch.name || patch.paused !== undefined)) throw new AppError(409, 'conflict', "This app's access was removed. Connect it again instead.");
      q('UPDATE clients SET name = ?, scopes = ?, limits = ?, paused = ? WHERE id = ?').run(
        patch.name ?? r.name, patch.scopes ? JSON.stringify(patch.scopes) : r.scopes, patch.limits ? JSON.stringify(patch.limits) : r.limits,
        patch.paused === undefined ? r.paused : patch.paused ? 1 : 0, id,
      );
      const name = patch.name ?? r.name;
      const summary = patch.paused !== undefined ? `${patch.paused ? 'Paused' : 'Resumed'} “${name}”` : patch.scopes ? `Changed what “${name}” can do` : `Updated “${name}”`;
      logActivity(ctx, { entityType: 'client', entityId: id, action: 'updated', summary });
      emit({ type: 'clients', seq: currentSeq() });
      return clientInfo(q('SELECT * FROM clients WHERE id = ?').get(id));
    });
  }

  function revokeClient(ctx: Ctx, id: string): ClientInfo {
    requireUser(ctx);
    return write(() => {
      const r = q('SELECT * FROM clients WHERE id = ?').get(id) as any;
      if (!r) throw notFound('Connection');
      if (!r.revoked_at) q('UPDATE clients SET revoked_at = ? WHERE id = ?').run(iso(), id);
      logActivity(ctx, { entityType: 'client', entityId: id, action: 'revoked', summary: `Removed access for “${r.name}”` });
      emit({ type: 'clients', seq: currentSeq() });
      return clientInfo(q('SELECT * FROM clients WHERE id = ?').get(id));
    });
  }

  function updateSettings(ctx: Ctx, patch: Partial<Settings>): Settings {
    requireUser(ctx);
    return write(() => {
      if (patch.automationPaused !== undefined) {
        q("INSERT INTO settings (key, value) VALUES ('automationPaused', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(patch.automationPaused));
        logActivity(ctx, { entityType: 'settings', entityId: 'automation', action: 'updated', summary: patch.automationPaused ? 'Paused all automation' : 'Resumed automation' });
      }
      if (patch.macNotify !== undefined) {
        q("INSERT INTO settings (key, value) VALUES ('macNotify', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(patch.macNotify));
        logActivity(ctx, { entityType: 'settings', entityId: 'notify', action: 'updated', summary: patch.macNotify ? 'Turned on Mac notifications' : 'Turned off Mac notifications' });
      }
      if (patch.threadLinking !== undefined) {
        q("INSERT INTO settings (key, value) VALUES ('threadLinking', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(patch.threadLinking));
        logActivity(ctx, { entityType: 'settings', entityId: 'threads', action: 'updated', summary: patch.threadLinking ? 'Turned on linking Claude threads to tasks' : 'Turned off linking Claude threads to tasks' });
      }
      if (patch.ownerName !== undefined && patch.ownerName !== getSettings().ownerName) {
        putSetting('ownerName', patch.ownerName);
        logActivity(ctx, { entityType: 'settings', entityId: 'name', action: 'updated', summary: patch.ownerName ? `Set your name to “${patch.ownerName}”` : 'Cleared your name' });
      }
      const settings = getSettings();
      emit({ type: 'settings', seq: currentSeq(), settings });
      return settings;
    });
  }

  function listActivity(ctx: Ctx, o: { entityId?: string; limit?: number; beforeId?: number }): ActivityEntry[] {
    requireUser(ctx);
    const limit = Math.min(Math.max(o.limit ?? 50, 1), 200);
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (o.entityId) {
      where.push('entity_id = ?');
      params.push(o.entityId);
    }
    if (o.beforeId) {
      where.push('id < ?');
      params.push(o.beforeId);
    }
    const rows = db
      .prepare(`SELECT * FROM activity ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`)
      .all(...params, limit) as any[];
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      actor: { kind: r.actor_kind, id: r.actor_id, label: r.actor_label, clientKind: r.client_kind ?? undefined, claimedName: r.claimed_name },
      entityType: r.entity_type,
      entityId: r.entity_id,
      action: r.action,
      changes: r.changes ? JSON.parse(r.changes) : null,
      rev: r.rev,
      summary: r.summary,
    }));
  }

  // ─── Sample data: clearly labeled, never real commitments ───

  /** The areas each starter choice makes. The sample set stays on one side, so the Work / Personal switch stays out of the way. */
  const STARTER: Record<StarterAreas, { name: string; mode: AreaMode }[]> = {
    sample: ['Clients', 'Side projects', 'Pets', 'Home', 'Hobbies', 'Personal'].map((name) => ({ name, mode: 'personal' as const })),
    'work-personal': [{ name: 'Work', mode: 'work' }, { name: 'Personal', mode: 'personal' }],
    none: [],
  };
  /** Where each sample goes, by the idea it shows. With no areas they stay unfiled. */
  const SAMPLE_HOME: Record<StarterAreas, Record<'client' | 'side' | 'personal' | 'home', string | null>> = {
    sample: { client: 'Clients', side: 'Side projects', personal: 'Personal', home: 'Home' },
    'work-personal': { client: 'Work', side: 'Personal', personal: 'Personal', home: 'Personal' },
    none: { client: null, side: null, personal: null, home: null },
  };

  function seed(shape: { areas: StarterAreas; samples: boolean }) {
    const ctx = systemCtx('seed');
    write(() => {
      const areas = STARTER[shape.areas].map((a) => createArea(ctx, a));
      if (!shape.samples) return;
      const home = SAMPLE_HOME[shape.areas];
      const areaFor = (where: keyof typeof home) => areas.find((a) => a.name === home[where])?.id ?? null;
      const sideArea = areaFor('side');
      let portfolio: Project | null = null;
      if (sideArea) {
        portfolio = createProject(ctx, { areaId: sideArea, name: 'Portfolio site' });
        q('UPDATE projects SET is_sample = 1 WHERE id = ?').run(portfolio.id);
      }
      const today = new Date(now());
      const inDays = (d: number) => localDay(new Date(today.getTime() + d * 86_400_000));
      // Six samples, each showing one idea. The Sample chip marks them; clearing them is one click on Today.
      const add = (input: TaskCreate & { areaId?: string | null }) => createTask(ctx, input, { isSample: true }).task;
      add({
        title: 'Send the invoice for the logo project',
        status: 'next',
        areaId: areaFor('client'),
        dueDate: inDays(-2),
        priority: 'high',
        nextAction: 'Attach the PDF and send it',
        notes: 'A sample task that is two days late. Overdue tasks come first on Today.',
      });
      const pick = add({
        title: 'Choose the hero photo for the portfolio',
        status: 'today',
        areaId: sideArea,
        projectId: portfolio?.id ?? null,
        notes: 'A sample task that needs a decision from you. It shows in For you until you answer.',
      });
      q('UPDATE tasks SET needs_you = ? WHERE id = ?').run('Pick one of the two photos', pick.id);
      q('INSERT INTO you_context (task_id, item, detail, session_id, at) VALUES (?, ?, ?, ?, ?)').run(
        pick.id, 'task', 'Both are in the shared folder. The wider one crops better on phones.', '', iso(),
      );
      const doing = add({
        title: 'Redesign the onboarding screens',
        status: 'doing',
        areaId: areaFor('client'),
        priority: 'medium',
        subtasks: ['Sketch the three screens', 'Write the button labels', 'Test with two people'],
        notes: 'A sample task in progress. The card shows the step you are on now.',
      });
      q('UPDATE subtasks SET done = 1 WHERE task_id = ? AND position = 0').run(doing.id);
      add({
        title: 'Plan the weekend trip',
        status: 'waiting',
        areaId: areaFor('personal'),
        waitingOn: 'Alex to confirm the dates',
        dueDate: inDays(3),
        notes: 'A sample task waiting on someone else. Say who, so you know who to nudge.',
      });
      const finished = add({
        title: 'Sort the receipts folder by month',
        status: 'done',
        areaId: areaFor('home'),
        notes: 'A sample task your assistant finished. Look it over in For you, then press Got it.',
      });
      q('UPDATE tasks SET finished_by = ? WHERE id = ?').run(
        JSON.stringify({ by: 'Your assistant', why: 'Moved 42 receipts into one folder per month.', link: '', sessionId: '', at: iso() }),
        finished.id,
      );
      add({
        title: 'Write the case study intro',
        status: 'today',
        areaId: sideArea,
        projectId: portfolio?.id ?? null,
        dueDate: inDays(0),
        nextAction: 'Open Focus and write for 20 minutes',
        subtasks: ['Draft the first paragraph', 'Add one result with a number', 'Read it out loud'],
        notes: 'A sample task to try Focus on. Focus shows one step at a time and hides everything else.',
      });
    });
  }

  /** A new install: the sample areas and tasks, until setup says otherwise. Never again once setup is done. */
  function seedIfEmpty(): boolean {
    if (getSettings().setupDone) return false;
    const has = (sql: string) => q(sql).get() !== undefined;
    if (has('SELECT 1 FROM areas LIMIT 1') || has('SELECT 1 FROM tasks LIMIT 1')) return false;
    seed({ areas: 'sample', samples: true });
    return true;
  }

  /**
   * Nothing here but what the seed made: no task, project or area of yours, no change to the samples by you or an
   * assistant, and no suggestions. Only then may setup swap the samples, since nothing of yours can be lost.
   */
  function onlySeedData(): boolean {
    const has = (sql: string) => q(sql).get() !== undefined;
    return !(
      has('SELECT 1 FROM tasks WHERE is_sample = 0 LIMIT 1') ||
      has('SELECT 1 FROM projects WHERE is_sample = 0 LIMIT 1') ||
      has("SELECT 1 FROM areas WHERE id NOT IN (SELECT entity_id FROM activity WHERE actor_id = 'system:seed' AND entity_type = 'area') LIMIT 1") ||
      has("SELECT 1 FROM activity WHERE entity_type IN ('task', 'area', 'project') AND actor_id <> 'system:seed' LIMIT 1") ||
      has('SELECT 1 FROM proposals LIMIT 1')
    );
  }

  function completeSetup(ctx: Ctx, input: SetupInput) {
    requireUser(ctx);
    return write(() => {
      const before = getSettings();
      if (before.setupDone) {
        throw new AppError(409, 'conflict', 'Setup is already done. Change your name in Settings, and your areas in the sidebar.', { setup: 'done' });
      }
      let reshaped = false;
      if (input.areas !== undefined && input.samples !== undefined) {
        if (!onlySeedData()) {
          throw new AppError(409, 'conflict', 'You already have tasks or areas of your own, so setup left them as they are.', { setup: 'has-data' });
        }
        // The seed's default is already here: nothing to swap.
        const isDefault = input.areas === 'sample' && input.samples && q('SELECT 1 FROM areas LIMIT 1').get() !== undefined;
        if (!isDefault) {
          // Everything left is the seed's, so it goes, with the seed's own history of making it.
          q('DELETE FROM subtasks').run();
          q('DELETE FROM tasks').run();
          q('DELETE FROM projects').run();
          q('DELETE FROM areas').run();
          q("DELETE FROM activity WHERE actor_id = 'system:seed'").run();
          seed({ areas: input.areas, samples: input.samples });
          reshaped = true;
        }
        if (!input.samples) putSetting('startedWithSamples', 'false');
      }
      if (input.name !== undefined && input.name !== before.ownerName) {
        putSetting('ownerName', input.name);
        logActivity(ctx, { entityType: 'settings', entityId: 'name', action: 'updated', summary: input.name ? `Set your name to “${input.name}”` : 'Cleared your name' });
      }
      putSetting('setupDone', 'true');
      const areas = { 'work-personal': 'Work and Personal', sample: 'the sample areas', none: 'no areas' };
      logActivity(ctx, {
        entityType: 'settings',
        entityId: 'setup',
        action: 'updated',
        summary: input.areas === undefined ? 'Skipped setup' : `Set up with ${areas[input.areas]}, ${input.samples ? 'and' : 'without'} sample tasks`,
      });
      const settings = getSettings();
      if (reshaped) emit({ type: 'reset', seq: nextSeq() });
      emit({ type: 'settings', seq: currentSeq(), settings });
      return { settings, reshaped };
    });
  }

  // ─── Export and import ───

  function exportAll(ctx: Ctx): ExportFile {
    requireUser(ctx);
    return {
      format: 'master-tasker-export',
      version: 1,
      exportedAt: iso(),
      areas: (q('SELECT * FROM areas ORDER BY position').all() as any[]).map(toArea),
      projects: (q('SELECT * FROM projects ORDER BY position').all() as any[]).map(toProject),
      tasks: toTasks(q('SELECT * FROM tasks ORDER BY created_at').all() as unknown as TaskRow[]),
    };
  }

  /** Merge an export: adds anything missing, never overwrites existing records. */
  function importMerge(ctx: Ctx, data: ExportFile) {
    requireUser(ctx);
    if (data?.format !== 'master-tasker-export' || data.version !== 1) throw new AppError(422, 'validation', 'Not a Master Tasker export file');
    return write(() => {
      let areas = 0, projects = 0, tasks = 0, skipped = 0;
      const at = iso();
      // Ids and dates come from a file, so only the shapes the app makes itself get in.
      const okId = (id: unknown) => zId.safeParse(id).success;
      const when = (v: unknown) => (typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? v : null);
      for (const a of data.areas ?? []) {
        if (!okId(a.id) || areaRow(a.id)) { skipped++; continue; }
        q('INSERT INTO areas (id, name, color, position, archived, is_sample, created_at, updated_at, seq, mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
          a.id, String(a.name).slice(0, 80), /^#[0-9a-f]{6}$/i.test(a.color) ? a.color : AREA_COLORS[0], Number(a.position) || 0, a.archived ? 1 : 0, a.isSample ? 1 : 0, at, at, nextSeq(),
          a.mode === 'work' ? 'work' : 'personal',
        );
        areas++;
      }
      for (const p of data.projects ?? []) {
        if (!okId(p.id) || projectRow(p.id)) { skipped++; continue; }
        if (!areaRow(p.areaId)) { skipped++; continue; }
        q('INSERT INTO projects (id, area_id, name, position, archived, is_sample, created_at, updated_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
          p.id, p.areaId, String(p.name).slice(0, 120), Number(p.position) || 0, p.archived ? 1 : 0, p.isSample ? 1 : 0, at, at, nextSeq(),
        );
        projects++;
      }
      for (const t of data.tasks ?? []) {
        if (typeof t.id !== 'string' || !TASK_ID_RE.test(t.id) || taskRow(t.id)) { skipped++; continue; }
        // Validate imported fields with the same rules as every other write.
        const fields = parse(zTaskCreate, {
          title: t.title, notes: t.notes, status: t.status, priority: t.priority, dueDate: t.dueDate, nextAction: t.nextAction,
          waitingOn: t.waitingOn, links: t.links, position: t.position,
          areaId: t.areaId && areaRow(t.areaId) ? t.areaId : null,
          projectId: t.projectId && projectRow(t.projectId) ? t.projectId : null,
        });
        const seq = nextSeq();
        q(
          `INSERT INTO tasks (id, title, notes, area_id, project_id, status, priority, due_date, next_action, waiting_on, links, position, rev, seq, is_sample, created_at, updated_at, completed_at, deleted_at, created_by, created_by_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          t.id, fields.title, fields.notes ?? '', fields.areaId ?? null, fields.projectId ?? null, fields.status ?? 'inbox', fields.priority ?? 'none',
          fields.dueDate ?? null, fields.nextAction ?? '', fields.waitingOn ?? '', JSON.stringify(fields.links ?? []), fields.position ?? 0, seq,
          t.isSample ? 1 : 0, when(t.createdAt) ?? at, at, when(t.completedAt), when(t.deletedAt), `${String(t.createdBy ?? 'Unknown').slice(0, 80)} (imported)`, ctx.actor.id,
        );
        for (const [i, s] of (t.subtasks ?? []).slice(0, LIMITS.subtasks).entries()) {
          q('INSERT INTO subtasks (id, task_id, title, done, position, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(newId('s'), t.id, String(s.title).slice(0, LIMITS.shortText), s.done ? 1 : 0, i, at);
        }
        logActivity(ctx, { entityType: 'task', entityId: t.id, action: 'imported', rev: 1, summary: `Imported “${fields.title.slice(0, 80)}”` });
        tasks++;
      }
      emit({ type: 'reset', seq: currentSeq() });
      return { areas, projects, tasks, skipped };
    });
  }

  return {
    events,
    db: () => db,
    swapDb(next: DB) {
      db = next;
      stmts = new Map();
    },
    authenticate,
    sync,
    currentSeq,
    listTasks,
    getTask,
    createTask,
    updateTask,
    completeTask,
    seenFinished,
    reopenTask,
    startTask,
    stopTask,
    appendNote,
    addSubtask,
    updateSubtask,
    reorderSubtasks,
    flagForYou,
    listAsks,
    startAsk,
    finishAsk,
    threadForItem,
    deleteSubtask,
    deleteTask: (ctx, id) => setDeleted(ctx, id, true),
    restoreTask: (ctx, id) => setDeleted(ctx, id, false),
    purgeTask,
    listTrash,
    clearSamples,
    listAreas,
    createArea,
    updateArea,
    deleteArea,
    listProjects,
    createProject,
    updateProject,
    createProposal,
    listProposals,
    acceptProposal,
    answerProposal,
    rejectProposal,
    withdrawProposal,
    listClients,
    createClient,
    updateClient,
    revokeClient,
    getSettings,
    updateSettings,
    listActivity,
    completeSetup,
    seedIfEmpty,
    exportAll,
    importMerge,
  };
}
