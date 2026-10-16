// Work / Personal / Both. Each area is on the work or the personal side (set in Settings, synced).
// The switch itself is saved per browser, so your phone can stay on Personal while your Mac is on Work.
// Unfiled tasks show in every mode, so nothing you capture gets lost.
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Area, Proposal, Task } from '../../shared/schema.ts';
import { api } from './api.ts';

export type WorkMode = 'work' | 'personal' | 'both';
export const WORK_MODES: { id: WorkMode; label: string }[] = [
  { id: 'work', label: 'Work' },
  { id: 'personal', label: 'Personal' },
  { id: 'both', label: 'Both' },
];
const KEY = 'mt.mode';
const read = (): WorkMode => {
  const m = localStorage.getItem(KEY);
  return m === 'work' || m === 'personal' ? m : 'both';
};
let current = read();
const listeners = new Set<() => void>();

export function setWorkMode(m: WorkMode) {
  current = m;
  localStorage.setItem(KEY, m);
  listeners.forEach((fn) => fn());
}
export const nextWorkMode = (m: WorkMode): WorkMode => WORK_MODES[(WORK_MODES.findIndex((x) => x.id === m) + 1) % WORK_MODES.length].id;

export function useWorkMode(): WorkMode {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      // Another tab changed it.
      const onStorage = (e: StorageEvent) => {
        if (e.key === KEY) {
          current = read();
          fn();
        }
      };
      window.addEventListener('storage', onStorage);
      return () => {
        listeners.delete(fn);
        window.removeEventListener('storage', onStorage);
      };
    },
    () => current,
  );
}

/** Unfiled (or an area you can't see) shows everywhere. */
export const areaInMode = (area: Area | undefined, mode: WorkMode) => mode === 'both' || !area || area.mode === mode;
export const taskInMode = (task: Pick<Task, 'areaId'>, areas: Map<string, Area>, mode: WorkMode) =>
  mode === 'both' || !task.areaId || areaInMode(areas.get(task.areaId), mode);

/** The area a suggestion is about, if it can be told. */
export function proposalAreaId(p: Proposal, tasks: Map<string, Task>): string | null {
  const b = p.body;
  if (b.kind === 'create') return b.task.areaId ?? null;
  if (b.kind === 'question' && !b.taskId) return b.areaId ?? null;
  const taskId = 'taskId' in b ? b.taskId : undefined;
  return (taskId && tasks.get(taskId)?.areaId) || null;
}
export const proposalInMode = (p: Proposal, tasks: Map<string, Task>, areas: Map<string, Area>, mode: WorkMode) =>
  taskInMode({ areaId: proposalAreaId(p, tasks) }, areas, mode);

// Pending suggestions, shared by the sidebar and the phone tab bar so the badge can follow the mode.
let pending: { version: number; list: Proposal[] | null; loading: Promise<void> | null } = { version: -1, list: null, loading: null };
const pendingListeners = new Set<() => void>();
export function usePendingProposals(version: number): Proposal[] | null {
  const [, bump] = useState(0);
  useEffect(() => {
    const fn = () => bump((n) => n + 1);
    pendingListeners.add(fn);
    if (pending.version !== version && !pending.loading) {
      const v = version;
      pending.loading = api<{ proposals: Proposal[] }>('GET', '/api/proposals?status=pending&limit=100')
        .then((r) => {
          pending = { version: v, list: r.proposals, loading: null };
        })
        .catch(() => {
          pending = { ...pending, loading: null };
        })
        .finally(() => pendingListeners.forEach((f) => f()));
    }
    return () => {
      pendingListeners.delete(fn);
    };
  }, [version]);
  return pending.list;
}
