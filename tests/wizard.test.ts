import { describe, expect, it } from 'vitest';
import {
  caption,
  captionFacts,
  countSpells,
  filterLedger,
  freshness,
  moodOf,
  newlyCompleted,
  planGlyphs,
  subtaskLabel,
  toSpells,
} from '../web/src/wizard/derive.ts';
import { DEFAULT_PREFS, parsePrefs } from '../web/src/wizard/prefs.ts';
import type { Status, Task, TaskProgress } from '../shared/schema.ts';

let n = 0;
const sub = (title: string, done = false, needsYou = false) => ({ id: `s_${++n}`, title, done, needsYou, position: n });
const task = (patch: Partial<Task>): Task =>
  ({
    id: `t_${++n}`,
    title: `Task ${n}`,
    notes: '',
    areaId: null,
    projectId: null,
    status: 'next',
    priority: 'none',
    dueDate: null,
    nextAction: '',
    waitingOn: '',
    needsYou: '',
    youContext: {},
    links: [],
    subtasks: [],
    position: n,
    rev: 1,
    seq: n,
    isSample: false,
    createdAt: `2026-10-0${(n % 9) + 1}T00:00:00Z`,
    updatedAt: `2026-10-0${(n % 9) + 1}T00:00:00Z`,
    completedAt: null,
    deletedAt: null,
    createdBy: 'test',
    ...patch,
  }) as Task;
const none = new Map<string, TaskProgress>();
const NOW = Date.parse('2026-10-08T12:00:00Z');

/** 40 tickets across every status, some needing you, some sharing one Claude thread. */
function fixture() {
  const statuses: Status[] = ['inbox', 'doing', 'today', 'next', 'waiting', 'done'];
  const tasks = Array.from({ length: 40 }, (_, i) =>
    task({
      status: statuses[i % 6],
      needsYou: i % 7 === 0 && statuses[i % 6] !== 'done' ? 'Approve the copy' : '',
      waitingOn: statuses[i % 6] === 'waiting' ? 'Chris' : '',
      subtasks: i % 3 ? [sub('a', true), sub('b'), sub('c')] : [],
    }),
  );
  const doing = tasks.filter((t) => t.status === 'doing');
  const progress = new Map<string, TaskProgress>(
    doing.slice(0, 3).map((t) => [t.id, { taskId: t.id, subtaskId: t.subtasks[1]?.id ?? null, note: 'Picked the icon set', noteKind: 'decision', noteAt: '2026-10-08T11:00:00Z', activeAt: '2026-10-08T11:00:00Z', sessionId: 'shared', threadTitle: 'Icons' }]),
  );
  return { tasks, progress };
}

describe('wizard state', () => {
  it('keeps every ticket reachable and counts match the source', () => {
    const { tasks, progress } = fixture();
    const spells = toSpells(tasks, progress);
    expect(spells).toHaveLength(40);
    const c = countSpells(spells);
    expect(c.total).toBe(40);
    expect(c.inProgress).toBe(tasks.filter((t) => t.status === 'doing').length);
    expect(c.done).toBe(tasks.filter((t) => t.status === 'done').length);
    expect(c.needsYou).toBe(tasks.filter((t) => t.needsYou).length);
    // The scene draws at most 12 (6 on Low); the rest are counted, never lost.
    for (const cap of [12, 6]) {
      const g = planGlyphs(spells, cap, null);
      expect(g.shown.length).toBe(cap);
      expect(g.shown.length + g.hidden.reduce((a, h) => a + h.count, 0)).toBe(40 - c.done);
    }
    const ledger = (['needsYou', 'working', 'waiting', 'queued', 'untriaged', 'done'] as const).map((f) => filterLedger(spells, f));
    const reachable = new Set(ledger.flat().map((s) => s.task.id));
    expect(reachable.size).toBe(40);
  });

  it('puts the selected ticket in the scene even past the cap', () => {
    const { tasks } = fixture();
    const spells = toSpells(tasks, none);
    const queued = tasks.find((t) => t.status === 'next' && !t.needsYou)!;
    expect(planGlyphs(spells, 6, queued.id).shown[0].task.id).toBe(queued.id);
  });

  it('never shows a percentage, and says nothing about subtasks when there are none', () => {
    expect(subtaskLabel({ done: 3, total: 7 })).toBe('3 of 7 subtasks checked off');
    expect(subtaskLabel({ done: 0, total: 1 })).toBe('0 of 1 subtask checked off');
    expect(subtaskLabel({ done: 0, total: 0 })).toBeNull();
  });

  it('treats a shared thread as one source, not several workers', () => {
    const { tasks, progress } = fixture();
    const spells = toSpells(tasks, progress).filter((s) => s.lastReported);
    expect(spells).toHaveLength(3);
    for (const s of spells) expect(s.lastReported!.sharedWith).toBe(2);
  });

  it('never claims live execution from In progress alone', () => {
    const t = task({ status: 'doing', title: 'Ship nav' });
    const spells = toSpells([t], none);
    const lines = caption(captionFacts(spells, countSpells(spells), null), 55, 2, NOW).join(' ');
    expect(lines).toContain('Marked In progress');
    expect(lines).not.toMatch(/running|executing|planning|tool/i);
  });

  it('keeps the same facts at every bluntness', () => {
    const t = task({ status: 'doing', title: 'Ship nav', needsYou: 'Approve the icon set' });
    const spells = toSpells([t], none);
    const f = captionFacts(spells, countSpells(spells), null);
    for (const b of [0, 33, 34, 55, 66, 67, 100]) {
      const text = caption(f, b, 0, NOW).join(' ');
      expect(text).toContain('Ship nav');
      expect(text).toContain('Approve the icon set');
      expect(text.toLowerCase()).toContain('you');
      expect(caption(f, b, 2, NOW).length).toBeLessThanOrEqual(3);
      expect(caption(f, b, 0, NOW)).toHaveLength(1);
    }
  });

  it('captions the oldest thing that needs you, and the selection when there is one', () => {
    const old = task({ status: 'next', needsYou: 'Old ask', updatedAt: '2026-09-01T00:00:00Z' });
    const fresh = task({ status: 'doing', needsYou: 'New ask', updatedAt: '2026-10-08T00:00:00Z' });
    const other = task({ status: 'today', title: 'Picked' });
    const spells = toSpells([fresh, old, other], none);
    const c = countSpells(spells);
    expect(captionFacts(spells, c, null).detail).toBe('Old ask');
    expect(captionFacts(spells, c, other.id).title).toBe('Picked');
    expect(moodOf(c)).toBe('attention');
  });

  it('says plainly when nothing is In progress', () => {
    const spells = toSpells([task({ status: 'next' })], none);
    const c = countSpells(spells);
    expect(moodOf(c)).toBe('idle');
    expect(caption(captionFacts(spells, c, null), 55, 1, NOW)[0]).toBe('No tasks marked In progress.');
  });
});

describe('wizard transitions', () => {
  const m = (e: [string, Status][]) => new Map(e);
  it('celebrates a confirmed completion once', () => {
    const before = m([['a', 'doing'], ['b', 'next']]);
    const after = m([['a', 'done'], ['b', 'next']]);
    expect(newlyCompleted(before, after, false)).toEqual(['a']);
    expect(newlyCompleted(after, after, false)).toEqual([]);
  });
  it('stays quiet on first load and on a reconnect replay', () => {
    const after = m([['a', 'done']]);
    expect(newlyCompleted(null, after, false)).toEqual([]);
    expect(newlyCompleted(m([['a', 'doing']]), after, true)).toEqual([]);
  });
  it('ignores a reopen, a deletion and a ticket that was never seen', () => {
    expect(newlyCompleted(m([['a', 'done']]), m([['a', 'doing']]), false)).toEqual([]);
    expect(newlyCompleted(m([['a', 'doing']]), m([]), false)).toEqual([]);
    expect(newlyCompleted(m([]), m([['new', 'done']]), false)).toEqual([]);
  });
  it('an optimistic tick that rolls back never reaches confirmed state', () => {
    // Confirmed status stays 'doing' while the optimistic change is pending and after it fails.
    const confirmed = m([['a', 'doing']]);
    expect(newlyCompleted(confirmed, confirmed, false)).toEqual([]);
  });
});

describe('wizard freshness', () => {
  it('reports the last known state when the connection drops', () => {
    expect(freshness('reconnecting', { lastOkAt: NOW, failures: 0 }, true, 20_000, NOW)).toMatchObject({ live: false, label: 'Last known state' });
  });
  it('flags progress after two missed polls, and only while polling', () => {
    expect(freshness('live', { lastOkAt: NOW - 46_000, failures: 0 }, true, 20_000, NOW).progressUnavailable).toBe(true);
    expect(freshness('live', { lastOkAt: NOW - 30_000, failures: 1 }, true, 20_000, NOW).progressUnavailable).toBe(false);
    expect(freshness('live', { lastOkAt: NOW, failures: 2 }, true, 20_000, NOW).label).toBe('Progress updates unavailable');
    expect(freshness('live', { lastOkAt: NOW - 600_000, failures: 0 }, false, 20_000, NOW).label).toBeNull();
  });
});

describe('wizard prefs', () => {
  it('defaults match the plan', () => {
    expect(DEFAULT_PREFS).toMatchObject({ bluntness: 55, happiness: 60, caffeine: 35, verbosity: 1, clutter: 40 });
  });
  it('recovers from corrupt or out-of-range records', () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('garbage')).toEqual(DEFAULT_PREFS);
    expect(parsePrefs({ bluntness: 900, happiness: -4, caffeine: 'lots', verbosity: 7, quality: 'ultra', paused: 'yes' })).toMatchObject({
      bluntness: 100,
      happiness: 0,
      caffeine: 35,
      verbosity: 2,
      quality: 'auto',
      paused: false,
    });
  });
});
