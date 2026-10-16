// Small per-browser choices: Labs switches, the first-run card and tour, whether you've tried Focus.
// Saved in localStorage and shared by every component that reads them, and across tabs.
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { RoutineInfo } from '../../shared/schema.ts';
import { api } from './api.ts';

const listeners = new Set<() => void>();
const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

export function setPref(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
  listeners.forEach((fn) => fn());
}

export function usePref(key: string): string | null {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      const onStorage = (e: StorageEvent) => e.key === key && fn();
      window.addEventListener('storage', onStorage);
      return () => {
        listeners.delete(fn);
        window.removeEventListener('storage', onStorage);
      };
    },
    () => read(key),
  );
}

export const LAB_WIZARD = 'mt.labs.wizard';
export const LAB_ROUTINES = 'mt.labs.routines';
export const FIRST_RUN_DISMISSED = 'mt.firstRun.dismissed';
export const TRIED_FOCUS = 'mt.firstRun.focus';
/** The tour: 'due' until you finish or skip it once, then 'seen'. Unset for anyone who used the app before it existed. */
export const TOUR = 'mt.tour';

/**
 * Call once, before anything saves a pref. A browser with no Master Tasker prefs at all is opening it for the
 * first time, so the tour is due. Someone who already uses the app doesn't get it pushed at them.
 */
export function noteFirstVisit() {
  try {
    if (!Object.keys(localStorage).some((k) => k.startsWith('mt.'))) localStorage.setItem(TOUR, 'due');
  } catch {}
}

let routineCount: number | null = null;
let loading: Promise<void> | null = null;
/** How many routines the Claude app has scheduled. Routines shows in the nav when there are any. */
export function useRoutineCount(): number | null {
  const [n, setN] = useState(routineCount);
  useEffect(() => {
    if (routineCount !== null) return;
    loading ??= api<{ routines: RoutineInfo[] }>('GET', '/api/sources')
      .then((r) => void (routineCount = r.routines.length))
      .catch(() => void (routineCount = 0));
    void loading.then(() => setN(routineCount));
  }, []);
  return n;
}

/** Wizard and Routines show in the nav only when turned on in Settings > Labs (Routines also when one exists). */
export function useLabs() {
  const wizard = usePref(LAB_WIZARD) === '1';
  const routinesOn = usePref(LAB_ROUTINES) === '1';
  const count = useRoutineCount();
  return { wizard, routines: routinesOn || (count ?? 0) > 0, routinesOn, routineCount: count };
}
