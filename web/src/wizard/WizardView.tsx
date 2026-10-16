// The Wizard view: an optional, deliberately silly stage over every ticket in scope.
// The joke is the art. Every fact and every action lives in plain HTML next to it.
import { Component, lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Maximize2, Minimize2, Pause, Play, Search } from 'lucide-react';
import type { Area, Project, Status, Task } from '../../../shared/schema.ts';
import { STATUS_LABELS } from '../../../shared/schema.ts';
import { cx, EMPTY_FILTERS, matches, plain, relativeTime } from '../lib.ts';
import { useStore } from '../store.ts';
import { POLL_MS, useAllProgress, useProgressMeta } from '../progress.ts';
import { WORK_MODES, type WorkMode } from '../mode.ts';
import { hasBothSides, ModeMenu } from '../components/Chrome.tsx';
import {
  caption,
  captionFacts,
  countSpells,
  filterLedger,
  freshness,
  moodOf,
  newlyCompleted,
  planGlyphs,
  sortLedger,
  SPELL_LABELS,
  subtaskLabel,
  toSpells,
  type LedgerFilter,
  type Mood,
  type SpellKind,
  type TaskSpell,
} from './derive.ts';
import { resetPersonality, useWizardPrefs, type Quality } from './prefs.ts';
import { useFinePointer, useNarrow, useReducedMotion, useTabVisible } from './media.ts';
import { WizardPortrait } from './WizardPortrait.tsx';
import type { SceneTier } from './scene.ts';
import './wizard.css';

const WizardScene = lazy(() => import('./WizardScene.tsx'));


interface Props {
  tasks: Task[];
  areas: Area[];
  projects: Project[];
  workMode: WorkMode;
  selectedId: string | null;
  onOpen: (id: string) => void;
}

const FILTERS: { id: LedgerFilter; label: string }[] = [
  { id: 'all', label: 'All open' },
  { id: 'needsYou', label: 'Needs you' },
  { id: 'working', label: 'In progress' },
  { id: 'waiting', label: 'Waiting' },
  { id: 'queued', label: 'Today and Next' },
  { id: 'untriaged', label: 'Inbox' },
];

const KIND_FILTER: Record<SpellKind, LedgerFilter> = { needsYou: 'needsYou', working: 'working', waiting: 'waiting', queued: 'queued', untriaged: 'untriaged', done: 'done' };

export default function WizardView({ tasks, areas, projects, workMode, selectedId, onOpen }: Props) {
  const snap = useStore();
  const progress = useAllProgress();
  const progressMeta = useProgressMeta();
  const [prefs, setPrefs] = useWizardPrefs();
  const reduced = useReducedMotion();
  const fine = useFinePointer();
  const narrow = useNarrow();
  const visible = useTabVisible();
  const [areaId, setAreaId] = useState<string>('');
  const [projectId, setProjectId] = useState<string>('');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<LedgerFilter>('all');
  const [doneShown, setDoneShown] = useState(50);
  const [shrunk, setShrunk] = useState(false);
  const [full, setFull] = useState(false);
  const sceneRef = useRef<HTMLDivElement>(null);
  const fullBtnRef = useRef<HTMLButtonElement>(null);
  const exitBtnRef = useRef<HTMLButtonElement>(null);
  const [now, setNow] = useState(() => Date.now());
  const [downgraded, setDowngraded] = useState(false);
  const [sceneFailed, setSceneFailed] = useState<string | null>(null);
  const [sceneKey, setSceneKey] = useState(0);
  const [turned, setTurned] = useState(false);
  const [resetNonce, setResetNonce] = useState(0);

  // Ages and staleness tick along with the progress poller, not every frame.
  useEffect(() => {
    const t = setInterval(() => document.visibilityState === 'visible' && setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => setNow(Date.now()), [progressMeta, snap.conn.status]);

  const areaMap = useMemo(() => new Map(areas.map((a) => [a.id, a])), [areas]);
  const projectMap = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const modeAreas = areas.filter((a) => !a.archived && (workMode === 'both' || a.mode === workMode));
  const areaProjects = projects.filter((p) => p.areaId === areaId && !p.archived);
  // An area from the other side, or one that went away, stops narrowing.
  useEffect(() => {
    if (areaId && !modeAreas.some((a) => a.id === areaId)) {
      setAreaId('');
      setProjectId('');
    }
  }, [areaId, modeAreas]);

  const scoped = useMemo(() => tasks.filter((t) => (projectId ? t.projectId === projectId : areaId ? t.areaId === areaId : true)), [tasks, areaId, projectId]);
  const spells = useMemo(() => toSpells(scoped, progress), [scoped, progress]);
  const counts = useMemo(() => countSpells(spells), [spells]);
  const mood: Mood = moodOf(counts);
  const fresh = freshness(snap.conn.status, progressMeta, counts.inProgress > 0, POLL_MS, now);

  const modeLabel = WORK_MODES.find((m) => m.id === workMode)!.label;
  const scopeLabel = projectId ? `${projectMap.get(projectId)?.name ?? 'Project'} tasks` : areaId ? `${areaMap.get(areaId)?.name ?? 'Area'} tasks` : workMode === 'both' ? 'All tasks, Work and Personal' : `All ${modeLabel} tasks`;

  // ─── Ledger ───
  const searched = useMemo(() => (q ? spells.filter((s) => matches(s.task, { ...EMPTY_FILTERS, q }, undefined, { areas: areaMap, projects: projectMap })) : spells), [spells, q, areaMap, projectMap]);
  const openRows = useMemo(() => sortLedger(filterLedger(searched, filter).filter((s) => s.kind !== 'done')), [searched, filter]);
  const doneRows = useMemo(() => sortLedger(searched.filter((s) => s.kind === 'done')), [searched]);
  const openTotal = counts.total - counts.done;

  // ─── Stage ───
  const motionOk = !reduced && !prefs.paused;
  const tier: SceneTier = resolveTier(prefs.quality, reduced, fine && !narrow, downgraded);
  const use3d = !sceneFailed && (full || !(narrow && shrunk));

  // Full screen: the browser's own where it allows it (not on iPhone), otherwise the stage fills the window.
  // Either way Escape leaves, and focus comes back to the button that opened it.
  const enterFull = () => {
    setFull(true);
    const el = sceneRef.current;
    if (el?.requestFullscreen && document.fullscreenEnabled) void el.requestFullscreen().catch(() => {});
    requestAnimationFrame(() => exitBtnRef.current?.focus());
  };
  const exitFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    setFull(false);
    requestAnimationFrame(() => fullBtnRef.current?.focus());
  };
  useEffect(() => {
    if (!full) return;
    const onChange = () => !document.fullscreenElement && exitFull();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      exitFull();
    };
    document.addEventListener('fullscreenchange', onChange);
    window.addEventListener('keydown', onKey, true);
    document.documentElement.classList.add('wz-full-open');
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      window.removeEventListener('keydown', onKey, true);
      document.documentElement.classList.remove('wz-full-open');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [full]);
  // The flat portrait draws no tickets, so then every ticket is counted in the chips.
  const cap = !use3d ? 0 : tier === 'normal' ? 12 : 6;
  const glyphs = useMemo(() => planGlyphs(spells, cap, selectedId), [spells, cap, selectedId]);
  const facts = captionFacts(spells, counts, selectedId);
  const lines = caption(facts, prefs.bluntness, prefs.verbosity, now);
  const followCursor = !reduced && (prefs.followCursor ?? fine);
  const energy = !fresh.live ? 0.1 : mood === 'working' ? Math.min(1, 0.45 + counts.inProgress * 0.1) : mood === 'attention' ? 0.55 : mood === 'idle' ? 0.2 : 0.08;

  // ─── Completions and announcements ───
  const [stamp, setStamp] = useState<{ ids: string[]; n: number } | null>(null);
  const [announce, setAnnounce] = useState('');
  const prevConfirmed = useRef<ReadonlyMap<string, Status> | null>(null);
  const prevSync = useRef<number | null>(null);
  const prevYou = useRef<Set<string> | null>(null);
  const scopedIds = useMemo(() => new Set(scoped.map((t) => t.id)), [scoped]);
  useEffect(() => {
    if (!snap.ready) return;
    // A fresh (re)sync replays history. Only live, confirmed changes celebrate.
    const replay = prevSync.current !== snap.conn.lastSyncAt;
    const done = newlyCompleted(prevConfirmed.current, snap.confirmedStatus, replay).filter((id) => scopedIds.has(id));
    prevConfirmed.current = snap.confirmedStatus;
    prevSync.current = snap.conn.lastSyncAt;
    const you = new Set(spells.filter((s) => s.needsYou.length).map((s) => s.task.id));
    const newYou = prevYou.current && !replay ? [...you].filter((id) => !prevYou.current!.has(id)) : [];
    prevYou.current = you;
    const parts: string[] = [];
    if (done.length) {
      setStamp((s) => ({ ids: done, n: (s?.n ?? 0) + 1 }));
      parts.push(done.length === 1 ? `Completed: ${snap.byId.get(done[0])?.title ?? 'a task'}.` : `${done.length} completed.`);
    }
    if (newYou.length) parts.push(newYou.length === 1 ? `Needs you: ${snap.byId.get(newYou[0])?.title ?? 'a task'}.` : `${newYou.length} tasks need you.`);
    if (parts.length) setAnnounce(parts.join(' '));
  }, [snap.ready, snap.confirmedStatus, snap.conn.lastSyncAt, snap.byId, spells, scopedIds]);
  useEffect(() => {
    if (!stamp) return;
    const t = setTimeout(() => setStamp(null), 4000);
    return () => clearTimeout(t);
  }, [stamp]);
  const stampText = stamp ? (stamp.ids.length === 1 ? `Completed: ${snap.byId.get(stamp.ids[0])?.title ?? ''}` : `${stamp.ids.length} completed`) : null;

  return (
    <div className={cx('wz', !fresh.live && 'is-stale')}>
      <div className="wz-head">
        <div className="wz-scope">
          <span className="eyebrow">Scope</span>
          <strong className="wz-scope-label">{scopeLabel}</strong>
          {hasBothSides(areas) && <ModeMenu />}
          <select className="select select-compact" aria-label="Narrow to an area" value={areaId} onChange={(e) => (setAreaId(e.target.value), setProjectId(''))}>
            <option value="">Every area</option>
            {modeAreas.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          {areaId && areaProjects.length > 0 && (
            <select className="select select-compact" aria-label="Narrow to a project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">Every project</option>
              {areaProjects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="wz-head-right">
          <span className={cx('wz-fresh', fresh.label ? 'is-warn' : 'is-ok')} role="status">
            <span className="wz-fresh-dot" aria-hidden />
            {fresh.label ?? 'Live'}
          </span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            aria-pressed={prefs.paused}
            title="Freezes the animation only. Tasks and assistants keep going."
            onClick={() => setPrefs({ paused: !prefs.paused })}
          >
            {prefs.paused ? <Play size={14} aria-hidden /> : <Pause size={14} aria-hidden />}
            {prefs.paused ? 'Resume motion' : 'Pause motion'}
          </button>
        </div>
      </div>

      <div className="wz-grid">
        <section className="wz-stage" aria-label="Wizard">
          <div
            ref={sceneRef}
            className={cx('wz-scene', !full && narrow && shrunk && 'is-shrunk', full && 'is-full', `mood-${mood}`)}
            role={full ? 'dialog' : undefined}
            aria-modal={full || undefined}
            aria-label={full ? 'Wizard, full screen' : undefined}
          >
            {use3d ? (
              <SceneBoundary onFail={setSceneFailed} key={sceneKey}>
                <Suspense fallback={<WizardPortrait mood={mood} happiness={prefs.happiness} energy={energy} animate={false} />}>
                  <WizardScene
                    glyphs={glyphs.shown}
                    selectedId={selectedId}
                    mood={mood}
                    stale={!fresh.live}
                    happiness={prefs.happiness}
                    caffeine={prefs.caffeine}
                    clutter={prefs.clutter}
                    energy={energy}
                    tier={tier}
                    animate={motionOk && visible}
                    followCursor={followCursor}
                    hoverTilt={motionOk && fine}
                    resetNonce={resetNonce}
                    onTurned={setTurned}
                    stamp={stamp}
                    onFail={setSceneFailed}
                    onSlow={() => setDowngraded(true)}
                  />
                </Suspense>
              </SceneBoundary>
            ) : (
              <WizardPortrait mood={mood} happiness={prefs.happiness} energy={energy} animate={motionOk && visible} compact={!full && narrow && shrunk} />
            )}
            <div className="wz-scene-tools">
              {use3d && turned && (
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setResetNonce((n) => n + 1)}>
                  Reset view
                </button>
              )}
              {full ? (
                <button ref={exitBtnRef} type="button" className="btn btn-secondary btn-sm" onClick={exitFull} title="Exit full screen (Esc)">
                  <Minimize2 size={14} aria-hidden /> Exit full screen
                </button>
              ) : (
                <button ref={fullBtnRef} type="button" className="btn btn-secondary btn-sm wz-icon-btn" onClick={enterFull} aria-label="Full screen" title="Full screen">
                  <Maximize2 size={14} aria-hidden />
                </button>
              )}
            </div>
            {full && (
              <div className="wz-full-caption">
                {lines.map((l, i) => (
                  <p key={i} className={i === 0 ? 'wz-caption-main' : 'wz-caption-sub'}>
                    {l}
                  </p>
                ))}
                <p className="wz-disclaimer">Visual activity is decorative. Task states come from Master Tasker.</p>
              </div>
            )}
            {stampText && <span className={cx('wz-stamp', motionOk && 'is-animated')}>{stampText}</span>}
          </div>
          {sceneFailed && (
            <p className="wz-note">
              3D unavailable ({sceneFailed}). Everything below still works.{' '}
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setSceneFailed(null);
                  setSceneKey((k) => k + 1);
                }}
              >
                Retry
              </button>
            </p>
          )}
          {glyphs.hidden.length > 0 && (
            <div className="wz-groups" aria-label="Tasks not drawn in the scene">
              {glyphs.hidden.map((g) => (
                <button key={g.kind} type="button" className="wz-group" onClick={() => setFilter(KIND_FILTER[g.kind])}>
                  <Glyph kind={g.kind} />+{g.count} {SPELL_LABELS[g.kind].toLowerCase()}
                </button>
              ))}
            </div>
          )}
          <div className="wz-caption">
            {lines.map((l, i) => (
              <p key={i} className={i === 0 ? 'wz-caption-main' : 'wz-caption-sub'}>
                {l}
              </p>
            ))}
          </div>
          <p className="wz-disclaimer">Visual activity is decorative. Task states come from Master Tasker.</p>
          {narrow && (
            <button type="button" className="btn btn-ghost btn-sm wz-shrink" aria-pressed={shrunk} onClick={() => setShrunk(!shrunk)}>
              {shrunk ? 'Show the full wizard' : 'Shrink the wizard'}
            </button>
          )}

          <div className="wz-knobs">
            <Knob id="wz-bluntness" label="Bluntness" value={prefs.bluntness} onChange={(v) => setPrefs({ bluntness: v })} low="Gentle" high="Terse" hint="Wording only. Same facts at every level." />
            <Knob id="wz-happiness" label="Happiness" value={prefs.happiness} onChange={(v) => setPrefs({ happiness: v })} low="Glum" high="Chipper" hint="Expression only. Warnings stay warnings." />
            <Knob id="wz-caffeine" label="Caffeine" value={prefs.caffeine} onChange={(v) => setPrefs({ caffeine: v })} low="Decaf" high="Jittery" hint="Animation only. Does not change speed, cost or concurrency." />
          </div>
          <details className="wz-settings">
            <summary>Stage settings</summary>
            <div className="wz-knobs">
              <Knob id="wz-verbosity" label="Verbosity" min={0} max={2} value={prefs.verbosity} onChange={(v) => setPrefs({ verbosity: v as 0 | 1 | 2 })} low="Brief" high="Detail" format={(v) => ['Brief', 'Standard', 'Detail'][v]} hint="How much the caption says. Full details stay in the ledger." />
              <Knob id="wz-clutter" label="Spell clutter" value={prefs.clutter} onChange={(v) => setPrefs({ clutter: v })} low="Tidy" high="Chaos" hint="Decorative sparkles only. Task markers always show." />
            </div>
            <div className="wz-setting-row">
              <label className="wz-check">
                <input type="checkbox" checked={followCursor} disabled={reduced} onChange={(e) => setPrefs({ followCursor: e.target.checked })} />
                Eyes follow the cursor
              </label>
              <label className="wz-select">
                Quality
                <select className="select select-compact" value={prefs.quality} onChange={(e) => (setPrefs({ quality: e.target.value as Quality }), setDowngraded(false))}>
                  <option value="auto">Auto{prefs.quality === 'auto' ? ` (${tier})` : ''}</option>
                  <option value="normal">Normal</option>
                  <option value="low">Low</option>
                  <option value="static">Static</option>
                </select>
              </label>
              <button type="button" className="btn btn-ghost btn-sm" onClick={resetPersonality}>
                Reset personality
              </button>
            </div>
            <p className="wz-hint">Saved on this device only. Changing these never touches your tasks or assistants.</p>
          </details>
        </section>

        <section className="wz-ledger" aria-labelledby="wz-ledger-title">
          <h2 id="wz-ledger-title" className="wz-ledger-title">
            Spell ledger
          </h2>
          <dl className="wz-counts">
            <Count label="In progress" n={counts.inProgress} kind="working" />
            <Count label="Needs you" n={counts.needsYou} kind="needsYou" />
            <Count label="Waiting" n={counts.waiting} kind="waiting" />
            <Count label="Today and Next" n={counts.queued} kind="queued" />
            <Count label="Inbox" n={counts.untriaged} kind="untriaged" />
          </dl>
          <p className="wz-hint">Needs you overlaps the others, so the counts don't add up to the total.</p>
          <div className="search wz-search">
            <Search size={15} aria-hidden className="search-icon" />
            <input className="search-input" type="search" placeholder="Search tasks" aria-label="Search tasks in the ledger" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="wz-filters" role="group" aria-label="Show">
            {FILTERS.map((f) => (
              <button key={f.id} type="button" aria-pressed={filter === f.id} className={cx('wz-filter', filter === f.id && 'is-on')} onClick={() => setFilter(f.id)}>
                {f.label}
              </button>
            ))}
          </div>
          <p className="wz-matching" aria-live="polite">
            {q || filter !== 'all' ? `${openRows.length} matching of ${openTotal} open tasks` : `${openTotal} open task${openTotal === 1 ? '' : 's'}`}
          </p>
          {openRows.length === 0 ? (
            <p className="wz-empty">{openTotal === 0 ? 'No open tasks in scope.' : 'Nothing matches.'}</p>
          ) : (
            <ul className="wz-rows">
              {openRows.map((s) => (
                <Row key={s.task.id} spell={s} selected={s.task.id === selectedId} onOpen={onOpen} now={now} areaName={s.task.areaId ? areaMap.get(s.task.areaId)?.name : undefined} />
              ))}
            </ul>
          )}
          <details className="wz-done" open={filter === 'done' || undefined}>
            <summary>
              Done <span className="mono">{doneRows.length}</span>
            </summary>
            <ul className="wz-rows">
              {doneRows.slice(0, doneShown).map((s) => (
                <Row key={s.task.id} spell={s} selected={s.task.id === selectedId} onOpen={onOpen} now={now} areaName={s.task.areaId ? areaMap.get(s.task.areaId)?.name : undefined} />
              ))}
            </ul>
            {doneRows.length > doneShown && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDoneShown((n) => n + 50)}>
                Show 50 more
              </button>
            )}
          </details>
        </section>
      </div>
      <div className="sr-only" aria-live="polite">
        {announce}
      </div>
    </div>
  );
}

/** How hard the 3D scene works. Reduced motion always means Static. */
function resolveTier(q: Quality, reduced: boolean, desktop: boolean, downgraded: boolean): SceneTier {
  if (q === 'static' || reduced) return 'static';
  if (q === 'low') return 'low';
  if (q === 'normal') return downgraded ? 'low' : 'normal';
  return desktop && !downgraded ? 'normal' : 'low';
}

function Row({ spell: s, selected, onOpen, now, areaName }: { spell: TaskSpell; selected: boolean; onOpen: (id: string) => void; now: number; areaName?: string }) {
  const t = s.task;
  const sub = subtaskLabel(s.subtasks);
  const lr = s.lastReported;
  return (
    <li>
      <button type="button" className={cx('wz-row', selected && 'is-selected', `kind-${s.kind}`)} data-task-id={t.id} aria-current={selected || undefined} onClick={() => onOpen(t.id)}>
        <Glyph kind={s.kind} />
        <span className="wz-row-body">
          <span className="wz-row-title">{t.title}</span>
          <span className="wz-row-meta">
            {t.status === 'doing' ? 'Marked In progress' : STATUS_LABELS[t.status]}
            {sub && ` · ${sub}`}
            {areaName && ` · ${areaName}`}
          </span>
          {s.needsYou.length > 0 && <span className="wz-row-you">Needs you: {s.needsYou[0]}{s.needsYou.length > 1 ? ` (+${s.needsYou.length - 1} more)` : ''}</span>}
          {t.status === 'waiting' && t.waitingOn && <span className="wz-row-detail">Waiting: {t.waitingOn}</span>}
          {s.kind !== 'done' && !s.subtasks.total && t.nextAction && <span className="wz-row-detail">Next: {t.nextAction}</span>}
          {lr && s.kind !== 'done' && (
            <span className="wz-row-detail">
              Last reported: {plain(lr.text).slice(0, 140)}
              {lr.at ? ` · ${relativeTime(lr.at, now)}` : ''}
              {lr.sharedWith ? ' · shared thread' : ''}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

/** Each state has its own shape as well as its own color. */
function Glyph({ kind }: { kind: SpellKind }) {
  return <span className={cx('wz-glyph', `glyph-${kind}`)} aria-hidden />;
}

function Count({ label, n, kind }: { label: string; n: number; kind: SpellKind }) {
  return (
    <div className="wz-count">
      <dt>
        <Glyph kind={kind} />
        {label}
      </dt>
      <dd className="mono">{n}</dd>
    </div>
  );
}

function Knob({ id, label, value, onChange, low, high, hint, min = 0, max = 100, format }: { id: string; label: string; value: number; onChange: (v: number) => void; low: string; high: string; hint: string; min?: number; max?: number; format?: (v: number) => string }) {
  return (
    <div className="wz-knob">
      <div className="wz-knob-top">
        <label htmlFor={id}>{label}</label>
        <output htmlFor={id} className="mono">
          {format ? format(value) : value}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        aria-describedby={`${id}-hint`}
        aria-valuetext={format ? format(value) : undefined}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ '--fill': `${((value - min) / (max - min)) * 100}%` } as CSSProperties}
      />
      <div className="wz-knob-ends" aria-hidden>
        <span>{low}</span>
        <span>{high}</span>
      </div>
      <p id={`${id}-hint`} className="wz-hint">
        {hint}
      </p>
    </div>
  );
}

/** Catches a 3D crash or a failed chunk load and falls back to the portrait. Never retries on its own. */
class SceneBoundary extends Component<{ children: ReactNode; onFail: (why: string) => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    this.props.onFail(err instanceof Error && /import|chunk|fetch/i.test(err.message) ? 'it did not load' : 'renderer error');
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

