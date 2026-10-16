// ⌘K: go anywhere, or do the main things, by typing a few letters.
import { CheckCircle2, Compass, Keyboard, Pause, Play, Plus, Search, Target, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Task } from '../../../shared/schema.ts';
import { cx, type ViewId } from '../lib.ts';
import { store, useStore } from '../store.ts';
import { finishTask } from '../finish.ts';
import { useLabs } from '../prefs.ts';
import { AreaDot } from './Bits.tsx';
import { VIEW_META } from './Chrome.tsx';
import { openTour } from './tour/Tour.tsx';

interface Command {
  id: string;
  label: string;
  group: string;
  icon?: ReactNode;
  hint?: string;
  run: () => void;
}

const NAV: ViewId[] = ['today', 'inbox', 'foryou', 'doing', 'board', 'next', 'waiting', 'done', 'activity', 'trash', 'settings', 'routines', 'wizard'];

export function CommandPalette({ open, onClose, scopeTask, onGo, onArea, onOpenTask, onCapture, onSearch, onLayout, onHelp, onFocusTask }: {
  open: boolean;
  onClose: () => void;
  scopeTask: Task | null;
  onGo: (v: ViewId) => void;
  onArea: (id: string) => void;
  onOpenTask: (id: string) => void;
  onCapture: () => void;
  onSearch: () => void;
  onLayout?: () => void;
  onHelp: () => void;
  onFocusTask: (id: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const { areas, tasks } = useStore();
  const labs = useLabs();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setQ('');
      setAt(0);
      d.showModal();
      requestAnimationFrame(() => input.current?.focus());
    }
    if (!open && d.open) d.close();
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [
      { id: 'new', label: 'New task', group: 'Actions', icon: <Plus size={15} aria-hidden />, hint: 'N', run: onCapture },
      { id: 'search', label: 'Search tasks', group: 'Actions', icon: <Search size={15} aria-hidden />, hint: '/', run: onSearch },
      ...(onLayout ? [{ id: 'layout', label: 'Switch board / list', group: 'Actions', hint: 'V', run: onLayout }] : []),
      { id: 'keys', label: 'Keyboard shortcuts', group: 'Actions', icon: <Keyboard size={15} aria-hidden />, hint: '?', run: onHelp },
      { id: 'tour', label: 'Take the tour', group: 'Actions', icon: <Compass size={15} aria-hidden />, run: openTour },
    ];
    if (scopeTask) {
      const t = scopeTask;
      if (t.status !== 'done') list.unshift(
        { id: 'done', label: `Mark done: ${t.title}`, group: 'This task', icon: <CheckCircle2 size={15} aria-hidden />, hint: 'X', run: () => finishTask(t.id) },
        { id: 'doing', label: `${t.status === 'doing' ? 'Stop' : 'Start'}: ${t.title}`, group: 'This task', icon: t.status === 'doing' ? <Pause size={15} aria-hidden /> : <Play size={15} aria-hidden />, hint: 'S', run: () => store.toggleDoing(t.id) },
        { id: 'focus', label: `Focus on: ${t.title}`, group: 'This task', icon: <Target size={15} aria-hidden />, hint: 'F', run: () => onFocusTask(t.id) },
      );
      list.splice(t.status !== 'done' ? 3 : 0, 0, { id: 'trash', label: `Move to Trash: ${t.title}`, group: 'This task', icon: <Trash2 size={15} aria-hidden />, run: () => store.deleteTask(t.id) });
    }
    for (const v of NAV) {
      if ((v === 'wizard' && !labs.wizard) || (v === 'routines' && !labs.routines)) continue;
      const m = VIEW_META[v];
      list.push({ id: `go-${v}`, label: `Go to ${m.label}`, group: 'Go to', icon: m.icon, hint: m.key ? `G ${m.key.toUpperCase()}` : undefined, run: () => onGo(v) });
    }
    for (const a of areas.filter((x) => !x.archived)) list.push({ id: `area-${a.id}`, label: a.name, group: 'Areas', icon: <AreaDot color={a.color} />, run: () => onArea(a.id) });
    return list;
  }, [scopeTask, areas, labs.wizard, labs.routines, onCapture, onSearch, onLayout, onHelp, onGo, onArea, onFocusTask]);

  const needle = q.trim().toLowerCase();
  const shown = useMemo(() => {
    const hits = needle ? commands.filter((c) => c.label.toLowerCase().includes(needle)) : commands;
    // Typing also finds tasks by title.
    const found = needle.length >= 2
      ? tasks.filter((t) => t.title.toLowerCase().includes(needle)).slice(0, 8).map<Command>((t) => ({ id: `task-${t.id}`, label: t.title, group: 'Tasks', run: () => onOpenTask(t.id) }))
      : [];
    return [...hits, ...found];
  }, [commands, needle, tasks, onOpenTask]);
  const cur = Math.min(at, Math.max(0, shown.length - 1));
  const run = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    // After the dialog closes, so focus can move where the command sends it.
    requestAnimationFrame(c.run);
  };
  let lastGroup = '';
  return (
    <dialog ref={ref} className="dialog palette" aria-label="Go anywhere or do anything" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <div className="palette-search">
        <Search size={16} aria-hidden />
        <input
          ref={input}
          className="palette-input"
          role="combobox"
          aria-expanded
          aria-controls="palette-list"
          aria-activedescendant={shown[cur] ? `pal-${shown[cur].id}` : undefined}
          aria-autocomplete="list"
          placeholder="Go to, or do…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setAt(0);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'ArrowDown') setAt((i) => Math.min(shown.length - 1, i + 1));
            else if (e.key === 'ArrowUp') setAt((i) => Math.max(0, i - 1));
            else if (e.key === 'Enter') run(shown[cur]);
            else return;
            e.preventDefault();
          }}
        />
      </div>
      <ul className="palette-list" id="palette-list" role="listbox" aria-label="Commands">
        {shown.map((c, i) => {
          const head = c.group !== lastGroup ? c.group : null;
          lastGroup = c.group;
          return (
            <li key={c.id} role="presentation">
              {head && <span className="palette-group eyebrow" role="presentation">{head}</span>}
              <div
                id={`pal-${c.id}`}
                role="option"
                aria-selected={i === cur}
                className={cx('palette-item', i === cur && 'is-active')}
                onMouseMove={() => setAt(i)}
                onClick={() => run(c)}
              >
                <span className="palette-icon">{c.icon}</span>
                <span className="palette-label">{c.label}</span>
                {c.hint && <kbd className="kbd">{c.hint}</kbd>}
              </div>
            </li>
          );
        })}
        {shown.length === 0 && <li className="palette-empty meta-line">Nothing matches “{q}”</li>}
      </ul>
    </dialog>
  );
}
