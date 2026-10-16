import { ArrowRight, Check, CornerDownLeft, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Task } from '../../../shared/schema.ts';
import { claudeIsOn } from '../lib.ts';
import { useProgress } from '../progress.ts';
import { store, useStore } from '../store.ts';
import { linkify } from './NeedsYou.tsx';
import { WeekDone } from './Today.tsx';

/** Opens focus mode on a task from anywhere in the app. */
export function openFocus(id: string) {
  window.dispatchEvent(new CustomEvent('mt:focus', { detail: id }));
}

/** The "Done when:" line from the notes, if the task has one. */
function doneWhen(notes: string): string {
  const m = /done when:\s*(.+)/i.exec(notes);
  return m ? m[1].trim() : '';
}

/**
 * One task, one step, the whole window. Everything else is hidden until you ask for it:
 * the step you're on, a way to finish it, and a place to park anything that pulls at you.
 * When it's done: how it went, and the next thing on Today.
 */
export function FocusMode({ task, next, onExit, onNext, onToday }: { task: Task; next?: Task | null; onExit: () => void; onNext?: (id: string) => void; onToday?: () => void }) {
  const [skipped, setSkipped] = useState<string[]>([]);
  const [stepsDone, setStepsDone] = useState(0);
  const [showNotes, setShowNotes] = useState(false);
  const [finished, setFinished] = useState(task.status === 'done');
  const started = useRef(Date.now());
  const [, tick] = useState(0);
  const progress = useProgress(task.id);
  const claudeOn = claudeIsOn(progress);
  const { tasks } = useStore();

  const steps = task.subtasks;
  const open = steps.filter((s) => !s.done);
  const current = useMemo(() => {
    const notSkipped = open.filter((s) => !skipped.includes(s.id));
    return notSkipped[0] ?? open[0] ?? null;
  }, [open, skipped]);
  const position = current ? steps.findIndex((s) => s.id === current.id) + 1 : steps.length;
  const claudeHasIt = !!current && !current.needsYou && claudeOn && progress?.subtaskId === current.id;
  const why = current?.needsYou ? task.youContext?.[current.id]?.detail : '';
  const finishLine = doneWhen(task.notes);
  const minutes = Math.floor((Date.now() - started.current) / 60000);
  const spent = minutes < 1 ? 'Under a minute' : `${minutes} min focused`;

  // A quiet clock, and no pop-ups from the rest of the app while you're here.
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    document.body.classList.add('is-focusing');
    const before = document.title;
    return () => {
      clearInterval(t);
      document.body.classList.remove('is-focusing');
      document.title = before;
    };
  }, []);
  useEffect(() => {
    document.title = finished ? 'Done · Master Tasker' : `Focus: ${current?.title ?? task.title}`;
  }, [current, task.title, finished]);

  const doneStep = () => {
    if (!current) return;
    store.updateSubtask(task.id, current.id, { done: true });
    setStepsDone((n) => n + 1);
  };
  const skip = () => current && setSkipped((s) => [...s.filter((id) => id !== current.id), current.id]);
  const complete = () => {
    store.complete(task.id, { quiet: true });
    setFinished(true);
  };
  const toToday = onToday ?? onExit;
  const allDone = open.length === 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest('input, textarea');
      if (e.key === 'Escape' && !typing) {
        e.preventDefault();
        onExit();
      } else if (e.key === 'Enter' && !typing && !(e.target as HTMLElement).closest('button')) {
        e.preventDefault();
        if (finished) toToday();
        else if (allDone) complete();
        else doneStep();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="focus" role="dialog" aria-modal="true" aria-label={`Focus: ${task.title}`}>
      <header className="focus-top">
        <span className="focus-ticket">{task.title}</span>
        <button type="button" className="focus-exit" onClick={onExit}>
          <X size={15} aria-hidden /> Exit focus <kbd>Esc</kbd>
        </button>
      </header>

      <main className="focus-main">
        {finished ? (
          <div className="focus-step focus-finished">
            <span className="focus-check" aria-hidden>
              <Check size={28} strokeWidth={2.5} />
            </span>
            <h1 className="focus-title">Done.</h1>
            <p className="focus-calm">
              {[stepsDone > 0 && `${stepsDone} ${stepsDone === 1 ? 'step' : 'steps'}`, spent].filter(Boolean).join(' · ')}
            </p>
            <WeekDone tasks={tasks} />
            <div className="focus-actions">
              {next && onNext ? (
                <>
                  <button type="button" className="focus-go" onClick={() => onNext(next.id)} autoFocus>
                    Start next: {next.title}
                  </button>
                  <button type="button" className="focus-skip" onClick={toToday}>
                    Back to Today
                  </button>
                </>
              ) : (
                <button type="button" className="focus-go" onClick={toToday} autoFocus>
                  Back to Today
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="focus-step" key={current?.id ?? 'end'}>
            {steps.length > 0 && (
              <div className="focus-count" aria-label={allDone ? 'Every step is done' : `Step ${position} of ${steps.length}`}>
                <span className="focus-dots" aria-hidden>
                  {steps.map((s) => (
                    <i key={s.id} className={s.done ? 'is-done' : s.id === current?.id ? 'is-now' : ''} />
                  ))}
                </span>
                {allDone ? 'Every step is done' : `Step ${position} of ${steps.length}`}
              </div>
            )}

            <h1 className="focus-title">{allDone ? (steps.length ? 'Last thing: mark the task complete.' : task.nextAction || task.title) : current!.title}</h1>

            {claudeHasIt && <p className="focus-note">Claude is working on this one. You can skip to your next step.</p>}
            {why && <p className="focus-note">{linkify(why)}</p>}

            <div className="focus-actions">
              {allDone ? (
                <button type="button" className="focus-go" onClick={complete} autoFocus>
                  <Check size={18} aria-hidden /> Complete task <kbd><CornerDownLeft size={12} aria-hidden /></kbd>
                </button>
              ) : (
                <>
                  <button type="button" className="focus-go" onClick={doneStep} autoFocus={!claudeHasIt}>
                    <Check size={18} aria-hidden /> Done, next step <kbd><CornerDownLeft size={12} aria-hidden /></kbd>
                  </button>
                  {open.length > 1 && (
                    <button type="button" className="focus-skip" onClick={skip} autoFocus={claudeHasIt}>
                      Skip for now <ArrowRight size={14} aria-hidden />
                    </button>
                  )}
                </>
              )}
            </div>

            {finishLine && (
              <p className="focus-doneline">
                <span>Done when</span> {finishLine}
              </p>
            )}
          </div>
        )}
      </main>

      {!finished && (
        <footer className="focus-bottom">
          <ParkIt />
          <div className="focus-meta">
            <span>{minutes < 1 ? 'Just started' : `${minutes} min focused`}</span>
            {task.notes.trim() && (
              <button type="button" className="focus-link" aria-expanded={showNotes} onClick={() => setShowNotes((v) => !v)}>
                {showNotes ? 'Hide task notes' : 'Show task notes'}
              </button>
            )}
          </div>
          {showNotes && <div className="focus-notes">{linkify(task.notes)}</div>}
        </footer>
      )}
    </div>
  );
}

/** Something pops into your head: drop it in Inbox and get back to the step. */
function ParkIt() {
  const [text, setText] = useState('');
  const [saved, setSaved] = useState(false);
  const save = async () => {
    const title = text.trim();
    if (!title) return;
    setText('');
    await store.createTask({ title: title.slice(0, 200), status: 'inbox' });
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };
  return (
    <form
      className="focus-park"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label htmlFor="focus-park-input" className="focus-park-label">
        {saved ? 'Parked in Inbox. Back to the step.' : 'Something else pulling at you? Park it here. It will wait.'}
      </label>
      <input id="focus-park-input" className="focus-park-input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Type it and press Enter" autoComplete="off" />
    </form>
  );
}
