// Drag-and-drop for both the board (columns) and the list (sections).
// Works with mouse, touch and keyboard (Space to pick up, arrows to move, Space to drop, Esc to cancel).
// Keyboard users can also skip dragging entirely: [ and ] move a task between columns, Alt+Up/Down reorders.
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { KeyboardCoordinateGetter } from '@dnd-kit/core';
import { ChevronLeft } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { STATUS_LABELS, type Area, type Project, type Status, type Task } from '../../../shared/schema.ts';
import { between, cx, formatDue, plural, todayIso } from '../lib.ts';
import { store } from '../store.ts';
import { useMedia, usePersisted } from './Chrome.tsx';
import { TaskItem } from './TaskItem.tsx';

export interface Group {
  id: string;
  title: string;
  status: Status | null; // null = not a drop target (e.g. "Overdue")
  tasks: Task[];
  sortable: boolean;
  empty?: ReactNode;
  footer?: ReactNode;
  icon?: ReactNode;
  /** Shown in the column but living elsewhere: on the board, Today also lists what's due or overdue, so its count matches the sidebar. */
  ghosts?: Task[];
  /** How many there are when `tasks` is cut short (Done shows the latest few). */
  total?: number;
}

interface Props {
  groups: Group[];
  layout: 'list' | 'board';
  areas: Map<string, Area>;
  projects: Map<string, Project>;
  selectedId: string | null;
  picked?: ReadonlySet<string>;
  editingId: string | null;
  onOpen: (id: string, mods?: { shift: boolean; meta: boolean }) => void;
  onEditDone: () => void;
  showPlacement: boolean;
  onDraggingChange: (dragging: boolean) => void;
  /** Opens a status's own view, from its column heading. */
  onOpenView?: (status: Status) => void;
  /** A phone: empty columns are skipped. */
  compact?: boolean;
}

/**
 * Keyboard movement that understands columns. Left/Right jump to the nearest card in the
 * neighbouring column (or the empty column itself); Up/Down move within the same column.
 * dnd-kit's default getter assumes one list and picks near neighbours by sub-pixel offsets.
 */
function columnKeyboardCoordinates(containerIds: Set<string>): KeyboardCoordinateGetter {
  return (event, { context: { active, collisionRect, droppableRects, droppableContainers } }) => {
    const dir = event.code;
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(dir)) return undefined;
    event.preventDefault();
    if (!active || !collisionRect) return undefined;
    const entries = droppableContainers
      .getEnabled()
      .filter((e) => e.id !== active.id)
      .map((e) => ({ id: String(e.id), rect: droppableRects.get(e.id), isContainer: containerIds.has(String(e.id)) }))
      .filter((e): e is { id: string; rect: NonNullable<typeof e.rect>; isContainer: boolean } => !!e.rect);
    const sameColumn = (r: { left: number }) => Math.abs(r.left - collisionRect.left) < collisionRect.width / 2;
    let target: { left: number; top: number } | undefined;
    if (dir === 'ArrowLeft' || dir === 'ArrowRight') {
      const side = entries.filter((e) => (dir === 'ArrowRight' ? e.rect.left >= collisionRect.left + collisionRect.width / 2 : e.rect.left <= collisionRect.left - collisionRect.width / 2));
      if (!side.length) return undefined;
      const columnLeft = dir === 'ArrowRight' ? Math.min(...side.map((e) => e.rect.left)) : Math.max(...side.map((e) => e.rect.left));
      const inColumn = side.filter((e) => Math.abs(e.rect.left - columnLeft) < collisionRect.width / 2);
      const cards = inColumn.filter((e) => !e.isContainer);
      if (cards.length) target = cards.reduce((a, b) => (Math.abs(b.rect.top - collisionRect.top) < Math.abs(a.rect.top - collisionRect.top) ? b : a)).rect;
      else {
        const col = inColumn.find((e) => e.isContainer);
        if (col) target = { left: col.rect.left + 8, top: col.rect.top + 8 };
      }
    } else {
      const down = dir === 'ArrowDown';
      const vertical = entries.filter((e) => sameColumn(e.rect) && (down ? e.rect.top > collisionRect.top + 1 : e.rect.top < collisionRect.top - 1));
      const cards = vertical.filter((e) => !e.isContainer);
      const pool = cards.length ? cards : vertical;
      if (!pool.length) return undefined;
      const best = pool.reduce((a, b) => (Math.abs(b.rect.top - collisionRect.top) < Math.abs(a.rect.top - collisionRect.top) ? b : a));
      target = best.isContainer ? { left: best.rect.left + 8, top: best.rect.top + 8 } : best.rect;
    }
    return target ? { x: target.left, y: target.top } : undefined;
  };
}

export function TaskGroups(props: Props) {
  const { groups, layout } = props;
  const [items, setItems] = useState<Record<string, string[]>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const byId = useMemo(() => new Map(groups.flatMap((g) => g.tasks.map((t) => [t.id, t] as const))), [groups]);

  // Mirror groups into local order while not dragging.
  const groupKey = groups.map((g) => `${g.id}:${g.tasks.map((t) => t.id).join(',')}`).join('|');
  useEffect(() => {
    if (!activeId) setItems(Object.fromEntries(groups.map((g) => [g.id, g.tasks.map((t) => t.id)])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupKey, activeId]);

  const groupIds = groups.map((g) => g.id).join('|');
  const coordinateGetter = useMemo(() => columnKeyboardCoordinates(new Set(groupIds.split('|'))), [groupIds]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter,
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter'] },
    }),
  );

  const groupOf = (id: string) => (items[id] ? id : Object.keys(items).find((k) => items[k].includes(id)));
  const groupById = (id: string | undefined) => groups.find((g) => g.id === id);
  const titleOf = (id: string | number) => byId.get(String(id))?.title ?? 'task';

  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${titleOf(active.id)}. Use arrow keys to move, Space to drop, Escape to cancel.`,
    onDragOver: ({ active, over }) => {
      if (!over) return `${titleOf(active.id)} is not over a column.`;
      const g = groupById(groupOf(String(over.id)));
      return g ? `${titleOf(active.id)} is over ${g.title}.` : '';
    },
    onDragEnd: ({ active, over }) => {
      const g = over ? groupById(groupOf(String(over.id))) : undefined;
      return g ? `Dropped ${titleOf(active.id)} in ${g.title}.` : `${titleOf(active.id)} was dropped back where it started.`;
    },
    onDragCancel: ({ active }) => `Cancelled. ${titleOf(active.id)} is back where it started.`,
  };

  function onDragStart(e: DragStartEvent) {
    setActiveId(String(e.active.id));
    props.onDraggingChange(true);
  }

  function onDragOver(e: DragOverEvent) {
    const { active, over } = e;
    if (!over) return;
    const from = groupOf(String(active.id));
    const to = groupOf(String(over.id));
    if (!from || !to || from === to) return;
    const target = groupById(to);
    if (!target?.status) return; // not a drop target
    setItems((prev) => {
      const fromList = prev[from].filter((x) => x !== active.id);
      const toList = [...prev[to]];
      const overIndex = toList.indexOf(String(over.id));
      toList.splice(overIndex >= 0 ? overIndex : toList.length, 0, String(active.id));
      return { ...prev, [from]: fromList, [to]: toList };
    });
  }

  function onDragEnd(e: DragEndEvent) {
    const id = String(e.active.id);
    setActiveId(null);
    props.onDraggingChange(false);
    if (!e.over) return;
    const to = groupOf(String(e.over.id));
    const target = groupById(to);
    const task = byId.get(id);
    if (!to || !target?.status || !task) return;
    const list = [...items[to]];
    const fromIndex = list.indexOf(id);
    let toIndex = list.indexOf(String(e.over.id));
    if (toIndex < 0) toIndex = list.length - 1;
    if (fromIndex >= 0 && fromIndex !== toIndex) {
      list.splice(fromIndex, 1);
      list.splice(toIndex, 0, id);
    }
    const idx = list.indexOf(id);
    const pos = (x: string | undefined) => (x ? store.getSnapshot().byId.get(x)?.position : undefined);
    const position = between(pos(list[idx - 1]), pos(list[idx + 1]));
    if (task.status === target.status && Math.abs(task.position - position) < 1e-9) return;
    setItems((prev) => ({ ...prev, [to]: list }));
    store.move(id, target.status, position);
  }

  const active = activeId ? byId.get(activeId) : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={() => {
        setActiveId(null);
        props.onDraggingChange(false);
      }}
      accessibility={{
        announcements,
        screenReaderInstructions: { draggable: 'To move this task, press Space, then use the arrow keys, then press Space again. Or press [ and ] to move between columns.' },
      }}
    >
      <BoardBody {...props} items={items} byId={byId} activeId={activeId} />
      <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }}>
        {active ? (
          <div className={cx('task', layout === 'board' ? 'task-card' : 'task-row', 'is-overlay')}>
            <div className="task-main">
              <span className="task-title">{active.title}</span>
            </div>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function BoardBody(props: Props & { items: Record<string, string[]>; byId: Map<string, Task>; activeId: string | null }) {
  const { groups, layout, items, byId, compact, activeId } = props;
  const [doneOpen, setDoneOpen] = usePersisted('mt.board.done-open', false);
  // An empty In progress column is a slim row above the board, not a whole column.
  const slim = layout === 'board' ? groups.find((g) => g.id === 'doing' && g.status === 'doing' && g.tasks.length === 0 && groups.length > 1) : undefined;
  // In a list, empty sections fold into one line. They come from the store, so they hold still during a drag.
  const folded = layout === 'list' && groups.length > 1 ? groups.filter((g) => g.tasks.length === 0 && !g.ghosts?.length) : [];
  const shown = groups.filter((g) => g !== slim && !folded.includes(g) && !(compact && layout === 'board' && g.tasks.length === 0 && !g.ghosts?.length && g.id !== activeId && !(items[g.id]?.length)));
  const single = groups.length === 1 && layout === 'list';
  const names = folded.map((g) => g.title);
  return (
    <div className={cx(layout === 'board' ? 'board-wrap' : 'groups-wrap')}>
      {slim && <SlimGroup group={slim} ids={items[slim.id] ?? []} />}
      <div className={cx(layout === 'board' ? 'board' : 'groups')}>
        {shown.map((g) =>
          layout === 'board' && g.id === 'done' && g.status === 'done' && !doneOpen ? (
            <DoneRail key={g.id} group={g} ids={items[g.id] ?? g.tasks.map((t) => t.id)} onOpen={() => setDoneOpen(true)} />
          ) : (
            <GroupView
              key={g.id}
              {...props}
              group={g}
              ids={items[g.id] ?? g.tasks.map((t) => t.id)}
              byId={byId}
              hideHeader={single}
              onCollapse={layout === 'board' && g.id === 'done' ? () => setDoneOpen(false) : undefined}
            />
          ),
        )}
      </div>
      {names.length > 0 && (
        <p className="groups-folded">
          <span className="eyebrow">Empty</span> {names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]}
        </p>
      )}
    </div>
  );
}

/** "Nothing in progress · press S". Still a place to drop a task to start it. */
function SlimGroup({ group, ids }: { group: Group; ids: string[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: group.id });
  const touch = useMedia('(pointer: coarse)');
  return (
    <SortableContext id={group.id} items={ids} strategy={verticalListSortingStrategy}>
      <section ref={setNodeRef} className={cx('group-slim', isOver && 'is-over')} aria-label={group.title} data-status={group.status ?? undefined}>
        <span className="eyebrow">{group.title}</span>
        <span className="group-slim-text">
          {isOver ? 'Drop to start it' : touch ? 'Nothing in progress · open a task and tap Start' : <>Nothing in progress · press <kbd className="kbd">S</kbd> on a task to start it</>}
        </span>
      </section>
    </SortableContext>
  );
}

/** Done, folded to a narrow rail with its count. Click or press Enter to open it. Drop on it to finish a task. */
function DoneRail({ group, ids, onOpen }: { group: Group; ids: string[]; onOpen: () => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: group.id });
  const n = group.total ?? group.tasks.length;
  return (
    <SortableContext id={group.id} items={ids} strategy={verticalListSortingStrategy}>
      <section ref={setNodeRef} className={cx('column-rail', isOver && 'is-over')} data-status="done" aria-label={`Done, ${plural(n, 'task')}`}>
        <button type="button" className="column-rail-btn" aria-expanded={false} aria-label={`Show Done, ${plural(n, 'task')}`} onClick={onOpen}>
          <span className="badge num">{n}</span>
          <span className="column-rail-label eyebrow">Done</span>
        </button>
      </section>
    </SortableContext>
  );
}

function GroupView({ group, ids, byId, layout, areas, projects, selectedId, picked, editingId, onOpen, onEditDone, showPlacement, onOpenView, hideHeader, onCollapse }: Props & { group: Group; ids: string[]; byId: Map<string, Task>; hideHeader?: boolean; onCollapse?: () => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: group.id, disabled: !group.status });
  const tasks = ids.map((id) => byId.get(id)).filter(Boolean) as Task[];
  const headingId = `group-${group.id}`;
  const ghosts = group.ghosts ?? [];
  const count = group.total ?? tasks.length + ghosts.length;
  const today = todayIso();
  return (
    <section className={cx(layout === 'board' ? 'column' : 'group', isOver && 'is-over')} aria-labelledby={headingId} data-status={group.status ?? undefined}>
      <header className={cx(layout === 'board' ? 'column-head' : 'group-head', hideHeader && 'sr-only')}>
        {group.icon}
        <h2 id={headingId} className="eyebrow">
          {onOpenView && group.status && layout === 'board' ? (
            <button type="button" className="column-title-btn" title={`Open ${group.title}`} onClick={() => onOpenView(group.status!)}>
              {group.title}
            </button>
          ) : (
            group.title
          )}
        </h2>
        <span className="count num" aria-label={plural(count, 'task')}>
          {count}
        </span>
        {onCollapse && (
          <button type="button" className="icon-btn icon-btn-sm column-collapse" aria-expanded aria-label="Fold Done away" title="Fold away" onClick={onCollapse}>
            <ChevronLeft size={14} aria-hidden />
          </button>
        )}
      </header>
      <SortableContext id={group.id} items={ids} strategy={verticalListSortingStrategy} disabled={!group.sortable}>
        <div ref={setNodeRef} className={layout === 'board' ? 'column-body' : 'group-body'} role="list" aria-labelledby={headingId}>
          {tasks.map((t) => (
            <TaskItem
              key={t.id}
              task={t}
              area={t.areaId ? areas.get(t.areaId) : undefined}
              project={t.projectId ? projects.get(t.projectId) : undefined}
              variant={layout === 'board' ? 'card' : 'row'}
              selected={selectedId === t.id}
              picked={picked?.has(t.id)}
              editing={editingId === t.id}
              onOpen={onOpen}
              onEditDone={onEditDone}
              showPlacement={showPlacement}
              sortable={group.sortable}
              container={group.id}
              groupStatus={group.status}
            />
          ))}
          {tasks.length === 0 && ghosts.length === 0 && (group.empty ?? <p className="column-empty">Nothing here yet</p>)}
          {ghosts.length > 0 && (
            <div className="ghosts" role="listitem">
              <span className="ghosts-title eyebrow">Also due</span>
              <ul>
                {ghosts.map((t) => (
                  <li key={t.id}>
                    <button type="button" className="ghost" onClick={() => onOpen(t.id)} title={`${STATUS_LABELS[t.status]}. Open it`}>
                      <span className="ghost-title">{t.title}</span>
                      <span className={cx('ghost-due', t.dueDate! < today && 'is-overdue')}>{t.dueDate! < today ? `Overdue · ${formatDue(t.dueDate!)}` : 'Today'}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </SortableContext>
      {group.footer}
    </section>
  );
}
