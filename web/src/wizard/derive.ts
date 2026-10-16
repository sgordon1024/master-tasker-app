// Turns tasks, progress and connection state into what the Wizard view shows. Pure: no network, no clock reads.
// Everything here comes from Master Tasker's own records. Nothing is inferred from animation or silence.
import type { Status, Task, TaskProgress } from '../../../shared/schema.ts';
import { byCompleted, byPosition, needsYouItems, relativeTime } from '../lib.ts';
import type { ConnStatus } from '../store.ts';

/** How a task appears in the scene. Needs you outranks the status it sits in. */
export type SpellKind = 'needsYou' | 'working' | 'waiting' | 'queued' | 'untriaged' | 'done';

export const SPELL_LABELS: Record<SpellKind, string> = {
  needsYou: 'Needs you',
  working: 'In progress',
  waiting: 'Waiting',
  queued: 'Today and Next',
  untriaged: 'Inbox',
  done: 'Done',
};

export interface LastReported {
  text: string;
  kind: 'decision' | 'reply' | 'subtask';
  at: string | null;
  threadTitle: string;
  sessionId: string;
  /** Other tasks in scope linked to the same thread. A shared thread is one source, not several workers. */
  sharedWith: number;
}

export interface TaskSpell {
  task: Task;
  kind: SpellKind;
  status: Status;
  needsYou: string[];
  subtasks: { done: number; total: number };
  /** The open subtask Claude last said it was on, if it named one that is still open. */
  reportedSubtask: string | null;
  lastReported: LastReported | null;
}

export function spellKind(t: Task): SpellKind {
  if (t.status === 'done') return 'done';
  if (needsYouItems(t).length > 0) return 'needsYou';
  if (t.status === 'doing') return 'working';
  if (t.status === 'waiting') return 'waiting';
  if (t.status === 'inbox') return 'untriaged';
  return 'queued';
}

export function toSpells(tasks: Task[], progress: ReadonlyMap<string, TaskProgress>): TaskSpell[] {
  const ids = new Set(tasks.map((t) => t.id));
  const perThread = new Map<string, number>();
  for (const p of progress.values()) if (ids.has(p.taskId) && p.sessionId) perThread.set(p.sessionId, (perThread.get(p.sessionId) ?? 0) + 1);
  return tasks.map((task) => {
    const p = progress.get(task.id);
    const sub = p?.subtaskId ? task.subtasks.find((s) => s.id === p.subtaskId && !s.done) : undefined;
    let lastReported: LastReported | null = null;
    if (p && (p.note || sub)) {
      lastReported = {
        text: p.note || (sub ? sub.title : ''),
        kind: p.note ? p.noteKind : 'subtask',
        at: p.noteAt,
        threadTitle: p.threadTitle,
        sessionId: p.sessionId,
        sharedWith: Math.max(0, (perThread.get(p.sessionId) ?? 1) - 1),
      };
    }
    return {
      task,
      kind: spellKind(task),
      status: task.status,
      needsYou: needsYouItems(task),
      subtasks: { done: task.subtasks.filter((s) => s.done).length, total: task.subtasks.length },
      reportedSubtask: sub?.title ?? null,
      lastReported,
    };
  });
}

/** "3 of 7 subtasks checked off". Never a percentage: subtasks are not equal in size. Null with no subtasks. */
export function subtaskLabel(s: TaskSpell['subtasks']): string | null {
  if (s.total === 0) return null;
  return `${s.done} of ${s.total} subtask${s.total === 1 ? '' : 's'} checked off`;
}

export interface WizardCounts {
  total: number;
  inProgress: number;
  /** Overlaps the others: a task can be In progress and need you. Don't add these together. */
  needsYou: number;
  waiting: number;
  queued: number;
  untriaged: number;
  done: number;
}

export function countSpells(spells: TaskSpell[]): WizardCounts {
  const c: WizardCounts = { total: spells.length, inProgress: 0, needsYou: 0, waiting: 0, queued: 0, untriaged: 0, done: 0 };
  for (const s of spells) {
    if (s.needsYou.length) c.needsYou++;
    if (s.status === 'doing') c.inProgress++;
    else if (s.status === 'waiting') c.waiting++;
    else if (s.status === 'today' || s.status === 'next') c.queued++;
    else if (s.status === 'inbox') c.untriaged++;
    else if (s.status === 'done') c.done++;
  }
  return c;
}

// ─── Ledger ───

export type LedgerFilter = 'all' | 'needsYou' | 'working' | 'waiting' | 'queued' | 'untriaged' | 'done';

export function filterLedger(spells: TaskSpell[], f: LedgerFilter): TaskSpell[] {
  if (f === 'all') return spells;
  if (f === 'needsYou') return spells.filter((s) => s.needsYou.length > 0);
  if (f === 'working') return spells.filter((s) => s.status === 'doing');
  if (f === 'waiting') return spells.filter((s) => s.status === 'waiting');
  if (f === 'queued') return spells.filter((s) => s.status === 'today' || s.status === 'next');
  if (f === 'untriaged') return spells.filter((s) => s.status === 'inbox');
  return spells.filter((s) => s.status === 'done');
}

const KIND_RANK: Record<SpellKind, number> = { needsYou: 0, working: 1, waiting: 2, queued: 3, untriaged: 4, done: 5 };

/** Ledger order: what needs you first, then by status, then the board's own order. Done is newest first. */
export function sortLedger(spells: TaskSpell[]): TaskSpell[] {
  return [...spells].sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || (a.kind === 'done' ? byCompleted(a.task, b.task) : byPosition(a.task, b.task)));
}

// ─── Scene glyphs ───

export interface GlyphPlan {
  shown: TaskSpell[];
  /** What didn't fit, by kind. Shown as "+17 more". The cap is a drawing limit, not an execution limit. */
  hidden: { kind: SpellKind; count: number }[];
}

/** Picks at most `cap` open tasks to draw: the selected one, then what needs you, then In progress, waiting, queued. */
export function planGlyphs(spells: TaskSpell[], cap: number, selectedId: string | null): GlyphPlan {
  const open = sortLedger(spells.filter((s) => s.kind !== 'done'));
  const sel = open.find((s) => s.task.id === selectedId);
  const ordered = sel ? [sel, ...open.filter((s) => s !== sel)] : open;
  const shown = ordered.slice(0, Math.max(0, cap));
  const hiddenCounts = new Map<SpellKind, number>();
  for (const s of ordered.slice(shown.length)) hiddenCounts.set(s.kind, (hiddenCounts.get(s.kind) ?? 0) + 1);
  const hidden = [...hiddenCounts].map(([kind, count]) => ({ kind, count })).sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]);
  return { shown, hidden };
}

// ─── Mood and caption ───

/** The whole stage's expression. Attention outranks work; work outranks idle. */
export type Mood = 'attention' | 'working' | 'idle' | 'empty';

export function moodOf(counts: WizardCounts): Mood {
  if (counts.needsYou > 0) return 'attention';
  if (counts.inProgress > 0) return 'working';
  if (counts.total - counts.done > 0) return 'idle';
  return 'empty';
}

export interface CaptionFacts {
  kind: 'needsYou' | 'working' | 'waiting' | 'queued' | 'untriaged' | 'done' | 'idle' | 'empty';
  title: string;
  /** The recorded request, wait reason or last report. Always kept whole. */
  detail: string;
  /** Tasks marked In progress in scope. */
  inProgress: number;
  needsYou: number;
  next: string;
  lastReported: LastReported | null;
  selected: boolean;
}

/**
 * What the caption is about: the selected task, else the oldest thing that needs you,
 * else In progress work, else the queue. Never rotates on its own.
 */
export function captionFacts(spells: TaskSpell[], counts: WizardCounts, selectedId: string | null): CaptionFacts {
  const base = { inProgress: counts.inProgress, needsYou: counts.needsYou };
  const sel = spells.find((s) => s.task.id === selectedId);
  const oldestYou = spells.filter((s) => s.needsYou.length && s.kind !== 'done').sort((a, b) => a.task.updatedAt.localeCompare(b.task.updatedAt))[0];
  const firstWorking = sortLedger(spells.filter((s) => s.status === 'doing'))[0];
  const subject = sel ?? oldestYou ?? firstWorking;
  if (!subject) {
    const open = counts.total - counts.done;
    return { ...base, kind: open ? 'idle' : 'empty', title: '', detail: '', next: '', lastReported: null, selected: false };
  }
  const t = subject.task;
  const firstOpen = t.subtasks.find((s) => !s.done && !s.needsYou)?.title ?? '';
  const next = subject.reportedSubtask ?? (firstOpen || t.nextAction);
  const detail =
    subject.kind === 'needsYou' ? subject.needsYou[0] : subject.kind === 'waiting' ? t.waitingOn : subject.kind === 'working' ? subject.reportedSubtask ?? '' : '';
  return { ...base, kind: subject.kind, title: t.title, detail, next, lastReported: subject.lastReported, selected: !!sel };
}

export type Tone = 'gentle' | 'plain' | 'terse';
export const toneOf = (bluntness: number): Tone => (bluntness <= 33 ? 'gentle' : bluntness <= 66 ? 'plain' : 'terse');

const q = (s: string) => `“${s}”`;

/**
 * The status sentence under the wizard. Bluntness picks the wording, verbosity how much. The facts,
 * the required action and the reason are the same at every setting. At most two short sentences,
 * plus one detail line at the highest verbosity.
 */
export function caption(f: CaptionFacts, bluntness: number, verbosity: 0 | 1 | 2, now: number): string[] {
  const tone = toneOf(bluntness);
  const lines: string[] = [];
  const pick = (gentle: string, plain: string, terse: string) => (tone === 'gentle' ? gentle : tone === 'plain' ? plain : terse);
  switch (f.kind) {
    case 'needsYou':
      lines.push(
        pick(
          `${q(f.title)} is waiting on you: ${f.detail}.`,
          `${q(f.title)} needs you: ${f.detail}.`,
          `Needs you: ${f.detail}. ${q(f.title)}.`,
        ),
      );
      break;
    case 'working':
      lines.push(
        f.detail
          ? pick(`${q(f.title)} is marked In progress. Last reported: ${f.detail}.`, `Marked In progress: ${q(f.title)}. Last reported: ${f.detail}.`, `In progress: ${q(f.title)}. Last reported: ${f.detail}.`)
          : pick(`${q(f.title)} is marked In progress.`, `Marked In progress: ${q(f.title)}.`, `In progress: ${q(f.title)}.`),
      );
      break;
    case 'waiting':
      lines.push(f.detail ? `Waiting: ${f.detail}. ${q(f.title)}.` : `Waiting: ${q(f.title)}.`);
      break;
    case 'queued':
      lines.push(`Today or Next: ${q(f.title)}.`);
      break;
    case 'untriaged':
      lines.push(`In the Inbox: ${q(f.title)}.`);
      break;
    case 'done':
      lines.push(`Completed: ${q(f.title)}.`);
      break;
    case 'idle':
      lines.push(pick('No tasks are marked In progress right now.', 'No tasks marked In progress.', 'Nothing In progress.'));
      break;
    case 'empty':
      lines.push(pick('No open tasks here. A quiet day for spells.', 'No open tasks in scope.', 'No open tasks.'));
      break;
  }
  if (verbosity >= 1 && f.next && f.kind !== 'done' && f.next !== f.detail) lines.push(`Next: ${f.next}.`);
  if (verbosity >= 1 && !f.selected && f.inProgress > 1 && f.kind !== 'idle') lines.push(`${f.inProgress} tasks marked In progress.`);
  if (verbosity >= 2 && f.lastReported) {
    const lr = f.lastReported;
    const when = lr.at ? relativeTime(lr.at, now) : 'time unknown';
    lines.push(`Source: ${lr.threadTitle || 'Claude thread'} · ${when}${lr.sharedWith ? ` · shared with ${lr.sharedWith} other task${lr.sharedWith === 1 ? '' : 's'}` : ''}`);
  }
  return lines.slice(0, verbosity + 1);
}

// ─── Freshness ───

export interface Freshness {
  /** Live connection to the server. When false, everything is the last known state. */
  live: boolean;
  /** Progress notes stopped loading. Separate from note age. */
  progressUnavailable: boolean;
  label: string | null;
}

export function freshness(conn: ConnStatus, progress: { lastOkAt: number | null; failures: number }, polling: boolean, pollMs: number, now: number): Freshness {
  const live = conn === 'live';
  const missed = polling && (progress.failures >= 2 || (progress.lastOkAt !== null && now - progress.lastOkAt > pollMs * 2 + 5000));
  const label = !live ? (conn === 'connecting' ? 'Connecting…' : 'Last known state') : missed ? 'Progress updates unavailable' : null;
  return { live, progressUnavailable: missed, label };
}

// ─── Completions ───

/**
 * Tasks the server has newly confirmed as done. Returns nothing on first load and after a
 * (re)sync, so reconnect replays and old Done tasks never celebrate. Optimistic ticks don't count:
 * this reads confirmed status only.
 */
export function newlyCompleted(prev: ReadonlyMap<string, Status> | null, next: ReadonlyMap<string, Status>, suppress: boolean): string[] {
  if (!prev || suppress) return [];
  const out: string[] = [];
  for (const [id, s] of next) if (s === 'done' && prev.has(id) && prev.get(id) !== 'done') out.push(id);
  return out;
}

/** Stable 0..1 number from a task id, for repeatable placement and motion. */
export function seed(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 100000) / 100000;
}
