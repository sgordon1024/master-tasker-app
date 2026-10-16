import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Check, GripVertical, Hand, Sparkles } from 'lucide-react';
import { memo, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Area, Project, Status, Task } from '../../../shared/schema.ts';
import { claudeIsOn, clip, cx, idleStep, needsYouItems, plain, relativeTime } from '../lib.ts';
import { useProgress } from '../progress.ts';
import { store, useIntegrations } from '../store.ts';
import { claudeInTerminal, claudeReady, workWithClaude } from '../claude.ts';
import { COLLAPSE_MS, finishTask, useFinishPhase } from '../finish.ts';
import { MetaChips, StatusSelect } from './Bits.tsx';

export interface ItemProps {
  task: Task;
  area?: Area;
  project?: Project;
  variant: 'row' | 'card';
  selected: boolean;
  /** Picked for a bulk action (Shift-click, Cmd-click, Shift+J/K). */
  picked?: boolean;
  editing: boolean;
  /** Open it, or with Shift or Cmd held, pick it for a bulk action. */
  onOpen: (id: string, mods?: { shift: boolean; meta: boolean }) => void;
  onEditDone: () => void;
  showPlacement?: boolean;
  sortable?: boolean;
  container?: string;
  /** The status the list it's in stands for. Its status label only shows at rest when it's different. */
  groupStatus?: Status | null;
}

export const TaskItem = memo(function TaskItem(props: ItemProps) {
  const { task, sortable = true } = props;
  const phase = useFinishPhase(task.id);
  const s = useSortable({
    id: task.id,
    disabled: !sortable || phase !== null,
    data: { container: props.container, task },
    attributes: { role: 'listitem', roleDescription: 'draggable task' },
  });
  const style = { transform: CSS.Translate.toString(s.transform), transition: s.transition };
  // dnd-kit marks a row it can't drag as aria-disabled, but the row still opens and takes keys. Only say
  // "draggable" where it is.
  const { 'aria-disabled': _disabled, 'aria-roledescription': roleDesc, 'aria-pressed': pressed, ...attrs } = s.attributes;
  const a11y = sortable ? { ...attrs, 'aria-roledescription': roleDesc, 'aria-pressed': pressed } : attrs;
  const needs = needsYouItems(task);
  const loud = needs.length > 0;
  // The label is the short name; the banner and the In progress line are read after it as the description.
  const descId = useId();
  const doing = task.status === 'doing';
  const described = [loud && `${descId}-you`, doing && `${descId}-now`].filter(Boolean).join(' ') || undefined;
  const el = useRef<HTMLDivElement | null>(null);
  // Folding away: the row's height goes to nothing, so the rows below slide up instead of jumping.
  useLayoutEffect(() => {
    const node = el.current;
    if (phase !== 'collapsing' || !node) return;
    const h = node.offsetHeight;
    const a = node.animate(
      [
        { height: `${h}px`, opacity: 1 },
        { height: '0px', opacity: 0, paddingTop: '0px', paddingBottom: '0px', marginTop: '0px', marginBottom: '0px', borderWidth: '0px' },
      ],
      { duration: COLLAPSE_MS, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards' },
    );
    return () => a.cancel();
  }, [phase]);
  return (
    <div
      ref={(n) => {
        s.setNodeRef(n);
        el.current = n;
      }}
      style={style}
      {...a11y}
      {...s.listeners}
      className={cx(
        'task',
        `task-${props.variant}`,
        props.selected && 'is-selected',
        props.picked && 'is-picked',
        (task.status === 'done' || phase) && 'is-done',
        phase && 'is-finishing',
        task.status === 'doing' && 'is-doing',
        loud && 'needs-you',
        s.isDragging && 'is-dragging',
        task.rev === 0 && 'is-saving',
      )}
      data-task-id={task.id}
      data-container={props.container}
      tabIndex={0}
      aria-label={`${needs.length ? 'Needs you: ' : ''}${task.title}${doing ? ', in progress' : ''}${task.status === 'done' ? ', done' : ''}${props.picked ? ', selected' : ''}`}
      aria-describedby={described}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button, input, select, a, textarea')) return;
        props.onOpen(task.id, { shift: e.shiftKey, meta: e.metaKey || e.ctrlKey });
      }}
    >
      {needs.length > 0 && <NeedsYouBanner id={`${descId}-you`} items={needs} />}
      <TaskInner {...props} descId={descId} finishing={phase !== null} />
    </div>
  );
});

function TaskInner({ task, area, project, variant, editing, onEditDone, showPlacement, container, descId, finishing, groupStatus }: ItemProps & { descId: string; finishing: boolean }) {
  const done = task.status === 'done' || finishing;
  const finishedBy = task.finishedBy?.by.trim() || 'Your assistant';
  return (
    <>
      {variant === 'row' && (
        <span className="task-grip" aria-hidden="true">
          <GripVertical size={14} />
        </span>
      )}
      <button
        type="button"
        className={cx('check', done && 'is-checked', finishing && 'is-popping')}
        role="checkbox"
        aria-checked={done}
        aria-label={done ? `Reopen ${task.title}` : `Complete ${task.title}`}
        onClick={(e) => {
          e.stopPropagation();
          if (!finishing) finishTask(task.id);
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <Check size={12} strokeWidth={3} aria-hidden />
      </button>
      <div className="task-main">
        {editing ? <InlineTitle task={task} onDone={onEditDone} /> : <span className="task-title">{task.title}</span>}
        {task.nextAction && !done && variant === 'card' && task.status !== 'doing' && <span className="task-next">Next: {task.nextAction}</span>}
        {task.status === 'doing' && <DoingNow task={task} id={`${descId}-now`} />}
        <div className="task-meta">
          {task.status === 'doing' && container !== 'doing' && (
            <span className="chip chip-doing">
              <span className="doing-dot" aria-hidden /> In progress
            </span>
          )}
          {task.status === 'done' && task.finishedBy && (
            <span className="chip chip-finished" title={task.finishedBy.why || `${finishedBy} finished this`}>
              <Check size={11} strokeWidth={3} aria-hidden /> Finished by {clip(finishedBy, 24)}
            </span>
          )}
          <MetaChips task={task} area={area} project={project} showPlacement={showPlacement} compact={variant === 'card'} />
        </div>
      </div>
      {variant === 'row' && (
        <div className={cx('task-trailing', groupStatus !== task.status && !done && 'shows-status')} onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <StatusSelect className="select-btn-compact status-select" align="end" value={task.status} label={`Status of ${task.title}`} onChange={(status) => store.updateTask(task.id, { status })} />
        </div>
      )}
    </>
  );
}

/** Loud on purpose: something only you can do. It stays until you check it off or clear it. */
function NeedsYouBanner({ id, items, label = 'Needs you' }: { id: string; items: string[]; label?: string }) {
  return (
    <div className="you-banner" title={items.join('\n')}>
      <span className="you-label">
        <Hand size={13} aria-hidden strokeWidth={2.5} /> {label}
      </span>
      <span className="you-text" id={id}>
        {items[0]}
        {items.length > 1 && <span className="sr-only">, and {items.length - 1} more</span>}
      </span>
      {items.length > 1 && <span className="you-more num" aria-hidden>+{items.length - 1}</span>}
    </div>
  );
}

/** On an In progress card: the subtask being worked on, and Claude's latest decision or reply in smaller text. */
function DoingNow({ task, id }: { task: Task; id: string }) {
  const p = useProgress(task.id);
  const open = task.subtasks.filter((x) => !x.done);
  // No Claude running it: show Claude's next step instead of the last one it was on, with a way to get it going.
  const idle = idleStep(task, claudeIsOn(p));
  // The way to get it going only shows once Claude is set up. Before that the card just shows the step.
  const integrations = useIntegrations();
  const ready = claudeReady(integrations);
  const terminal = claudeInTerminal(integrations);
  const current = (ready && !idle && p?.subtaskId && open.find((x) => x.id === p.subtaskId && !x.needsYou)) || null;
  const shown = current ?? (idle?.id ? open.find((x) => x.id === idle.id) : null) ?? open[0] ?? null;
  const note = ready ? p?.note : undefined;
  if (!shown && !note && !task.nextAction) return null;
  // "Up next" is Claude's next step when no thread is on it. Without Claude it's simply the step you're on now.
  const label = current ? 'Now' : ready && idle ? 'Up next' : 'Now';
  return (
    <div className="doing-now" id={id}>
      {shown ? (
        <span className={cx('now-subtask', current && 'is-current')} title={current ? 'Claude said it is on this subtask' : 'First open subtask'}>
          <span className="now-label">{label}</span>
          <span className="now-title">{shown.title}</span>
        </span>
      ) : (
        task.nextAction && <span className="task-next">Next: {task.nextAction}</span>
      )}
      {idle &&
        ready &&
        (p?.sessionId ? (
          <button type="button" className="now-start" title={terminal ? "Its Claude thread stopped. Copies a prompt that picks up where it left off, to paste into Claude Code in Terminal." : "Its Claude thread stopped and can't see changes on its own. Opens a new thread that picks up where it left off: press Enter there."} onClick={() => workWithClaude(task.id, { pickUp: true })}>
            <Sparkles size={12} aria-hidden /> Claude stopped · Pick up
          </button>
        ) : (
          <button type="button" className="now-start" title={terminal ? 'No Claude thread is on this. Copies a prompt that starts here, to paste into Claude Code in Terminal.' : 'No Claude thread is on this. Opens a new one that starts here: press Enter there.'} onClick={() => workWithClaude(task.id, { subtaskId: idle.id ?? undefined })}>
            <Sparkles size={12} aria-hidden /> Claude isn't on it · Start
          </button>
        ))}
      {note && p && (
        <span className="now-note" title={`From "${p.threadTitle}"${p.noteAt ? `, ${relativeTime(p.noteAt)}` : ''}`}>
          <Sparkles size={12} aria-hidden className="now-note-icon" />
          {p.noteKind === 'decision' && <strong>Decided: </strong>}
          {plain(note)}
          {p.noteAt && <span className="now-when"> · {relativeTime(p.noteAt)}</span>}
        </span>
      )}
    </div>
  );
}

function InlineTitle({ task, onDone }: { task: Task; onDone: () => void }) {
  const [value, setValue] = useState(task.title);
  const baseRev = useRef(task.rev);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = () => {
    const title = value.trim();
    if (title && title !== task.title) store.updateTask(task.id, { title }, { baseRev: baseRev.current });
    onDone();
  };
  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') onDone();
  };
  return (
    <input
      ref={ref}
      className="inline-input"
      value={value}
      aria-label="Task title"
      maxLength={500}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={onKey}
      onPointerDown={(e) => e.stopPropagation()}
    />
  );
}
