// Small device facts the Wizard reacts to: reduced motion, touch vs mouse, tab visibility.
import { useSyncExternalStore } from 'react';

function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (fn) => {
      const m = matchMedia(query);
      m.addEventListener('change', fn);
      return () => m.removeEventListener('change', fn);
    },
    () => matchMedia(query).matches,
  );
}

export const useReducedMotion = () => useMedia('(prefers-reduced-motion: reduce)');
export const useFinePointer = () => useMedia('(pointer: fine)');
export const useNarrow = () => useMedia('(max-width: 760px)');

export function useTabVisible(): boolean {
  return useSyncExternalStore(
    (fn) => {
      document.addEventListener('visibilitychange', fn);
      return () => document.removeEventListener('visibilitychange', fn);
    },
    () => document.visibilityState === 'visible',
  );
}
