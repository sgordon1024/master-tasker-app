import { openFocus } from './Focus.tsx';
import { AlertCircle, ArrowDown, ArrowUp, CalendarDays, Check, ChevronLeft, Copy, Equal, ExternalLink, GripVertical, Hand, Lock, MoreHorizontal, Pause, Play, Plus, RefreshCw, RotateCcw, Sparkles, Target, Trash2, Undo2, Unlink, X } from 'lucide-react';
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, TouchSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { PRIORITY_LABELS, STATUS_LABELS, type ActivityEntry, type ClaudeThread, type Area, type Priority, type Project, type Task, type TaskPatchFields } from '../../../shared/schema.ts';
import { api } from '../api.ts';
import { fetchThreads, isEmptyTask, refreshProgress, unlinkThread, useProgress } from '../progress.ts';
import { addDays, claudeIsOn, cx, dueState, idleStep, longDate, needsYouItems, plain, relativeTime, sentence, todayIso } from '../lib.ts';
import { NeedsYouActions } from './NeedsYou.tsx';
import { CLAUDE_SETUP_HASH, claudeInTerminal, claudeReady, copyPrompt, openClaudeSetup, openThread, workWithClaude, workWithClaudeLabel } from '../claude.ts';
import { store, useIntegrations, useStore } from '../store.ts';
import { copyAssistantPrompt, openAssistants, useConnectedAssistants } from '../assistants.ts';
import { finishTask } from '../finish.ts';
import { ActorBadge } from './ActorBadge.tsx';
import { StatusSelect } from './Bits.tsx';
import { Menu, SelectMenu, type MenuEntry, type SelectOption } from './Menu.tsx';

interface Props {
  task: Task;
  areas: Area[];
  projects: Project[];
  onClose: () => void;
}

export function TaskDetail({ task, areas, projects, onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panelRef.current?.focus();
  }, [task.id]);
  const done = task.status === 'done';
  const areaProjects = projects.filter((p) => p.areaId === task.areaId && !p.archived);
  const update = (patch: TaskPatchFields, baseRev?: number) => store.updateTask(task.id, patch, { baseRev });
  const integrations = useIntegrations();
  const ready = claudeReady(integrations);
  const assistants = useConnectedAssistants();
  // Fields you don't need every time stay behind "+ Add" until you ask for them, or until they have something in them.
  const [adding, setAdding] = useState<Record<string, boolean>>({});
  useEffect(() => setAdding({}), [task.id]);
  const showPlace = !!task.areaId || adding.place;
  const showLinks = task.links.length > 0 || adding.link;
  const showYou = !task.needsYou && adding.you;
  const chips = [
    !showPlace && { id: 'place', label: 'Area or project' },
    !showLinks && { id: 'link', label: 'Link' },
    !task.needsYou && !showYou && { id: 'you', label: 'Needs you' },
  ].filter(Boolean) as { id: string; label: string }[];
  const reveal = (id: string) => {
    setAdding((a) => ({ ...a, [id]: true }));
    requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>(`[data-reveal="${id}"] input, [data-reveal="${id}"] select`)?.focus());
  };
  // Claude set up: Claude's own buttons. Any other assistant: a prompt to paste into it. Both: both. None yet: a way to connect one.
  const othersConnected = (assistants ?? []).some((n) => n !== 'Claude');
  const forOthers: MenuEntry[] = othersConnected
    ? [{ label: 'Copy prompt for your assistant', icon: <Copy size={14} aria-hidden />, onSelect: () => void copyAssistantPrompt(task) }]
    : [];
  const assistantItems: MenuEntry[] = ready
    ? [
        { label: workWithClaudeLabel(integrations), icon: claudeInTerminal(integrations) ? <Copy size={14} aria-hidden /> : <Sparkles size={14} aria-hidden />, onSelect: () => void workWithClaude(task.id) },
        // With only Claude Code, the item above already copies a prompt.
        ...(claudeInTerminal(integrations) ? [] : [{ label: othersConnected ? 'Copy prompt for Claude' : 'Copy prompt', icon: <Copy size={14} aria-hidden />, onSelect: () => void copyPrompt(task) }]),
        ...forOthers,
      ]
    : assistants?.length
      ? [{ label: 'Copy prompt for your assistant', icon: <Copy size={14} aria-hidden />, onSelect: () => void copyAssistantPrompt(task) }]
      : [{ label: 'Connect an AI assistant', icon: <Sparkles size={14} aria-hidden />, onSelect: openAssistants }];
  const menu: MenuEntry[] = [
    ...(!done ? [{ label: 'Focus', icon: <Target size={14} aria-hidden />, hint: 'F', onSelect: () => openFocus(task.id) }] : []),
    ...(task.rev > 0 ? assistantItems : []),
    { separator: true },
    { label: 'Move to Trash', icon: <Trash2 size={14} aria-hidden />, hint: 'Del', danger: true, onSelect: () => { store.deleteTask(task.id); onClose(); } },
  ];

  return (
    <aside className="detail" aria-label="Task details" ref={panelRef} tabIndex={-1} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <DetailResizer />
      <div className="detail-head">
        <button type="button" className="icon-btn detail-back" aria-label="Back" onClick={onClose}>
          <ChevronLeft size={22} aria-hidden />
          <span className="detail-back-text">Back</span>
        </button>
        <button type="button" className={cx('btn', done ? 'btn-secondary' : 'btn-primary', 'btn-sm')} onClick={() => (done ? store.reopen(task.id) : finishTask(task.id))}>
          {done ? <RotateCcw size={14} aria-hidden /> : <Check size={14} aria-hidden />}
          {done ? 'Reopen' : 'Mark done'}
        </button>
        {!done && (
          <button type="button" className={cx('btn btn-secondary btn-sm', task.status === 'doing' && 'btn-doing')} onClick={() => store.toggleDoing(task.id)} title="Start or stop working on this (S)">
            {task.status === 'doing' ? <Pause size={14} aria-hidden /> : <Play size={14} aria-hidden />}
            {task.status === 'doing' ? 'Stop' : 'Start'}
          </button>
        )}
        <div className="detail-head-spacer" />
        <Menu label="More actions" trigger={<MoreHorizontal size={18} aria-hidden />} items={menu} />
        <button type="button" className="icon-btn detail-close" aria-label="Close details" title="Close (Esc)" onClick={onClose}>
          <X size={18} aria-hidden />
        </button>
      </div>

      <div className="detail-body">
        <NeedsYouPanel task={task} />
        <DraftText key={`${task.id}-title`} task={task} field="title" label="Title" className="detail-title" multiline required onCommit={update} />
        {task.isSample && <p className="meta-line detail-sample"><span className="chip chip-sample">Sample</span> One of the sample tasks. Clear them all from Today.</p>}
        {ready && <ClaudeBar task={task} />}

        <div className="field-grid field-grid-3">
          <MenuField label="Status">
            <StatusSelect value={task.status} onChange={(status) => update({ status })} />
          </MenuField>
          <MenuField label="Priority">
            <SelectMenu label="Priority" value={task.priority} options={PRIORITY_OPTIONS} onChange={(priority) => update({ priority })} />
          </MenuField>
          <MenuField label="Due">
            <DueMenu task={task} onChange={(dueDate) => update({ dueDate })} />
          </MenuField>
        </div>

        {task.status === 'waiting' && <DraftText key={`${task.id}-waiting`} task={task} field="waitingOn" label="Waiting on" placeholder="What or whom you're waiting on" onCommit={update} />}
        <DraftText key={`${task.id}-next`} task={task} field="nextAction" label="Next action" placeholder="The very next physical step" onCommit={update} />
        <Subtasks task={task} />
        <DraftText key={`${task.id}-notes`} task={task} field="notes" label="Notes" placeholder="Context, details, decisions" multiline rows={5} onCommit={update} />

        {showPlace && (
          <div className="field-grid" data-reveal="place">
            <Field label="Area">
              <select className="select" value={task.areaId ?? ''} onChange={(e) => update({ areaId: e.target.value || null, projectId: null })}>
                <option value="">Unfiled</option>
                {areas.filter((a) => !a.archived || a.id === task.areaId).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Project">
              <select className="select" value={task.projectId ?? ''} disabled={!task.areaId} onChange={(e) => update({ projectId: e.target.value || null })}>
                <option value="">{task.areaId ? 'No project' : 'Pick an area first'}</option>
                {areaProjects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        )}
        {showLinks && (
          <div data-reveal="link">
            <Links task={task} onCommit={update} />
          </div>
        )}
        {/* While it's set, the red panel at the top shows it, with its buttons. */}
        {showYou && (
          <div data-reveal="you">
            <DraftText key={`${task.id}-you`} task={task} field="needsYou" label="Needs you" placeholder="Something only you can decide or do. It stays loud until you clear it." onCommit={update} />
          </div>
        )}
        {chips.length > 0 && (
          <div className="add-chips" role="group" aria-label="Add to this task">
            {chips.map((c) => (
              <button key={c.id} type="button" className="chip chip-add" onClick={() => reveal(c.id)}>
                <Plus size={12} aria-hidden /> {c.label}
              </button>
            ))}
          </div>
        )}

        <details className="detail-more">
          <summary>Details</summary>
          <ClaudeThreads task={task} />
          <History task={task} />
        </details>
      </div>
    </aside>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label eyebrow">{label}</span>
      {children}
    </label>
  );
}

/** A field whose control is a menu button. The button names itself ("Priority: High"), so this is only the heading. */
function MenuField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field">
      <span className="field-label eyebrow" aria-hidden>{label}</span>
      {children}
    </div>
  );
}

const PRIORITY_OPTIONS: SelectOption<Priority>[] = [
  { value: 'none', label: PRIORITY_LABELS.none },
  { value: 'low', label: PRIORITY_LABELS.low, icon: <ArrowDown size={14} aria-hidden /> },
  { value: 'medium', label: PRIORITY_LABELS.medium, icon: <Equal size={14} aria-hidden /> },
  { value: 'high', label: PRIORITY_LABELS.high, icon: <ArrowUp size={14} aria-hidden /> },
];

const SHORT_DATE = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const SHORT_DATE_YEAR = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const shortDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return (y === new Date().getFullYear() ? SHORT_DATE : SHORT_DATE_YEAR).format(new Date(y, m - 1, d));
};

/** The due date as a chip that opens a menu: Today, Tomorrow, Next week, any date, or none. Never clipped. */
function DueMenu({ task, onChange }: { task: Task; onChange: (d: string | null) => void }) {
  const today = todayIso();
  const [y, m, d] = today.split('-').map(Number);
  const monday = addDays(today, 7 - ((new Date(y, m - 1, d).getDay() + 6) % 7));
  const overdue = dueState(task) === 'overdue';
  const quick = [
    { label: 'Today', date: today },
    { label: 'Tomorrow', date: addDays(today, 1) },
    { label: 'Next week', date: monday },
  ];
  return (
    <Menu
      plain
      label="Due date"
      buttonLabel={task.dueDate ? `Due: ${longDate(task.dueDate)}${overdue ? ', overdue' : ''}` : 'Due: none'}
      tooltip={false}
      align="end"
      className={cx('select-btn due-btn', overdue && 'is-overdue', !task.dueDate && 'is-empty')}
      trigger={
        <>
          {overdue ? <AlertCircle size={14} aria-hidden /> : <CalendarDays size={14} aria-hidden />}
          <span className="select-btn-value">{task.dueDate ? shortDate(task.dueDate) : 'No date'}</span>
        </>
      }
      items={() => [
        ...quick.map((q) => ({ label: q.label, hint: shortDate(q.date), checked: task.dueDate === q.date, onSelect: () => onChange(q.date) })),
        { separator: true as const },
        {
          key: 'pick',
          render: (close: () => void) => (
            <label className="menu-date">
              <span className="menu-date-label">Pick a date</span>
              <input
                className="input input-sm"
                type="date"
                data-menu-focus
                defaultValue={task.dueDate ?? ''}
                onChange={(e) => {
                  // Typed dates arrive a digit at a time: only a whole, real year counts.
                  const v = e.target.value;
                  if (/^\d{4}-\d{2}-\d{2}$/.test(v) && Number(v.slice(0, 4)) >= 1900) onChange(v);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    close();
                  }
                  if (e.key !== 'Tab' && e.key !== 'Escape') e.stopPropagation();
                }}
              />
            </label>
          ),
        },
        ...(task.dueDate ? [{ separator: true as const }, { label: 'No due date', icon: <X size={14} aria-hidden />, onSelect: () => onChange(null) }] : []),
      ]}
    />
  );
}

type TextField = 'title' | 'notes' | 'nextAction' | 'waitingOn' | 'needsYou';

/**
 * A text field that keeps your draft while you type, even if the task changes elsewhere.
 * The revision is captured when you start editing, so the server can tell if someone else
 * changed the same field in the meantime. It will never be overwritten silently.
 * Notes save themselves 800ms after you stop typing, and when the page closes. Esc saves too.
 */
function DraftText({ task, field, label, placeholder, multiline, rows = 2, required, className, onCommit }: {
  task: Task;
  field: TextField;
  label: string;
  placeholder?: string;
  multiline?: boolean;
  rows?: number;
  required?: boolean;
  className?: string;
  onCommit: (patch: TaskPatchFields, baseRev?: number) => void;
}) {
  const serverValue = task[field];
  const [draft, setDraft] = useState<string | null>(null);
  const start = useRef<{ rev: number; value: string } | null>(null);
  const value = draft ?? serverValue;
  const changedElsewhere = draft !== null && start.current !== null && serverValue !== start.current.value;
  const id = `f-${task.id}-${field}`;
  const autosave = field === 'notes';
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<string | null>(null);
  latest.current = draft;

  const begin = () => {
    if (start.current) return;
    start.current = { rev: task.rev, value: serverValue };
    setDraft(serverValue);
  };
  /** Save what's typed. `keep` keeps editing (autosave); otherwise the field lets go of its draft. */
  const save = (keep: boolean, o: { keepalive?: boolean } = {}) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const s = start.current;
    const typed = latest.current;
    if (!keep) start.current = null;
    if (typed === null || !s) return keep ? undefined : setDraft(null);
    const next = field === 'title' ? typed.trim() : typed;
    if (!((required && !next) || next === s.value)) {
      store.updateTask(task.id, { [field]: next } as TaskPatchFields, { baseRev: s.rev, keepalive: o.keepalive });
      // The same edit carrying on: later saves still compare against where you started, so nothing from elsewhere is lost.
      if (keep) start.current = { rev: s.rev, value: next };
    }
    if (!keep) setDraft(null);
  };
  useEffect(() => {
    if (!autosave) return;
    const flush = () => save(true, { keepalive: true });
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      // Leaving the task with a save still waiting: send it now.
      if (timer.current) save(true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autosave, task.id]);
  const common = {
    id,
    className: cx(multiline ? 'textarea' : 'input', className),
    value,
    placeholder,
    onFocus: begin,
    onBlur: () => save(false),
    onChange: (e: { target: { value: string } }) => {
      setDraft(e.target.value);
      latest.current = e.target.value;
      if (!autosave) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => save(true), 800);
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      e.stopPropagation();
      // Esc never throws away what you typed: it saves and leaves the field.
      if (e.key === 'Escape') (e.target as HTMLElement).blur();
      if (e.key === 'Enter' && (!multiline || field === 'title') && !e.shiftKey) {
        e.preventDefault();
        (e.target as HTMLElement).blur();
      }
    },
  };
  return (
    <div className="field">
      <label className="field-label eyebrow" htmlFor={id}>
        {label}
      </label>
      {multiline ? <textarea {...common} rows={field === 'title' ? 1 : rows} /> : <input {...common} />}
      {changedElsewhere && (
        <p className="field-warning" role="status">
          This changed somewhere else while you were typing. If you save, you will be asked which version to keep.
        </p>
      )}
    </div>
  );
}

/** The loud version, at the top of the task. Subtasks are cleared by checking them off below. */
function NeedsYouPanel({ task }: { task: Task }) {
  if (!needsYouItems(task).length) return null;
  return (
    <div className="you-panel" role="status">
      <span className="you-label">
        <Hand size={14} aria-hidden strokeWidth={2.5} /> Needs you
      </span>
      <NeedsYouActions task={task} />
    </div>
  );
}

/** A subtask row you can drag by its handle (or pick up with Space and move with the arrow keys). */
function SortableSubtask({ id, title, sortable, className, children }: { id: string; title: string; sortable: boolean; className: string | false | undefined; children: ReactNode }) {
  const s = useSortable({ id, disabled: !sortable });
  return (
    <li ref={s.setNodeRef} style={{ transform: CSS.Translate.toString(s.transform), transition: s.transition }} className={cx(className, s.isDragging && 'is-dragging')}>
      {sortable && (
        <button type="button" className="subtask-grip" aria-label={`Move ${title}`} title="Drag to reorder" {...s.attributes} {...s.listeners}>
          <GripVertical size={13} aria-hidden />
        </button>
      )}
      {children}
    </li>
  );
}

function Subtasks({ task }: { task: Task }) {
  const [title, setTitle] = useState('');
  const progress = useProgress(task.id);
  const claudeOn = claudeIsOn(progress);
  // Claude's next step while no thread is running it. Same glimmer, plus a way to start Claude on it. Only once Claude is set up.
  const integrations = useIntegrations();
  const ready = claudeReady(integrations);
  const terminal = claudeInTerminal(integrations);
  const idleId = ready ? idleStep(task, claudeOn)?.id ?? null : null;
  // The step being worked: the one Claude said it's on, else its next open step (the card's "Up next").
  const currentId =
    task.status !== 'doing' ? null : !claudeOn ? idleId : progress?.subtaskId ?? task.subtasks.find((s) => !s.done && !s.needsYou)?.id ?? null;
  const done = task.subtasks.filter((s) => s.done).length;
  // You can drag subtasks into any order, unless your assistant planned them as steps that must happen in sequence.
  const canSort = !task.subtasksOrdered && task.subtasks.length > 1 && task.rev > 0 && !task.subtasks.some((s) => s.id.startsWith('tmp_'));
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const ids = task.subtasks.map((s) => s.id);
    store.reorderSubtasks(task.id, arrayMove(ids, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id))));
  };
  return (
    <div className="field">
      <span className="field-label eyebrow subtasks-head">
        Subtasks {task.subtasks.length > 0 && <span className="num">· {done}/{task.subtasks.length}</span>}
        {task.subtasksOrdered && task.subtasks.length > 1 && (
          <button type="button" className="subtasks-lock" title="Your assistant planned these as steps that happen in this order. Unlock to drag them around." onClick={() => store.setSubtasksOrdered(task.id, false)}>
            <Lock size={11} aria-hidden /> In order · Unlock to reorder
          </button>
        )}
      </span>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={task.subtasks.map((s) => s.id)} strategy={verticalListSortingStrategy}>
      <ul className="subtasks">
        {task.subtasks.map((s) => (
          <SortableSubtask key={s.id} id={s.id} title={s.title} sortable={canSort} className={cx('subtask', s.done && 'is-done', s.needsYou && !s.done ? 'needs-you' : s.id === currentId && 'is-current', s.id === idleId && 'is-idle')}>
            {s.id === currentId && !s.needsYou && <span className="sr-only">{s.id === idleId ? "Claude's next step, not running: " : 'Claude is on this now: '}</span>}
            <button
              type="button"
              role="checkbox"
              aria-checked={s.done}
              className={cx('check check-sub', s.done && 'is-checked')}
              aria-label={`Done: ${s.title}`}
              onClick={() => store.updateSubtask(task.id, s.id, { done: !s.done })}
            >
              <Check size={10} strokeWidth={3} aria-hidden />
            </button>
            <SubtaskTitle taskId={task.id} id={s.id} title={s.title} />
            {s.id === currentId && !s.needsYou && progress?.note && (
              <span className="subtask-thinking" title={progress.threadTitle}>
                <Sparkles size={12} aria-hidden /> {progress.noteKind === 'decision' && <strong>Decided: </strong>}
                {plain(progress.note)}
              </span>
            )}
            {s.needsYou && !s.done && (
              <span className="subtask-you-tag">
                <Hand size={11} aria-hidden strokeWidth={2.5} /> You
              </span>
            )}
            {s.id === idleId && !s.needsYou && (
              <span className="subtask-idle-tag" title="Claude's step, but no Claude thread is running it. Press play to work on it with Claude.">
                Claude's turn
              </span>
            )}
            {!s.done && (
              s.needsYou ? (
                <button
                  type="button"
                  className="btn btn-sm subtask-hand-back"
                  aria-label={`Hand back ${s.title}`}
                  title="Not yours after all. Unflags it so your assistant can do it."
                  onClick={() => store.updateSubtask(task.id, s.id, { needsYou: false })}
                >
                  <Undo2 size={13} aria-hidden /> Hand back
                </button>
              ) : (
                <>
                {ready && (
                  <button
                    type="button"
                    className="icon-btn icon-btn-sm icon-btn-flag subtask-start"
                    aria-label={`Work on ${s.title} with Claude`}
                    title={terminal ? 'Copies a prompt that starts with this subtask, to paste into Claude Code in Terminal' : 'Work on this with Claude: opens a new Claude thread that starts with this subtask'}
                    onClick={() => workWithClaude(task.id, { subtaskId: s.id })}
                  >
                    <Sparkles size={14} aria-hidden />
                  </button>
                )}
                <button
                  type="button"
                  className="icon-btn icon-btn-sm icon-btn-flag"
                  aria-label={`Flag ${s.title} as needing you`}
                  title="Flag as something only you can do"
                  onClick={() => store.updateSubtask(task.id, s.id, { needsYou: true })}
                >
                  <Hand size={14} aria-hidden />
                </button>
                </>
              )
            )}
            <button type="button" className="icon-btn icon-btn-sm" aria-label={`Remove subtask ${s.title}`} onClick={() => store.deleteSubtask(task.id, s.id)}>
              <X size={14} aria-hidden />
            </button>
          </SortableSubtask>
        ))}
      </ul>
      </SortableContext>
      </DndContext>
      <form
        className="add-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim()) return;
          store.addSubtask(task.id, title.trim());
          setTitle('');
        }}
      >
        <Plus size={14} aria-hidden className="add-row-icon" />
        <input className="input input-quiet" value={title} placeholder="Add a subtask" aria-label="New subtask" maxLength={500} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      </form>
    </div>
  );
}

/** Once Claude is set up: one quiet button to hand the task to Claude. Copy prompt and Set up Claude are in the ⋯ menu. */
function ClaudeBar({ task }: { task: Task }) {
  const progress = useProgress(task.id);
  const integrations = useIntegrations();
  if (task.rev === 0 || task.status === 'done') return null;
  const empty = isEmptyTask(task);
  // Its last thread stopped while there's still Claude's work to do: the new thread picks up from there.
  const pickUp = !!progress?.sessionId && !!idleStep(task, claudeIsOn(progress));
  // With only Claude Code, the same button copies a prompt to paste in Terminal.
  const terminal = claudeInTerminal(integrations);
  const title = terminal
    ? pickUp
      ? 'Its last Claude thread stopped. Copies a prompt that picks up where it left off, to paste into Claude Code in Terminal.'
      : 'Copies a prompt to paste into Claude Code in Terminal.'
    : pickUp
      ? 'Its last Claude thread stopped. Opens a new thread in the Claude app that picks up where it left off. Press Enter there.'
      : empty
        ? 'Opens a new thread in the Claude app. Claude asks you about this task, fills it out, plans it and works it. Press Enter there.'
        : 'Opens a new thread in the Claude app that plans and works this task. Press Enter there.';
  return (
    <div className="detail-claude" role="group" aria-label="Claude">
      <button type="button" className="btn btn-secondary btn-sm btn-start-claude" title={title} onClick={() => workWithClaude(task.id, { pickUp })}>
        {terminal ? <Copy size={14} aria-hidden /> : <Sparkles size={14} aria-hidden />} {workWithClaudeLabel(integrations)}
      </button>
    </div>
  );
}

/** The Claude threads on a task. Only once Claude is set up, or when the task already has some. */
function ClaudeThreads({ task }: { task: Task }) {
  const [threads, setThreads] = useState<ClaudeThread[] | null>(null);
  const [busy, setBusy] = useState(false);
  const progress = useProgress(task.id);
  const { settings } = useStore();
  const integrations = useIntegrations();
  const ready = claudeReady(integrations);
  const isTemp = task.rev === 0;
  const load = (refresh = false) => {
    if (isTemp) return;
    setBusy(true);
    fetchThreads(task.id, refresh)
      .then((t) => {
        setThreads(t);
        if (refresh) refreshProgress();
      })
      .catch(() => setThreads((t) => t ?? []))
      .finally(() => setBusy(false));
  };
  // Refetch when the task changes or Claude says something new on it.
  useEffect(() => load(), [task.id, isTemp, progress?.noteAt]);
  const openHref = (id: string) => `${location.hash.split('?')[0] || '#/today'}?task=${id}`;
  if (!ready && !threads?.length) return null;
  return (
    <div className="field">
      <span className="field-label eyebrow field-label-row">
        <span>Claude threads {threads && threads.length > 0 && <span className="num">· {threads.length}</span>}</span>
        <button type="button" className="icon-btn icon-btn-sm" aria-label="Look for new threads" title="Look for new threads" disabled={busy} onClick={() => load(true)}>
          <RefreshCw size={13} aria-hidden className={cx(busy && 'spin')} />
        </button>
      </span>
      {threads === null ? (
        <p className="meta-line">Looking for threads…</p>
      ) : threads.length === 0 && !settings.threadLinking ? (
        <p className="meta-line">
          Thread linking is off, so Claude threads don't show here.{' '}
          <a className="link-btn" href={CLAUDE_SETUP_HASH} onClick={(e) => { e.preventDefault(); openClaudeSetup(); }}>Turn it on</a>
        </p>
      ) : threads.length === 0 ? (
        <p className="meta-line">
          {claudeInTerminal(integrations)
            ? 'No threads yet. Press Copy prompt for Claude Code and paste it into Claude Code in Terminal. The thread shows up here within a few seconds.'
            : 'No threads yet. Choose Work on this with Claude in the ⋯ menu, or paste Copy prompt into Claude Code. The thread shows up here within a few seconds.'}
        </p>
      ) : (
        <ul className="threads">
          {threads.map((t) => (
            <li key={t.sessionId} className="thread">
              <div className="thread-main">
                <span className="thread-title">{t.title}</span>
                <span className="meta-line">
                  {t.cwd ? <span className="mono thread-cwd" title={t.cwd}>{t.cwd.split('/').filter(Boolean).slice(-1)[0]}</span> : null}
                  {t.lastActiveAt && <> · active {relativeTime(t.lastActiveAt)}</>}
                </span>
                {progress?.sessionId === t.sessionId && progress.note && (
                  <span className="thread-note">
                    <Sparkles size={12} aria-hidden /> {progress.noteKind === 'decision' && <strong>Decided: </strong>}
                    {plain(progress.note)}
                  </span>
                )}
                {t.otherTasks.length > 0 && (
                  <span className="meta-line">
                    Also on:{' '}
                    {t.otherTasks.map((o, i) => (
                      <span key={o.id}>
                        {i > 0 && ', '}
                        <a className="link" href={openHref(o.id)} title={STATUS_LABELS[o.status]}>{o.title}</a>
                      </span>
                    ))}
                  </span>
                )}
              </div>
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                aria-label={`Open ${t.title} in Claude`}
                title={`Open this thread in the Claude app. If it isn't there, copies:\n${t.resumeCommand}`}
                onClick={() => openThread(t.sessionId, t.resumeCommand)}
              >
                <ExternalLink size={14} aria-hidden />
              </button>
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                aria-label={`Unlink ${t.title}`}
                title="Unlink this thread from this task"
                onClick={() => unlinkThread(task.id, t.sessionId).then(setThreads).catch(() => store.toast('Could not unlink that thread.', 'error'))}
              >
                <Unlink size={14} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// The task panel's width: drag its left edge. Saved in this browser.
const DETAIL_DEFAULT = 440;
const DETAIL_MIN = 360;
const detailMax = () => Math.max(DETAIL_MIN, Math.min(1000, Math.round(window.innerWidth * 0.7)));
const clampDetail = (w: number) => Math.min(detailMax(), Math.max(DETAIL_MIN, Math.round(w)));

function DetailResizer() {
  const [width, setWidth] = useState(() => clampDetail(Number(localStorage.getItem('mt.detail-w')) || DETAIL_DEFAULT));
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    localStorage.setItem('mt.detail-w', String(width));
    document.documentElement.style.setProperty('--detail-w', `${width}px`);
  }, [width]);
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = width;
    setDragging(true);
    document.body.classList.add('is-col-resizing');
    // The panel is on the right, so dragging left makes it wider.
    const move = (ev: PointerEvent) => setWidth(clampDetail(w0 - (ev.clientX - x0)));
    const up = () => {
      setDragging(false);
      document.body.classList.remove('is-col-resizing');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div
      className={cx('detail-resizer', dragging && 'is-dragging')}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize task panel"
      aria-valuenow={width}
      aria-valuemin={DETAIL_MIN}
      aria-valuemax={detailMax()}
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      onPointerDown={startDrag}
      onDoubleClick={() => setWidth(DETAIL_DEFAULT)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') setWidth((w) => clampDetail(w + 24));
        else if (e.key === 'ArrowRight') setWidth((w) => clampDetail(w - 24));
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    />
  );
}

/**
 * Long titles get cut off, so hovering slides the text along to show the rest, then it slides back
 * when you move away. Not while you're editing, and not if you've asked for less motion.
 */
function useHoverScroll() {
  const ref = useRef<HTMLInputElement>(null);
  const frame = useRef(0);
  const stop = () => cancelAnimationFrame(frame.current);
  useEffect(() => stop, []);
  const slide = (to: 'end' | 'start') => {
    const el = ref.current;
    stop();
    if (!el || document.activeElement === el) return;
    const max = el.scrollWidth - el.clientWidth;
    if (max <= 0) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const from = el.scrollLeft;
    const target = to === 'end' ? max : 0;
    const speed = to === 'end' ? 60 : 400; // px per second: read on the way out, snap back home
    const delay = to === 'end' ? 350 : 0;
    const start = performance.now() + delay;
    const tick = (now: number) => {
      const t = Math.max(0, now - start) / 1000;
      const dist = Math.min(Math.abs(target - from), t * speed);
      el.scrollLeft = from + Math.sign(target - from) * dist;
      if (dist < Math.abs(target - from)) frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  };
  return { ref, onMouseEnter: () => slide('end'), onMouseLeave: () => slide('start') };
}

function SubtaskTitle({ taskId, id, title }: { taskId: string; id: string; title: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const hover = useHoverScroll();
  return (
    <input
      {...hover}
      className="input input-quiet subtask-title"
      value={draft ?? title}
      title={draft === null ? title : undefined}
      aria-label="Subtask title"
      maxLength={500}
      onFocus={() => setDraft(title)}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') (e.target as HTMLElement).blur();
        if (e.key === 'Escape') {
          setDraft(null);
          (e.target as HTMLElement).blur();
        }
      }}
      onBlur={() => {
        if (draft !== null && draft.trim() && draft.trim() !== title) store.updateSubtask(taskId, id, { title: draft.trim() });
        setDraft(null);
      }}
    />
  );
}

function Links({ task, onCommit }: { task: Task; onCommit: (patch: TaskPatchFields, baseRev?: number) => void }) {
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = () => {
    let u = url.trim();
    if (!u) return;
    if (!/^[a-z]+:/i.test(u)) u = `https://${u}`;
    try {
      new URL(u);
    } catch {
      return setError('That does not look like a link');
    }
    setError(null);
    onCommit({ links: [...task.links, { url: u, ...(label.trim() ? { label: label.trim() } : {}) }] });
    setUrl('');
    setLabel('');
  };
  return (
    <div className="field">
      <span className="field-label eyebrow">Links</span>
      {task.links.length > 0 && (
        <ul className="links">
          {task.links.map((l, i) => (
            <li key={`${l.url}-${i}`} className="link-row">
              <a href={l.url} target="_blank" rel="noreferrer noopener" className="link">
                <ExternalLink size={13} aria-hidden />
                <span>{l.label || l.url}</span>
              </a>
              <button type="button" className="icon-btn icon-btn-sm" aria-label={`Remove link ${l.label || l.url}`} onClick={() => onCommit({ links: task.links.filter((_, j) => j !== i) })}>
                <X size={14} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="link-add" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <input className="input" value={url} placeholder="https://…" aria-label="Link URL" onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        <input className="input" value={label} placeholder="Label (optional)" aria-label="Link label" onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        <button type="submit" className="btn btn-secondary btn-sm" disabled={!url.trim()}>
          Add
        </button>
      </form>
      {error && <p className="field-warning" role="alert">{error}</p>}
    </div>
  );
}

function History({ task }: { task: Task }) {
  const { versions } = useStore();
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
  const isTemp = task.rev === 0;
  useEffect(() => {
    if (isTemp) return;
    const ctl = new AbortController();
    api<{ activity: ActivityEntry[] }>('GET', `/api/activity?entityId=${task.id}&limit=50`, undefined, { signal: ctl.signal })
      .then((r) => setEntries(r.activity))
      .catch(() => {});
    return () => ctl.abort();
  }, [task.id, task.rev, versions.activity, isTemp]);
  return (
    <div className="field">
      <span className="field-label eyebrow">History</span>
      <p className="meta-line">
        Created by {task.createdBy} · {relativeTime(task.createdAt)}
      </p>
      {entries && entries.length > 0 && (
        <ol className="history">
          {entries.map((e, i) => {
            // A run of changes by the same one names them once.
            const prev = entries[i - 1];
            const cont = !!prev && prev.actor.kind === e.actor.kind && prev.actor.id === e.actor.id && prev.actor.claimedName === e.actor.claimedName;
            return (
            <li key={e.id} className={cx('history-item', cont && 'is-cont')}>
              {cont ? <span className="sr-only">{e.actor.label}: </span> : <ActorBadge actor={e.actor} />}
              <span className="history-text">{sentence(e.summary)}</span>
              <time className="history-time" dateTime={e.at} title={new Date(e.at).toLocaleString()}>
                {relativeTime(e.at)}
              </time>
            </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
