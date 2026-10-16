// App chrome: sidebar, connection status, toasts, conflict dialog, capture bar, shortcut help.
import {
  Activity,
  Archive,
  Briefcase,
  CalendarCheck,
  Check,
  CheckCircle2,
  ClipboardCheck,
  ChevronDown,
  ChevronRight,
  Clock,
  Columns3,
  Compass,
  FolderPlus,
  Home,
  Inbox,
  Layers,
  ListTodo,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Radar,
  Settings as SettingsIcon,
  Trash2,
  WandSparkles,
  X,
  Zap,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { PRIORITY_LABELS, STATUS_LABELS, type Area, type AreaMode, type Project, type Status, type Task, type TaskPatchFields } from '../../../shared/schema.ts';
import { claudeIsOn, cx, formatDue, formatTime, parseCapture, relativeTime, type CapturePlaces, type ParsedCapture, type Scope, type ViewId } from '../lib.ts';
import { store, useStore, type Conflict } from '../store.ts';
import { areaInMode, setWorkMode, useWorkMode, WORK_MODES, type WorkMode } from '../mode.ts';
import { assistantStatusLine, openAssistants, useConnectedAssistants, useWaitingAssistants } from '../assistants.ts';
import { useAllProgress } from '../progress.ts';
import { useLabs } from '../prefs.ts';
import { AREA_PALETTE, areaColor } from '../areaColors.ts';
import { AreaDot, Kbd } from './Bits.tsx';
import { confirmDialog, Menu, type MenuEntry } from './Menu.tsx';
import { openTour } from './tour/Tour.tsx';

/** Every view. `key` is the letter after G that goes there. */
export const VIEW_META: Record<ViewId, { label: string; icon: ReactNode; key?: string }> = {
  today: { label: 'Today', icon: <CalendarCheck size={16} aria-hidden />, key: 't' },
  inbox: { label: 'Inbox', icon: <Inbox size={16} aria-hidden />, key: 'i' },
  foryou: { label: 'For you', icon: <ClipboardCheck size={16} aria-hidden />, key: 'f' },
  doing: { label: 'In progress', icon: <Zap size={16} aria-hidden />, key: 's' },
  board: { label: 'Board', icon: <Columns3 size={16} aria-hidden />, key: 'b' },
  next: { label: 'Next', icon: <ListTodo size={16} aria-hidden />, key: 'n' },
  waiting: { label: 'Waiting', icon: <Clock size={16} aria-hidden />, key: 'w' },
  done: { label: 'Done', icon: <CheckCircle2 size={16} aria-hidden />, key: 'd' },
  activity: { label: 'Activity', icon: <Activity size={16} aria-hidden />, key: 'a' },
  trash: { label: 'Trash', icon: <Trash2 size={16} aria-hidden /> },
  settings: { label: 'Settings', icon: <SettingsIcon size={16} aria-hidden />, key: ',' },
  routines: { label: 'Routines', icon: <Radar size={16} aria-hidden />, key: 'r' },
  wizard: { label: 'Wizard', icon: <WandSparkles size={16} aria-hidden />, key: 'z' },
};

const modeIcon = (id: WorkMode, size = 14) => (id === 'work' ? <Briefcase size={size} aria-hidden /> : id === 'personal' ? <Home size={size} aria-hidden /> : <Layers size={size} aria-hidden />);

/** Areas exist on both the work and the personal side, so the Work / Personal / Both switch means something. */
export const hasBothSides = (areas: Area[]) => {
  const live = areas.filter((a) => !a.archived);
  return live.some((a) => a.mode === 'work') && live.some((a) => a.mode === 'personal');
};

/** "Showing: Both ▾" in the toolbar. Press M to cycle. Only shown once areas exist on both sides. */
export function ModeMenu() {
  const mode = useWorkMode();
  const label = WORK_MODES.find((m) => m.id === mode)!.label;
  return (
    <Menu
      label="Show work, personal or both"
      className="mode-menu btn btn-ghost btn-sm"
      trigger={
        <>
          {modeIcon(mode)}
          <span className="mode-menu-text">
            <span className="mode-menu-prefix">Showing: </span>
            {label}
          </span>
          <ChevronDown size={13} aria-hidden />
        </>
      }
      items={WORK_MODES.map((m) => ({ label: m.label, icon: modeIcon(m.id), checked: mode === m.id, onSelect: () => setWorkMode(m.id) }))}
    />
  );
}

// Sidebar width: drag the edge. Narrower than ICONS_BELOW snaps to icons only.
const ICONS_W = 64;
const ICONS_BELOW = 150;
// Wide enough that "In progress" with its dot and count, and two-digit badges, never get cut off.
const MIN_W = 224;
const MAX_W = 440;
const DEFAULT_W = 264;
const readNum = (k: string, d: number) => {
  const n = Number(localStorage.getItem(k));
  return Number.isFinite(n) && n > 0 ? n : d;
};
const clampW = (w: number) => (w < ICONS_BELOW ? ICONS_W : Math.min(MAX_W, Math.max(MIN_W, w)));
export const usePersisted = (key: string, initial: boolean) => {
  const [v, setV] = useState<boolean>(() => {
    const s = localStorage.getItem(key);
    return s === null ? initial : s === '1';
  });
  useEffect(() => localStorage.setItem(key, v ? '1' : '0'), [key, v]);
  return [v, setV] as const;
};

const MORE_VIEWS: ViewId[] = ['activity', 'trash', 'settings', 'routines', 'wizard'];

export function Sidebar({ scope, counts, onNavigate, open, onClose }: {
  scope: Scope;
  counts: Record<string, number>;
  onNavigate: (s: Partial<Scope>) => void;
  open: boolean;
  onClose: () => void;
}) {
  const { areas, projects } = useStore();
  const workMode = useWorkMode();
  const labs = useLabs();
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => JSON.parse(localStorage.getItem('mt.expanded') ?? '{}'));
  const [adding, setAdding] = useState<'area' | string | null>(null);
  const [areasOpen, setAreasOpen] = usePersisted('mt.nav.areas', true);
  const [moreOpen, setMoreOpen] = usePersisted('mt.nav.more', false);
  const [width, setWidth] = useState(() => clampW(readNum('mt.sidebar-w', DEFAULT_W)));
  const lastWide = useRef(width > ICONS_W ? width : DEFAULT_W);
  const [dragging, setDragging] = useState(false);
  const phone = useMedia('(max-width: 760px)');
  const iconOnly = width === ICONS_W && !phone;
  useEffect(() => localStorage.setItem('mt.expanded', JSON.stringify(expanded)), [expanded]);
  useEffect(() => {
    localStorage.setItem('mt.sidebar-w', String(width));
    if (width > ICONS_W) lastWide.current = width;
    document.documentElement.style.setProperty('--sidebar-w', `${width}px`);
  }, [width]);

  const nav = (s: Partial<Scope>) => {
    onNavigate(s);
    onClose();
  };
  const toggleIcons = () => setWidth((w) => (w === ICONS_W ? lastWide.current : ICONS_W));
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = width;
    setDragging(true);
    const move = (ev: PointerEvent) => setWidth(clampW(w0 + ev.clientX - x0));
    const up = () => {
      setDragging(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const onResizeKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft') setWidth((w) => clampW(w === MIN_W ? ICONS_W : w - 24));
    else if (e.key === 'ArrowRight') setWidth((w) => clampW(w === ICONS_W ? MIN_W : w + 24));
    else if (e.key === 'Enter' || e.key === ' ') toggleIcons();
    else return;
    e.preventDefault();
  };

  const viewItem = (v: ViewId, badge?: ReactNode, o: { className?: string; badgeLabel?: string } = {}) => {
    const m = VIEW_META[v];
    const active = scope.view === v && !scope.areaId && !scope.projectId;
    return (
      <li key={v}>
        <button
          type="button"
          className={cx('nav-item', active && 'is-active', o.className)}
          aria-current={active ? 'page' : undefined}
          title={iconOnly ? `${m.label}${o.badgeLabel ? ` (${o.badgeLabel})` : ''}` : undefined}
          onClick={() => nav({ view: v, areaId: null, projectId: null })}
        >
          {m.icon}
          <span className="nav-label">{m.label}</span>
          {badge}
        </button>
      </li>
    );
  };
  const pill = (n: number | undefined, you = false) => (n ? <span className={cx('badge num', you && 'badge-you')}>{n}</span> : null);
  const doing = counts.doing ?? 0;
  const needsYou = counts.needsYou ?? 0;
  const bothSides = hasBothSides(areas);
  // With one side, a new area goes on that side, and nothing asks which.
  const onlySide: AreaMode = areas.find((a) => !a.archived)?.mode ?? 'personal';
  const moreViews = MORE_VIEWS.filter((v) => (v === 'wizard' ? labs.wizard : v === 'routines' ? labs.routines : true));
  const moreActive = moreViews.includes(scope.view) && !scope.areaId;
  const showMore = moreOpen || moreActive || iconOnly;
  const visibleAreas = areas.filter((a) => !a.archived && areaInMode(a, workMode));

  // One Tab stop per area row. Arrow keys move inside a row (left, right) and between rows (up, down).
  const onAreaKeys = (e: React.KeyboardEvent<HTMLUListElement>) => {
    const target = e.target as HTMLElement;
    const row = target.closest<HTMLElement>('.nav-row');
    if (!row || target.tagName === 'INPUT') return;
    const inRow = [...row.querySelectorAll<HTMLElement>('[data-roving]')];
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('.nav-row')];
    const i = inRow.indexOf(target);
    const r = rows.indexOf(row);
    let next: HTMLElement | undefined;
    if (e.key === 'ArrowRight') next = inRow[Math.min(inRow.length - 1, i + 1)];
    else if (e.key === 'ArrowLeft') next = inRow[Math.max(0, i - 1)];
    else if (e.key === 'ArrowDown') next = rows[r + 1]?.querySelector<HTMLElement>('[data-roving="main"]') ?? undefined;
    else if (e.key === 'ArrowUp') next = rows[r - 1]?.querySelector<HTMLElement>('[data-roving="main"]') ?? undefined;
    else if (e.key === 'Home') next = rows[0]?.querySelector<HTMLElement>('[data-roving="main"]') ?? undefined;
    else if (e.key === 'End') next = rows[rows.length - 1]?.querySelector<HTMLElement>('[data-roving="main"]') ?? undefined;
    else return;
    e.preventDefault();
    e.stopPropagation();
    next?.focus();
  };

  return (
    <>
      <div className={cx('scrim', open && 'is-open')} onClick={onClose} aria-hidden="true" />
      <nav className={cx('sidebar', open && 'is-open', iconOnly && 'is-icons', dragging && 'is-resizing')} aria-label="Main">
        <div className="brand">
          {/* One task in focus, the rest quieter below it. */}
          <svg className="brand-mark" viewBox="0 0 24 24" aria-hidden="true">
            <rect className="brand-tile" width="24" height="24" rx="7" />
            <circle className="brand-now" cx="8" cy="10" r="2.5" />
            <path className="brand-line" d="M15 10h3.25" />
            <path className="brand-line is-later" d="M5.75 16.5h12.5" />
          </svg>
          <span className="brand-name">Master Tasker</span>
          <button type="button" className="icon-btn sidebar-close" aria-label="Close menu" onClick={onClose}>
            <X size={18} aria-hidden />
          </button>
        </div>
        <div className="sidebar-scroll">
          <ul className="nav-list">
            {/* Open tasks, like every other count here. How the day is going shows on Today itself. */}
            {viewItem('today', pill(counts.today), { badgeLabel: counts.today ? String(counts.today) : undefined })}
            {viewItem('inbox', pill(counts.inbox), { badgeLabel: counts.inbox ? String(counts.inbox) : undefined })}
            {viewItem('foryou', pill(needsYou, true), { className: needsYou ? 'nav-item-you' : undefined, badgeLabel: needsYou ? `${needsYou} need you` : undefined })}
            {viewItem('doing', doing > 0 ? <><span className="doing-dot" aria-hidden />{pill(doing)}</> : null, { className: doing > 0 ? 'nav-item-doing' : undefined, badgeLabel: doing ? String(doing) : undefined })}
            {viewItem('board')}
            {/* Board's columns, each as its own list. */}
            {viewItem('next', pill(counts.next), { className: 'nav-item-sub', badgeLabel: counts.next ? String(counts.next) : undefined })}
            {viewItem('waiting', pill(counts.waiting), { className: 'nav-item-sub', badgeLabel: counts.waiting ? String(counts.waiting) : undefined })}
            {viewItem('done', null, { className: 'nav-item-sub' })}
          </ul>
          <div className="nav-section">
            <button type="button" className="nav-section-toggle" aria-expanded={areasOpen} onClick={() => setAreasOpen(!areasOpen)} title={iconOnly ? (areasOpen ? 'Hide areas' : 'Show areas') : undefined}>
              <ChevronRight size={13} aria-hidden className={cx('chev', areasOpen && 'is-open')} />
              <span className="eyebrow">Areas</span>
            </button>
            <button type="button" className="icon-btn icon-btn-sm nav-section-add" aria-label="Add area" title="Add area" onClick={() => { setAreasOpen(true); setAdding('area'); }}>
              <Plus size={14} aria-hidden />
            </button>
          </div>
          {areasOpen && (
            <ul className="nav-list nav-areas" onKeyDown={onAreaKeys}>
              {visibleAreas.map((a) => (
                <AreaItem
                  key={a.id}
                  area={a}
                  projects={projects.filter((p) => p.areaId === a.id && !p.archived)}
                  count={counts[`area:${a.id}`] ?? 0}
                  projectCounts={counts}
                  scope={scope}
                  expanded={!iconOnly && (expanded[a.id] ?? false)}
                  onToggle={() => setExpanded((x) => ({ ...x, [a.id]: !(x[a.id] ?? false) }))}
                  onNavigate={nav}
                  adding={adding === a.id}
                  onAddProject={() => {
                    setExpanded((x) => ({ ...x, [a.id]: true }));
                    setAdding(a.id);
                  }}
                  onDoneAdding={() => setAdding(null)}
                  iconOnly={iconOnly}
                  sides={bothSides}
                />
              ))}
              {visibleAreas.length === 0 && adding !== 'area' && !iconOnly && (
                <li className="nav-empty">
                  <button type="button" className="link-btn" onClick={() => setAdding('area')}>Add an area</button> to group tasks.
                </li>
              )}
              {adding === 'area' && !iconOnly && (
                <li>
                  <AreaAdd
                    sides={bothSides}
                    defaultMode={bothSides ? (workMode === 'work' ? 'work' : 'personal') : onlySide}
                    onDone={(area) => {
                      setAdding(null);
                      if (area) nav({ view: 'board', areaId: area.id, projectId: null });
                    }}
                  />
                </li>
              )}
            </ul>
          )}
        </div>
        <div className="nav-more">
          {!iconOnly && (
            <button type="button" className="nav-item nav-more-toggle" aria-expanded={showMore} aria-controls="nav-more-list" onClick={() => setMoreOpen(!showMore)} disabled={moreActive}>
              <MoreHorizontal size={16} aria-hidden />
              <span className="nav-label">More</span>
              <ChevronRight size={13} aria-hidden className={cx('chev', showMore && 'is-open')} />
            </button>
          )}
          {showMore && (
            <ul className="nav-list" id="nav-more-list">
              {moreViews.map((v) => viewItem(v))}
              <li>
                <button
                  type="button"
                  className="nav-item"
                  title={iconOnly ? 'Take the tour' : undefined}
                  onClick={() => {
                    onClose();
                    openTour();
                  }}
                >
                  <Compass size={16} aria-hidden />
                  <span className="nav-label">Take the tour</span>
                </button>
              </li>
            </ul>
          )}
          {!phone && (
            <button type="button" className="nav-item nav-collapse" onClick={toggleIcons} aria-label={iconOnly ? 'Expand sidebar' : 'Collapse sidebar to icons'} title={iconOnly ? 'Expand sidebar' : 'Collapse sidebar to icons'}>
              {iconOnly ? <PanelLeftOpen size={16} aria-hidden /> : <PanelLeftClose size={16} aria-hidden />}
              <span className="nav-label">Collapse</span>
            </button>
          )}
        </div>
        <ConnectionStatus />
        {!phone && (
          <div
            className="sidebar-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            aria-valuenow={width}
            aria-valuemin={ICONS_W}
            aria-valuemax={MAX_W}
            tabIndex={0}
            title="Drag to resize. Double-click to switch to icons."
            onPointerDown={startDrag}
            onDoubleClick={toggleIcons}
            onKeyDown={onResizeKey}
          />
        )}
      </nav>
    </>
  );
}

export function useMedia(query: string) {
  const [m, setM] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const on = () => setM(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return m;
}


/** Archive, with Undo. */
export async function archiveArea(area: Area) {
  try {
    await store.updateArea(area.id, { archived: true });
    store.toast(`Archived “${area.name}”. Its tasks stay where they are.`, 'info', { label: 'Undo', run: () => void store.updateArea(area.id, { archived: false }) });
  } catch (e) {
    store.toast((e as Error).message, 'error');
  }
}

/** Delete, after asking in the app's own dialog. An area with tasks asks where they go first. */
export async function deleteArea(area: Area, onGone?: () => void) {
  const { tasks, areas } = store.getSnapshot();
  const own = tasks.filter((t) => t.areaId === area.id).length;
  const others = areas.filter((a) => a.id !== area.id && !a.archived);
  const r = await confirmDialog(
    own === 0
      ? { title: `Delete “${area.name}”?`, body: <p>It has no tasks. Its projects go too. This can't be undone.</p>, confirmLabel: 'Delete area', danger: true }
      : {
          title: `Delete “${area.name}”?`,
          body: <p>It has {own} {own === 1 ? 'task' : 'tasks'}. Choose where they go. Its projects move with them.</p>,
          confirmLabel: 'Move and delete',
          danger: true,
          choice: { label: 'Move tasks to', value: others[0]?.id ?? '', options: [...others.map((a) => ({ value: a.id, label: a.name })), { value: '', label: 'Unfiled' }] },
        },
  );
  if (!r.ok) return;
  try {
    const out = await store.deleteArea(area.id, own === 0 ? undefined : r.value || null);
    onGone?.();
    const to = r.value ? others.find((a) => a.id === r.value)?.name : 'Unfiled';
    store.toast(out.moved ? `Deleted “${area.name}”. Moved ${out.moved} ${out.moved === 1 ? 'task' : 'tasks'} to ${to}.` : `Deleted “${area.name}”`, 'success');
  } catch (e) {
    store.toast((e as Error).message, 'error');
  }
}

const setSide = (area: Area, mode: AreaMode) =>
  store
    .updateArea(area.id, { mode })
    .then(() => store.toast(`“${area.name}” is ${mode === 'work' ? 'Work' : 'Personal'} now`, 'success'))
    .catch((e) => store.toast(e.message, 'error'));

/** An area's ⋯ menu. Its side (Work or Personal) only shows once there are areas on both; until then Settings has it. */
export function areaMenu(area: Area, o: { onRename: () => void; onAddProject?: () => void; onGone?: () => void; sides?: boolean }): MenuEntry[] {
  return [
    { label: 'Rename', icon: <Pencil size={14} aria-hidden />, onSelect: o.onRename },
    ...(o.onAddProject ? [{ label: 'Add project', icon: <FolderPlus size={14} aria-hidden />, onSelect: o.onAddProject }] : []),
    { heading: 'Color' },
    {
      key: 'colors',
      render: (close) => (
        <div className="menu-swatches" role="group" aria-label="Color">
          {AREA_PALETTE.map(({ hex: c, name }) => (
            <button
              key={c}
              type="button"
              role="menuitemradio"
              aria-checked={area.color.toLowerCase() === c.toLowerCase()}
              aria-label={name}
              title={name}
              tabIndex={-1}
              className="menu-swatch"
              style={{ background: areaColor(c) }}
              onClick={() => {
                close();
                void store.updateArea(area.id, { color: c }).catch((e) => store.toast(e.message, 'error'));
              }}
            >
              {area.color.toLowerCase() === c.toLowerCase() && <Check size={12} strokeWidth={3} aria-hidden />}
            </button>
          ))}
        </div>
      ),
    },
    ...(o.sides
      ? ([
          { heading: 'Side' },
          { label: 'Work', icon: <Briefcase size={14} aria-hidden />, checked: area.mode === 'work', onSelect: () => area.mode !== 'work' && void setSide(area, 'work') },
          { label: 'Personal', icon: <Home size={14} aria-hidden />, checked: area.mode === 'personal', onSelect: () => area.mode !== 'personal' && void setSide(area, 'personal') },
        ] as MenuEntry[])
      : []),
    { separator: true },
    { label: 'Archive', icon: <Archive size={14} aria-hidden />, onSelect: () => void archiveArea(area) },
    { label: 'Delete…', icon: <Trash2 size={14} aria-hidden />, danger: true, onSelect: () => void deleteArea(area, o.onGone) },
  ];
}

function AreaItem({ area, projects, count, projectCounts, scope, expanded, onToggle, onNavigate, adding, onAddProject, onDoneAdding, iconOnly, sides }: {
  iconOnly: boolean;
  sides: boolean;
  area: Area;
  projects: Project[];
  count: number;
  projectCounts: Record<string, number>;
  scope: Scope;
  expanded: boolean;
  onToggle: () => void;
  onNavigate: (s: Partial<Scope>) => void;
  adding: boolean;
  onAddProject: () => void;
  onDoneAdding: () => void;
}) {
  const active = scope.areaId === area.id && !scope.projectId;
  const [renaming, setRenaming] = useState(false);
  const main = useRef<HTMLButtonElement>(null);
  const rename = async (name: string) => {
    setRenaming(false);
    if (name && name !== area.name) await store.updateArea(area.id, { name }).catch((e) => store.toast(e.message, 'error'));
    requestAnimationFrame(() => main.current?.focus());
  };
  return (
    <li>
      {renaming ? (
        <InlineAdd placeholder="Area name" initial={area.name} onSubmit={rename} onCancel={() => rename(area.name)} />
      ) : (
        <div className="nav-row">
          <button type="button" className="disclosure" data-roving="disclosure" tabIndex={-1} aria-expanded={expanded} aria-label={`${expanded ? 'Collapse' : 'Expand'} ${area.name}`} onClick={onToggle}>
            <ChevronRight size={14} aria-hidden className={cx('chev', expanded && 'is-open')} />
          </button>
          <button
            ref={main}
            type="button"
            data-roving="main"
            className={cx('nav-item', active && 'is-active')}
            aria-current={active ? 'page' : undefined}
            title={iconOnly ? area.name : undefined}
            aria-keyshortcuts="ArrowRight"
            onClick={() => onNavigate({ view: 'board', areaId: area.id, projectId: null })}
            onDoubleClick={() => !iconOnly && setRenaming(true)}
          >
            <AreaDot color={area.color} />
            <span className="nav-label">{area.name}</span>
            {count > 0 && <span className="badge num">{count}</span>}
          </button>
          {!iconOnly && (
            <Menu
              label={`${area.name} options`}
              className="icon-btn-sm nav-row-action"
              trigger={<MoreHorizontal size={15} aria-hidden />}
              triggerProps={{ tabIndex: -1, 'data-roving': 'menu' }}
              items={() => areaMenu(area, { sides, onRename: () => setRenaming(true), onAddProject, onGone: () => scope.areaId === area.id && onNavigate({ view: 'board', areaId: null, projectId: null }) })}
            />
          )}
        </div>
      )}
      {expanded && (
        <ul className="nav-sub">
          {projects.map((p) => {
            const pActive = scope.projectId === p.id;
            return (
              <li key={p.id}>
                <button type="button" className={cx('nav-item nav-item-sub', pActive && 'is-active')} aria-current={pActive ? 'page' : undefined} onClick={() => onNavigate({ view: 'board', areaId: area.id, projectId: p.id })}>
                  <span className="nav-label">{p.name}</span>
                  {(projectCounts[`project:${p.id}`] ?? 0) > 0 && <span className="badge num">{projectCounts[`project:${p.id}`]}</span>}
                </button>
              </li>
            );
          })}
          {projects.length === 0 && !adding && (
            <li className="nav-empty">
              <button type="button" className="link-btn" onClick={onAddProject}>Add a project</button>
            </li>
          )}
          {adding && (
            <li>
              <InlineAdd
                placeholder="Project name"
                onSubmit={async (name) => {
                  const p = await store.createProject(area.id, name).catch((e) => (store.toast(e.message, 'error'), null));
                  onDoneAdding();
                  if (p) onNavigate({ view: 'board', areaId: area.id, projectId: p.id });
                }}
                onCancel={onDoneAdding}
              />
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

/** Add an area: its name, and once there are areas on both sides, which side it's on. A toast confirms the side, with Change. */
function AreaAdd({ defaultMode, sides, onDone }: { defaultMode: AreaMode; sides: boolean; onDone: (area: Area | null) => void }) {
  const [v, setV] = useState('');
  const [mode, setMode] = useState<AreaMode>(defaultMode);
  const form = useRef<HTMLFormElement>(null);
  const submit = async () => {
    const name = v.trim();
    if (!name) return onDone(null);
    const area = await store.createArea(name, mode).catch((e) => (store.toast(e.message, 'error'), null));
    if (area && sides) {
      const other: AreaMode = mode === 'work' ? 'personal' : 'work';
      store.toast(`Added “${area.name}” to ${mode === 'work' ? 'Work' : 'Personal'}`, 'success', {
        label: 'Change',
        run: () => void setSide(area, other),
      });
    }
    onDone(area);
  };
  return (
    <form
      ref={form}
      className="inline-add area-add"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onBlur={(e) => {
        if (!form.current?.contains(e.relatedTarget as Node) && !v.trim()) onDone(null);
      }}
    >
      <input
        autoFocus
        className="input input-sm"
        value={v}
        placeholder="Area name"
        aria-label="Area name"
        maxLength={80}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') onDone(null);
        }}
      />
      {sides && (
        <div className="segmented segmented-xs" role="group" aria-label="Side">
          {(['work', 'personal'] as AreaMode[]).map((m) => (
            <button key={m} type="button" aria-pressed={mode === m} className={cx('seg', mode === m && 'is-on')} onClick={() => setMode(m)}>
              {m === 'work' ? 'Work' : 'Personal'}
            </button>
          ))}
        </div>
      )}
    </form>
  );
}

function InlineAdd({ placeholder, onSubmit, onCancel, initial = '' }: { placeholder: string; onSubmit: (v: string) => void; onCancel: () => void; initial?: string }) {
  const [v, setV] = useState(initial);
  return (
    <form
      className="inline-add"
      onSubmit={(e) => {
        e.preventDefault();
        if (v.trim()) onSubmit(v.trim());
      }}
    >
      <input
        autoFocus
        className="input input-sm"
        value={v}
        placeholder={placeholder}
        aria-label={placeholder}
        maxLength={120}
        onFocus={(e) => initial && e.currentTarget.select()}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => (initial ? onSubmit(v.trim() || initial) : !v.trim() && onCancel())}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') onCancel();
        }}
      />
    </form>
  );
}

/** "Saved on this Mac" only when the event stream is open and recently heard from. Below it, a quiet line about assistants. */
export function ConnectionStatus({ compact = false }: { compact?: boolean }) {
  const { conn, pendingCount, retryingCount } = useStore();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 15_000);
    return () => clearInterval(t);
  }, []);
  const label = { connecting: 'Connecting', live: 'Saved on this Mac', reconnecting: 'Reconnecting', offline: 'Offline' }[conn.status];
  let detail = conn.lastSyncAt ? (conn.status === 'live' ? formatTime(conn.lastSyncAt) : `Last saved ${relativeTime(conn.lastSyncAt)}`) : 'Not connected yet';
  if (retryingCount > 0) detail = `${retryingCount} change${retryingCount > 1 ? 's' : ''} waiting to save`;
  else if (pendingCount > 0) detail = 'Saving…';
  return (
    <div className={cx('conn', `conn-${conn.status}`, compact && 'conn-compact')} title={conn.error ?? undefined}>
      <span className="conn-dot" aria-hidden="true" />
      <span className="conn-text">
        <span role="status" aria-live="polite">
          <span className="conn-label">{label}</span>
          {!compact && <span className="conn-detail"> · {detail}</span>}
        </span>
        {!compact && <AssistantLine />}
      </span>
      {conn.status !== 'live' && !compact && (
        <button type="button" className="btn btn-ghost btn-xs" onClick={() => void store.syncNow().catch(() => {})}>
          Retry
        </button>
      )}
    </div>
  );
}

/** No assistant connected, which ones are, or, while Claude threads are running, how many tasks Claude is on. */
function AssistantLine() {
  const names = useConnectedAssistants();
  const waiting = useWaitingAssistants();
  const progress = useAllProgress();
  const { tasks } = useStore();
  if (!names) return null;
  const n = tasks.filter((t) => t.status === 'doing' && claudeIsOn(progress.get(t.id))).length;
  if (names.length === 0 && n === 0) {
    return (
      <button type="button" className="conn-claude link-btn" onClick={openAssistants}>
        {assistantStatusLine(names, 0, waiting)}
      </button>
    );
  }
  return <span className="conn-claude">{assistantStatusLine(names, n)}</span>;
}

export function Toasts() {
  const { toasts } = useStore();
  return (
    <div className="toasts" role="region" aria-label="Notifications" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cx('toast', `toast-${t.tone}`)}
          role={t.tone === 'error' ? 'alert' : 'status'}
          onMouseEnter={() => store.pauseToast(t.id)}
          onMouseLeave={(e) => !e.currentTarget.contains(document.activeElement) && store.resumeToast(t.id)}
          onFocus={() => store.pauseToast(t.id)}
          onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && store.resumeToast(t.id)}
        >
          <span>{t.message}</span>
          {t.action && (
            <button
              type="button"
              className="btn btn-ghost btn-xs toast-action"
              onClick={() => {
                t.action!.run();
                store.dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button type="button" className="icon-btn icon-btn-sm" aria-label="Dismiss" onClick={() => store.dismissToast(t.id)}>
            <X size={14} aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}

const FIELD_NAMES: Record<string, string> = {
  title: 'Title', notes: 'Notes', status: 'Status', priority: 'Priority', dueDate: 'Due date', nextAction: 'Next action',
  waitingOn: 'Waiting on', links: 'Links', areaId: 'Area', projectId: 'Project', subtasks: 'Subtasks',
};

function show(field: string, v: unknown, areas: Area[], projects: Project[]) {
  if (v === null || v === undefined || v === '') return <em className="muted">empty</em>;
  if (field === 'status') return STATUS_LABELS[v as Status];
  if (field === 'areaId') return areas.find((a) => a.id === v)?.name ?? String(v);
  if (field === 'projectId') return projects.find((p) => p.id === v)?.name ?? String(v);
  if (field === 'links') return (v as Task['links']).map((l) => l.label || l.url).join(', ') || <em className="muted">none</em>;
  return String(v);
}

/** Shown when your save collided with someone else's change. Nothing is lost: you pick. */
export function ConflictDialog() {
  const { conflicts, areas, projects } = useStore();
  const c: Conflict | undefined = conflicts[0];
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (c && !d.open) d.showModal();
    if (!c && d.open) d.close();
  }, [c]);
  if (!c) return <dialog ref={ref} className="dialog" />;
  const fields = c.fields.filter((f) => f in c.mine);
  const resolve = (choice: 'mine' | 'theirs' | 'both') => {
    if (choice !== 'theirs') {
      const patch: TaskPatchFields = {};
      for (const f of fields) {
        const mine = (c.mine as Record<string, unknown>)[f];
        const theirs = (c.theirs as unknown as Record<string, unknown>)[f];
        (patch as Record<string, unknown>)[f] = choice === 'both' && f === 'notes' ? `${theirs}\n\n${mine}` : mine;
      }
      // Re-apply on top of the version you just reviewed.
      const rest = Object.fromEntries(Object.entries(c.mine).filter(([k]) => !fields.includes(k)));
      store.updateTask(c.taskId, { ...rest, ...patch }, { baseRev: c.theirs.rev });
    }
    store.dismissConflict(c.id);
  };
  return (
    <dialog ref={ref} className="dialog" aria-labelledby="conflict-title" onCancel={(e) => { e.preventDefault(); resolve('theirs'); }}>
      <h2 id="conflict-title" className="dialog-title">Two edits collided</h2>
      <p className="dialog-body">
        “{c.theirs.title}” was changed somewhere else while you were editing. Nothing has been overwritten. Choose what to keep.
      </p>
      <div className="conflict-grid">
        {fields.map((f) => (
          <div key={f} className="conflict-field">
            <span className="eyebrow">{FIELD_NAMES[f] ?? f}</span>
            <div className="conflict-pair">
              <div className="conflict-side">
                <span className="conflict-who">Theirs (saved now)</span>
                <div className="conflict-value">{show(f, (c.theirs as unknown as Record<string, unknown>)[f], areas, projects)}</div>
              </div>
              <div className="conflict-side conflict-mine">
                <span className="conflict-who">Yours (not saved)</span>
                <div className="conflict-value">{show(f, (c.mine as Record<string, unknown>)[f], areas, projects)}</div>
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="dialog-actions">
        <button type="button" className="btn btn-secondary" onClick={() => resolve('theirs')}>
          Keep theirs
        </button>
        {fields.includes('notes') && (
          <button type="button" className="btn btn-secondary" onClick={() => resolve('both')}>
            Keep both notes
          </button>
        )}
        <button type="button" className="btn btn-primary" onClick={() => resolve('mine')} autoFocus>
          Use mine
        </button>
      </div>
    </dialog>
  );
}

export function ShortcutHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const labs = useLabs();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  const mod = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
  const rows: [ReactNode, string][] = [
    [<><Kbd>N</Kbd> or <Kbd>C</Kbd></>, 'New task. Add “fri”, “Oct 20”, “in 3 days”, “#area” or “!high” to set a date, a place or a priority'],
    [<><Kbd>/</Kbd></>, 'Search'],
    [<><Kbd>{mod}</Kbd> <Kbd>K</Kbd></>, 'Go anywhere or do anything'],
    [<><Kbd>M</Kbd></>, 'Switch between Work, Personal and Both, once you have both'],
    [<><Kbd>J</Kbd> <Kbd>K</Kbd> or <Kbd>↓</Kbd> <Kbd>↑</Kbd></>, 'Next / previous task'],
    [<><Kbd>Shift</Kbd> + <Kbd>J</Kbd> <Kbd>K</Kbd></>, 'Select more than one task (or Shift-click, or ' + mod + '-click)'],
    [<><Kbd>Enter</Kbd> or <Kbd>O</Kbd></>, 'Open task'],
    [<><Kbd>E</Kbd></>, 'Rename inline'],
    [<><Kbd>S</Kbd></>, 'Start or stop working on it (In progress)'],
    [<><Kbd>F</Kbd></>, 'Focus on it: one step at a time, full window'],
    [<><Kbd>X</Kbd></>, 'Complete or reopen'],
    [<><Kbd>1</Kbd> to <Kbd>5</Kbd></>, 'Set status: Inbox, Today, Next, Waiting, Done'],
    [<><Kbd>[</Kbd> <Kbd>]</Kbd></>, 'Move to previous / next column'],
    [<><Kbd>Alt</Kbd> + <Kbd>↑</Kbd> <Kbd>↓</Kbd></>, 'Move up / down'],
    [<><Kbd>Space</Kbd></>, 'Pick up to drag with arrow keys, Space to drop'],
    [<><Kbd>P</Kbd></>, 'Cycle priority'],
    [<><Kbd>Del</Kbd></>, 'Move to Trash (undo available)'],
    [<><Kbd>G</Kbd> then <Kbd>T</Kbd> <Kbd>I</Kbd> <Kbd>F</Kbd> <Kbd>S</Kbd> <Kbd>B</Kbd></>, 'Go to Today, Inbox, For you, In progress, Board'],
    [<><Kbd>G</Kbd> then <Kbd>N</Kbd> <Kbd>W</Kbd> <Kbd>D</Kbd></>, 'Go to Next, Waiting, Done'],
    [<><Kbd>G</Kbd> then <Kbd>A</Kbd> <Kbd>,</Kbd></>, 'Go to Activity, Settings'],
    ...(labs.routines ? [[<><Kbd>G</Kbd> then <Kbd>R</Kbd></>, 'Go to Routines'] as [ReactNode, string]] : []),
    ...(labs.wizard ? [[<><Kbd>G</Kbd> then <Kbd>Z</Kbd></>, 'Go to the Wizard'] as [ReactNode, string]] : []),
    [<><Kbd>V</Kbd></>, 'Switch board / list'],
    [<><Kbd>?</Kbd></>, 'Show this list'],
    [<><Kbd>Esc</Kbd></>, 'Close panel, clear selection or search'],
  ];
  return (
    <dialog ref={ref} className="dialog" aria-labelledby="keys-title" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <div className="dialog-headrow">
        <h2 id="keys-title" className="dialog-title">Keyboard shortcuts</h2>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
          <X size={18} aria-hidden />
        </button>
      </div>
      <dl className="keys">
        {rows.map(([k, d], i) => (
          <div key={i} className="keys-row">
            <dt>{k}</dt>
            <dd>{d}</dd>
          </div>
        ))}
      </dl>
    </dialog>
  );
}

/** What capture read out of the title, in words: "Due Fri · High priority · In Home". */
export function describeParsed(p: Pick<ParsedCapture, 'dueDate' | 'priority'> & Partial<Pick<ParsedCapture, 'place'>>) {
  return [p.dueDate && `Due ${formatDue(p.dueDate)}`, p.priority && `${PRIORITY_LABELS[p.priority]} priority`, p.place && `In ${p.place}`].filter(Boolean).join(' · ');
}

/** "#side-projects": how to type an area's name in capture. */
const tagOf = (name: string) => `#${name.toLowerCase().trim().replace(/\s+/g, '-')}`;

/**
 * Quick capture, on its own row. Below the field, in space kept for it: the syntax while you type nothing yet,
 * then what it read out of the title (a day, a place, a priority) before you press Enter.
 */
export function Capture({ inputRef, placeholder, places, onCreate }: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  placeholder: string;
  places: CapturePlaces;
  onCreate: (parsed: ParsedCapture, raw: string) => void;
}) {
  const [v, setV] = useState('');
  const [focused, setFocused] = useState(false);
  const parsed = v.trim() ? parseCapture(v, undefined, places) : null;
  const said = parsed && parsed.found.length ? describeParsed(parsed) : '';
  const firstArea = places.areas.find((a) => !a.archived);
  const example = firstArea && firstArea.name.length <= 16 ? tagOf(firstArea.name) : '#home';
  return (
    <form
      className="capture"
      onSubmit={(e) => {
        e.preventDefault();
        const raw = v.trim();
        if (!raw) return;
        onCreate(parseCapture(raw, undefined, places), raw);
        setV('');
      }}
    >
      <div className="capture-field">
        <Plus size={16} aria-hidden className="capture-icon" />
        <input
          ref={inputRef}
          className="capture-input"
          value={v}
          placeholder={placeholder}
          aria-label="New task title"
          aria-describedby="capture-help"
          maxLength={500}
          enterKeyHint="done"
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') {
              setV('');
              (e.target as HTMLElement).blur();
            }
          }}
        />
        {!v && (
          <span className="capture-hint" aria-hidden="true">
            <Kbd>N</Kbd>
          </span>
        )}
      </div>
      <p id="capture-help" className="capture-help">
        {!said && focused && <span className="capture-syntax">Try {example}, fri, Oct 20, in 3 days or !high</span>}
        <span className="capture-read" aria-live="polite">
          {said && (
            <>
              <span className="capture-help-label">Reads as</span>
              <span className="chip chip-accent capture-parsed">{said}</span>
            </>
          )}
        </span>
      </p>
    </form>
  );
}

/** After you move a task into Waiting: what or who it's waiting on. Saved on the task and added to its notes. */
export function WaitingDialog() {
  const { waitPrompt, byId } = useStore();
  const task = waitPrompt ? byId.get(waitPrompt) : undefined;
  const ref = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState('');
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (task && !d.open) {
      setText(task.waitingOn);
      d.showModal();
    }
    if (!task && d.open) d.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id]);
  const close = () => store.closeWaitPrompt();
  const save = () => {
    const said = text.trim();
    if (task && said) {
      if (said !== task.waitingOn) store.updateTask(task.id, { waitingOn: said });
      store.appendNote(task.id, `Waiting on ${said}`);
    }
    close();
  };
  return (
    <dialog ref={ref} className="dialog dialog-small" aria-labelledby="wait-title" onCancel={(e) => { e.preventDefault(); close(); }}>
      {task && (
        <form onSubmit={(e) => { e.preventDefault(); save(); }}>
          <h2 id="wait-title" className="dialog-title">What are you waiting on?</h2>
          <p className="dialog-body">“{task.title}” is in Waiting. Say who or what, and it's saved on the task and added to its notes.</p>
          <textarea
            className="textarea"
            rows={2}
            autoFocus
            aria-label="What you're waiting on"
            placeholder="e.g. Michael to confirm the final dates and my slot"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                save();
              }
            }}
          />
          <div className="dialog-actions">
            <button type="button" className="btn btn-secondary" onClick={close}>Skip</button>
            <button type="submit" className="btn btn-primary" disabled={!text.trim()}>Save</button>
          </div>
        </form>
      )}
    </dialog>
  );
}
