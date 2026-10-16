// Today, the home screen: where you stand in one line, a short first-run card, and a quiet end to the day.
import { Check, Compass, Sparkles, Target, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Task } from '../../../shared/schema.ts';
import { addDays, byPosition, cx, formatDue, PRIORITY_RANK, todayIso, type Filters, type ViewId } from '../lib.ts';
import { store, useStore } from '../store.ts';
import { openAssistants, useConnectedAssistants } from '../assistants.ts';
import { FIRST_RUN_DISMISSED, setPref, TRIED_FOCUS, usePref } from '../prefs.ts';
import { openTour } from './tour/Tour.tsx';

const DAY = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

/** Today's open tasks in the order the page shows them: in progress, overdue, due today, planned. */
export function todayQueue(tasks: Task[], today = todayIso()): Task[] {
  const open = tasks.filter((t) => t.status !== 'done' && !t.deletedAt);
  const doing = open.filter((t) => t.status === 'doing').sort(byPosition);
  const overdue = open.filter((t) => t.status !== 'doing' && t.dueDate && t.dueDate < today).sort((a, b) => a.dueDate!.localeCompare(b.dueDate!));
  const due = open.filter((t) => t.status !== 'doing' && t.dueDate === today).sort(byPosition);
  const planned = open.filter((t) => t.status === 'today' && !(t.dueDate && t.dueDate <= today)).sort(byPosition);
  return [...doing, ...overdue, ...due, ...planned];
}

/** "Wed, Oct 14 · 1 overdue · 1 due today · 1 needs you". Each part takes you there. What's done is in TodayProgress. */
export function TodaySummary({ counts, filters, onFilter, onGo }: {
  counts: Record<string, number>;
  filters: Filters;
  onFilter: (due: Filters['due']) => void;
  onGo: (v: ViewId) => void;
}) {
  const parts: { key: string; label: string; on?: boolean; run: () => void; tone?: string }[] = [];
  if (counts.overdue) parts.push({ key: 'overdue', label: `${counts.overdue} overdue`, on: filters.due === 'overdue', run: () => onFilter(filters.due === 'overdue' ? 'any' : 'overdue'), tone: 'is-danger' });
  if (counts.dueToday) parts.push({ key: 'due', label: `${counts.dueToday} due today`, on: filters.due === 'today', run: () => onFilter(filters.due === 'today' ? 'any' : 'today') });
  if (counts.needsYou) parts.push({ key: 'you', label: `${counts.needsYou} ${counts.needsYou === 1 ? 'needs' : 'need'} you`, run: () => onGo('foryou'), tone: 'is-you' });
  return (
    <p className="view-summary">
      <button type="button" className="summary-link summary-date" onClick={() => onFilter('any')} title="Show all of Today">
        {DAY.format(new Date())}
      </button>
      {parts.map((p) => (
        <span key={p.key} className={`summary-part-${p.key}`}>
          <span className="summary-sep" aria-hidden> · </span>
          <button type="button" className={cx('summary-link', p.tone, p.on && 'is-on')} aria-pressed={p.on === undefined ? undefined : p.on} onClick={p.run}>
            {p.label}
          </button>
        </span>
      ))}
    </p>
  );
}

/** Monday to Sunday of this week, and how many tasks were finished on each day. */
export function weekStats(tasks: Task[], today = todayIso()) {
  const [y, m, d] = today.split('-').map(Number);
  const dow = (new Date(y, m - 1, d).getDay() + 6) % 7; // Monday is 0
  const monday = addDays(today, -dow);
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const per = new Map(days.map((x) => [x, 0]));
  for (const t of tasks) {
    if (t.status !== 'done' || !t.completedAt) continue;
    const day = todayIso(new Date(t.completedAt));
    if (per.has(day)) per.set(day, per.get(day)! + 1);
  }
  return { days, per, total: [...per.values()].reduce((a, b) => a + b, 0) };
}

/** Changes to a number briefly lift it, so a completion is felt where the count is. Not on first show. */
function useTick(n: number) {
  const prev = useRef(n);
  const [ticks, setTicks] = useState(0);
  useEffect(() => {
    if (n > prev.current) setTicks((t) => t + 1);
    prev.current = n;
  }, [n]);
  return ticks;
}

/** Next to Today's title: a small ring and "3 of 6 done · 9 this week". The week takes you to Done. */
export function TodayProgress({ done, open, week, onGo }: { done: number; open: number; week: number; onGo: (v: ViewId) => void }) {
  const total = done + open;
  const ticks = useTick(done);
  if (total === 0 && week === 0) return null;
  const r = 7;
  const c = 2 * Math.PI * r;
  const frac = total ? done / total : 0;
  return (
    <p className="today-progress">
      <svg className="progress-ring" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
        <circle className="progress-ring-track" cx="9" cy="9" r={r} />
        <circle className="progress-ring-fill" cx="9" cy="9" r={r} strokeDasharray={c} strokeDashoffset={c * (1 - frac)} />
      </svg>
      {total > 0 && (
        <span className="today-progress-count">
          <span key={ticks} className={cx('num', ticks > 0 && 'is-ticking')}>{done}</span> of <span className="num">{total}</span> done
        </span>
      )}
      {week > 0 && (
        <span className="today-week">
          {total > 0 && <span className="summary-sep" aria-hidden> · </span>}
          <button type="button" className="summary-link" onClick={() => onGo('done')} title="See what you finished">
            <span className="num">{week}</span>&nbsp;this week
          </button>
        </span>
      )}
    </p>
  );
}

/**
 * Today, emptied by finishing it: the count, the week, what's first tomorrow, and a quiet sign-off.
 * In the page, so nothing is in the way, and nothing asks for more.
 */
export function TodayDone({ tasks, done, onOpen }: { tasks: Task[]; done: number; onOpen: (id: string) => void }) {
  const today = todayIso();
  const { total } = weekStats(tasks, today);
  const first = tomorrowTop(tasks, today, 1)[0];
  const name = useStore().settings.ownerName;
  return (
    <section className="today-done" aria-labelledby="today-done-title">
      <span className="today-done-check" aria-hidden>
        <Check size={22} strokeWidth={2.5} />
      </span>
      <h2 id="today-done-title" className="today-done-title">Today's done</h2>
      <p className="today-done-count">
        <span className="num">{done}</span> done today · <span className="num">{total}</span> this week
      </p>
      <WeekDone tasks={tasks} bare />
      {first ? (
        <p className="today-done-next">
          First up tomorrow:{' '}
          <button type="button" className="link-btn" onClick={() => onOpen(first.id)}>
            {first.title}
          </button>
          {first.dueDate && <span className="meta-line"> · due {formatDue(first.dueDate, today)}</span>}
        </p>
      ) : (
        <p className="today-done-next">Nothing lined up for tomorrow yet. That can wait until tomorrow too.</p>
      )}
      <p className="today-done-signoff">Enjoy the rest of your day{name ? `, ${name}` : ''}.</p>
    </section>
  );
}

/**
 * Three things to do once: clear the samples, connect an AI assistant, try Focus. The tour is a click away. Dismiss it
 * any time. If you started without the samples, there's nothing to clear, so it's two.
 */
export function FirstRunCard({ onFocus }: { onFocus: (id: string) => void }) {
  const { tasks, ready, settings } = useStore();
  const assistants = useConnectedAssistants();
  const dismissed = usePref(FIRST_RUN_DISMISSED) === '1';
  const triedFocus = usePref(TRIED_FOCUS) === '1';
  if (!ready || dismissed || assistants === null) return null;
  const samples = tasks.filter((t) => t.isSample).length;
  const steps = [
    { id: 'samples', done: samples === 0, title: 'Clear the sample tasks', body: 'They show one idea each. Clear them when you are ready for your own.' },
    { id: 'assistant', done: assistants.length > 0, title: 'Connect an AI assistant', body: 'Claude, Codex, Copilot, Cursor, Gemini and others can plan and work your tasks. Optional, and you can do it later.' },
    { id: 'focus', done: triedFocus, title: 'Try Focus', body: 'One task, one step at a time, the whole window.' },
  ].filter((s) => s.id !== 'samples' || samples > 0 || settings.startedWithSamples);
  if (steps.every((s) => s.done)) return null;
  const queue = todayQueue(tasks);
  const focusOn = tasks.find((t) => t.isSample && t.status !== 'done' && /focus/i.test(t.nextAction)) ?? queue[0] ?? tasks.find((t) => t.status !== 'done');
  return (
    <section className="first-run" aria-labelledby="first-run-title">
      <div className="first-run-head">
        <h2 id="first-run-title" className="first-run-title">Getting started</h2>
        <button type="button" className="link-btn first-run-tour" onClick={openTour}>
          <Compass size={14} aria-hidden /> Take the tour
        </button>
        <button type="button" className="icon-btn icon-btn-sm" aria-label="Dismiss getting started" title="Dismiss" onClick={() => setPref(FIRST_RUN_DISMISSED, '1')}>
          <X size={15} aria-hidden />
        </button>
      </div>
      <ol className="first-run-steps">
        {steps.map((s, i) => (
          <li key={s.id} className={cx('first-run-step', s.done && 'is-done')}>
            <span className="first-run-num" aria-hidden>{s.done ? <Check size={13} strokeWidth={3} /> : i + 1}</span>
            <div className="first-run-text">
              <span className="first-run-step-title">
                {s.title}
                {s.done && <span className="sr-only"> (done)</span>}
              </span>
              <span className="meta-line">{s.body}</span>
            </div>
            {!s.done && s.id === 'samples' && (
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => void store.clearSamples()}>
                <Trash2 size={14} aria-hidden /> Clear {samples} {samples === 1 ? 'sample' : 'samples'}
              </button>
            )}
            {!s.done && s.id === 'assistant' && (
              <button type="button" className="btn btn-secondary btn-sm" onClick={openAssistants}>
                <Sparkles size={14} aria-hidden /> Connect an assistant
              </button>
            )}
            {!s.done && s.id === 'focus' && (
              <button type="button" className="btn btn-secondary btn-sm" disabled={!focusOn} title={focusOn ? `Focus on “${focusOn.title}”` : 'Add a task first'} onClick={() => focusOn && onFocus(focusOn.id)}>
                <Target size={14} aria-hidden /> Try Focus
              </button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** What's up first tomorrow: due tomorrow, most important first, then the top of Next. */
export function tomorrowTop(tasks: Task[], today = todayIso(), n = 3): Task[] {
  const tomorrow = addDays(today, 1);
  const open = tasks.filter((t) => t.status !== 'done' && !t.deletedAt);
  const due = open.filter((t) => t.dueDate === tomorrow).sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || byPosition(a, b));
  const next = open.filter((t) => t.status === 'next' && t.dueDate !== tomorrow && !(t.dueDate && t.dueDate <= today)).sort(byPosition);
  return [...due, ...next].slice(0, n);
}

const WEEKDAY_1 = new Intl.DateTimeFormat(undefined, { weekday: 'narrow' });
const WEEKDAY_LONG = new Intl.DateTimeFormat(undefined, { weekday: 'long' });

/** On Done: "This week: N done", with a bar for each day, Monday to Sunday. Bare: only the bars, inside something else. */
export function WeekDone({ tasks, bare = false }: { tasks: Task[]; bare?: boolean }) {
  const today = todayIso();
  const { days, per, total } = weekStats(tasks, today);
  const max = Math.max(1, ...per.values());
  return (
    <section className={cx('week-done', bare && 'is-bare')} aria-label={`This week: ${total} done`}>
      {!bare && (
        <p className="week-done-total">
          This week: <strong className="num">{total}</strong> done
        </p>
      )}
      <ol className="week-bars" aria-hidden>
        {days.map((day) => {
          const [yy, mm, dd] = day.split('-').map(Number);
          const date = new Date(yy, mm - 1, dd);
          const n = per.get(day)!;
          return (
            <li key={day} className={cx('week-bar', day === today && 'is-today', day > today && 'is-later')} title={`${WEEKDAY_LONG.format(date)}: ${n} done`}>
              <span className="week-bar-fill" style={{ height: `${Math.round((n / max) * 100)}%` }} />
              <span className="week-bar-day">{WEEKDAY_1.format(date)}</span>
            </li>
          );
        })}
      </ol>
      <ul className="sr-only">
        {days.map((day) => {
          const [yy, mm, dd] = day.split('-').map(Number);
          return <li key={day}>{WEEKDAY_LONG.format(new Date(yy, mm - 1, dd))}: {per.get(day)} done</li>;
        })}
      </ul>
    </section>
  );
}
