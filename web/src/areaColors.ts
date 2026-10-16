// Area colors. Eight hues around the wheel, skipping the red that means Needs you and Overdue.
// An area stores the light-mode hex (the server checks for #rrggbb). The app paints each one with
// a CSS variable instead, so it gets a lighter value in dark mode. tokens.css holds both values.

export interface AreaColor {
  hex: string;
  name: string;
}

export const AREA_PALETTE: AreaColor[] = [
  { hex: '#526AC3', name: 'Indigo' },
  { hex: '#8A57AE', name: 'Violet' },
  { hex: '#AC5701', name: 'Orange' },
  { hex: '#058379', name: 'Teal' },
  { hex: '#867003', name: 'Olive' },
  { hex: '#AB4A7D', name: 'Rose' },
  { hex: '#3F842E', name: 'Green' },
  { hex: '#077CA4', name: 'Blue' },
];

/** The colors an area can be, the same ones new areas get in turn. */
export const AREA_COLORS = AREA_PALETTE.map((c) => c.hex);

// The palette before these, kept so an area saved with one still gets its mode-aware color.
const OLD_PALETTE = ['#2563EB', '#7C3AED', '#C2410C', '#0F766E', '#B45309', '#BE185D', '#4D7C0F', '#0369A1'];

/** The CSS color to paint an area with: its palette variable when it has one, else the saved hex. */
export function areaColor(hex: string): string {
  const h = hex.toUpperCase();
  const i = AREA_COLORS.indexOf(h);
  const j = i >= 0 ? i : OLD_PALETTE.indexOf(h);
  return j >= 0 ? `var(--area-${j + 1})` : hex;
}
