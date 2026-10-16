// First-run setup: your name, the starter areas, and whether to add the sample tasks. One quiet card on a plain
// page, like Focus and the tour. It shows once per install, before the tour, until you finish or skip it.
// Skip (or Esc) keeps the sample areas and tasks a new install starts with, and keeps a name you typed.
import { ArrowRight, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { SetupInput, StarterAreas } from '../../../shared/schema.ts';
import { cx } from '../lib.ts';
import { store } from '../store.ts';
import '../styles/tour.css';
import '../styles/setup.css';

const AREAS: { id: StarterAreas; label: string; hint: string }[] = [
  { id: 'work-personal', label: 'Work and Personal', hint: 'Two areas. Show one side at a time, or both.' },
  { id: 'sample', label: 'The sample set', hint: 'Clients, Side projects, Pets, Home, Hobbies and Personal.' },
  { id: 'none', label: 'None, I’ll add my own', hint: 'Add areas from the sidebar when you need them.' },
];

const SAMPLES: { id: 'yes' | 'no'; label: string }[] = [
  { id: 'yes', label: 'Yes, add them' },
  { id: 'no', label: 'No thanks' },
];

/** Everything you can reach with Tab, in order: one stop per radio group, the checked one. */
const TABBABLE = 'button:not([disabled]), input:not([type="radio"]):not([disabled]), input[type="radio"]:checked';

export function Setup() {
  const ref = useRef<HTMLDialogElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [name, setName] = useState('');
  const [areas, setAreas] = useState<StarterAreas>('work-personal');
  const [samples, setSamples] = useState<'yes' | 'no'>('yes');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (!d.open) d.showModal();
    // On a phone, focusing the field would bring up the keyboard over the screen. Start on the title there.
    const touch = matchMedia('(pointer: coarse)').matches;
    // Without preventScroll a short window scrolls the card and hides the title under the top bar.
    (touch ? titleRef.current : nameRef.current)?.focus({ preventScroll: true });
    d.querySelector('.setup-main')?.scrollTo(0, 0);
    return () => {
      if (d.open) d.close();
    };
  }, []);
  // Afterwards, focus goes to the page, unless the tour has already taken it.
  useEffect(
    () => () => {
      requestAnimationFrame(() => {
        if (!document.activeElement || document.activeElement === document.body) document.getElementById('main')?.focus();
      });
    },
    [],
  );

  const send = async (choice: SetupInput) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await store.completeSetup(choice);
    } catch (err) {
      setError(`${(err as Error).message} Try again.`);
      setBusy(false);
    }
  };
  const finish = (e: FormEvent) => {
    e.preventDefault();
    void send({ name, areas, samples: samples === 'yes' });
  };
  // Keeps today's sample areas and tasks. A name you typed is kept, so nothing is lost.
  const skip = () => void send(name.trim() ? { name } : {});

  const onKeyDown = (e: KeyboardEvent<HTMLDialogElement>) => {
    // The app's own shortcuts stay out while setup is open.
    e.stopPropagation();
    if (e.key !== 'Tab') return;
    // Keep Tab inside the screen, going round.
    const items = [...(ref.current?.querySelectorAll<HTMLElement>(TABBABLE) ?? [])];
    const first = items[0];
    const end = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === titleRef.current)) {
      e.preventDefault();
      end?.focus();
    } else if (!e.shiftKey && document.activeElement === end) {
      e.preventDefault();
      first?.focus();
    }
  };

  return (
    <dialog
      ref={ref}
      className="tour setup"
      aria-labelledby="setup-name"
      aria-describedby="setup-intro"
      onKeyDown={onKeyDown}
      onCancel={(e) => {
        // Esc is Skip: it leaves, and keeps what's there.
        e.preventDefault();
        skip();
      }}
    >
      <div className="tour-top">
        <span className="tour-name">
          <svg className="brand-mark" viewBox="0 0 24 24" aria-hidden="true">
            <rect className="brand-tile" width="24" height="24" rx="7" />
            <circle className="brand-now" cx="8" cy="10" r="2.5" />
            <path className="brand-line" d="M15 10h3.25" />
            <path className="brand-line is-later" d="M5.75 16.5h12.5" />
          </svg>
          <span id="setup-name">Set up Master Tasker</span>
        </span>
        <button type="button" className="focus-exit" onClick={skip} disabled={busy}>
          <X size={15} aria-hidden /> Skip setup <kbd aria-hidden>Esc</kbd>
        </button>
      </div>

      <div className="setup-main">
        <form className="setup-card" onSubmit={finish} noValidate>
          <div className="setup-head">
            <h2 ref={titleRef} className="setup-title" tabIndex={-1}>
              Welcome
            </h2>
            <p id="setup-intro" className="setup-intro">
              Three quick choices. You can change them all later.
            </p>
          </div>

          <div className="setup-q">
            <label htmlFor="setup-your-name" className="setup-label">
              Your name <span className="setup-optional">Optional</span>
            </label>
            <p id="setup-name-help" className="setup-help">
              What the app and your AI assistant call you.
            </p>
            <input
              ref={nameRef}
              id="setup-your-name"
              className="input setup-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              autoComplete="given-name"
              spellCheck={false}
              aria-describedby="setup-name-help"
            />
          </div>

          <fieldset className="setup-q">
            <legend className="setup-label">Starter areas</legend>
            <p id="setup-areas-help" className="setup-help">
              Areas group your tasks. Rename, add or remove them any time.
            </p>
            <div className="setup-options">
              {AREAS.map((c) => (
                <label key={c.id} className={cx('setup-option', areas === c.id && 'is-on')}>
                  <input type="radio" className="setup-radio" name="setup-areas" value={c.id} checked={areas === c.id} onChange={() => setAreas(c.id)} aria-describedby={`setup-areas-${c.id}`} />
                  <span className="setup-option-text">
                    <span className="setup-option-label">{c.label}</span>
                    <span id={`setup-areas-${c.id}`} className="setup-option-hint">
                      {c.hint}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="setup-q">
            <legend className="setup-label">Sample tasks</legend>
            <p className="setup-help">Six tasks, each showing one idea. Clear them from Today when you’re ready.</p>
            <div className="setup-options setup-options-pair">
              {SAMPLES.map((c) => (
                <label key={c.id} className={cx('setup-option', samples === c.id && 'is-on')}>
                  <input type="radio" className="setup-radio" name="setup-samples" value={c.id} checked={samples === c.id} onChange={() => setSamples(c.id)} />
                  <span className="setup-option-label">{c.label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          {error && (
            <p className="field-warning setup-error" role="alert">
              {error}
            </p>
          )}
          <div className="setup-actions">
            <button type="submit" className="focus-go" disabled={busy}>
              Continue <ArrowRight size={18} aria-hidden />
            </button>
          </div>
        </form>
      </div>
    </dialog>
  );
}
