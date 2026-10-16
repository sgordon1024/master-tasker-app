// Step 2: a few tasks on Today, one In progress, Focus on its next step, and where you stand.
// The ring fills from 1 to 2 of 5 and today's bar grows, once.
import { Zap } from 'lucide-react';
import { Arrow, Art, at, Box, Tick } from './parts.tsx';

const LABEL = 'A diagram. On Today, one task is In progress. Focus shows its next step, step 2 of 3, with a Done, next step button. Beside it, a ring shows 2 of 5 done, and bars show this week.';
const DAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const TODAY = 2;

function Row({ y, title, done = false, d = 0 }: { y: number; title: string; done?: boolean; d?: number }) {
  return (
    <g>
      <Tick cx={14} cy={y} done={done} d={d} />
      <text className={done ? 'ta-title is-done' : 'ta-title'} x={32} y={y + 4.5}>
        {title}
      </text>
    </g>
  );
}

/** The In progress row: the accent wash and a thin outline all the way round, and its chip. */
function Doing({ y, w }: { y: number; w: number }) {
  return (
    <g className="ta-in" style={at(140)}>
      <Box className="ta-doing" x={0} y={y} w={w} h={60} r={10} />
      <Tick cx={14} cy={y + 20} />
      <text className="ta-title is-strong" x={32} y={y + 24.5}>
        Redesign onboarding
      </text>
      <rect className="ta-chip" x={32} y={y + 32} width={92} height={20} rx={10} />
      <Zap className="ta-icon-accent" x={38} y={y + 36} size={12} aria-hidden />
      <text className="ta-chip-text is-strong" x={54} y={y + 46}>
        In progress
      </text>
    </g>
  );
}

/** Focus, small: the dots, the step, and its one button. */
function FocusFrame({ x, y, w, h, title }: { x: number; y: number; w: number; h: number; title: string[] }) {
  const mid = x + w / 2;
  const two = title.length > 1;
  const top = y + (two ? 38 : 18);
  const go = two ? y + h - 62 : y + h - 40;
  return (
    <g className="ta-in" style={at(440)}>
      <Box className="ta-page ta-raised" x={x} y={y} w={w} h={h} r={16} />
      <circle className="ta-dot-done" cx={mid - 12} cy={top} r={3.5} />
      <circle className="ta-dot-now ta-pop" cx={mid} cy={top} r={4.5} style={at(640)} />
      <circle className="ta-dot-open" cx={mid + 12} cy={top} r={3.25} />
      <text className="ta-label" x={mid} y={top + 24} textAnchor="middle">
        Step 2 of 3
      </text>
      {title.map((line, i) => (
        <text key={line} className="ta-step" x={mid} y={top + (two ? 56 : 50) + i * 22} textAnchor="middle">
          {line}
        </text>
      ))}
      <rect className="ta-go" x={mid - 58} y={go} width={116} height={30} rx={15} />
      <text className="ta-go-text" x={mid} y={go + 19.5} textAnchor="middle">
        Done, next step
      </text>
    </g>
  );
}

/** "2 of 5 done" with the ring, and this week's bars. */
function Standing({ cx, cy, r, text, bars }: { cx: number; cy: number; r: number; text: { x: number; y: number; anchor?: 'middle' }; bars: { x: number; bottom: number; w: number; step: number; heights: number[]; label?: { x: number; y: number } } }) {
  const c = 2 * Math.PI * r;
  return (
    <g>
      <g className="ta-in" style={at(820)}>
        <circle className="ta-ring-track" cx={cx} cy={cy} r={r} />
        <circle
          className="ta-ring-fill"
          cx={cx}
          cy={cy}
          r={r}
          strokeDasharray={c.toFixed(2)}
          strokeDashoffset={(c * 0.6).toFixed(2)}
          transform={`rotate(-90 ${cx} ${cy})`}
          style={at(980, { '--ring-from': `${(c * 0.8).toFixed(2)}px` })}
        />
        <text className="ta-count" x={text.x} y={text.y} textAnchor={text.anchor}>
          2 of 5 done
        </text>
      </g>
      <g className="ta-fade" style={at(880)}>
        {bars.label && (
          <text className="ta-label" x={bars.label.x} y={bars.label.y}>
            This week
          </text>
        )}
        {DAYS.map((day, i) => {
          const x = bars.x + i * bars.step;
          const h = bars.heights[i];
          return (
            <g key={i}>
              <rect
                className={i === TODAY ? 'ta-bar is-today ta-grow' : i > TODAY ? 'ta-bar is-later' : 'ta-bar'}
                x={x}
                y={bars.bottom - h}
                width={bars.w}
                height={h}
                rx={Math.min(3, bars.w / 2)}
                style={i === TODAY ? at(1060) : undefined}
              />
              <text className={i === TODAY ? 'ta-day is-today' : 'ta-day'} x={x + bars.w / 2} y={bars.bottom + 17} textAnchor="middle">
                {day}
              </text>
            </g>
          );
        })}
      </g>
    </g>
  );
}

export function FocusArt({ compact }: { compact: boolean }) {
  return compact ? <Compact /> : <Wide />;
}

function Wide() {
  return (
    <Art w={616} h={280} label={LABEL}>
      <g className="ta-in" style={at(0)}>
        <text className="ta-head" x={0} y={30}>
          Today
        </text>
        <Row y={62} title="Send invoice" done d={260} />
        <Row y={178} title="Pick up groceries" />
        <path className="ta-rule" d="M32 198.5 H216" />
        <Row y={218} title="Book dentist" />
      </g>
      <Doing y={90} w={216} />
      <Arrow from={[222, 120]} to={[250, 120]} d={380} />

      <text className="ta-label ta-fade" x={256} y={30} style={at(440)}>
        Focus
      </text>
      <FocusFrame x={256} y={40} w={184} h={200} title={['Write the', 'button labels']} />
      <Arrow from={[446, 140]} to={[466, 140]} d={760} />

      <Standing
        cx={490}
        cy={140}
        r={16}
        text={{ x: 514, y: 144.5 }}
        bars={{ x: 474, bottom: 234, w: 12, step: 20, heights: [22, 34, 18, 3, 3, 3, 3], label: { x: 474, y: 186 } }}
      />
    </Art>
  );
}

function Compact() {
  return (
    <Art w={320} h={300} label={LABEL}>
      <g className="ta-in" style={at(0)}>
        <text className="ta-head" x={0} y={14}>
          Today
        </text>
        <Row y={40} title="Send invoice" done d={260} />
      </g>
      <Doing y={62} w={320} />
      <Arrow from={[98, 128]} to={[98, 172]} d={380} />
      <text className="ta-label ta-fade" x={108} y={155} style={at(440)}>
        Focus
      </text>
      <FocusFrame x={0} y={180} w={196} h={120} title={['Write button labels']} />
      <Arrow from={[202, 202]} to={[244, 202]} d={760} />
      <Standing
        cx={266}
        cy={202}
        r={14}
        text={{ x: 266, y: 236, anchor: 'middle' }}
        bars={{ x: 220, bottom: 274, w: 8, step: 14, heights: [16, 24, 12, 3, 3, 3, 3] }}
      />
    </Art>
  );
}
