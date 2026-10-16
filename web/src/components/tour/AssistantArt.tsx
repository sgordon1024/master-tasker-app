// Step 3: an AI assistant, any of them, plans a task into steps and ticks off what it can.
// The step only you can do turns red and goes to For you. The spark is generic: no app's mark.
import { ClipboardCheck, Hand } from 'lucide-react';
import { Arrow, Art, at, Box, Spark, Tick } from './parts.tsx';

const LABEL = 'A diagram. Your AI assistant plans a task into steps and checks off two of them. One step, pick the hero photo, needs you. It shows in red and goes to For you, where only you can check it off.';

function Badge({ cx, cy, r }: { cx: number; cy: number; r: number }) {
  return (
    <g className="ta-in" style={at(0)}>
      <circle className="ta-spark-bg" cx={cx} cy={cy} r={r} />
      <Spark x={cx - r * 0.06} y={cy + r * 0.06} r={r * 0.46} />
      <Spark x={cx + r * 0.46} y={cy - r * 0.44} r={r * 0.19} />
    </g>
  );
}

/** The task's steps: two done by the assistant, one that needs you, and one still to do. */
function Steps({ x, y, w, last = true }: { x: number; y: number; w: number; last?: boolean }) {
  const tx = x + 30;
  return (
    <g>
      <g className="ta-fade" style={at(420)}>
        <Tick cx={x + 14} cy={y} done d={620} />
        <text className="ta-title is-done" x={tx} y={y + 4.5}>
          Sketch the screens
        </text>
        <path className="ta-rule" d={`M${tx} ${y + 18.5} H${x + w - 12}`} />
        <Tick cx={x + 14} cy={y + 36} done d={820} />
        <text className="ta-title is-done" x={tx} y={y + 40.5}>
          Write the button labels
        </text>
      </g>
      <g className="ta-in" style={at(1000)}>
        <Box className="ta-you-row" x={x - 6} y={y + 58} w={w} h={60} r={10} />
        <rect className="ta-you" x={x + 4} y={y + 66} width={92} height={20} rx={10} />
        <Hand className="ta-icon-you-ink" x={x + 10} y={y + 70} size={12} strokeWidth={2.5} aria-hidden />
        <text className="ta-you-text" x={x + 26} y={y + 80}>
          Needs you
        </text>
        <Tick cx={x + 14} cy={y + 100} />
        <text className="ta-title is-strong" x={tx} y={y + 104.5}>
          Pick the hero photo
        </text>
      </g>
      {last && (
        <g className="ta-fade" style={at(420)}>
          <Tick cx={x + 14} cy={y + 138} />
          <text className="ta-title" x={tx} y={y + 142.5}>
            Test with two people
          </text>
        </g>
      )}
    </g>
  );
}

/** For you in the sidebar, with its red count. */
function ForYou({ x, y }: { x: number; y: number }) {
  return (
    <g className="ta-in" style={at(1320)}>
      <Box className="ta-box ta-raised" x={x} y={y} w={166} h={36} />
      <ClipboardCheck className="ta-icon-you" x={x + 12} y={y + 10} size={16} aria-hidden />
      <text className="ta-nav" x={x + 36} y={y + 22.5}>
        For you
      </text>
      <g className="ta-pop" style={at(1460)}>
        <rect className="ta-you" x={x + 134} y={y + 9} width={22} height={18} rx={9} />
        <text className="ta-badge" x={x + 145} y={y + 22} textAnchor="middle">
          1
        </text>
      </g>
    </g>
  );
}

export function AssistantArt({ compact }: { compact: boolean }) {
  return compact ? <Compact /> : <Wide />;
}

function Wide() {
  return (
    <Art w={616} h={280} label={LABEL}>
      <Badge cx={32} cy={128} r={24} />
      <text className="ta-label ta-fade" x={32} y={172} textAnchor="middle" style={at(80)}>
        Assistant
      </text>
      <Arrow from={[62, 128]} to={[96, 128]} d={180} />

      <g className="ta-in" style={at(260)}>
        <Box className="ta-box ta-raised" x={104} y={16} w={304} h={248} r={12} />
        <text className="ta-step" x={122} y={46}>
          Redesign onboarding
        </text>
        <Spark x={127} y={61} r={5} />
        <text className="ta-hint" x={138} y={65.5}>
          Planned by your assistant
        </text>
      </g>
      <Steps x={120} y={98} w={284} />

      <Arrow from={[414, 185]} to={[442, 185]} d={1180} />
      <ForYou x={450} y={167} />
      <text className="ta-hint ta-fade" x={450} y={228} style={at(1460)}>
        Only you can check it off
      </text>
    </Art>
  );
}

function Compact() {
  return (
    <Art w={320} h={300} label={LABEL}>
      <Badge cx={18} cy={18} r={18} />
      <text className="ta-hint ta-fade" x={46} y={22.5} style={at(80)}>
        Your assistant planned the steps
      </text>
      <g className="ta-in" style={at(260)}>
        <Box className="ta-box ta-raised" x={0} y={44} w={320} h={184} r={12} />
        <text className="ta-step" x={16} y={72}>
          Redesign onboarding
        </text>
      </g>
      <Steps x={14} y={98} w={300} last={false} />
      <Arrow from={[83, 232]} to={[83, 256]} d={1180} />
      <ForYou x={0} y={262} />
      <g className="ta-fade" style={at(1460)}>
        <text className="ta-hint" x={180} y={277}>
          Only you can
        </text>
        <text className="ta-hint" x={180} y={294}>
          check it off
        </text>
      </g>
    </Art>
  );
}
