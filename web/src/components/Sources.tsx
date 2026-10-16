// Routines: each scheduled routine, the tasks it's tied to, what it reads, and switches to stop it reading things.
import { CalendarClock, ExternalLink, Plus, Radar } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { RoutineInfo } from '../../../shared/schema.ts';
import { api } from '../api.ts';
import { cx, relativeTime } from '../lib.ts';
import { store, useIntegrations } from '../store.ts';
import { CLAUDE_SETUP_HASH, claudeReady, openClaudeSetup, startThread } from '../claude.ts';
import { EmptyState } from './Bits.tsx';

export function RoutinesView({ onOpenTask }: { onOpenTask: (id: string) => void }) {
  const [routines, setRoutines] = useState<RoutineInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    api<{ routines: RoutineInfo[] }>('GET', '/api/sources')
      .then((r) => {
        setRoutines(r.routines);
        setError(null);
      })
      .catch((e) => setError((e as Error).message));
  useEffect(() => {
    load();
  }, []);

  const change = async (id: string, body: { paused?: boolean; source?: string; on?: boolean }) => {
    try {
      const { routine } = await api<{ routine: RoutineInfo }>('PATCH', `/api/sources/${id}`, body);
      setRoutines((list) => list?.map((r) => (r.id === id ? { ...r, ...routine, tickets: r.tickets, lastRunLink: r.lastRunLink } : r)) ?? null);
    } catch (e) {
      store.toast((e as Error).message, 'error');
    }
  };

  return (
    <div className="page">
      <div className="page-intro">
        <p>Routines the Claude app runs on a schedule, what each one reads, and the tasks it's tied to. Switch a source off and that routine skips it from its next run on.</p>
      </div>
      {error && <p className="form-error">{error}</p>}
      {routines && routines.length === 0 && (
        <EmptyState icon={<Radar size={22} />} title="No routines scheduled" body="Routines you schedule in the Claude app show up here.">
          <button type="button" className="btn btn-secondary" onClick={() => document.getElementById('add-source-text')?.focus()}>Add a source</button>
        </EmptyState>
      )}
      <ul className="routines">
        {routines?.map((r) => (
          <li key={r.id} className={cx('routine', (r.paused || !r.enabled) && 'is-paused')}>
            <div className="routine-head">
              <div className="routine-title">
                <h2>{r.name}</h2>
                <span className="routine-when">
                  <CalendarClock size={12} aria-hidden /> {r.schedule}
                  {!r.enabled && ' · off in the Claude app'}
                  {r.lastRunAt && ` · last ran ${relativeTime(r.lastRunAt)}`}
                </span>
              </div>
              {r.lastRunLink && (
                <a className="btn btn-ghost btn-sm" href={r.lastRunLink} title="Open the latest run in the Claude app">
                  <ExternalLink size={13} aria-hidden /> Last run
                </a>
              )}
              <label className="routine-switch">
                <span>{r.paused ? 'Paused' : 'On'}</span>
                <button type="button" role="switch" aria-checked={!r.paused} aria-label={`Run ${r.name}`} className="switch" onClick={() => change(r.id, { paused: !r.paused })}>
                  <span className="switch-thumb" />
                </button>
              </label>
            </div>
            {r.description && <p className="routine-desc">{r.description}</p>}
            <div className="routine-row">
              <span className="routine-label">Tasks</span>
              <span className="routine-chips">
                {r.allTasks && <span className="chip">Every open task</span>}
                {r.tickets?.map((t) => (
                  <button key={t.id} type="button" className="chip routine-ticket" onClick={() => onOpenTask(t.id)} title="Open this task">
                    <span className="chip-text">{t.title}</span>
                  </button>
                ))}
                {!r.allTasks && !r.tickets?.length && <span className="routine-none">None tied to it</span>}
              </span>
            </div>
            <div className="routine-row">
              <span className="routine-label">Reads</span>
              <ul className="routine-sources">
                {r.sources.length === 0 && <li className="routine-none">Nothing it names. It works from its own notes.</li>}
                {r.sources.map((s) => (
                  <li key={s.key} className={cx('routine-source', !s.on && 'is-off')}>
                    <span>{s.label}</span>
                    <button type="button" role="switch" aria-checked={s.on} aria-label={`${r.name} reads ${s.label}`} className="switch switch-sm" disabled={r.paused} onClick={() => change(r.id, { source: s.key, on: !s.on })}>
                      <span className="switch-thumb" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            {!r.enforced && r.sources.length > 0 && (
              <p className="routine-note">The first time you pause this or switch a source off, one line is added to its instructions telling it to check these switches before it reads anything.</p>
            )}
          </li>
        ))}
      </ul>
      <AddSource onAdded={load} />
    </div>
  );
}

/** Sources are wide open (an app, a folder, a website, a person's notes), so you just say what you want. */
function AddSource({ onAdded }: { onAdded: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  // Without Claude set up, it still saves the task, for later.
  const ready = claudeReady(useIntegrations());
  const send = async () => {
    if (text.trim().length < 3 || busy) return;
    setBusy(true);
    try {
      const req = api<{ url: string }>('POST', '/api/sources/request', { text: text.trim() });
      // Started while the click still counts, so with only Claude Code the prompt can be copied.
      const started = ready ? startThread(req, 'Saved as a task. ') : null;
      started?.catch(() => {});
      await req;
      setText('');
      onAdded();
      if (started) await started;
      else store.toast('Saved as a task in Today. Set up Claude to work on it with you.', 'success', { label: 'Set up', run: openClaudeSetup });
    } catch (e) {
      store.toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="add-source" aria-labelledby="add-source-title">
      <h2 id="add-source-title" className="section-title">
        <Plus size={15} aria-hidden /> Add a source
      </h2>
      <p className="section-intro">Say what you want a routine to read and why. This makes a task and opens a Claude thread that sets it up with you. Nothing gets connected until you say so there.</p>
      <textarea
        className="textarea"
        rows={3}
        id="add-source-text"
        aria-label="Describe the source to add"
        placeholder="e.g. Have the daily review also check my Notion work board for anything assigned to me."
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
        }}
      />
      <div className="add-source-actions">
        {!ready && (
          <span className="meta-line">
            Claude isn't set up yet, so this saves a task for later.{' '}
            <a className="link-btn" href={CLAUDE_SETUP_HASH} onClick={(e) => { e.preventDefault(); openClaudeSetup(); }}>Set up Claude</a>
          </span>
        )}
        <button type="button" className="btn btn-primary btn-sm" disabled={text.trim().length < 3 || busy} onClick={send}>
          {ready ? 'Talk to Claude about it' : 'Save as a task'}
        </button>
      </div>
    </section>
  );
}
