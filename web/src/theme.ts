// Appearance: light or dark mode plus a color theme. Saved in this browser only.
// A theme only sets Baseline's seed tokens, so every derived color follows it.
// Each theme has a darker accent for light mode (white text on it) and a brighter one for
// dark mode (dark text on it). All pairs were checked for at least 4.5:1 contrast.

export type Mode = 'system' | 'light' | 'dark';

export interface ColorTheme {
  id: string;
  name: string;
  light: string;
  dark: string;
  hue: number; // neutral tint
  chroma: number; // how strongly neutrals take the tint
}

export const THEMES: ColorTheme[] = [
  { id: 'baseline', name: 'Baseline Blue', light: '#2F5BEA', dark: '#7B97F8', hue: 255, chroma: 0.006 },
  { id: 'lagoon', name: 'Lagoon', light: '#0F766E', dark: '#3CD3C0', hue: 190, chroma: 0.012 },
  { id: 'forest', name: 'Forest', light: '#17663A', dark: '#5ADB8C', hue: 150, chroma: 0.014 },
  { id: 'honey', name: 'Honey', light: '#9A5B05', dark: '#F5C542', hue: 80, chroma: 0.014 },
  { id: 'lavender', name: 'Lavender', light: '#6650CC', dark: '#BCB0F7', hue: 285, chroma: 0.018 },
  { id: 'graphite', name: 'Graphite', light: '#434B58', dark: '#C5CBD5', hue: 250, chroma: 0.004 },
];

// Themes from before there were six. A saved one moves to the closest that's left.
// The pink and red ones went because red means Needs you and Overdue.
const RETIRED: Record<string, string> = {
  grape: 'lavender',
  bubblegum: 'lavender',
  synthwave: 'lavender',
  tangerine: 'honey',
  cherry: 'honey',
  coral: 'honey',
  espresso: 'honey',
  matcha: 'forest',
  midnight: 'baseline',
  arctic: 'baseline',
};

const MODE_KEY = 'mt.theme';
const COLOR_KEY = 'mt.color';
const DARK_INK = '#0F1114';
const PAINT_KEY = 'mt.paint';

export const getMode = (): Mode => {
  const m = localStorage.getItem(MODE_KEY);
  return m === 'light' || m === 'dark' ? m : 'system';
};
export const getColorTheme = (): ColorTheme => {
  const saved = localStorage.getItem(COLOR_KEY) ?? '';
  return THEMES.find((t) => t.id === (RETIRED[saved] ?? saved)) ?? THEMES[0];
};
export const systemIsDark = () => matchMedia('(prefers-color-scheme: dark)').matches;
export const isDark = (mode = getMode()) => mode === 'dark' || (mode === 'system' && systemIsDark());

export function setAppearance(next: { mode?: Mode; color?: string }) {
  if (next.mode) localStorage.setItem(MODE_KEY, next.mode);
  if (next.color) localStorage.setItem(COLOR_KEY, next.color);
  applyTheme();
}

export function applyTheme() {
  const dark = isDark();
  const t = getColorTheme();
  if (localStorage.getItem(COLOR_KEY) && localStorage.getItem(COLOR_KEY) !== t.id) localStorage.setItem(COLOR_KEY, t.id);
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  root.style.setProperty('--seed-accent', dark ? t.dark : t.light);
  root.style.setProperty('--seed-neutral-hue', String(t.hue));
  root.style.setProperty('--seed-neutral-chroma', String(t.chroma));
  root.style.setProperty('--accent-on', dark ? DARK_INK : '#FFFFFF');
  // What public/theme-boot.js needs to paint the right theme before the app loads.
  localStorage.setItem(PAINT_KEY, JSON.stringify({ light: t.light, dark: t.dark, hue: t.hue, chroma: t.chroma, lightOn: '#FFFFFF', darkOn: DARK_INK }));
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#121417' : '#fdfdfe');
}
