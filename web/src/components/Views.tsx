import { Check, ClipboardCheck, Download, ExternalLink, Hand, History as HistoryIcon, Lightbulb, Moon, Pause, Play, RotateCcw, Sun, Trash2, Upload, X } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { FinishedList } from './Finished.tsx';
import { THEMES, getColorTheme, getMode, setAppearance, systemIsDark, type Mode } from '../theme.ts';
import {
  AREA_MODES,
  PRIORITY_LABELS,
  STATUS_LABELS,
  type ActivityEntry,
  type Area,
  type AreaMode,
  type Proposal,
  type Task,
} from '../../../shared/schema.ts';
import { api, newKey } from '../api.ts';
import { clip, cx, formatDue, formatTime, friendlyDateTime, relativeTime, sentence, todayIso, type ViewId } from '../lib.ts';
import { confirmDialog, SelectMenu } from './Menu.tsx';
import { NeedsYouActions } from './NeedsYou.tsx';
import { store, useStore } from '../store.ts';
import { ActorBadge } from './ActorBadge.tsx';
import { AreaDot, EmptyState, onRadioKeys, radioTab } from './Bits.tsx';
import type { Actor } from '../../../shared/schema.ts';
import { proposalInMode, setWorkMode, useWorkMode } from '../mode.ts';
import { LAB_ROUTINES, LAB_WIZARD, setPref, useLabs } from '../prefs.ts';
import { AssistantsSection } from './Connect.tsx';
import { ASSISTANT_PICK } from '../assistants.ts';

function useFetch<T>(path: string, deps: unknown[]): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    const ctl = new AbortController();
    api<T>('GET', path, undefined, { signal: ctl.signal })
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => e.name !== 'AbortError' && setError(e.message));
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, n, ...deps]);
  return { data, error, reload: () => setN((x) => x + 1) };
}

// ─── For you ───

interface ReviewStatus {
  configured: boolean;
  lastRun: { at: string; summary?: string } | null;
  running: { startedAt: string } | null;
  unfinished: { startedAt: string } | null;
}

function DailyReviewStatus({ version }: { version: number }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  const { data } = useFetch<ReviewStatus>('/api/review/status', [version, tick]);
  if (!data?.configured) return null;
  const time = (iso: string) => new Date(iso).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  return (
    <div className="review-status" role="status">
      <span className={cx('review-dot', data.running ? 'is-running' : data.unfinished ? 'is-warn' : 'is-ok')} aria-hidden />
      <div className="review-status-text">
        <p className="review-status-title">
          {data.running ? `Daily review running, started ${relativeTime(data.running.startedAt)}` : data.lastRun ? `Daily review last finished ${time(data.lastRun.at)}` : 'Daily review has not finished a run yet'}
        </p>
        <p className="meta-line">
          {data.unfinished ? `A run started ${relativeTime(data.unfinished.startedAt)} did not finish. The next run covers that time again. ` : ''}
          {data.lastRun?.summary && !data.running ? `${data.lastRun.summary}. ` : ''}
          Runs at 8am and 2pm while the Claude app is open. Pause it in Settings.
        </p>
      </div>
    </div>
  );
}

/** Tasks waiting on you, loud, first. */
function NeedsYouList({ tasks, onOpen }: { tasks: Task[]; onOpen: (id: string) => void }) {
  return (
    <section className="foryou-section" aria-labelledby="you-list-title">
      <h2 id="you-list-title" className="foryou-title you-list-title">
        <Hand size={17} aria-hidden strokeWidth={2.5} /> Needs you {tasks.length > 0 && <span className="badge badge-you num">{tasks.length}</span>}
      </h2>
      {tasks.length === 0 ? (
        <p className="meta-line foryou-none">Nothing needs you right now.</p>
      ) : (
        <ul className="you-list">
          {tasks.map((t) => (
            <li key={t.id} className="you-item">
              <button type="button" className="you-item-title" onClick={() => onOpen(t.id)} title="Open the task">
                {t.title} <ExternalLink size={12} aria-hidden />
              </button>
              <NeedsYouActions task={t} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** For you: what needs a decision from you, what assistants finished, and the changes they suggest. */
export function ForYouView({ needsYou = [], finished = [], onOpen, onGo }: { needsYou?: Task[]; finished?: Task[]; onOpen: (id: string) => void; onGo: (v: ViewId) => void }) {
  const { versions, byId, areas } = useStore();
  const [showAll, setShowAll] = useState(false);
  const { data, error, reload } = useFetch<{ proposals: Proposal[] }>(`/api/proposals?status=${showAll ? 'all' : 'pending'}&limit=100`, [versions.proposals]);
  const act = async (p: Proposal, verb: 'accept' | 'reject') => {
    try {
      await api('POST', `/api/proposals/${p.id}/${verb}`, {}, { idempotencyKey: newKey() });
      store.toast(verb === 'accept' ? 'Suggestion accepted' : 'Suggestion rejected', 'success');
      reload();
    } catch (e) {
      store.toast((e as Error).message, 'error');
      reload();
    }
  };
  const workMode = useWorkMode();
  const areaMap = new Map(areas.map((a) => [a.id, a]));
  const all = data?.proposals ?? [];
  const list = all.filter((p) => proposalInMode(p, byId, areaMap, workMode));
  const hidden = all.length - list.length;
  const pending = list.filter((p) => p.status === 'pending').length;
  if (data && list.length === 0 && needsYou.length === 0 && finished.length === 0 && hidden === 0 && !showAll) {
    return (
      <div className="page">
        <EmptyState icon={<ClipboardCheck size={22} />} title="You're all caught up" body="When a task needs a decision from you, or an assistant finishes or suggests something, it shows up here.">
          <button type="button" className="btn btn-secondary" onClick={() => onGo('today')}>Go to Today</button>
        </EmptyState>
      </div>
    );
  }
  return (
    <div className="page foryou">
      <div className="page-intro">
        <p>Decisions only you can make, what your assistants finished, and changes they suggest. Nothing here is applied until you say so.</p>
      </div>
      <NeedsYouList tasks={needsYou} onOpen={onOpen} />
      <section className="foryou-section" aria-labelledby="finished-h">
        <h2 id="finished-h" className="foryou-title">
          <Check size={16} aria-hidden /> Finished for you {finished.length > 0 && <span className="badge num">{finished.length}</span>}
        </h2>
        {finished.length === 0 ? <p className="meta-line foryou-none">Nothing newly finished.</p> : <FinishedList tasks={finished} onOpen={onOpen} />}
      </section>
      <section className="foryou-section" aria-labelledby="suggest-h">
        <div className="foryou-title-row">
          <h2 id="suggest-h" className="foryou-title">
            <Lightbulb size={16} aria-hidden /> Suggestions {pending > 0 && <span className="badge num">{pending}</span>}
          </h2>
          <label className="toggle-inline">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show resolved
          </label>
        </div>
        <DailyReviewStatus version={versions.proposals} />
        {error && <p className="field-warning">{error}</p>}
        {hidden > 0 && (
          <p className="mode-hidden meta-line">
            {hidden} {hidden === 1 ? 'suggestion is' : 'suggestions are'} for the {workMode === 'work' ? 'personal' : 'work'} side.{' '}
            <button type="button" className="link-btn" onClick={() => setWorkMode('both')}>Show both</button>
          </p>
        )}
        {data && list.length === 0 && <p className="meta-line foryou-none">{showAll ? 'No suggestions yet.' : 'No suggestions waiting.'}</p>}
        <AcceptAll proposals={list} onDone={reload} />
        <ul className="cards">
          {list.map((p) => (
            <li key={p.id} className={cx('card', 'proposal', p.status !== 'pending' && 'is-resolved')}>
              <div className="card-head">
                <span className={cx('eyebrow', p.body.kind === 'question' && 'eyebrow-ask')}>{KIND_TITLE[p.body.kind]}</span>
                <span className="card-from">from {p.clientLabel}</span>
                <span className="card-time">{relativeTime(p.lastSeenAt)}</span>
                {p.seenCount > 1 && <span className="chip num" title="Times this suggestion arrived. Repeats are merged, not duplicated.">×{p.seenCount}</span>}
                {p.status !== 'pending' && <span className="chip">{p.body.kind === 'question' ? (p.status === 'accepted' ? 'answered' : 'dismissed') : p.status}</span>}
              </div>
              <ProposalBody p={p} target={'taskId' in p.body && p.body.taskId ? byId.get(p.body.taskId) : undefined} areaName={(id) => areas.find((a) => a.id === id)?.name} />
              {p.reason && <p className="card-reason">“{p.reason}”</p>}
              <div className="card-foot">
                {p.confidence !== null && <span className="meta-line num">confidence {Math.round(p.confidence * 100)}%</span>}
                {p.sourceUrl && (
                  <a className="link" href={p.sourceUrl} target="_blank" rel="noreferrer noopener">
                    <ExternalLink size={13} aria-hidden /> Source
                  </a>
                )}
                <div className="detail-head-spacer" />
                {p.status === 'pending' && p.body.kind === 'question' && (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => act(p, 'reject')}>
                    <X size={14} aria-hidden /> Dismiss
                  </button>
                )}
                {p.status === 'pending' && p.body.kind !== 'question' && (
                  <>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => act(p, 'reject')}>
                      <X size={14} aria-hidden /> Reject
                    </button>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => act(p, 'accept')}>
                      <Check size={14} aria-hidden /> Accept
                    </button>
                  </>
                )}
              </div>
              {p.status === 'pending' && p.body.kind === 'question' && <AnswerBox p={p} choices={p.body.choices ?? []} onDone={reload} />}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/**
 * Accept all for one connection's pending suggestions (not its questions), after you confirm the count.
 * Only shows for a connection with two or more, and only accepts the ones on screen.
 */
function AcceptAll({ proposals, onDone }: { proposals: Proposal[]; onDone: () => void }) {
  const [asking, setAsking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const groups = new Map<string, { label: string; ids: string[] }>();
  for (const p of proposals) {
    if (p.status !== 'pending' || p.body.kind === 'question') continue;
    const g = groups.get(p.clientId) ?? { label: p.clientLabel, ids: [] };
    g.ids.push(p.id);
    groups.set(p.clientId, g);
  }
  const many = [...groups].filter(([, g]) => g.ids.length > 1);
  if (many.length === 0) return null;
  const accept = async (clientId: string, ids: string[]) => {
    setBusy(true);
    try {
      const r = await api<{ accepted: number; failed: { id: string; message: string }[] }>('POST', '/api/proposals/accept-all', { clientId, ids }, { idempotencyKey: newKey() });
      const n = r.accepted;
      store.toast(
        r.failed.length === 0
          ? `Accepted ${n} ${n === 1 ? 'suggestion' : 'suggestions'}`
          : `Accepted ${n}. ${r.failed.length} couldn't be applied and ${r.failed.length === 1 ? 'is' : 'are'} still here: ${r.failed[0].message}`,
        r.failed.length === 0 ? 'success' : 'error',
      );
      setAsking(null);
    } catch (e) {
      store.toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
      onDone();
    }
  };
  return (
    <div className="accept-all">
      {many.map(([clientId, g]) =>
        asking === clientId ? (
          <div key={clientId} className="accept-all-row" role="group" aria-label={`Accept all from ${g.label}`}>
            <span>
              Accept {g.ids.length} suggestions from {g.label}? Each one is applied like pressing Accept on it.
            </span>
            <span className="button-row">
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setAsking(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void accept(clientId, g.ids)}>
                <Check size={14} aria-hidden /> Accept {g.ids.length}
              </button>
            </span>
          </div>
        ) : (
          <div key={clientId} className="accept-all-row">
            <span className="meta-line">
              {g.ids.length} suggestions from {g.label}
            </span>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAsking(clientId)}>
              <Check size={14} aria-hidden /> Accept all
            </button>
          </div>
        ),
      )}
    </div>
  );
}

const KIND_TITLE: Record<Proposal['body']['kind'], string> = { create: 'New task', update: 'Edit', complete: 'Mark done', reopen: 'Reopen', note: 'Add note', question: 'Needs info' };

function AnswerBox({ p, choices, onDone }: { p: Proposal; choices: string[]; onDone: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async (answer: string) => {
    if (!answer.trim() || busy) return;
    setBusy(true);
    try {
      await api('POST', `/api/proposals/${p.id}/answer`, { answer: answer.trim() }, { idempotencyKey: newKey() });
      store.toast('Answer saved. The next review run will act on it.', 'success');
      onDone();
    } catch (e) {
      store.toast((e as Error).message, 'error');
      setBusy(false);
    }
  };
  return (
    <form className="answer" onSubmit={(e) => { e.preventDefault(); send(text); }}>
      {choices.length > 0 && (
        <div className="answer-choices">
          {choices.map((c) => (
            <button key={c} type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => send(c)}>
              {c}
            </button>
          ))}
        </div>
      )}
      <div className="answer-row">
        <input className="input" aria-label="Your answer" placeholder={choices.length ? 'Or type an answer' : 'Type an answer'} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.stopPropagation()} maxLength={1000} />
        <button type="submit" className="btn btn-secondary btn-sm" disabled={busy || !text.trim()}>
          <Check size={14} aria-hidden /> Answer
        </button>
      </div>
    </form>
  );
}

function ProposalBody({ p, target, areaName }: { p: Proposal; target?: Task; areaName: (id: string) => string | undefined }) {
  const b = p.body;
  if (b.kind === 'create') {
    const t = b.task;
    return (
      <div className="card-body">
        <p className="card-title">{t.title}</p>
        <p className="meta-line">
          {[t.areaId ? areaName(t.areaId) : p.areaId ? areaName(p.areaId) : 'Unfiled', t.status && STATUS_LABELS[t.status], t.dueDate && `due ${formatDue(t.dueDate)}`, t.priority && t.priority !== 'none' && PRIORITY_LABELS[t.priority]]
            .filter(Boolean)
            .join(' · ')}
        </p>
        {t.notes && <p className="card-notes">{t.notes}</p>}
      </div>
    );
  }
  const name = target?.title ?? 'a task that is no longer visible';
  if (b.kind === 'update') {
    return (
      <div className="card-body">
        <p className="card-title">{name}</p>
        <ul className="diff">
          {Object.entries(b.patch).map(([f, v]) => (
            <li key={f}>
              <span className="eyebrow">{f}</span> <span className="diff-old">{String((target as unknown as Record<string, unknown>)?.[f] ?? '') || 'empty'}</span> →{' '}
              <span className="diff-new">{typeof v === 'object' ? JSON.stringify(v) : String(v ?? '') || 'empty'}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (b.kind === 'question') {
    return (
      <div className="card-body">
        <p className="card-title">{b.question}</p>
        <p className="meta-line">{target ? `About “${target.title}”` : b.areaId ? areaName(b.areaId) : 'General'}</p>
        {p.answer && <p className="card-answer"><span className="eyebrow">Your answer</span> {p.answer}</p>}
      </div>
    );
  }
  return (
    <div className="card-body">
      <p className="card-title">{name}</p>
      {b.kind === 'note' && <p className="card-notes">{b.text}</p>}
    </div>
  );
}

// ─── Activity ───

export function ActivityView({ onOpenTask, onGo }: { onOpenTask: (id: string) => void; onGo: (v: ViewId) => void }) {
  const { versions, byId } = useStore();
  const [who, setWho] = useState<'all' | 'user' | 'client' | 'system'>('all');
  const [older, setOlder] = useState<ActivityEntry[]>([]);
  const { data } = useFetch<{ activity: ActivityEntry[] }>('/api/activity?limit=100', [versions.activity]);
  const all = [...(data?.activity ?? []), ...older.filter((o) => !(data?.activity ?? []).some((d) => d.id === o.id))];
  const shown = all.filter((e) => who === 'all' || e.actor.kind === who);
  const loadMore = async () => {
    const last = all[all.length - 1];
    if (!last) return;
    const r = await api<{ activity: ActivityEntry[] }>('GET', `/api/activity?limit=100&beforeId=${last.id}`);
    setOlder((o) => [...o, ...r.activity]);
  };
  // One heading per day, newest first. Within a day, a run of changes by the same one names them once.
  const today = todayIso();
  const who_ = (a: Actor) => `${a.kind}:${a.id}:${a.claimedName ?? ''}`;
  const days: [string, ActivityEntry[]][] = [];
  for (const e of shown) {
    const d = todayIso(new Date(e.at));
    if (days.length && days[days.length - 1][0] === d) days[days.length - 1][1].push(e);
    else days.push([d, [e]]);
  }
  return (
    <div className="page">
      <div className="page-intro">
        <p>Every change to your tasks, who made it, and when.</p>
        <SelectMenu
          label="Filter by who"
          align="end"
          className="select-btn-compact"
          value={who}
          onChange={setWho}
          options={[
            { value: 'all', label: 'Everyone' },
            { value: 'user', label: 'You' },
            { value: 'client', label: 'Assistants and automations' },
            { value: 'system', label: 'System' },
          ]}
        />
      </div>
      {data && shown.length === 0 && (
        <EmptyState icon={<HistoryIcon size={22} />} title="No activity yet" body="Changes from you and from connected assistants appear here.">
          <button type="button" className="btn btn-secondary" onClick={() => onGo('today')}>Go to Today</button>
        </EmptyState>
      )}
      {days.map(([day, entries]) => (
        <section key={day} className="feed-day" aria-labelledby={`day-${day}`}>
          <h2 id={`day-${day}`} className="eyebrow feed-day-title">{formatDue(day, today)}</h2>
          <ol className="feed">
            {entries.map((e, i) => {
              const task = e.entityType === 'task' ? byId.get(e.entityId) : undefined;
              const cont = i > 0 && who_(entries[i - 1].actor) === who_(e.actor);
              return (
                <li key={e.id} className={cx('feed-item', cont && 'is-cont')}>
                  {cont ? <span className="sr-only">{e.actor.label}: </span> : <ActorBadge actor={e.actor} />}
                  {task ? (
                    <button type="button" className="feed-text feed-link" onClick={() => onOpenTask(task.id)}>
                      {sentence(e.summary)}
                    </button>
                  ) : (
                    <span className="feed-text">{sentence(e.summary)}</span>
                  )}
                  <time className="history-time" dateTime={e.at} title={new Date(e.at).toLocaleString()}>
                    {formatTime(e.at)}
                  </time>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
      {all.length >= 100 && (
        <button type="button" className="btn btn-secondary" onClick={loadMore}>
          Load older
        </button>
      )}
    </div>
  );
}

// ─── Trash ───

export function TrashView({ onGo }: { onGo: (v: ViewId) => void }) {
  const { versions, tasks } = useStore();
  const { data, reload } = useFetch<{ tasks: Task[] }>('/api/trash', [versions.activity, tasks.length]);
  const purge = async (t: Task) => {
    const r = await confirmDialog({
      title: `Delete “${clip(t.title, 60)}” forever?`,
      body: <p>This can't be undone, though the daily backups still have it.</p>,
      confirmLabel: 'Delete forever',
      danger: true,
    });
    if (!r.ok) return;
    try {
      await api('DELETE', `/api/trash/${t.id}`, undefined, { idempotencyKey: newKey() });
      reload();
    } catch (e) {
      store.toast((e as Error).message, 'error');
    }
  };
  const list = data?.tasks ?? [];
  return (
    <div className="page">
      {list.length > 0 && (
        <div className="page-intro">
          <p>Deleted tasks wait here until you delete them for good. Restore puts a task back where it was.</p>
        </div>
      )}
      {data && list.length === 0 && (
        <EmptyState icon={<Trash2 size={22} />} title="Trash is empty" body="Deleting a task moves it here first, so mistakes are easy to undo.">
          <button type="button" className="btn btn-secondary" onClick={() => onGo('today')}>Go to Today</button>
        </EmptyState>
      )}
      <ul className="cards">
        {list.map((t) => (
          <li key={t.id} className="card card-row">
            <div className="card-body">
              <p className="card-title">{t.title}</p>
              <p className="meta-line">Deleted {t.deletedAt ? relativeTime(t.deletedAt) : ''} · was in {STATUS_LABELS[t.status]}</p>
            </div>
            <button type="button" className="btn btn-secondary btn-sm" onClick={async () => { await store.restoreTask(t.id); reload(); }}>
              <RotateCcw size={14} aria-hidden /> Restore
            </button>
            <button type="button" className="btn btn-ghost btn-sm btn-danger-text" onClick={() => purge(t)}>
              Delete forever
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Settings ───

function Section({ id, title, children, intro }: { id: string; title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <section className="settings-section" aria-labelledby={`s-${id}`}>
      <h2 id={`s-${id}`} className="section-title" tabIndex={-1}>
        {title}
      </h2>
      {intro && <p className="section-intro">{intro}</p>}
      {children}
    </section>
  );
}

/** `section` scrolls to one part of Settings, from a link like #/settings?section=assistants. */
export function SettingsView({ section = null }: { section?: string | null }) {
  const { settings, tasks } = useStore();
  const samples = tasks.filter((t) => t.isSample).length;
  useEffect(() => {
    const go = (to: string | null) => {
      if (!to) return;
      // Old links still work: claude opens AI assistants with Claude picked, connections opens its Assistants with access.
      if (to === 'claude') setPref(ASSISTANT_PICK, 'claude-code');
      // General starts with your name.
      const id = to === 'general' ? 'name' : to === 'claude' ? 'assistants' : to;
      const el = id === 'connections' ? document.getElementById('assistants-access') : document.getElementById(`s-${id}`)?.closest('section');
      if (!el) return;
      if (id === 'advanced') el.querySelector('details')?.setAttribute('open', '');
      el.scrollIntoView({ block: 'start' });
      el.querySelector<HTMLElement>('h2, h3')?.focus({ preventScroll: true });
    };
    go(section);
    const on = (e: Event) => go((e as CustomEvent<string>).detail);
    window.addEventListener('mt:section', on);
    return () => window.removeEventListener('mt:section', on);
  }, [section]);
  return (
    <div className="page settings">
      <SettingsNav />
      <NameSection />
      <Appearance />
      <AreasSection />
      <Section id="notifications" title="Notifications" intro="When an assistant finishes a task, it shows in For you until you press Got it, and as a message in any open tab.">
        <label className="toggle-inline">
          <input type="checkbox" checked={settings.macNotify} onChange={(e) => store.setMacNotify(e.target.checked).catch((err) => store.toast(err.message, 'error'))} /> Also show a Mac notification
        </label>
      </Section>
      {(samples > 0 || settings.startedWithSamples) && (
        <Section id="samples" title="Sample tasks" intro="Six sample tasks, each showing one idea. Clearing them moves them to Trash.">
          <button type="button" className="btn btn-secondary" disabled={samples === 0} onClick={() => void store.clearSamples()}>
            <Trash2 size={14} aria-hidden /> {samples ? `Clear ${samples} sample ${samples === 1 ? 'task' : 'tasks'}` : 'No sample tasks left'}
          </button>
        </Section>
      )}
      <AssistantsSection />
      <Section id="pause" title="Pause assistants" intro="Stops every connected assistant and automation from changing or suggesting anything. They can still read. The app itself works as usual.">
        <button type="button" className={cx('btn', settings.automationPaused ? 'btn-primary' : 'btn-secondary')} onClick={() => store.setAutomationPaused(!settings.automationPaused).catch((e) => store.toast(e.message, 'error'))}>
          {settings.automationPaused ? <Play size={14} aria-hidden /> : <Pause size={14} aria-hidden />}
          {settings.automationPaused ? 'Resume assistants' : 'Pause assistants'}
        </button>
        {settings.automationPaused && <p className="field-warning">Assistants are paused. They get a clear “paused” message if they try.</p>}
      </Section>
      <DataSection />
      <Labs />
      <Advanced />
    </div>
  );
}

/** Your name: what the app and your AI assistant call you. Empty means they say “you”. */
function NameSection() {
  const { settings } = useStore();
  const saved = settings.ownerName;
  const [draft, setDraft] = useState(saved);
  const [busy, setBusy] = useState(false);
  // Follow a change made elsewhere, like another tab, unless you're part way through typing.
  const last = useRef(saved);
  useEffect(() => {
    setDraft((d) => (d === last.current ? saved : d));
    last.current = saved;
  }, [saved]);
  const changed = draft.trim() !== saved;
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!changed || busy) return;
    setBusy(true);
    const name = draft.trim();
    store
      .setOwnerName(name)
      .then(() => {
        setDraft(name);
        store.toast(name ? `Saved your name` : 'Cleared your name', 'success');
      })
      .catch((err) => store.toast(err.message, 'error'))
      .finally(() => setBusy(false));
  };
  return (
    <Section id="name" title="Your name" intro="What the app and your AI assistant call you. Leave it empty and they say “you”.">
      <form className="name-row" onSubmit={save}>
        <input className="input" aria-labelledby="s-name" value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={60} autoComplete="given-name" spellCheck={false} />
        <button type="submit" className="btn btn-secondary" disabled={!changed || busy}>
          Save
        </button>
      </form>
    </Section>
  );
}

const SETTINGS_NAV: { id: string; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'assistants', label: 'AI assistants' },
  { id: 'backups', label: 'Backups' },
  { id: 'labs', label: 'Labs' },
  { id: 'advanced', label: 'Advanced' },
];

/** A short row of links to each part of Settings. */
function SettingsNav() {
  return (
    <nav className="settings-nav" aria-label="Settings sections">
      {SETTINGS_NAV.map((n) => (
        <button key={n.id} type="button" className="settings-nav-link" onClick={() => window.dispatchEvent(new CustomEvent('mt:section', { detail: n.id }))}>
          {n.label}
        </button>
      ))}
    </nav>
  );
}

/** Wizard and Routines: there when you want them, out of the way when you don't. */
function Labs() {
  const labs = useLabs();
  const row = (key: string, on: boolean, name: string, body: string) => (
    <div className="pref-row">
      <span className="pref-text">
        <span className="pref-label">{name}</span>
        <span className="meta-line">{body}</span>
      </span>
      <button type="button" role="switch" aria-checked={on} aria-label={name} className="switch" onClick={() => setPref(key, on ? null : '1')}>
        <span className="switch-thumb" />
      </button>
    </div>
  );
  return (
    <Section id="labs" title="Labs" intro="Extra views. Each shows in the sidebar, under More, while it's on.">
      {row(LAB_WIZARD, labs.wizard, 'Wizard', "Your tasks as a scene: each one a spell, with what's happening on it.")}
      {row(
        LAB_ROUTINES,
        labs.routinesOn,
        'Routines',
        labs.routineCount ? `Routines the Claude app runs on a schedule. You have ${labs.routineCount}, so it shows anyway.` : 'Routines the Claude app runs on a schedule, what each reads, and the tasks it is tied to. Shows on its own once you have one.',
      )}
    </Section>
  );
}

const SIDES = AREA_MODES;
const setSide = (a: Area, mode: AreaMode) => a.mode !== mode && store.updateArea(a.id, { mode }).catch((e) => store.toast(e.message, 'error'));

/** Every area: which side it's on, and the archived ones, to bring back. */
function AreasSection() {
  const { areas } = useStore();
  const live = areas.filter((a) => !a.archived);
  const archived = areas.filter((a) => a.archived);
  return (
    <Section id="areas" title="Areas" intro="Each area is on the work or the personal side. Once you have both, “Showing” above your tasks (or M) picks which side you see. Unfiled tasks always show.">
      {live.length === 0 && <p className="meta-line">No areas yet. Add one from the sidebar.</p>}
      <ul className="area-sides">
        {live.map((a) => (
          <li key={a.id} className="area-side">
            <span className="area-side-name">
              <AreaDot color={a.color} /> {a.name}
            </span>
            <div className="segmented" role="radiogroup" aria-label={`${a.name} is`} onKeyDown={(e) => onRadioKeys(e, SIDES, a.mode, (m) => setSide(a, m))}>
              {SIDES.map((m, i) => (
                <button key={m} type="button" role="radio" aria-checked={a.mode === m} tabIndex={radioTab(a.mode === m, i === 0, SIDES.includes(a.mode))} className={cx('seg', a.mode === m && 'is-on')} onClick={() => setSide(a, m)}>
                  {m === 'work' ? 'Work' : 'Personal'}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>
      {archived.length > 0 && (
        <>
          <h3 className="eyebrow settings-sub">Archived</h3>
          <ul className="area-sides">
            {archived.map((a) => (
              <li key={a.id} className="area-side">
                <span className="area-side-name">
                  <AreaDot color={a.color} /> {a.name}
                </span>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => store.updateArea(a.id, { archived: false }).then(() => store.toast(`Restored “${a.name}”`, 'success')).catch((e) => store.toast(e.message, 'error'))}>
                  <RotateCcw size={14} aria-hidden /> Restore
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}

const MODES: { id: Mode; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'system', label: 'Match my Mac' },
];

function Appearance() {
  const [mode, setMode] = useState<Mode>(getMode);
  const [color, setColor] = useState(() => getColorTheme().id);
  const [sysDark, setSysDark] = useState(systemIsDark);
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const on = () => setSysDark(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const dark = mode === 'dark' || (mode === 'system' && sysDark);
  const update = (next: { mode?: Mode; color?: string }) => {
    if (next.mode) setMode(next.mode);
    if (next.color) setColor(next.color);
    setAppearance(next);
  };
  return (
    <Section id="appearance" title="Appearance" intro="Saved in this browser.">
      <div className="pref-label pref-label-block" id="mode-label">
        {dark ? <Moon size={15} aria-hidden /> : <Sun size={15} aria-hidden />} Light or dark
      </div>
      <div className="segmented segmented-pref" role="radiogroup" aria-labelledby="mode-label" onKeyDown={(e) => onRadioKeys(e, MODES.map((m) => m.id), mode, (m) => update({ mode: m }))}>
        {MODES.map((m, i) => (
          <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} tabIndex={radioTab(mode === m.id, i === 0, true)} className={cx('seg', mode === m.id && 'is-on')} onClick={() => update({ mode: m.id })}>
            {m.label}
          </button>
        ))}
      </div>
      <div className="pref-label pref-label-block" id="color-label">Color theme</div>
      <div className="theme-row">
        <div className="swatches" role="radiogroup" aria-labelledby="color-label" onKeyDown={(e) => onRadioKeys(e, THEMES.map((t) => t.id), color, (id) => update({ color: id }))}>
          {THEMES.map((t, i) => (
            <button key={t.id} type="button" role="radio" aria-checked={color === t.id} aria-label={t.name} title={t.name} tabIndex={radioTab(color === t.id, i === 0, THEMES.some((x) => x.id === color))} className={cx('swatch', color === t.id && 'is-on')} onClick={() => update({ color: t.id })} style={{ '--sw': dark ? t.dark : t.light } as CSSProperties}>
              {color === t.id && <Check size={14} className="swatch-check" strokeWidth={3} aria-hidden />}
            </button>
          ))}
        </div>
        <span className="theme-name" aria-hidden>{THEMES.find((t) => t.id === color)?.name}</span>
      </div>
    </Section>
  );
}

interface BackupRow { name: string; bytes: number; createdAt: string; reason: string }

function DataSection() {
  const { data, reload } = useFetch<{ backups: BackupRow[]; dir: string }>('/api/backups', []);
  const [busy, setBusy] = useState(false);
  const backupNow = async () => {
    setBusy(true);
    try {
      const r = await api<{ name: string }>('POST', '/api/backups', {}, { idempotencyKey: newKey() });
      store.toast(`Backup saved: ${r.name}`, 'success');
      reload();
    } finally {
      setBusy(false);
    }
  };
  const restore = async (b: BackupRow) => {
    const ok = await confirmDialog({ title: 'Restore this backup?', body: <p>Your tasks right now are backed up first, then replaced by the backup from {friendlyDateTime(b.createdAt).replace(/^[A-Z]/, (c) => c.toLowerCase())}.</p>, confirmLabel: 'Restore backup', danger: true });
    if (!ok.ok) return;
    setBusy(true);
    try {
      const r = await api<{ restored: string; tasks: number; safetyBackup: string }>('POST', '/api/backups/restore', { name: b.name }, { idempotencyKey: newKey() });
      store.toast(`Restored ${r.tasks} tasks. Previous data saved as ${r.safetyBackup}.`, 'success');
      await store.syncNow(true);
      reload();
    } catch (e) {
      store.toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const importFile = async (file: File) => {
    try {
      const json = JSON.parse(await file.text());
      const r = await api<{ tasks: number; areas: number; projects: number; skipped: number; backup: string }>('POST', '/api/import', json, { idempotencyKey: newKey() });
      store.toast(`Imported ${r.tasks} tasks, ${r.areas} areas, ${r.projects} projects. Skipped ${r.skipped} that already exist.`, 'success');
      reload();
    } catch (e) {
      store.toast(`Import failed: ${(e as Error).message}`, 'error');
    }
  };
  return (
    <>
      <Section id="backups" title="Backups" intro="Your tasks are saved on this Mac and backed up every day, and before every import and restore.">
        <div className="button-row">
          <a className="btn btn-secondary" href="/api/export" download={`master-tasker-export-${new Date().toISOString().slice(0, 10)}.json`}>
            <Download size={14} aria-hidden /> Export
          </a>
          <label className="btn btn-secondary">
            <Upload size={14} aria-hidden /> Import
            <input type="file" accept="application/json,.json" className="sr-only" onChange={(e) => e.target.files?.[0] && void importFile(e.target.files[0])} />
          </label>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={backupNow}>
            Back up now
          </button>
        </div>
        <p className="meta-line">Import adds what is missing and never overwrites tasks you already have.</p>
        {data && data.backups.length > 0 && (
          <ul className="backups">
            {data.backups.slice(0, 12).map((b) => (
              <li key={b.name} className="backup-row">
                <span className="backup-name">{reasonLabel(b.reason)}</span>
                <span className="meta-line">{friendlyDateTime(b.createdAt)} · {(b.bytes / 1024).toFixed(0)} KB</span>
                <button type="button" className="btn btn-ghost btn-xs" disabled={busy} onClick={() => restore(b)}>
                  Restore
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

const REASON: Record<string, string> = { auto: 'Daily', manual: 'Backed up by you', 'manual-cli': 'Backed up by you', 'pre-import': 'Before an import', 'pre-restore': 'Before a restore' };
const reasonLabel = (r: string) => REASON[r] ?? (r.startsWith('pre-migration') ? 'Before an update' : r);

/** The technical details, for when you need them: where the database lives, and which version is running. */
function Advanced() {
  const { data } = useFetch<{ version: string; schemaVersion: number; uptimeSec: number; lastBackupAt: string | null }>('/api/health', []);
  const dir = useFetch<{ dir: string }>('/api/backups', []).data?.dir ?? null;
  return (
    <section className="settings-section" aria-labelledby="s-advanced">
      <details className="advanced">
        <summary>
          <h2 id="s-advanced" className="section-title">Advanced</h2>
        </summary>
        <dl className="advanced-list">
          <div><dt>Storage</dt><dd>One SQLite database file on this Mac</dd></div>
          {dir && <div><dt>Backups folder</dt><dd className="mono">{dir}</dd></div>}
          {data && (
            <>
              <div><dt>Version</dt><dd className="mono">{data.version}</dd></div>
              <div><dt>Database schema</dt><dd className="mono">{data.schemaVersion}</dd></div>
              <div><dt>Running for</dt><dd>{Math.round(data.uptimeSec / 60)} min</dd></div>
              <div><dt>Last backup</dt><dd>{data.lastBackupAt ? relativeTime(data.lastBackupAt) : 'never'}</dd></div>
            </>
          )}
        </dl>
      </details>
    </section>
  );
}
