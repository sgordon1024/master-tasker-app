import { AlertCircle, ArrowDown, ArrowUp, CalendarDays, Equal, Hourglass, Link2, ListChecks } from 'lucide-react';
import type { KeyboardEvent, ReactNode } from 'react';
import { PRIORITY_LABELS, STATUS_LABELS, STATUSES, type Area, type Priority, type Project, type Status, type Task } from '../../../shared/schema.ts';
import { areaColor } from '../areaColors.ts';
import { clip, cx, dueState, formatDue, longDate } from '../lib.ts';
import { SelectMenu } from './Menu.tsx';

/**
 * Arrow keys for a radiogroup of buttons (WAI-ARIA radio pattern): arrows and Home/End move the choice
 * and focus together. Pair it with roving tabindex: tabIndex={radioTab(selected, isFirst, anySelected)}.
 */
export function onRadioKeys<T>(e: KeyboardEvent<HTMLElement>, options: readonly T[], current: T, choose: (v: T) => void) {
  const step = ({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as Record<string, number>)[e.key];
  const edge = e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1 : null;
  if (step === undefined && edge === null) return;
  e.preventDefault();
  e.stopPropagation(); // the app's own arrow-key shortcuts move between tasks
  const at = options.indexOf(current);
  const i = edge ?? (Math.max(at, 0) + step + options.length) % options.length;
  if (i !== at) choose(options[i]);
  e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[i]?.focus();
}

/** Roving tabindex: only the checked radio is in the tab order, or the first if none is checked. */
export const radioTab = (checked: boolean, first: boolean, anyChecked: boolean) => (checked || (first && !anyChecked) ? 0 : -1);

export function AreaDot({ color, size = 8 }: { color: string; size?: number }) {
  return <span className="area-dot" style={{ background: areaColor(color), width: size, height: size }} aria-hidden="true" />;
}

export function PlacementChip({ area, project, compact = false }: { area?: Area; project?: Project; compact?: boolean }) {
  // Unfiled is the absence of a place, not worth a chip.
  if (!area) return null;
  const full = project ? `${area.name} / ${project.name}` : area.name;
  // Long names are shortened at a word, never mid-word. On a narrow card, a project goes by its own name:
  // the dot's color says the area, and the full place is in the title and read out.
  const shown = project ? (compact ? clip(project.name, 22) : `${clip(area.name, 18)} / ${clip(project.name, 22)}`) : clip(area.name, compact ? 22 : 28);
  return (
    <span className="chip chip-place" title={full}>
      <AreaDot color={area.color} />
      <span className="chip-text">
        {compact && project && <span className="sr-only">{area.name} / </span>}
        {shown}
      </span>
    </span>
  );
}

export function DueChip({ task }: { task: Pick<Task, 'dueDate' | 'status'> }) {
  if (!task.dueDate) return null;
  const state = dueState(task);
  return (
    <span className={cx('chip', state === 'overdue' && 'chip-danger', state === 'today' && 'chip-accent')} title={`Due ${longDate(task.dueDate)}`}>
      {state === 'overdue' ? <AlertCircle size={12} aria-hidden /> : <CalendarDays size={12} aria-hidden />}
      <span className="chip-text">
        {/* Read out in words: "Due Friday, October 16, overdue", not "Fri" or "Oct 12". */}
        <span className="sr-only">
          Due {longDate(task.dueDate)}
          {state === 'overdue' ? ', overdue' : ''}
        </span>
        <span aria-hidden="true">{state === 'overdue' ? `Overdue · ${formatDue(task.dueDate)}` : formatDue(task.dueDate)}</span>
      </span>
    </span>
  );
}

const PRIORITY_ICON: Record<Priority, ReactNode> = {
  high: <ArrowUp size={12} aria-hidden />,
  medium: <Equal size={12} aria-hidden />,
  low: <ArrowDown size={12} aria-hidden />,
  none: null,
};

export function PriorityChip({ priority }: { priority: Priority }) {
  if (priority === 'none') return null;
  // Low is plain quiet text. High is the only one with weight, and it says so with the arrow, not with red.
  if (priority === 'low')
    return (
      <span className="pri-low" title="Low priority">
        {PRIORITY_ICON.low}
        {PRIORITY_LABELS.low}
      </span>
    );
  return (
    <span className={cx('chip', `chip-pri-${priority}`)} title={`${PRIORITY_LABELS[priority]} priority`}>
      {PRIORITY_ICON[priority]}
      <span className="chip-text">{PRIORITY_LABELS[priority]}</span>
    </span>
  );
}

/**
 * A task's chips, in order of what matters: when it's due, what it's waiting on, priority, subtasks, links, then
 * where it lives. On a card they wrap to two lines at most, so the first ones always show whole.
 */
export function MetaChips({ task, area, project, showPlacement = true, compact = false }: { task: Task; area?: Area; project?: Project; showPlacement?: boolean; compact?: boolean }) {
  const doneSubs = task.subtasks.filter((s) => s.done).length;
  return (
    <>
      <DueChip task={task} />
      {task.status === 'waiting' && task.waitingOn && (
        <span className="chip chip-warning" title={`Waiting on ${task.waitingOn}`}>
          <Hourglass size={12} aria-hidden />
          <span className="chip-text">{clip(task.waitingOn, 32)}</span>
        </span>
      )}
      <PriorityChip priority={task.priority} />
      {task.subtasks.length > 0 && (
        <span className="chip" title={`${doneSubs} of ${task.subtasks.length} subtasks done`}>
          <ListChecks size={12} aria-hidden />
          <span className="chip-text num">
            <span className="sr-only">Subtasks </span>
            {doneSubs}/{task.subtasks.length}
          </span>
        </span>
      )}
      {task.links.length > 0 && (
        <span className="chip" title={`${task.links.length} source link${task.links.length > 1 ? 's' : ''}`}>
          <Link2 size={12} aria-hidden />
          <span className="chip-text num">{task.links.length}</span>
        </span>
      )}
      {showPlacement && <PlacementChip area={area} project={project} compact={compact} />}
      {/* Last and quiet: it says where the task came from, not what to do with it. */}
      {task.isSample && <span className="sample-mark">Sample</span>}
    </>
  );
}

export const STATUS_OPTIONS = STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] }));

/** Where a task stands, in the app's own menu. */
export function StatusSelect({ value, onChange, label = 'Status', className, align }: { value: Status; onChange: (s: Status) => void; label?: string; className?: string; align?: 'start' | 'end' }) {
  return <SelectMenu label={label} value={value} options={STATUS_OPTIONS} onChange={onChange} className={className} align={align} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function EmptyState({ icon, title, body, children }: { icon: ReactNode; title: string; body: ReactNode; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon" aria-hidden="true">
        {icon}
      </div>
      <h2 className="empty-title">{title}</h2>
      <p className="empty-body">{body}</p>
      {children && <div className="empty-actions">{children}</div>}
    </div>
  );
}
