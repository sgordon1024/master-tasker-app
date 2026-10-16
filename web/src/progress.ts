// What Claude is doing on each In progress task, read locally from linked Claude Code threads.
// Polled only while something is in progress and the tab is visible. No AI runs for this.
import { useEffect, useSyncExternalStore } from 'react';
import type { ClaudeThread, Task, TaskProgress } from '../../shared/schema.ts';
import { api } from './api.ts';

export const POLL_MS = 20_000;
let byTask = new Map<string, TaskProgress>();
/** When progress last loaded, and how many fetches have failed since. */
export interface ProgressMeta {
  lastOkAt: number | null;
  failures: number;
}
let meta: ProgressMeta = { lastOkAt: null, failures: 0 };
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export async function refreshProgress() {
  try {
    const { progress } = await api<{ progress: TaskProgress[] }>('GET', '/api/progress');
    byTask = new Map(progress.map((p) => [p.taskId, p]));
    meta = { lastOkAt: Date.now(), failures: 0 };
  } catch {
    // Progress is a nice-to-have. The connection indicator already reports outages.
    meta = { ...meta, failures: meta.failures + 1 };
  }
  notify();
}

/** Every task's progress, for views that show many tasks at once. */
export const useAllProgress = (): ReadonlyMap<string, TaskProgress> => useSyncExternalStore(subscribe, () => byTask);
export const useProgressMeta = (): ProgressMeta => useSyncExternalStore(subscribe, () => meta);

export function useProgress(taskId: string): TaskProgress | undefined {
  return useSyncExternalStore(subscribe, () => byTask.get(taskId));
}

/** Keeps progress fresh while any task is In progress. */
export function useProgressPolling(active: boolean, key: string) {
  useEffect(() => {
    if (!active) return;
    refreshProgress();
    const tick = () => document.visibilityState === 'visible' && refreshProgress();
    const timer = setInterval(tick, POLL_MS);
    window.addEventListener('focus', tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', tick);
    };
  }, [active, key]);
}

/** An empty task: just a title. Claude asks about it first, then fills it out. */
export const isEmptyTask = (t: Task) => !t.notes.trim() && !t.nextAction.trim() && t.subtasks.length === 0 && t.links.length === 0;

/**
 * The reference you paste into a Claude thread. It starts the /master-tasker skill, which fills
 * out, plans, files and works the task. Its task id is how the thread gets linked.
 */
export function claudeReference(task: Task): string {
  const open = task.subtasks.filter((s) => !s.done).map((s) => `- ${s.title}${s.needsYou ? ' (needs me)' : ''}`);
  return [
    `/master-tasker ${task.id}`,
    '',
    `Master Tasker task ${task.id}: ${task.title}`,
    ...(isEmptyTask(task)
      ? ['This task is empty. Ask me what it is, fill it out and file it, then plan and work it.']
      : [...(task.nextAction ? [`Next action: ${task.nextAction}`] : []), ...(open.length ? ['Open subtasks:', ...open] : [])]),
    'While you work, start a line with:',
    '- "Now on: <subtask>" when you switch subtasks',
    '- "Decision: <one line>" for key decisions',
    '- "Done: <subtask>" when you finish one (it gets ticked off)',
    '- "Needs you: <subtask or what I must decide or do> | <the context I need: what, where, your recommendation>" when it is on me. Only I check those off.',
  ].join('\n');
}

export const fetchThreads = (taskId: string, refresh = false) =>
  api<{ threads: ClaudeThread[] }>('GET', `/api/tasks/${taskId}/threads${refresh ? '?refresh=1' : ''}`).then((r) => r.threads);
export const unlinkThread = (taskId: string, sessionId: string) =>
  api<{ threads: ClaudeThread[] }>('POST', `/api/tasks/${taskId}/threads/${encodeURIComponent(sessionId)}/unlink`, {}).then((r) => r.threads);
