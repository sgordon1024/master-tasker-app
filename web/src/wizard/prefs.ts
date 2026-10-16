// The Wizard's stage settings. Kept per browser, presentation only: none of these touch tasks,
// Claude threads, cost or concurrency, and nothing here is ever sent anywhere.
import { useCallback, useSyncExternalStore } from 'react';

export type Quality = 'auto' | 'normal' | 'low' | 'static';

export interface WizardPrefs {
  v: 1;
  bluntness: number;
  happiness: number;
  caffeine: number;
  verbosity: 0 | 1 | 2;
  clutter: number;
  /** null follows the device: on for a mouse, off for touch. */
  followCursor: boolean | null;
  paused: boolean;
  quality: Quality;
}

export const DEFAULT_PREFS: WizardPrefs = { v: 1, bluntness: 55, happiness: 60, caffeine: 35, verbosity: 1, clutter: 40, followCursor: null, paused: false, quality: 'auto' };

const KEY = 'mt.wizard';
const clamp = (n: unknown, lo: number, hi: number, d: number) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d);

/** Reads anything, returns valid prefs. Corrupt or old records fall back to defaults field by field. */
export function parsePrefs(raw: unknown): WizardPrefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_PREFS;
  return {
    v: 1,
    bluntness: clamp(r.bluntness, 0, 100, d.bluntness),
    happiness: clamp(r.happiness, 0, 100, d.happiness),
    caffeine: clamp(r.caffeine, 0, 100, d.caffeine),
    verbosity: clamp(r.verbosity, 0, 2, d.verbosity) as 0 | 1 | 2,
    clutter: clamp(r.clutter, 0, 100, d.clutter),
    followCursor: typeof r.followCursor === 'boolean' ? r.followCursor : null,
    paused: r.paused === true,
    quality: (['auto', 'normal', 'low', 'static'] as const).includes(r.quality as Quality) ? (r.quality as Quality) : d.quality,
  };
}

function load(): WizardPrefs {
  try {
    return parsePrefs(JSON.parse(localStorage.getItem(KEY) ?? 'null'));
  } catch {
    return DEFAULT_PREFS;
  }
}

let current: WizardPrefs | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
const get = () => (current ??= load());

export function setPrefs(patch: Partial<WizardPrefs>) {
  current = parsePrefs({ ...get(), ...patch });
  listeners.forEach((fn) => fn());
  // The screen updates on every tick; the disk write waits for the knob to settle.
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(current));
    } catch {
      // Private mode or full storage: settings just won't stick.
    }
  }, 300);
}

export function useWizardPrefs(): [WizardPrefs, (patch: Partial<WizardPrefs>) => void] {
  const prefs = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    get,
  );
  return [prefs, useCallback(setPrefs, [])];
}

/** Personality only. Stage settings (motion, quality, clutter) keep their values. */
export const resetPersonality = () => setPrefs({ bluntness: DEFAULT_PREFS.bluntness, happiness: DEFAULT_PREFS.happiness, caffeine: DEFAULT_PREFS.caffeine, verbosity: DEFAULT_PREFS.verbosity });

/** Test hook: forget the in-memory copy so the next read comes from storage. */
export const _resetPrefsCache = () => {
  current = null;
};
