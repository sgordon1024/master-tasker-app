// Step 1: Add puts it in Inbox, and sorting moves it onto the board, filed under an area.
// The one task that moves glides from its Inbox slot to Today and gets its area chip.
import { Plus } from 'lucide-react';
import { Arrow, Art, at, Box, Card, Chip, Column, Stub, type ChipSpec } from './parts.tsx';

const WORK: ChipSpec = { label: 'Work', area: 1, w: 54 };
const PERSONAL: ChipSpec = { label: 'Personal', area: 6, w: 75 };
const LABEL = 'A diagram. The Add field puts a task in Inbox. Sorting moves it to the Today column of the board, filed under Work. Next and Waiting hold other sorted tasks.';

function AddField({ w }: { w: number }) {
  return (
    <g className="ta-in" style={at(0)}>
      <Box className="ta-box ta-raised" x={0} y={0} w={w} h={40} r={12} />
      <Plus className="ta-icon" x={12} y={12} size={16} aria-hidden />
      <text className="ta-hint" x={36} y={24.5}>
        Add to Inbox
      </text>
    </g>
  );
}

/** The task you sort. It sits in Inbox, glides to Today, then shows its area. */
function Sorted({ x, y, w, fx, fy }: { x: number; y: number; w: number; fx: number; fy: number }) {
  return (
    <g className="ta-glide" style={at(640, { '--fx': `${fx}px`, '--fy': `${fy}px` })}>
      <Card x={x} y={y} w={w} h={58} title="Send invoice" top />
      <Chip x={x + 8} y={y + 30} {...WORK} className="ta-fade" style={at(1180)} />
    </g>
  );
}

export function CaptureArt({ compact }: { compact: boolean }) {
  return compact ? <Compact /> : <Wide />;
}

function Wide() {
  const cols = [
    { x: 184, name: 'Today' },
    { x: 332, name: 'Next' },
    { x: 480, name: 'Waiting' },
  ];
  return (
    <Art w={616} h={280} label={LABEL}>
      <AddField w={136} />
      <Arrow from={[68, 46]} to={[68, 72]} d={140} />

      <g className="ta-in" style={at(120)}>
        <Column x={0} y={80} w={136} h={200} name="Inbox" />
        <Box className="ta-slot" x={8} y={114} w={120} h={58} />
        <Card x={8} y={180} w={120} h={40} title="Book dentist" />
        <Card x={8} y={228} w={120} h={40} title="Idea: new icons" />
      </g>

      <g className="ta-fade" style={at(220)}>
        <text className="ta-label" x={184} y={12}>
          Board
        </text>
        <path className="ta-bracket" d="M184.5 27 V20.5 H615.5 V27" />
      </g>
      {cols.map((c, i) => (
        <Column key={c.name} x={c.x} y={32} w={136} h={248} name={c.name} className="ta-in" style={at(220 + i * 60)} />
      ))}
      <g className="ta-fade" style={at(420)}>
        <Stub x={192} y={132} w={120} bar={56} />
        <Card x={340} y={66} w={120} h={58} title="Audit forms" chip={WORK} />
        <Stub x={340} y={132} w={120} />
        <Stub x={340} y={180} w={120} bar={48} />
        <Card x={488} y={66} w={120} h={58} title="Trip dates" chip={PERSONAL} />
      </g>

      <Arrow from={[144, 143]} to={[174, 143]} d={480} />
      <text className="ta-label ta-fade" x={159} y={133} textAnchor="middle" style={at(480)}>
        Sort
      </text>
      <Sorted x={192} y={66} w={120} fx={-184} fy={48} />
    </Art>
  );
}

function Compact() {
  const cols = [
    { x: 0, name: 'Today' },
    { x: 108, name: 'Next' },
    { x: 216, name: 'Waiting' },
  ];
  return (
    <Art w={320} h={300} label={LABEL}>
      <AddField w={320} />
      <Arrow from={[52, 46]} to={[52, 68]} d={140} />

      <g className="ta-in" style={at(120)}>
        <Column x={0} y={74} w={320} h={96} name="Inbox" />
        <Box className="ta-slot" x={8} y={104} w={96} h={58} />
        <Card x={112} y={104} w={100} h={40} title="Book dentist" />
        <Card x={220} y={104} w={92} h={40} title="New icons" />
      </g>

      <Arrow from={[160, 178]} to={[160, 202]} d={480} />
      <text className="ta-label ta-fade" x={170} y={194} style={at(480)}>
        Sort
      </text>
      <text className="ta-label ta-fade" x={0} y={198} style={at(220)}>
        Board
      </text>
      {cols.map((c, i) => (
        <Column key={c.name} x={c.x} y={208} w={104} h={92} name={c.name} className="ta-in" style={at(220 + i * 60)} />
      ))}
      <g className="ta-fade" style={at(420)}>
        <Card x={112} y={236} w={96} h={58} title="Audit forms" chip={WORK} />
        <Card x={220} y={236} w={96} h={58} title="Trip dates" chip={PERSONAL} />
      </g>
      <Sorted x={4} y={236} w={96} fx={4} fy={-132} />
    </Art>
  );
}
