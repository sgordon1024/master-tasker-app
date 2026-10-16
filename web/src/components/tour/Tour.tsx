// The tour: three pictures of how Master Tasker works, a few plain words each. Full window and quiet, like Focus.
// It opens once, the first time a browser opens the app, after your tasks load. Take it again from More,
// the Getting started card, or ⌘K.
import { ArrowLeft, ArrowRight, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentType, type KeyboardEvent } from 'react';
import { cx } from '../../lib.ts';
import { setPref, TOUR, usePref } from '../../prefs.ts';
import { useStore } from '../../store.ts';
import { useMedia } from '../Chrome.tsx';
import { AssistantArt } from './AssistantArt.tsx';
import { CaptureArt } from './CaptureArt.tsx';
import { FocusArt } from './FocusArt.tsx';
import '../../styles/tour.css';

const OPEN_EVENT = 'mt:tour';

/** Opens the tour from anywhere in the app. */
export function openTour() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

interface Step {
  title: string;
  say: string;
  note?: string;
  Art: ComponentType<{ compact: boolean }>;
}

const STEPS: Step[] = [
  {
    title: 'Capture it, then sort it',
    say: 'Put anything in Inbox with the Add field. Then sort it into Today, Next or Waiting, under an area like Work or Personal. Board shows it all.',
    Art: CaptureArt,
  },
  {
    title: 'One thing at a time',
    say: 'Pick a few tasks for Today and start one. Focus takes it one step at a time, and Today shows where you stand: 2 of 5 done, and your week so far.',
    Art: FocusArt,
  },
  {
    title: 'Your AI assistant helps. You stay in charge.',
    say: 'Connect one and it can plan a task into steps and work through them. Anything only you can decide or do comes back to you as Needs\u00a0you, in For\u00a0you.',
    note: "Connecting one is optional. Claude, Codex, Copilot in VS Code, Cursor, Gemini and others can connect. It's told not to send email, buy things or use your accounts unless you ask.",
    Art: AssistantArt,
  },
];

/** Mounted once in the app. Opens itself on a first visit, and whenever openTour() is called. */
export function Tour({ blocked = false }: { blocked?: boolean }) {
  const { ready } = useStore();
  const due = usePref(TOUR) === 'due';
  const [open, setOpen] = useState(false);
  // Where focus goes back to afterwards.
  const back = useRef<HTMLElement | null>(null);

  const show = useCallback(() => {
    back.current = document.activeElement as HTMLElement | null;
    setOpen(true);
  }, []);
  useEffect(() => {
    if (ready && due && !blocked && !open) show();
  }, [ready, due, blocked, open, show]);
  useEffect(() => {
    window.addEventListener(OPEN_EVENT, show);
    return () => window.removeEventListener(OPEN_EVENT, show);
  }, [show]);

  const close = useCallback(() => {
    setPref(TOUR, 'seen');
    setOpen(false);
    const el = back.current;
    requestAnimationFrame(() => {
      if (el && el !== document.body && el.isConnected) el.focus();
      if (!document.activeElement || document.activeElement === document.body) document.getElementById('main')?.focus();
    });
  }, []);

  return open ? <TourDialog onClose={close} /> : null;
}

function TourDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  const [step, setStep] = useState(0);
  const compact = useMedia('(max-width: 719px)');
  const s = STEPS[step];
  const last = step === STEPS.length - 1;

  useLayoutEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (!d.open) d.showModal();
    next.current?.focus();
    return () => {
      if (d.open) d.close();
    };
  }, []);

  const go = (to: number) => {
    const i = Math.max(0, Math.min(STEPS.length - 1, to));
    setStep(i);
    // Back disappears on the first step, so focus moves to Next rather than getting lost.
    if (i === 0 && document.activeElement !== next.current) next.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDialogElement>) => {
    // The app's own shortcuts stay out while the tour is open.
    e.stopPropagation();
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      go(step + (e.key === 'ArrowRight' ? 1 : -1));
    } else if (e.key === 'Tab') {
      // Keep Tab inside the tour, going round.
      const items = [...(ref.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? [])].filter((b) => b.checkVisibility?.({ visibilityProperty: true }) ?? true);
      const first = items[0];
      const end = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        end?.focus();
      } else if (!e.shiftKey && document.activeElement === end) {
        e.preventDefault();
        first?.focus();
      }
    }
  };

  const Art = s.Art;
  return (
    <dialog
      ref={ref}
      className="tour"
      aria-labelledby="tour-name"
      aria-describedby="tour-title tour-say"
      onKeyDown={onKeyDown}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
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
          <span id="tour-name">How Master Tasker works</span>
        </span>
        <button type="button" className="focus-exit" onClick={onClose}>
          <X size={15} aria-hidden /> Skip tour <kbd aria-hidden>Esc</kbd>
        </button>
      </div>

      <div className="tour-main">
        <div aria-live="polite">
          <div className="tour-stage" key={step}>
            <div className="tour-art">
              <Art compact={compact} />
            </div>
            <div className="tour-count">
              <span className="tour-dots" aria-hidden>
                {STEPS.map((x, i) => (
                  <i key={x.title} className={i === step ? 'is-now' : i < step ? 'is-past' : ''} />
                ))}
              </span>
              {step + 1} of {STEPS.length}
            </div>
            <h2 id="tour-title" className="tour-title">
              {s.title}
            </h2>
            <p id="tour-say" className="tour-say">
              {s.say}
            </p>
            {s.note && <p className="tour-note">{s.note}</p>}
          </div>
        </div>

        <div className="tour-actions">
          <button type="button" className={cx('focus-skip tour-back', step === 0 && 'is-hidden')} onClick={() => go(step - 1)}>
            <ArrowLeft size={14} aria-hidden /> Back
          </button>
          <button type="button" ref={next} className="focus-go" onClick={() => (last ? onClose() : go(step + 1))}>
            {last ? 'Start using Master Tasker' : 'Next'}
            {!last && <ArrowRight size={18} aria-hidden />}
          </button>
        </div>
      </div>
    </dialog>
  );
}
