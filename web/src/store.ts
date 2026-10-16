// Client state: the server copy of every task, plus a queue of optimistic changes layered on top.
// What you see = server state + pending changes. When a change fails it is simply dropped from the
// queue, which rolls the screen back. Live events update the server copy without touching your queue.
import { useSyncExternalStore } from 'react';
import { api, ApiError, newKey } from './api.ts';
import { clip, todayIso } from './lib.ts';
import { STATUS_LABELS, type Area, type ClientInfo, type Integrations, type LiveEvent, type Project, type Settings, type SetupInput, type Status, type SyncPayload, type Task, type TaskCreate, type TaskPatchFields } from '../../shared/schema.ts';

export type ConnStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';

export interface Toast {
  id: string;
  message: string;
  tone: 'info' | 'error' | 'success';
  action?: { label: string; run: () => void };
}

/** How long a toast stays. One you can act on stays long enough to reach it. Hovering or focusing it holds it. */
const TOAST_MS = 4500;
const ACTION_TOAST_MS = 10_000;

/** Done today, for the "Done · N today" count and the end of the day. */
export const doneToday = (tasks: Task[], today = todayIso()) => tasks.filter((t) => t.status === 'done' && t.completedAt && todayIso(new Date(t.completedAt)) === today).length;

export interface Conflict {
  id: string;
  taskId: string;
  theirs: Task;
  mine: TaskPatchFields;
  fields: string[];
  message: string;
}

interface Pending {
  id: string;
  taskId: string;
  label: string;
  apply: (t: Task | undefined) => Task | undefined;
  retrying: boolean;
}

export interface Snapshot {
  ready: boolean;
  tasks: Task[];
  byId: Map<string, Task>;
  /** Status as the server last confirmed it, without optimistic changes. Celebrations wait for this. */
  confirmedStatus: Map<string, Status>;
  areas: Area[];
  projects: Project[];
  conn: { status: ConnStatus; lastSyncAt: number | null; lastHeardAt: number | null; error: string | null };
  pendingCount: number;
  retryingCount: number;
  pendingProposals: number;
  settings: Settings;
  /** What's set up for Claude on this Mac. Null until the first check comes back. */
  integrations: Integrations | null;
  /** Every connection: the assistants and automations with access, and removed ones. Null until the first load. */
  clients: ClientInfo[] | null;
  toasts: Toast[];
  conflicts: Conflict[];
  /** A task you just moved into Waiting: the app asks what you're waiting on. */
  waitPrompt: string | null;
  versions: { proposals: number; clients: number; activity: number; reset: number };
}

const MAX_RETRY_MS = 10 * 60_000;
const STALE_AFTER_MS = 40_000;

function patchTask(t: Task, patch: TaskPatchFields): Task {
  const next = { ...t, ...patch, updatedAt: new Date().toISOString() } as Task;
  if (patch.status === 'done' && t.status !== 'done') next.completedAt = new Date().toISOString();
  if (patch.status && patch.status !== 'done') next.completedAt = null;
  return next;
}

function newTaskId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  return `t_${Array.from(bytes, (b) => chars[b % 62]).join('')}`;
}

class Store {
  private server = new Map<string, Task>();
  private areas: Area[] = [];
  private projects: Project[] = [];
  private pending: Pending[] = [];
  private chains = new Map<string, Promise<unknown>>();
  private aliases = new Map<string, string>();
  private seq: number | null = null;
  private listeners = new Set<() => void>();
  private es: EventSource | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private lastTick = Date.now();
  private syncing: Promise<void> | null = null;
  private snap: Snapshot;
  private state = {
    ready: false,
    conn: { status: 'connecting' as ConnStatus, lastSyncAt: null as number | null, lastHeardAt: null as number | null, error: null as string | null },
    pendingProposals: 0,
    // setupDone starts true, so the setup screen never flashes before the first sync says otherwise.
    settings: { automationPaused: false, macNotify: true, threadLinking: false, setupDone: true, ownerName: '', startedWithSamples: true } as Settings,
    integrations: null as Integrations | null,
    clients: null as ClientInfo[] | null,
    toasts: [] as Toast[],
    conflicts: [] as Conflict[],
    waitPrompt: null as string | null,
    versions: { proposals: 0, clients: 0, activity: 0, reset: 0 },
  };

  constructor() {
    this.snap = this.build();
  }

  // ─── Subscription ───
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.snap;
  private notify() {
    this.snap = this.build();
    for (const l of this.listeners) l();
  }
  private build(): Snapshot {
    const view = new Map(this.server);
    for (const p of this.pending) {
      const id = this.resolve(p.taskId);
      const next = p.apply(view.get(id));
      if (next) view.set(id, next);
      else view.delete(id);
    }
    return {
      ...this.state,
      tasks: [...view.values()].filter((t) => !t.deletedAt),
      byId: view,
      confirmedStatus: new Map([...this.server].map(([id, t]) => [id, t.status])),
      areas: this.areas,
      projects: this.projects,
      pendingCount: this.pending.length,
      retryingCount: this.pending.filter((p) => p.retrying).length,
    };
  }
  private set(partial: Partial<typeof this.state>) {
    this.state = { ...this.state, ...partial };
    this.notify();
  }
  private setConn(partial: Partial<Snapshot['conn']>) {
    this.set({ conn: { ...this.state.conn, ...partial } });
  }
  private resolve(id: string) {
    return this.aliases.get(id) ?? id;
  }

  // ─── Toasts ───
  private toastTimers = new Map<string, { timer: ReturnType<typeof setTimeout> | null; left: number; startedAt: number }>();
  toast(message: string, tone: Toast['tone'] = 'info', action?: Toast['action']) {
    // Focus mode stays quiet. Only problems get through.
    if (tone !== 'error' && typeof document !== 'undefined' && document.body.classList.contains('is-focusing')) return;
    const id = newKey();
    const toasts = [...this.state.toasts, { id, message, tone, action }];
    for (const old of toasts.slice(0, -4)) this.clearToastTimer(old.id);
    this.set({ toasts: toasts.slice(-4) });
    this.toastTimers.set(id, { timer: null, left: action ? ACTION_TOAST_MS : TOAST_MS, startedAt: 0 });
    this.resumeToast(id);
    return id;
  }
  /** Hovering or focusing a toast holds it on screen. */
  pauseToast(id: string) {
    const t = this.toastTimers.get(id);
    if (!t?.timer) return;
    clearTimeout(t.timer);
    t.timer = null;
    t.left = Math.max(1500, t.left - (Date.now() - t.startedAt));
  }
  resumeToast(id: string) {
    const t = this.toastTimers.get(id);
    if (!t || t.timer) return;
    t.startedAt = Date.now();
    t.timer = setTimeout(() => this.dismissToast(id), t.left);
  }
  private clearToastTimer(id: string) {
    const t = this.toastTimers.get(id);
    if (t?.timer) clearTimeout(t.timer);
    this.toastTimers.delete(id);
  }
  dismissToast(id: string) {
    this.clearToastTimer(id);
    if (this.state.toasts.some((t) => t.id === id)) this.set({ toasts: this.state.toasts.filter((t) => t.id !== id) });
  }
  closeWaitPrompt() {
    if (this.state.waitPrompt) this.set({ waitPrompt: null });
  }
  dismissConflict(id: string) {
    this.set({ conflicts: this.state.conflicts.filter((c) => c.id !== id) });
  }

  // ─── Server state ───
  private upsertServer(task: Task) {
    const local = this.server.get(task.id);
    if (local && local.seq > task.seq) return false;
    if (task.deletedAt) this.server.delete(task.id);
    else this.server.set(task.id, task);
    return true;
  }

  private applySync(p: SyncPayload) {
    if (p.full) {
      this.server = new Map(p.tasks.map((t) => [t.id, t]));
    } else {
      for (const t of p.tasks) this.upsertServer(t);
    }
    this.areas = p.areas;
    this.projects = p.projects;
    this.seq = p.seq;
    this.state = {
      ...this.state,
      ready: true,
      pendingProposals: p.pendingProposals,
      settings: p.settings,
      conn: { ...this.state.conn, lastSyncAt: Date.now(), error: null },
    };
    this.notify();
  }

  /** Pull everything that changed since the last sync. Safe to call any time. */
  syncNow(full = false): Promise<void> {
    if (this.syncing) return this.syncing;
    const since = full || this.seq === null ? '' : String(this.seq);
    this.syncing = api<SyncPayload>('GET', `/api/sync?since=${since}`)
      .then((p) => {
        // The server's counter went backwards: the database was restored. Start clean.
        if (!p.full && this.seq !== null && p.seq < this.seq) {
          this.seq = null;
          this.syncing = null;
          return this.syncNow(true);
        }
        this.applySync(p);
      })
      .catch((err) => {
        this.setConn({ error: (err as Error).message });
        throw err;
      })
      .finally(() => {
        this.syncing = null;
      });
    return this.syncing;
  }

  private onEvent(e: LiveEvent) {
    this.state.conn = { ...this.state.conn, lastHeardAt: Date.now() };
    const v = this.state.versions;
    switch (e.type) {
      case 'task': {
        const before = this.server.get(e.task.id);
        // An assistant just finished it: say so in every open tab.
        if (before && before.status !== 'done' && e.task.status === 'done' && e.task.finishedBy) {
          this.toast(`${clip(e.task.finishedBy.by.trim() || 'Your assistant', 40)} finished “${clip(e.task.title, 60)}”`, 'success', { label: 'Look', run: () => void (window.location.hash = '#/foryou') });
        }
        this.upsertServer(e.task);
        this.state.versions = { ...v, activity: v.activity + 1 };
        break;
      }
      case 'area':
        this.areas = [...this.areas.filter((a) => a.id !== e.area.id), e.area].sort((a, b) => a.position - b.position);
        break;
      case 'area-deleted':
        this.areas = this.areas.filter((a) => a.id !== e.id);
        this.projects = this.projects.filter((p) => p.areaId !== e.id);
        break;
      case 'project':
        this.projects = [...this.projects.filter((p) => p.id !== e.project.id), e.project].sort((a, b) => a.position - b.position);
        break;
      case 'proposals':
        this.state.pendingProposals = e.pending;
        this.state.versions = { ...v, proposals: v.proposals + 1, activity: v.activity + 1 };
        break;
      case 'clients':
        this.state.versions = { ...v, clients: v.clients + 1, activity: v.activity + 1 };
        void this.refreshClients();
        break;
      case 'settings':
        if (e.settings.threadLinking !== this.state.settings.threadLinking) void this.refreshIntegrations();
        this.state.settings = e.settings;
        this.state.versions = { ...v, activity: v.activity + 1 };
        break;
      case 'integrations':
        void this.refreshIntegrations();
        break;
      case 'activity':
        this.state.versions = { ...v, activity: v.activity + 1 };
        break;
      case 'reset':
        this.state.versions = { ...v, reset: v.reset + 1, proposals: v.proposals + 1, clients: v.clients + 1, activity: v.activity + 1 };
        void this.syncNow(true).catch(() => {});
        void this.refreshClients();
        break;
    }
    if (this.seq !== null && e.seq > this.seq && e.type !== 'reset') this.seq = Math.max(this.seq, e.seq);
    this.notify();
  }

  // ─── Live connection ───
  start() {
    this.connect();
    void this.refreshIntegrations();
    void this.refreshClients();
    setInterval(() => this.watchdog(), 5000);
    const wake = () => {
      if (this.state.conn.status !== 'live') this.connect();
      else void this.syncNow().catch(() => {});
      // Coming back to the app is when someone has just installed Claude. Check again, at most every 15 seconds.
      if (Date.now() - this.integrationsAt > 15_000) void this.refreshIntegrations(true);
      // Or set up another app, which has now started using its access. A quick local check, every time.
      void this.refreshClients();
    };
    window.addEventListener('online', wake);
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') wake();
    });
    window.addEventListener('offline', () => this.setConn({ status: 'offline', error: 'This device is offline' }));
    window.addEventListener('beforeunload', (e) => {
      if (this.pending.length > 0) e.preventDefault();
    });
  }

  private connect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.es?.close();
    if (this.state.conn.status === 'live') this.setConn({ status: 'reconnecting' });
    const es = new EventSource('/api/events');
    this.es = es;
    es.addEventListener('hello', () => {
      this.state.conn = { ...this.state.conn, lastHeardAt: Date.now() };
      // Reconcile anything missed while disconnected, then call it live.
      this.syncNow()
        .then(() => {
          if (this.es !== es) return;
          this.reconnectDelay = 1000;
          this.setConn({ status: 'live', error: null });
          this.flushRetries();
        })
        .catch(() => this.scheduleReconnect());
    });
    es.addEventListener('change', (ev) => this.onEvent(JSON.parse((ev as MessageEvent).data)));
    es.addEventListener('ping', (ev) => {
      const { seq } = JSON.parse((ev as MessageEvent).data) as { seq: number };
      this.setConn({ lastHeardAt: Date.now() });
      // A missed event (or a restore) shows up as a seq mismatch. Reconcile.
      if (this.seq !== null && seq !== this.seq) void this.syncNow(seq < this.seq).catch(() => {});
    });
    es.onerror = () => {
      if (this.es !== es) return;
      es.close();
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.setConn({ status: navigator.onLine === false ? 'offline' : 'reconnecting' });
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private watchdog() {
    const now = Date.now();
    const slept = now - this.lastTick > 20_000;
    this.lastTick = now;
    const silent = this.state.conn.status === 'live' && this.state.conn.lastHeardAt !== null && now - this.state.conn.lastHeardAt > STALE_AFTER_MS;
    if (slept || silent) this.connect();
  }

  // ─── Mutations ───
  private retryWaiters = new Set<() => void>();
  private flushRetries() {
    for (const w of this.retryWaiters) w();
    this.retryWaiters.clear();
  }

  /**
   * Run a write optimistically. Changes to the same task are sent in order.
   * Network failures are retried with the same idempotency key, so nothing is ever applied twice.
   */
  private run<T extends { task?: Task }>(
    taskId: string,
    label: string,
    apply: Pending['apply'],
    send: (realId: string, key: string) => Promise<T>,
    onError?: (err: ApiError, p: Pending) => boolean,
  ): Promise<T | null> {
    const p: Pending = { id: newKey(), taskId, label, apply, retrying: false };
    this.pending.push(p);
    this.notify();
    const key = newKey();
    const prev = this.chains.get(taskId) ?? Promise.resolve();
    const job = prev.then(async () => {
      const started = Date.now();
      let delay = 1000;
      for (;;) {
        try {
          const out = await send(this.resolve(taskId), key);
          if (out?.task) this.upsertServer(out.task);
          this.drop(p);
          return out;
        } catch (e) {
          const err = e instanceof ApiError ? e : new ApiError(0, 'network', String(e));
          if (err.retryable && Date.now() - started < MAX_RETRY_MS) {
            p.retrying = true;
            this.notify();
            await new Promise<void>((resolve) => {
              const t = setTimeout(resolve, delay);
              this.retryWaiters.add(() => {
                clearTimeout(t);
                resolve();
              });
            });
            delay = Math.min(delay * 2, 15_000);
            continue;
          }
          this.drop(p);
          if (!onError?.(err, p)) {
            this.toast(err.retryable ? `Could not save “${label}”. The change was undone.` : err.message, 'error');
          }
          return null;
        }
      }
    });
    this.chains.set(taskId, job.catch(() => {}));
    return job;
  }
  private drop(p: Pending) {
    this.pending = this.pending.filter((x) => x !== p);
    this.notify();
  }

  createTask(input: TaskCreate): Promise<Task | null> {
    // The id is chosen here, so a live event that arrives before the response updates this same row.
    const tempId = newTaskId();
    input = { ...input, id: tempId };
    const now = new Date().toISOString();
    const status: Status = input.status ?? 'inbox';
    const optimistic: Task = {
      id: tempId,
      title: input.title,
      notes: input.notes ?? '',
      youContext: {},
      areaId: input.areaId ?? null,
      projectId: input.projectId ?? null,
      status,
      priority: input.priority ?? 'none',
      dueDate: input.dueDate ?? null,
      nextAction: input.nextAction ?? '',
      waitingOn: input.waitingOn ?? '',
      needsYou: '',
      links: input.links ?? [],
      subtasks: (input.subtasks ?? []).map((title, i) => ({ id: `tmp_s${i}`, title, done: false, position: i, needsYou: false })),
      subtasksOrdered: false,
      finishedBy: null,
      prevStatus: null,
      startedFrom: null,
      position: input.position ?? Math.min(0, ...[...this.server.values()].filter((t) => t.status === status).map((t) => t.position)) - 1,
      rev: 0,
      seq: Number.MAX_SAFE_INTEGER,
      isSample: false,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      deletedAt: null,
      createdBy: 'You',
    };
    return this.run(tempId, input.title, (t) => t ?? optimistic, async (_id, key) => {
      const out = await api<{ task: Task }>('POST', '/api/tasks', input, { idempotencyKey: key });
      this.aliases.set(tempId, out.task.id);
      return out;
    }).then((o) => o?.task ?? null);
  }

  /** Edit fields. baseRev defaults to the server revision you are looking at right now. */
  updateTask(id: string, patch: TaskPatchFields, opts: { baseRev?: number; label?: string; keepalive?: boolean } = {}) {
    const realId = this.resolve(id);
    const baseRevAtStart = opts.baseRev ?? this.server.get(realId)?.rev;
    const label = opts.label ?? this.snap.byId.get(realId)?.title ?? 'task';
    // Moving into Waiting (drag, keyboard or the status menu): ask what it's waiting on.
    const before = this.snap.byId.get(realId);
    if (patch.status === 'waiting' && before && before.status !== 'waiting' && patch.waitingOn === undefined) queueMicrotask(() => this.set({ waitPrompt: realId }));
    return this.run(
      id,
      label,
      (t) => (t ? patchTask(t, patch) : t),
      (rid, key) => {
        const baseRev = baseRevAtStart ?? this.server.get(rid)?.rev ?? 1;
        return api<{ task: Task }>('PATCH', `/api/tasks/${rid}`, { baseRev, patch }, { idempotencyKey: key, keepalive: opts.keepalive });
      },
      (err) => {
        if (err.code !== 'conflict' || !err.conflictCurrent) return false;
        this.upsertServer(err.conflictCurrent);
        this.set({
          conflicts: [
            ...this.state.conflicts,
            { id: newKey(), taskId: err.conflictCurrent.id, theirs: err.conflictCurrent, mine: patch, fields: err.body?.fields ?? [], message: err.message },
          ],
        });
        return true;
      },
    );
  }

  move(id: string, status: Status, position: number) {
    return this.updateTask(id, { status, position });
  }

  /** Mark it done. Says how many are done today, with Undo. `quiet` skips the toast (Focus mode, bulk). */
  complete(id: string, o: { quiet?: boolean } = {}) {
    const t = this.snap.byId.get(this.resolve(id));
    if (!t || t.status === 'done') return;
    const job = this.run(id, t.title, (x) => (x ? { ...patchTask(x, { status: 'done' }), prevStatus: x.status === 'done' ? x.prevStatus : x.status, finishedBy: null } : x), (rid, key) => api<{ task: Task }>('POST', `/api/tasks/${rid}/complete`, {}, { idempotencyKey: key }));
    if (!o.quiet) this.toast(`Done · ${doneToday(this.snap.tasks)} today`, 'success', { label: 'Undo', run: () => this.reopen(id) });
    return job;
  }
  /** Back to where it was before Done. */
  reopen(id: string) {
    const t = this.snap.byId.get(this.resolve(id));
    if (!t) return;
    const to: Status = t.prevStatus && t.prevStatus !== 'done' ? t.prevStatus : 'next';
    this.run(id, t.title, (x) => (x ? { ...patchTask(x, { status: to }), finishedBy: null } : x), (rid, key) => api<{ task: Task }>('POST', `/api/tasks/${rid}/reopen`, {}, { idempotencyKey: key }));
  }
  /** You've looked over what an assistant finished. */
  seenFinished(id: string) {
    const t = this.snap.byId.get(this.resolve(id));
    if (!t?.finishedBy) return;
    this.run(id, t.title, (x) => (x ? { ...x, finishedBy: null } : x), (rid, key) => api<{ task: Task }>('POST', `/api/tasks/${rid}/finished/seen`, {}, { idempotencyKey: key }));
  }
  /** Start working on a task (to the top of In progress), or stop (back to where it was before). */
  toggleDoing(id: string) {
    const t = this.snap.byId.get(this.resolve(id));
    if (!t) return;
    if (t.status === 'doing') return this.stop(id);
    const top = Math.min(0, ...[...this.snap.byId.values()].filter((x) => x.status === 'doing' && !x.deletedAt).map((x) => x.position)) - 1;
    const from = t.status;
    this.run(
      id,
      t.title,
      (x) => (x ? { ...patchTask(x, { status: 'doing', position: top }), startedFrom: from === 'done' ? x.startedFrom : from } : x),
      (rid, key) => api<{ task: Task }>('PATCH', `/api/tasks/${rid}`, { baseRev: this.server.get(rid)?.rev ?? 1, patch: { status: 'doing', position: top } }, { idempotencyKey: key }),
    );
  }
  stop(id: string) {
    const t = this.snap.byId.get(this.resolve(id));
    if (!t || t.status !== 'doing') return;
    const to: Status = t.startedFrom && t.startedFrom !== 'doing' && t.startedFrom !== 'done' ? t.startedFrom : 'today';
    this.run(id, t.title, (x) => (x ? patchTask(x, { status: to }) : x), (rid, key) => api<{ task: Task }>('POST', `/api/tasks/${rid}/stop`, {}, { idempotencyKey: key }));
  }
  toggleDone(id: string) {
    const t = this.snap.byId.get(this.resolve(id));
    if (t?.status === 'done') this.reopen(id);
    else this.complete(id);
  }

  addSubtask(id: string, title: string) {
    this.run(
      id,
      title,
      (t) => (t ? { ...t, subtasks: [...t.subtasks, { id: `tmp_${newKey().slice(0, 6)}`, title, done: false, position: t.subtasks.length, needsYou: false }] } : t),
      (rid, key) => api<{ task: Task }>('POST', `/api/tasks/${rid}/subtasks`, { title }, { idempotencyKey: key }),
    );
  }
  updateSubtask(id: string, subId: string, patch: { title?: string; done?: boolean; needsYou?: boolean }) {
    this.run(
      id,
      'subtask',
      (t) => (t ? { ...t, subtasks: t.subtasks.map((s) => (s.id === subId ? { ...s, ...patch, ...(patch.done ? { needsYou: false } : {}) } : s)) } : t),
      (rid, key) => api<{ task: Task }>('PATCH', `/api/tasks/${rid}/subtasks/${subId}`, patch, { idempotencyKey: key }),
    );
  }
  /** Your new subtask order. */
  reorderSubtasks(id: string, ids: string[]) {
    this.run(
      id,
      'subtask order',
      (t) => (t ? { ...t, subtasks: ids.map((sid, i) => ({ ...t.subtasks.find((s) => s.id === sid)!, position: i })).filter((s) => s.id) } : t),
      (rid, key) => api<{ task: Task }>('PUT', `/api/tasks/${rid}/subtasks/order`, { ids }, { idempotencyKey: key }),
    );
  }
  setSubtasksOrdered(id: string, ordered: boolean) {
    this.run(
      id,
      'subtask order',
      (t) => (t ? { ...t, subtasksOrdered: ordered } : t),
      (rid, key) => api<{ task: Task }>('PUT', `/api/tasks/${rid}/subtasks/order`, { ordered }, { idempotencyKey: key }),
    );
  }
  deleteSubtask(id: string, subId: string) {
    this.run(
      id,
      'subtask',
      (t) => (t ? { ...t, subtasks: t.subtasks.filter((s) => s.id !== subId) } : t),
      (rid, key) => api<{ task: Task }>('DELETE', `/api/tasks/${rid}/subtasks/${subId}`, undefined, { idempotencyKey: key }),
    );
  }
  appendNote(id: string, text: string) {
    this.run(
      id,
      'note',
      (t) => (t ? { ...t, notes: `${t.notes}${t.notes ? '\n\n' : ''}${text}` } : t),
      (rid, key) => api<{ task: Task }>('POST', `/api/tasks/${rid}/notes`, { text }, { idempotencyKey: key }),
    );
  }

  deleteTask(id: string, o: { quiet?: boolean } = {}) {
    const t = this.snap.byId.get(this.resolve(id));
    if (!t) return;
    return this.run(id, t.title, () => undefined, (rid, key) => api<{ task: Task }>('DELETE', `/api/tasks/${rid}`, undefined, { idempotencyKey: key })).then((out) => {
      if (out && !o.quiet) this.toast(`Moved “${clip(t.title)}” to Trash`, 'info', { label: 'Undo', run: () => void this.restoreTask(out.task!.id, { quiet: true }) });
      return out;
    });
  }
  /** Back out of Trash, to the status it had. Says where, with a way to open it. */
  async restoreTask(id: string, o: { quiet?: boolean } = {}) {
    try {
      const out = await api<{ task: Task }>('POST', `/api/tasks/${id}/restore`, {}, { idempotencyKey: newKey() });
      this.upsertServer(out.task);
      this.notify();
      if (!o.quiet) this.toast(`Restored to ${STATUS_LABELS[out.task.status]}`, 'success', { label: 'Open', run: () => void (window.location.hash = `#/${out.task.status}?task=${out.task.id}`) });
      return out.task;
    } catch (err) {
      this.toast((err as Error).message, 'error');
      return null;
    }
  }
  /** Moves every sample task to Trash. Undo brings them all back. */
  async clearSamples() {
    try {
      const out = await api<{ tasks: number; ids: string[] }>('POST', '/api/samples/clear', {}, { idempotencyKey: newKey() });
      await this.syncNow().catch(() => {});
      this.toast(out.tasks ? `Cleared ${out.tasks} sample ${out.tasks === 1 ? 'task' : 'tasks'}` : 'No sample tasks left', 'success', out.tasks ? {
        label: 'Undo',
        run: () => void Promise.all(out.ids.map((id) => this.restoreTask(id, { quiet: true }))),
      } : undefined);
      return out.tasks;
    } catch (err) {
      this.toast((err as Error).message, 'error');
      return 0;
    }
  }

  // Areas and projects are small and rare: no optimistic layer, just wait for the server.
  async createArea(name: string, mode?: Area['mode']) {
    const out = await api<{ area: Area }>('POST', '/api/areas', { name, ...(mode ? { mode } : {}) }, { idempotencyKey: newKey() });
    this.onEvent({ type: 'area', seq: this.seq ?? 0, area: out.area });
    return out.area;
  }
  async updateArea(id: string, patch: Partial<Pick<Area, 'name' | 'color' | 'archived' | 'position' | 'mode'>>) {
    const out = await api<{ area: Area }>('PATCH', `/api/areas/${id}`, patch, { idempotencyKey: newKey() });
    this.onEvent({ type: 'area', seq: this.seq ?? 0, area: out.area });
    return out.area;
  }
  /** Deletes an area. One with tasks needs `moveTo`: another area's id, or null for Unfiled. */
  async deleteArea(id: string, moveTo?: string | null) {
    const out = await api<{ moved: number }>('DELETE', `/api/areas/${id}`, moveTo === undefined ? {} : { moveTo }, { idempotencyKey: newKey() });
    this.onEvent({ type: 'area-deleted', seq: this.seq ?? 0, id });
    if (out.moved) await this.syncNow().catch(() => {});
    return out;
  }
  async createProject(areaId: string, name: string) {
    const out = await api<{ project: Project }>('POST', '/api/projects', { areaId, name }, { idempotencyKey: newKey() });
    this.onEvent({ type: 'project', seq: this.seq ?? 0, project: out.project });
    return out.project;
  }
  async updateProject(id: string, patch: Partial<Pick<Project, 'name' | 'archived' | 'areaId' | 'position'>>) {
    const out = await api<{ project: Project }>('PATCH', `/api/projects/${id}`, patch, { idempotencyKey: newKey() });
    this.onEvent({ type: 'project', seq: this.seq ?? 0, project: out.project });
  }
  async setMacNotify(on: boolean) {
    const out = await api<{ settings: Settings }>('PATCH', '/api/settings', { macNotify: on }, { idempotencyKey: newKey() });
    this.set({ settings: out.settings });
  }
  async setAutomationPaused(paused: boolean) {
    const out = await api<{ settings: Settings }>('PATCH', '/api/settings', { automationPaused: paused }, { idempotencyKey: newKey() });
    this.set({ settings: out.settings });
  }
  async setOwnerName(name: string) {
    const out = await api<{ settings: Settings }>('PATCH', '/api/settings', { ownerName: name }, { idempotencyKey: newKey() });
    this.set({ settings: out.settings });
  }
  /**
   * First-run setup, or Skip with no choices. If you already have tasks or areas of your own, it keeps them,
   * saves the name and says so. Resolves once the app shows the result.
   */
  async completeSetup(choice: SetupInput) {
    const send = (body: SetupInput) => api<{ settings: Settings; reshaped: boolean }>('POST', '/api/setup', body, { idempotencyKey: newKey() });
    let out: { settings: Settings; reshaped: boolean };
    try {
      out = await send(choice);
    } catch (err) {
      const why = err instanceof ApiError ? err.body?.setup : undefined;
      // Another tab finished it first. Show what it chose.
      if (why === 'done') return void (await this.syncNow(true));
      if (why !== 'has-data') throw err;
      out = await send(choice.name === undefined ? {} : { name: choice.name });
      this.toast((err as Error).message, 'info');
    }
    if (out.reshaped) await this.syncNow(true).catch(() => {});
    this.set({ settings: out.settings });
  }
  async setThreadLinking(on: boolean) {
    const out = await api<{ settings: Settings }>('PATCH', '/api/settings', { threadLinking: on }, { idempotencyKey: newKey() });
    this.set({ settings: out.settings });
    await this.refreshIntegrations();
  }

  // ─── Connections ───
  /** Loads every connection again. Live events call it whenever one is made, changed or removed. */
  async refreshClients(): Promise<ClientInfo[] | null> {
    try {
      const { clients } = await api<{ clients: ClientInfo[] }>('GET', '/api/clients');
      this.set({ clients });
    } catch {
      // The connection indicator already reports outages. Keep what we had.
    }
    return this.state.clients;
  }

  // ─── Connecting Claude ───
  private integrationsAt = 0;
  private integrationsLoading: Promise<Integrations | null> | null = null;
  /** Checks what's set up for Claude. `recheck` looks again on disk instead of using the server's last look. */
  refreshIntegrations(recheck = false): Promise<Integrations | null> {
    if (this.integrationsLoading && !recheck) return this.integrationsLoading;
    this.integrationsAt = Date.now();
    const job = api<{ integrations: Integrations }>('GET', `/api/integrations${recheck ? '?refresh=1' : ''}`)
      .then(({ integrations }) => {
        this.set({ integrations });
        return integrations;
      })
      .catch(() => this.state.integrations)
      .finally(() => {
        if (this.integrationsLoading === job) this.integrationsLoading = null;
      });
    this.integrationsLoading = job;
    return job;
  }
  /** Sets up or removes Claude Code or Claude Desktop. Returns the server's plain-words message. */
  async connectClaude(what: 'claude-code' | 'claude-desktop', on: boolean): Promise<{ message: string; backup?: string | null }> {
    const out = await api<{ integrations: Integrations; message: string; backup?: string | null }>(on ? 'POST' : 'DELETE', `/api/integrations/${what}`, on ? {} : undefined, { idempotencyKey: newKey() });
    this.set({ integrations: out.integrations });
    if (what === 'claude-code') void this.syncNow().catch(() => {});
    return out;
  }
}

export const store = new Store();

export function useStore(): Snapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

/** What's set up for Claude, for any screen that changes with it. Null until the first check. */
export function useIntegrations(): Integrations | null {
  return useSyncExternalStore(store.subscribe, () => store.getSnapshot().integrations);
}

/** Every connection, for any screen that changes with them. Null until the first load. */
export function useClients(): ClientInfo[] | null {
  return useSyncExternalStore(store.subscribe, () => store.getSnapshot().clients);
}
