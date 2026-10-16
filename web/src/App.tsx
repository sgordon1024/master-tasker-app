import { FocusMode } from './components/Focus.tsx';
import { Setup } from './components/Setup.tsx';
import { Tour } from './components/tour/Tour.tsx';
import { CalendarCheck, CheckCircle2, Clock, Columns3, Filter, Inbox as InboxIcon, Keyboard, List, ListTodo, Menu, Search, SearchX, Trash2, X, Zap } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PRIORITIES, PRIORITY_LABELS, STATUS_LABELS, type Status, type Task, type TaskCreate } from '../../shared/schema.ts';
import { EmptyState, AreaDot, STATUS_OPTIONS } from './components/Bits.tsx';
import { Capture, ConflictDialog, WaitingDialog, ConnectionStatus, ShortcutHelp, Sidebar, Toasts, VIEW_META, ModeMenu, hasBothSides, describeParsed, useMedia } from './components/Chrome.tsx';
import { ConfirmHost, SelectMenu } from './components/Menu.tsx';
import { CommandPalette } from './components/Palette.tsx';
import { FirstRunCard, todayQueue, TodayDone, TodayProgress, TodaySummary, WeekDone, weekStats } from './components/Today.tsx';
import { TaskDetail } from './components/TaskDetail.tsx';
import { TaskGroups, type Group } from './components/TaskGroups.tsx';
import { RoutinesView } from './components/Sources.tsx';
import { ActivityView, ForYouView, SettingsView, TrashView } from './components/Views.tsx';
import { between, byCompleted, byPosition, clip, cx, EMPTY_FILTERS, formatDue, inScope, matches, byYouFirst, needsYouItems, PRIORITY_RANK, STATUS_ORDER, todayIso, type Filters, type ParsedCapture, type Scope, type ViewId } from './lib.ts';
import { doneToday, store, useStore } from './store.ts';
import { useProgressPolling } from './progress.ts';
import { finishTask, useFinishing } from './finish.ts';
import { setPref, TRIED_FOCUS, useLabs } from './prefs.ts';
import { areaInMode, nextWorkMode, proposalInMode, setWorkMode, taskInMode, usePendingProposals, useWorkMode, WORK_MODES } from './mode.ts';

// The Wizard is optional and heavy, so it loads only when opened.
const WizardView = lazy(() => import('./wizard/WizardView.tsx'));

// 1 to 5 keep their meaning; In progress has its own key (S).
const NUMBER_KEYS: Status[] = ['inbox', 'today', 'next', 'waiting', 'done'];
const TASK_VIEWS: ViewId[] = ['inbox', 'doing', 'today', 'next', 'waiting', 'done', 'board'];
// Older links keep working.
const VIEW_ALIASES: Record<string, ViewId> = { review: 'foryou', sources: 'routines' };

function parseHash(): { scope: Scope; taskId: string | null; focusId: string | null; section: string | null } {
  const [path, qs] = location.hash.replace(/^#\/?/, '').split('?');
  const parts = path.split('/').filter(Boolean);
  const params = new URLSearchParams(qs ?? '');
  const taskId = params.get('task');
  const focusId = params.get('focus');
  if (parts[0] === 'area' && parts[1]) return { scope: { view: 'board', areaId: parts[1], projectId: parts[3] ?? null }, taskId, focusId, section: null };
  // Today is home.
  const name = VIEW_ALIASES[parts[0]] ?? parts[0];
  const view = (Object.keys(VIEW_META) as ViewId[]).includes(name as ViewId) ? (name as ViewId) : 'today';
  // One part of Settings, e.g. #/settings?section=assistants for AI assistants.
  const section = view === 'settings' ? params.get('section') : null;
  return { scope: { view, areaId: null, projectId: null }, taskId, focusId, section };
}

function toHash(scope: Scope, taskId: string | null, focusId: string | null = null, section: string | null = null) {
  const base = scope.areaId ? `#/area/${scope.areaId}${scope.projectId ? `/project/${scope.projectId}` : ''}` : `#/${scope.view}`;
  const q = new URLSearchParams();
  if (section && scope.view === 'settings' && !scope.areaId) q.set('section', section);
  if (taskId) q.set('task', taskId);
  if (focusId) q.set('focus', focusId);
  const s = q.toString();
  return s ? `${base}?${s}` : base;
}

/** The view part of a hash, without the open task: "#/today?task=x" is "#/today". */
const viewOf = (h: string) => h.split('?')[0] || '#/today';

const isTyping = (el: EventTarget | null) => {
  const n = el as HTMLElement | null;
  return !!n && (n.tagName === 'INPUT' || n.tagName === 'TEXTAREA' || n.tagName === 'SELECT' || n.isContentEditable);
};

export function App() {
  const snap = useStore();
  const { tasks, areas, projects, ready, byId } = snap;
  // First-run setup comes before everything else, the tour included. It shows once per install.
  const setupOpen = ready && !snap.settings.setupDone;
  const initial = useMemo(parseHash, []);
  const [scope, setScope] = useState<Scope>(initial.scope);
  const [openId, setOpenId] = useState<string | null>(initial.taskId);
  // Focus mode: one task, one step, the whole window.
  const [focusId, setFocusId] = useState<string | null>(initial.focusId);
  const [section, setSection] = useState<string | null>(initial.section);
  useEffect(() => {
    const on = (e: Event) => setFocusId((e as CustomEvent<string>).detail);
    window.addEventListener('mt:focus', on);
    return () => window.removeEventListener('mt:focus', on);
  }, []);
  useEffect(() => {
    if (focusId) setPref(TRIED_FOCUS, '1');
  }, [focusId]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const phone = useMedia('(max-width: 760px)');
  // Until you pick one, phones show List (five columns don't fit a phone) and wider screens show Board.
  const [layoutPick, setLayoutPick] = useState<'board' | 'list' | null>(() => localStorage.getItem('mt.layout') as 'board' | 'list' | null);
  const layoutPref = layoutPick ?? (phone ? 'list' : 'board');
  const [menuOpen, setMenuOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  // In a narrow window, search hides behind an icon until you ask for it.
  const [searchOpen, setSearchOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  // Tasks picked for a bulk action.
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const captureRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const today = todayIso();
  const labs = useLabs();
  const finishing = useFinishing();

  const setLayout = (l: 'board' | 'list') => {
    setLayoutPick(l);
    localStorage.setItem('mt.layout', l);
  };
  // Re-poll right away when the set of In progress tasks or their subtasks change.
  const doingKey = useMemo(() => tasks.filter((t) => t.status === 'doing').map((t) => `${t.id}:${t.rev}`).join(','), [tasks]);
  useProgressPolling(doingKey !== '', doingKey);

  // Opening a task adds a history entry, so the browser's Back closes it. Everything else replaces.
  // The entry remembers the view it was opened on. Moving to another view forgets it, so closing the
  // task never steps back to the view you left.
  const shownOpen = useRef<string | null>(initial.taskId);
  const goingBack = useRef(false);
  useEffect(() => {
    const h = toHash(scope, openId, focusId, section);
    if (location.hash !== h) {
      if (openId && openId !== shownOpen.current) history.pushState({ mtTask: openId, mtView: viewOf(h) }, '', h);
      else {
        const st = history.state as { mtTask?: string; mtView?: string } | null;
        history.replaceState(st?.mtTask && st.mtView === viewOf(h) ? st : null, '', h);
      }
    }
    shownOpen.current = openId;
  }, [scope, openId, focusId, section]);
  useEffect(() => {
    const onPop = () => {
      goingBack.current = false;
      const p = parseHash();
      shownOpen.current = p.taskId;
      setScope(p.scope);
      setOpenId(p.taskId);
      setFocusId(p.focusId);
      setSection(p.section);
    };
    window.addEventListener('hashchange', onPop);
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('hashchange', onPop);
      window.removeEventListener('popstate', onPop);
    };
  }, []);
  /**
   * Close the open task. If opening it added a history entry, step back over it instead of adding another.
   * Once only: Esc reaches both the panel and the page, and two steps back would leave the view.
   */
  const closeTask = useCallback(() => {
    if (goingBack.current) return;
    if (history.state?.mtTask && history.state.mtTask === shownOpen.current && history.state.mtView === viewOf(location.hash)) {
      goingBack.current = true;
      history.back();
    } else setOpenId(null);
  }, []);

  const areaMap = useMemo(() => new Map(areas.map((a) => [a.id, a])), [areas]);
  const bothSides = hasBothSides(areas);
  const workMode = useWorkMode();
  // With areas on only one side, the switch has nothing to switch: show everything.
  useEffect(() => {
    if (ready && !bothSides && workMode !== 'both') setWorkMode('both');
  }, [ready, bothSides, workMode]);
  // Everything below works on the tasks for the current mode. Opening a task by link still works.
  const modeTasks = useMemo(() => (workMode === 'both' ? tasks : tasks.filter((t) => taskInMode(t, areaMap, workMode))), [tasks, areaMap, workMode]);
  const pendingList = usePendingProposals(snap.versions.proposals);
  const pendingInMode = pendingList ? pendingList.filter((p) => proposalInMode(p, byId, areaMap, workMode)).length : snap.pendingProposals;
  const projectMap = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const scopedArea = scope.areaId ? areaMap.get(scope.areaId) : undefined;
  const scopedProject = scope.projectId ? projectMap.get(scope.projectId) : undefined;
  const isTaskView = TASK_VIEWS.includes(scope.view) || !!scope.areaId;
  const isBoardView = !!scope.areaId || scope.view === 'board';
  const layout: 'board' | 'list' = isBoardView ? layoutPref : 'list';
  const filtersActive = filters.q !== '' || filters.priority !== 'any' || filters.due !== 'any';
  const filterCount = Number(filters.priority !== 'any') + Number(filters.due !== 'any');

  // Counts for the sidebar, ignoring search and filters. Today counts what the Today column and page show:
  // planned for today, plus anything due today or overdue.
  const counts = useMemo(() => {
    const c: Record<string, number> = { inbox: 0, doing: 0, today: 0, next: 0, waiting: 0, todayDone: doneToday(modeTasks, today), overdue: 0, dueToday: 0 };
    for (const t of modeTasks) {
      if (t.status === 'done') continue;
      if (t.status !== 'today' && c[t.status] !== undefined) c[t.status]++;
      if (t.status === 'today' || (t.dueDate && t.dueDate <= today)) c.today++;
      if (t.dueDate && t.dueDate < today) c.overdue++;
      if (t.dueDate === today) c.dueToday++;
      if (t.areaId) c[`area:${t.areaId}`] = (c[`area:${t.areaId}`] ?? 0) + 1;
      if (t.projectId) c[`project:${t.projectId}`] = (c[`project:${t.projectId}`] ?? 0) + 1;
    }
    c.needsYou = modeTasks.filter((t) => needsYouItems(t).length > 0).length;
    c.finished = modeTasks.filter((t) => t.status === 'done' && t.finishedBy).length;
    c.foryou = pendingInMode + c.needsYou + c.finished;
    return c;
  }, [modeTasks, today, pendingInMode]);

  const visible = useMemo(() => {
    const list = modeTasks.filter((t) => inScope(t, scope) && matches(t, filters, today, { areas: areaMap, projects: projectMap }));
    // A task you just finished stays where it was until it has folded away.
    return finishing.size ? list.map((t) => (finishing.has(t.id) ? { ...t, status: finishing.get(t.id)!.from } : t)) : list;
  }, [modeTasks, scope, filters, today, areaMap, projectMap, finishing]);

  const groups: Group[] = useMemo(() => {
    // Anything that needs you goes to the top of its column.
    // Among those, most important first.
    const youFirst = (a: Task, b: Task) => {
      const ya = needsYouItems(a).length > 0, yb = needsYouItems(b).length > 0;
      return Number(yb) - Number(ya) || (ya && yb ? byYouFirst(a, b) : 0);
    };
    const of = (s: Status) => visible.filter((t) => t.status === s).sort((a, b) => youFirst(a, b) || (s === 'done' ? byCompleted(a, b) : byPosition(a, b)));
    if (isBoardView) {
      return STATUS_ORDER.map((s) => {
        const list = of(s);
        return {
          id: s,
          title: STATUS_LABELS[s],
          status: s,
          tasks: s === 'done' ? list.slice(0, layout === 'board' ? 30 : 10) : list,
          total: s === 'done' ? list.length : undefined,
          sortable: true,
          // Due today or overdue counts as Today, wherever it lives, the same as the sidebar.
          ghosts: s === 'today' && layout === 'board' ? visible.filter((t) => t.status !== 'today' && t.status !== 'done' && t.dueDate && t.dueDate <= today).sort((a, b) => a.dueDate!.localeCompare(b.dueDate!)) : undefined,
        };
      });
    }
    switch (scope.view) {
      case 'today': {
        // In progress has its own group above, due date or not.
        const open = visible.filter((t) => t.status !== 'done' && t.status !== 'today' && t.status !== 'doing' && t.dueDate);
        const overdue = open.filter((t) => t.dueDate! < today).sort((a, b) => a.dueDate!.localeCompare(b.dueDate!));
        const dueToday = open.filter((t) => t.dueDate === today).sort(byPosition);
        const g: Group[] = [];
        const doing = of('doing');
        if (doing.length) g.push({ id: 'doing', title: 'In progress', status: 'doing', tasks: doing, sortable: true });
        if (overdue.length) g.push({ id: 'overdue', title: 'Overdue', status: null, tasks: overdue, sortable: false });
        if (dueToday.length) g.push({ id: 'due-today', title: 'Due today', status: null, tasks: dueToday, sortable: false });
        const planned = of('today');
        if (planned.length || !g.length) g.push({ id: 'today', title: g.length ? 'Planned for today' : 'Today', status: 'today', tasks: planned, sortable: true });
        return g;
      }
      case 'done': {
        const byDay = new Map<string, Task[]>();
        for (const t of of('done').slice(0, 300)) {
          const d = t.completedAt ? todayIso(new Date(t.completedAt)) : 'Earlier';
          byDay.set(d, [...(byDay.get(d) ?? []), t]);
        }
        return [...byDay.entries()].map(([d, list]) => ({ id: `done-${d}`, title: d === 'Earlier' ? d : formatDue(d, today), status: null, tasks: list, sortable: false }));
      }
      default: {
        const s = scope.view as Status;
        return [{ id: s, title: STATUS_LABELS[s], status: s, tasks: of(s), sortable: true }];
      }
    }
  }, [visible, scope, layout, today, isBoardView]);

  // A link to an area or project that no longer exists falls back to the board.
  useEffect(() => {
    if (!ready) return;
    if ((scope.areaId && !areaMap.has(scope.areaId)) || (scope.projectId && !projectMap.has(scope.projectId))) {
      setScope({ view: 'board', areaId: null, projectId: null });
    }
  }, [ready, scope.areaId, scope.projectId, areaMap, projectMap]);

  const totalShown = groups.reduce((n, g) => n + g.tasks.length + (g.ghosts?.length ?? 0), 0);
  const openTask = openId ? byId.get(openId) : undefined;
  useEffect(() => {
    if (openId && ready && !openTask) setOpenId(null);
  }, [openId, openTask, ready]);

  const navigate = useCallback((s: Partial<Scope>) => {
    setScope((cur) => ({ ...cur, ...s }));
    setSection(null);
    setEditingId(null);
    setPicked(new Set());
  }, []);
  const go = (view: ViewId) => navigate({ view, areaId: null, projectId: null });

  // Switching to the other side while looking at an area of this side goes back to the board.
  useEffect(() => {
    if (scopedArea && !areaInMode(scopedArea, workMode)) setScope({ view: 'board', areaId: null, projectId: null });
  }, [scopedArea, workMode]);

  // Wizard and Routines are Labs: switched off, their pages aren't there.
  useEffect(() => {
    if ((scope.view === 'wizard' && !labs.wizard) || (scope.view === 'routines' && !labs.routines && labs.routineCount !== null)) setScope({ view: 'today', areaId: null, projectId: null });
  }, [scope.view, labs.wizard, labs.routines, labs.routineCount]);

  const createDefaults = (): Partial<TaskCreate> => {
    const status: Status = ['doing', 'today', 'next', 'waiting'].includes(scope.view) && !scope.areaId ? (scope.view as Status) : 'inbox';
    // In Work or Personal mode, a new task goes to that side's first area, so it stays visible there.
    const modeArea = workMode === 'both' ? null : areas.find((a) => !a.archived && a.mode === workMode)?.id ?? null;
    return { status, areaId: scope.areaId ?? modeArea, projectId: scope.projectId ?? null };
  };
  // Capture reads a day ("fri", "Oct 20"), a place ("#home") and "!high" out of the title. When it does, a toast says so, with Undo.
  const capture = (p: ParsedCapture, raw: string) => {
    const d = createDefaults();
    const input = {
      ...d,
      title: p.title,
      ...(p.dueDate ? { dueDate: p.dueDate } : {}),
      ...(p.priority ? { priority: p.priority } : {}),
      ...(p.areaId ? { areaId: p.areaId, projectId: p.projectId } : {}),
    } as TaskCreate;
    void store.createTask(input).then((t) => {
      if (!t || !p.found.length) return;
      store.toast(`Added “${clip(p.title)}” · ${describeParsed(p)}`, 'success', {
        label: 'Undo',
        run: () =>
          store.updateTask(t.id, {
            title: raw,
            ...(p.dueDate ? { dueDate: null } : {}),
            ...(p.priority ? { priority: 'none' as const } : {}),
            ...(p.areaId ? { areaId: d.areaId ?? null, projectId: d.projectId ?? null } : {}),
          }),
      });
    });
  };
  const openSearch = () => {
    setSearchOpen(true);
    requestAnimationFrame(() => searchRef.current?.focus());
  };

  // ─── Keyboard ───
  const focusedTaskId = () => (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-task-id]')?.dataset.taskId ?? null;
  const focusTask = (id: string) =>
    requestAnimationFrame(() => mainRef.current?.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(id)}"]`)?.focus());
  const taskEls = () => [...(mainRef.current?.querySelectorAll<HTMLElement>('[data-task-id]') ?? [])].filter((el) => !el.classList.contains('is-finishing'));

  const moveFocus = (dir: 1 | -1) => {
    const all = taskEls();
    if (!all.length) return null;
    const cur = focusedTaskId();
    const i = cur ? all.findIndex((el) => el.dataset.taskId === cur) : -1;
    const next = all[Math.max(0, Math.min(all.length - 1, i === -1 ? 0 : i + dir))];
    next.focus();
    next.scrollIntoView({ block: 'nearest' });
    return next.dataset.taskId ?? null;
  };

  const reorder = (id: string, dir: 1 | -1) => {
    const el = mainRef.current?.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(id)}"]`);
    const container = el?.dataset.container;
    const group = groups.find((g) => g.id === container);
    if (!group?.sortable || !group.status) return;
    const list = group.tasks;
    const i = list.findIndex((t) => t.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    const pos = dir < 0 ? between(list[j - 1]?.position, list[j].position) : between(list[j].position, list[j + 1]?.position);
    store.move(id, group.status, pos);
    focusTask(id);
  };

  // ─── Picking several tasks ───
  const pickRange = (to: string) => {
    const ids = taskEls().map((el) => el.dataset.taskId!);
    const from = anchor.current ?? focusedTaskId() ?? openId ?? to;
    const a = ids.indexOf(from), b = ids.indexOf(to);
    if (a < 0 || b < 0) return setPicked(new Set([to]));
    const [lo, hi] = a < b ? [a, b] : [b, a];
    setPicked((cur) => new Set([...cur, ...ids.slice(lo, hi + 1)]));
  };
  const togglePick = (id: string) => {
    anchor.current = id;
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const clearPicked = () => {
    setPicked(new Set());
    anchor.current = null;
  };
  const pickedIds = [...picked].filter((id) => byId.has(id));
  const bulk = {
    complete: () => {
      const open = pickedIds.filter((id) => byId.get(id)!.status !== 'done');
      open.forEach((id) => store.complete(id, { quiet: true }));
      store.toast(`Done · ${open.length} ${open.length === 1 ? 'task' : 'tasks'}`, 'success', { label: 'Undo', run: () => open.forEach((id) => store.reopen(id)) });
      clearPicked();
    },
    move: (status: Status) => {
      pickedIds.forEach((id) => store.updateTask(id, { status }));
      store.toast(`Moved ${pickedIds.length} to ${STATUS_LABELS[status]}`);
      clearPicked();
    },
    trash: () => {
      const ids = pickedIds;
      void Promise.all(ids.map((id) => store.deleteTask(id, { quiet: true }))).then((outs) => {
        const gone = outs.filter(Boolean).length;
        if (gone) store.toast(`Moved ${gone} ${gone === 1 ? 'task' : 'tasks'} to Trash`, 'info', { label: 'Undo', run: () => ids.forEach((id) => void store.restoreTask(id, { quiet: true })) });
      });
      if (openId && ids.includes(openId)) setOpenId(null);
      clearPicked();
    },
  };

  // Clicking the open card again closes it. Shift or Cmd picks instead.
  const onItem = (id: string, mods?: { shift: boolean; meta: boolean }) => {
    if (mods?.meta) return togglePick(id);
    if (mods?.shift) return pickRange(id);
    if (picked.size) clearPicked();
    anchor.current = id;
    if (openId === id) closeTask();
    else setOpenId(id);
  };

  // A click on empty space (board, gaps, page background) closes the open task. Clicks on cards,
  // the task panel, dialogs and any control keep it open.
  useEffect(() => {
    if (!openId) return;
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.defaultPrevented) return;
      const el = e.target as HTMLElement | null;
      if (!el?.isConnected) return;
      if (el.closest('.task, .detail, dialog, .toasts, .menu, .bulk-bar, [role="menu"], [role="listbox"], button, a, input, select, textarea, label, summary, [contenteditable="true"], [role="switch"], [role="button"], [role="tab"], [tabindex]:not([tabindex="-1"])')) return;
      if (String(window.getSelection() ?? '').length > 0) return;
      closeTask();
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [openId, closeTask]);

  const gPending = useRef(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ⌘K anywhere, even while typing.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && !focusId) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      if (e.metaKey || e.ctrlKey) return;
      if (focusId) return; // Focus mode handles its own keys.
      if (document.querySelector('dialog[open]')) return;
      if (dragging) return;
      if (isTyping(e.target)) return;
      const key = e.key;
      const id = focusedTaskId() ?? openId;
      const task = id ? store.getSnapshot().byId.get(id) : undefined;

      if (gPending.current) {
        gPending.current = false;
        const target = (Object.entries(VIEW_META) as [ViewId, { key?: string }][]).find(([v, m]) => m.key === key.toLowerCase() && (v !== 'wizard' || labs.wizard) && (v !== 'routines' || labs.routines));
        if (target) {
          e.preventDefault();
          go(target[0]);
        }
        return;
      }
      if (key === 'g') {
        gPending.current = true;
        setTimeout(() => (gPending.current = false), 1200);
        return;
      }
      if (key === 'Escape') {
        if (picked.size) clearPicked();
        else if (openId) closeTask();
        else if (filtersActive) setFilters(EMPTY_FILTERS);
        return;
      }
      if (key === '?') return setHelpOpen(true);
      // Several picked: the task keys act on all of them.
      if (picked.size) {
        if (key === 'x') return bulk.complete();
        if (key === 'Delete' || key === 'Backspace') {
          e.preventDefault();
          return bulk.trash();
        }
        if (/^[1-4]$/.test(key)) return bulk.move(NUMBER_KEYS[Number(key) - 1]);
        if (key === '5') return bulk.complete();
      }
      if ((key === 'J' || key === 'K' || ((key === 'ArrowDown' || key === 'ArrowUp') && e.shiftKey)) && !e.altKey) {
        e.preventDefault();
        const from = focusedTaskId();
        const to = moveFocus(key === 'J' || key === 'ArrowDown' ? 1 : -1);
        if (from && to) setPicked((cur) => new Set([...cur, from, to]));
        if (!anchor.current) anchor.current = from;
        return;
      }
      if (key === 'f' && task && task.status !== 'done') return setFocusId(task.id);
      if (key === 'm' && bothSides) {
        const m = nextWorkMode(workMode);
        setWorkMode(m);
        return store.toast(`Showing ${WORK_MODES.find((x) => x.id === m)!.label}`, 'info');
      }
      if (key === 'n' || key === 'c') {
        e.preventDefault();
        // Focus synchronously so no keystrokes typed right after N are lost.
        if (captureRef.current) captureRef.current.focus();
        else {
          go('inbox');
          requestAnimationFrame(() => captureRef.current?.focus());
        }
        return;
      }
      if (key === '/') {
        e.preventDefault();
        openSearch();
        return;
      }
      if (key === 'v' && isBoardView) return setLayout(layoutPref === 'board' ? 'list' : 'board');
      if (key === 'j' || key === 'ArrowDown') {
        if (e.altKey && task) return reorder(task.id, 1);
        e.preventDefault();
        return void moveFocus(1);
      }
      if (key === 'k' || key === 'ArrowUp') {
        if (e.altKey && task) return reorder(task.id, -1);
        e.preventDefault();
        return void moveFocus(-1);
      }
      if (!task) return;
      if (key === 'Enter' || key === 'o') {
        e.preventDefault();
        setOpenId(task.id);
      } else if (key === 'e') {
        e.preventDefault();
        setEditingId(task.id);
      } else if (key === 'x') {
        finishTask(task.id);
      } else if (key === 's') {
        store.toggleDoing(task.id);
        focusTask(task.id);
      } else if (/^[1-5]$/.test(key)) {
        if (key === '5') finishTask(task.id);
        else store.updateTask(task.id, { status: NUMBER_KEYS[Number(key) - 1] });
        focusTask(task.id);
      } else if (key === '[' || key === ']') {
        const i = STATUS_ORDER.indexOf(task.status);
        const next = STATUS_ORDER[i + (key === ']' ? 1 : -1)];
        if (next) {
          store.updateTask(task.id, { status: next });
          store.toast(`Moved to ${STATUS_LABELS[next]}`);
          focusTask(task.id);
        }
      } else if (key === 'p') {
        const i = PRIORITIES.indexOf(task.priority);
        store.updateTask(task.id, { priority: PRIORITIES[(i + 1) % PRIORITIES.length] });
      } else if (key === 'Delete' || key === 'Backspace') {
        e.preventDefault();
        moveFocus(1);
        store.deleteTask(task.id);
        if (openId === task.id) setOpenId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ─── Render ───
  const title = scopedProject?.name ?? scopedArea?.name ?? VIEW_META[scope.view].label;
  const canCapture = isTaskView && scope.view !== 'done';
  const capturePlaceholder = (() => {
    const d = createDefaults();
    const where = scopedProject ? scopedProject.name : scopedArea ? scopedArea.name : null;
    return `Add to ${STATUS_LABELS[d.status!]}${where ? ` in ${where}` : ''}`;
  })();
  const focusCapture = () => requestAnimationFrame(() => captureRef.current?.focus());
  const focusTaskObj = focusId ? byId.get(focusId) : undefined;
  const tabs: ViewId[] = ['today', 'inbox', 'foryou', 'doing'];
  const tabBadge = (v: ViewId) => (v === 'foryou' ? counts.needsYou : v === 'today' ? counts.today : counts[v]);
  const isToday = scope.view === 'today' && !scope.areaId;
  // Today's progress: done today, of done plus what's still on the page (in progress, overdue, due, planned).
  const todayOpen = useMemo(() => todayQueue(modeTasks, today).length, [modeTasks, today]);
  const week = useMemo(() => weekStats(modeTasks, today).total, [modeTasks, today]);
  const todayDone = isToday && ready && totalShown === 0 && !filtersActive && counts.todayDone > 0;
  // Under the title of every task view, one line in the same place, so the toolbar never moves between views.
  const countLine = (() => {
    if (scope.projectId) return `${counts[`project:${scope.projectId}`] ?? 0} open`;
    if (scope.areaId) return `${counts[`area:${scope.areaId}`] ?? 0} open`;
    const n = counts[scope.view] ?? 0;
    switch (scope.view) {
      case 'inbox': return n ? `${n} to sort` : 'All sorted';
      case 'doing': return n ? `${n} in progress` : 'Nothing started';
      case 'next': return n ? `${n} ready to do` : 'Nothing lined up';
      case 'waiting': return n ? `${n} waiting on someone else` : 'Not waiting on anyone';
      case 'done': return `${week} done this week`;
      case 'board': return `${counts.inbox + counts.doing + counts.next + counts.waiting + modeTasks.filter((t) => t.status === 'today').length} open`;
      default: return '';
    }
  })();
  const progress = isToday && ready && <TodayProgress done={counts.todayDone} open={todayOpen} week={week} onGo={go} />;
  const firstRun = isToday && ready && <FirstRunCard onFocus={(id) => setFocusId(id)} />;

  return (
    <>
      <div className={cx('app', openTask && 'has-detail')} inert={!!focusTaskObj}>
        <a className="skip-link" href="#main">Skip to tasks</a>
        <Sidebar scope={scope} counts={counts} onNavigate={navigate} open={menuOpen} onClose={() => setMenuOpen(false)} />

        <main id="main" className="main" ref={mainRef} tabIndex={-1}>
          <header className={cx('topbar', searchOpen && 'is-searching')}>
            <div className="title-block">
              {scopedArea && scopedProject && (
                <span className="crumb">
                  <AreaDot color={scopedArea.color} />
                  <button type="button" className="crumb-link" onClick={() => navigate({ projectId: null })}>
                    {scopedArea.name}
                  </button>
                </span>
              )}
              <div className="title-row">
                <h1 className="view-title">
                  {scopedArea && !scopedProject && <AreaDot color={scopedArea.color} size={10} />}
                  {title}
                </h1>
                {!phone && progress}
              </div>
              {isTaskView && (
                <div className="summary-row">
                  {phone && progress}
                  {isToday ? (
                    ready && <TodaySummary counts={counts} filters={filters} onFilter={(due) => setFilters({ ...EMPTY_FILTERS, due })} onGo={go} />
                  ) : (
                    ready && <p className="view-summary view-count">{countLine}</p>
                  )}
                </div>
              )}
            </div>
            <div className="topbar-spacer" />
            {isTaskView && (
              <div className="toolbar-tools">
                <div className="search" role="search">
                  <Search size={15} aria-hidden className="search-icon" />
                  <input
                    ref={searchRef}
                    className="search-input"
                    type="search"
                    placeholder="Search"
                    aria-label="Search tasks"
                    value={filters.q}
                    onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
                    onBlur={(e) => !e.target.value && setSearchOpen(false)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        setFilters((f) => ({ ...f, q: '' }));
                        setSearchOpen(false);
                        (e.target as HTMLElement).blur();
                      }
                      if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        moveFocus(1);
                      }
                    }}
                  />
                </div>
                <button type="button" className={cx('icon-btn search-toggle', filters.q && 'is-on')} aria-label="Search" title="Search (/)" aria-expanded={searchOpen} onClick={openSearch}>
                  <Search size={18} aria-hidden />
                </button>
                <button type="button" className={cx('btn btn-ghost btn-sm filter-btn tool-other', filterCount > 0 && 'is-on')} aria-label={filterCount ? `Filter, ${filterCount} on` : 'Filter'} aria-expanded={filtersOpen} aria-controls="filters" onClick={() => setFiltersOpen((o) => !o)}>
                  <Filter size={14} aria-hidden /> <span className="seg-label" aria-hidden>Filter</span>{filterCount > 0 && <span className="badge num" aria-hidden>{filterCount}</span>}
                </button>
                {bothSides && <span className="tool-other"><ModeMenu /></span>}
                {isBoardView && (
                  <div className="segmented tool-other" role="group" aria-label="Layout">
                    <button type="button" aria-pressed={layout === 'board'} aria-label="Board" className={cx('seg', layout === 'board' && 'is-on')} onClick={() => setLayout('board')}>
                      <Columns3 size={14} aria-hidden /> <span className="seg-label" aria-hidden>Board</span>
                    </button>
                    <button type="button" aria-pressed={layout === 'list'} aria-label="List" className={cx('seg', layout === 'list' && 'is-on')} onClick={() => setLayout('list')}>
                      <List size={14} aria-hidden /> <span className="seg-label" aria-hidden>List</span>
                    </button>
                  </div>
                )}
              </div>
            )}
            <ConnectionStatus compact />
            <button type="button" className="icon-btn help-btn" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" onClick={() => setHelpOpen(true)}>
              <Keyboard size={18} aria-hidden />
            </button>
          </header>

          {isTaskView && filtersOpen && (
            <div className="filters" id="filters" role="group" aria-label="Filters">
              <SelectMenu
                label="Filter by priority"
                className="select-btn-compact"
                value={filters.priority}
                onChange={(priority) => setFilters((f) => ({ ...f, priority }))}
                options={[
                  { value: 'any', label: 'Any priority' },
                  ...PRIORITIES.filter((p) => p !== 'none').sort((a, b) => PRIORITY_RANK[a] - PRIORITY_RANK[b]).map((p) => ({ value: p, label: PRIORITY_LABELS[p] })),
                  { value: 'none', label: 'No priority' },
                ]}
              />
              <SelectMenu
                label="Filter by due date"
                className="select-btn-compact"
                value={filters.due}
                onChange={(due) => setFilters((f) => ({ ...f, due }))}
                options={[
                  { value: 'any', label: 'Any date' },
                  { value: 'overdue', label: 'Overdue' },
                  { value: 'today', label: 'Due today' },
                  { value: 'week', label: 'Due within 7 days' },
                  { value: 'none', label: 'No due date' },
                ]}
              />
              {filtersActive && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFilters(EMPTY_FILTERS)}>
                  <X size={14} aria-hidden /> Clear
                </button>
              )}
            </div>
          )}
          {canCapture && (
            <div className="capture-row">
              <Capture inputRef={captureRef} placeholder={capturePlaceholder} places={{ areas, projects }} onCreate={capture} />
            </div>
          )}

          <div className={cx('content', layout === 'board' && isTaskView && totalShown > 0 && 'content-board')}>
            {/* On a phone, your tasks come first and Getting started waits below them. */}
            {!phone && firstRun}
            {!ready && isTaskView && <Loading />}
            {ready && isTaskView && totalShown === 0 && filtersActive && (
              <EmptyState icon={<SearchX size={22} />} title="No matching tasks" body={filters.q ? `Nothing in ${title} matches “${filters.q}”.` : `Nothing in ${title} matches these filters.`}>
                <button type="button" className="btn btn-secondary" onClick={() => setFilters(EMPTY_FILTERS)}>
                  Clear search and filters
                </button>
              </EmptyState>
            )}
            {todayDone && <TodayDone tasks={modeTasks} done={counts.todayDone} onOpen={setOpenId} />}
            {ready && isTaskView && totalShown === 0 && !filtersActive && !todayDone && <ViewEmpty view={scope.view} scoped={!!scope.areaId} name={title} onAdd={focusCapture} onGo={go} />}
            {ready && scope.view === 'done' && !scope.areaId && <WeekDone tasks={modeTasks} />}
            {ready && isTaskView && totalShown > 0 && (
              <TaskGroups
                groups={groups}
                layout={layout}
                areas={areaMap}
                projects={projectMap}
                selectedId={openId}
                picked={picked}
                editingId={editingId}
                onOpen={onItem}
                onEditDone={() => {
                  const id = editingId;
                  setEditingId(null);
                  if (id) focusTask(id);
                }}
                showPlacement={!scope.areaId}
                onDraggingChange={setDragging}
                onOpenView={(s) => go(s)}
                compact={phone}
              />
            )}
            {phone && firstRun}
            {scope.view === 'foryou' && !scope.areaId && (
              <ForYouView
                needsYou={modeTasks.filter((t) => needsYouItems(t).length > 0).sort(byYouFirst)}
                finished={modeTasks.filter((t) => t.status === 'done' && t.finishedBy).sort((a, b) => (b.finishedBy!.at > a.finishedBy!.at ? 1 : -1))}
                onOpen={setOpenId}
                onGo={go}
              />
            )}
            {scope.view === 'activity' && !scope.areaId && <ActivityView onOpenTask={setOpenId} onGo={go} />}
            {scope.view === 'routines' && !scope.areaId && <RoutinesView onOpenTask={setOpenId} />}
            {scope.view === 'trash' && !scope.areaId && <TrashView onGo={go} />}
            {scope.view === 'settings' && !scope.areaId && <SettingsView section={section} />}
            {scope.view === 'wizard' && !scope.areaId && labs.wizard && (
              <Suspense fallback={<Loading />}>
                <WizardView tasks={modeTasks} areas={areas} projects={projects} workMode={workMode} selectedId={openId} onOpen={setOpenId} />
              </Suspense>
            )}
          </div>
        </main>

        {openTask && <TaskDetail task={openTask} areas={areas} projects={projects} onClose={() => {
          const id = openTask.id;
          closeTask();
          focusTask(id);
        }} />}

        {pickedIds.length > 0 && <BulkBar count={pickedIds.length} onComplete={bulk.complete} onMove={bulk.move} onTrash={bulk.trash} onClear={clearPicked} />}

        <nav className="tabbar" aria-label="Views">
          {tabs.map((v) => {
            const n = tabBadge(v);
            return (
              <button
                key={v}
                type="button"
                className={cx('tab', scope.view === v && !scope.areaId && 'is-active')}
                aria-current={scope.view === v && !scope.areaId ? 'page' : undefined}
                onClick={() => go(v)}
              >
                {VIEW_META[v].icon}
                <span>{VIEW_META[v].label}</span>
                {n ? <span className={cx('badge num tab-badge', v === 'foryou' && 'badge-you')}>{n}</span> : null}
              </button>
            );
          })}
          <button type="button" className="tab" onClick={() => setMenuOpen(true)}>
            <Menu size={16} aria-hidden />
            <span>More</span>
          </button>
        </nav>

        <Toasts />
        <ConflictDialog />
        <WaitingDialog />
        <ConfirmHost />
        <ShortcutHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          scopeTask={openTask ?? null}
          onGo={go}
          onArea={(areaId) => navigate({ view: 'board', areaId, projectId: null })}
          onOpenTask={(id) => setOpenId(id)}
          onCapture={() => {
            if (!canCapture) go('inbox');
            focusCapture();
          }}
          onSearch={openSearch}
          onLayout={isBoardView ? () => setLayout(layout === 'board' ? 'list' : 'board') : undefined}
          onHelp={() => setHelpOpen(true)}
          onFocusTask={(id) => setFocusId(id)}
        />
      </div>
      {focusTaskObj && (
        <FocusMode
          key={focusTaskObj.id}
          task={focusTaskObj}
          next={todayQueue(modeTasks, today).find((t) => t.id !== focusTaskObj.id) ?? null}
          onExit={() => setFocusId(null)}
          onNext={(id) => setFocusId(id)}
          onToday={() => {
            setFocusId(null);
            go('today');
          }}
        />
      )}
      {setupOpen && <Setup />}
      <Tour blocked={!!focusTaskObj || setupOpen} />
    </>
  );
}

function Loading() {
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden="true" />
      Loading your tasks
    </div>
  );
}

/** With several tasks picked: what you can do to all of them at once. */
function BulkBar({ count, onComplete, onMove, onTrash, onClear }: { count: number; onComplete: () => void; onMove: (s: Status) => void; onTrash: () => void; onClear: () => void }) {
  return (
    <div className="bulk-bar" role="toolbar" aria-label={`${count} selected`}>
      <span className="bulk-count">{count} selected</span>
      <SelectMenu
        label="Move to"
        display="Move to…"
        className="select-btn-compact bulk-move"
        value={null}
        onChange={onMove}
        options={STATUS_OPTIONS.filter((o) => o.value !== 'done')}
      />
      <button type="button" className="btn btn-secondary btn-sm" onClick={onComplete}>
        <CheckCircle2 size={14} aria-hidden /> Mark done
      </button>
      <button type="button" className="btn btn-ghost btn-sm btn-danger-text" onClick={onTrash}>
        <Trash2 size={14} aria-hidden /> Move to Trash
      </button>
      <button type="button" className="icon-btn" aria-label="Clear selection" title="Clear selection (Esc)" onClick={onClear}>
        <X size={16} aria-hidden />
      </button>
    </div>
  );
}

/** Every empty page has one thing to do next. */
function ViewEmpty({ view, scoped, name, onAdd, onGo }: { view: ViewId; scoped: boolean; name: string; onAdd: () => void; onGo: (v: ViewId) => void }) {
  const add = (
    <button type="button" className="btn btn-secondary" onClick={onAdd}>
      Add a task
    </button>
  );
  const goTo = (v: ViewId, label: string) => (
    <button type="button" className="btn btn-secondary" onClick={() => onGo(v)}>
      {label}
    </button>
  );
  if (scoped) return <EmptyState icon={<ListTodo size={22} />} title={`Nothing in ${name} yet`} body="Tasks you add here land in this area's Inbox.">{add}</EmptyState>;
  switch (view) {
    case 'board':
      return <EmptyState icon={<Columns3 size={22} />} title="Nothing here yet" body="Every task shows up here, in a column for where it stands.">{add}</EmptyState>;
    case 'inbox':
      return <EmptyState icon={<InboxIcon size={22} />} title="Inbox is clear" body="Everything is sorted. New tasks land here first.">{add}</EmptyState>;
    case 'doing':
      return <EmptyState icon={<Zap size={22} />} title="Nothing in progress" body="Start a task when you begin working on it, and it shows here.">{goTo('today', 'Pick from Today')}</EmptyState>;
    case 'today':
      return <EmptyState icon={<CalendarCheck size={22} />} title="Nothing planned for today" body="Pull a few tasks in from Next. Anything due today shows up here on its own.">{goTo('next', 'Pick from Next')}</EmptyState>;
    case 'next':
      return <EmptyState icon={<ListTodo size={22} />} title="Nothing in Next" body="Next holds tasks you're ready to do. Sorting the Inbox fills it.">{goTo('inbox', 'Sort the Inbox')}</EmptyState>;
    case 'waiting':
      return <EmptyState icon={<Clock size={22} />} title="Not waiting on anyone" body="When something is blocked on a person or a reply, move it here and say who.">{goTo('next', 'See Next')}</EmptyState>;
    case 'done':
      return <EmptyState icon={<CheckCircle2 size={22} />} title="Nothing finished yet" body="Finished tasks collect here, newest first.">{goTo('today', 'Go to Today')}</EmptyState>;
    default:
      return <EmptyState icon={<ListTodo size={22} />} title="Nothing here yet" body="">{add}</EmptyState>;
  }
}

