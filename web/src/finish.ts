// Finishing a task: the check fills, the row stays struck through for a moment, then folds away.
// The task is marked done right away. Only how it leaves the list waits.
import { useSyncExternalStore } from 'react';
import type { Status } from '../../shared/schema.ts';
import { store } from './store.ts';

export const STRUCK_MS = 700;
export const COLLAPSE_MS = 240;

type Phase = 'struck' | 'collapsing';
let finishing = new Map<string, { from: Status; phase: Phase }>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());
const set = (next: Map<string, { from: Status; phase: Phase }>) => {
  finishing = next;
  notify();
};

export const reducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** If focus is on the row that's leaving, move it to the next task so the keyboard doesn't lose its place. */
function handOffFocus(id: string) {
  const row = document.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(id)}"]`);
  if (!row || !row.contains(document.activeElement)) return;
  const all = [...document.querySelectorAll<HTMLElement>('[data-task-id]')].filter((el) => !el.classList.contains('is-finishing'));
  const after = all.find((el) => row.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
  (after ?? all[all.length - 1])?.focus();
}

/** Mark a task done with the finishing moment. Done tasks reopen right away, with no moment. */
export function finishTask(id: string) {
  const t = store.getSnapshot().byId.get(id);
  if (!t) return;
  if (t.status === 'done') return store.reopen(id);
  set(new Map(finishing).set(id, { from: t.status, phase: 'struck' }));
  store.complete(id);
  setTimeout(() => {
    const still = store.getSnapshot().byId.get(id)?.status === 'done';
    if (!still || reducedMotion()) return end(id);
    handOffFocus(id);
    set(new Map(finishing).set(id, { from: t.status, phase: 'collapsing' }));
    setTimeout(() => end(id), COLLAPSE_MS);
  }, STRUCK_MS);
}

function end(id: string) {
  if (!finishing.has(id)) return;
  handOffFocus(id);
  const next = new Map(finishing);
  next.delete(id);
  set(next);
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
/** Every task that's on its way out, and where it was. Lists keep it in place until it has gone. */
export const useFinishing = () => useSyncExternalStore(subscribe, () => finishing);
export const useFinishPhase = (id: string): Phase | null => useSyncExternalStore(subscribe, () => finishing.get(id)?.phase ?? null);
