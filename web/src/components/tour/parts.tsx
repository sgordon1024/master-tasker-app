// The tour's drawing kit: the app's own shapes, simplified. Cards, chips, columns, the check, arrows and a spark.
// Everything is drawn at 1:1, so 12px here is 12px on screen. Colors come from tokens through classes in tour.css.
import type { CSSProperties, ReactNode } from 'react';
import { cx } from '../../lib.ts';

/** When a part arrives, in ms after the picture starts. Each part arrives once and then stays still. */
export const at = (ms: number, more?: Record<string, string>) => ({ '--d': `${ms}ms`, ...more }) as CSSProperties;

export function Art({ w, h, label, children }: { w: number; h: number; label: string; children: ReactNode }) {
  return (
    <svg className="ta" viewBox={`0 0 ${w} ${h}`} width={w} height={h} role="img" aria-label={label}>
      {children}
    </svg>
  );
}

/** A rectangle on the half pixel, so its 1px line is crisp. */
export function Box({ x, y, w, h, r = 8, className }: { x: number; y: number; w: number; h: number; r?: number; className?: string }) {
  return <rect className={className} x={x + 0.5} y={y + 0.5} width={w - 1} height={h - 1} rx={r} />;
}

/** A board column, or the Inbox: the desk color, with its name at the top. */
export function Column({ x, y, w, h, name, className, style }: { x: number; y: number; w: number; h: number; name: string; className?: string; style?: CSSProperties }) {
  return (
    <g className={className} style={style}>
      <rect className="ta-col" x={x} y={y} width={w} height={h} rx={16} />
      <text className="ta-label" x={x + 14} y={y + 22}>
        {name}
      </text>
    </g>
  );
}

export interface ChipSpec {
  label: string;
  /** Which area color, 1 to 8, as in tokens.css. */
  area: number;
  w: number;
}

/** An area chip: a dot in the area's color and its name, on the chip wash. */
export function Chip({ x, y, label, area, w, className, style }: ChipSpec & { x: number; y: number; className?: string; style?: CSSProperties }) {
  return (
    <g className={className} style={style}>
      <rect className="ta-chip" x={x} y={y} width={w} height={20} rx={10} />
      <circle cx={x + 10} cy={y + 10} r={3.5} style={{ fill: `var(--area-${area})` }} />
      <text className="ta-chip-text" x={x + 18} y={y + 14}>
        {label}
      </text>
    </g>
  );
}

/** A task card: a title, and an area chip when it has been sorted. `top` keeps the title up top for a chip drawn later. */
export function Card({ x, y, w, h, title, chip, top = !!chip, className, style }: { x: number; y: number; w: number; h: number; title: string; chip?: ChipSpec; top?: boolean; className?: string; style?: CSSProperties }) {
  return (
    <g className={className} style={style}>
      <Box className="ta-box" x={x} y={y} w={w} h={h} />
      <text className="ta-title" x={x + 10} y={top ? y + 22 : y + h / 2 + 4.5}>
        {title}
      </text>
      {chip && <Chip x={x + 8} y={y + 30} {...chip} />}
    </g>
  );
}

/** A card with no words: one more task, said quietly. */
export function Stub({ x, y, w, h = 40, bar = 64, className, style }: { x: number; y: number; w: number; h?: number; bar?: number; className?: string; style?: CSSProperties }) {
  return (
    <g className={className} style={style}>
      <Box className="ta-box" x={x} y={y} w={w} h={h} />
      <rect className="ta-stub" x={x + 10} y={y + h / 2 - 3} width={bar} height={6} rx={3} />
    </g>
  );
}

/** The round check. Done fills it green and pops, once, like the real one. */
export function Tick({ cx: x, cy: y, done = false, d = 0 }: { cx: number; cy: number; done?: boolean; d?: number }) {
  return (
    <g>
      <circle className="ta-tick" cx={x} cy={y} r={7.25} />
      {done && (
        <g className="ta-tick-done ta-pop" style={at(d)}>
          <circle cx={x} cy={y} r={8} />
          <path d={`M${x - 3.5} ${y + 0.25} l2.4 2.4 l4.6 -4.8`} />
        </g>
      )}
    </g>
  );
}

/** A line with a small open head that draws itself once. A bend makes it a gentle curve. */
export function Arrow({ from, to, bend, d = 0 }: { from: [number, number]; to: [number, number]; bend?: [number, number]; d?: number }) {
  const [x1, y1] = from;
  const [x2, y2] = to;
  const [qx, qy] = bend ?? [(x1 + x2) / 2, (y1 + y2) / 2];
  const a = Math.atan2(y2 - qy, x2 - qx);
  const wing = (s: number) => `${(x2 - 6 * Math.cos(a + s)).toFixed(2)} ${(y2 - 6 * Math.sin(a + s)).toFixed(2)}`;
  return (
    <g className="ta-arrow">
      <path className="ta-draw" d={`M${x1} ${y1} Q${qx} ${qy} ${x2} ${y2}`} pathLength={1} style={at(d)} />
      <path className="ta-fade" d={`M${wing(0.62)} L${x2} ${y2} L${wing(-0.62)}`} style={at(d + 220)} />
    </g>
  );
}

/** A four-point spark: an assistant at work. Generic on purpose, so it stands for any AI app. */
export function Spark({ x, y, r, className }: { x: number; y: number; r: number; className?: string }) {
  const k = r * 0.22;
  const p = (dx: number, dy: number) => `${(x + dx).toFixed(2)} ${(y + dy).toFixed(2)}`;
  return (
    <path
      className={cx('ta-spark', className)}
      d={`M${p(0, -r)} C${p(k, -k)} ${p(k, -k)} ${p(r, 0)} C${p(k, k)} ${p(k, k)} ${p(0, r)} C${p(-k, k)} ${p(-k, k)} ${p(-r, 0)} C${p(-k, -k)} ${p(-k, -k)} ${p(0, -r)}Z`}
    />
  );
}
