import { describe, expect, it } from 'vitest';
import { claudeIsOn, idleStep } from '../web/src/lib.ts';
import type { Task } from '../shared/schema.ts';

const sub = (id: string, title: string, done = false, needsYou = false) => ({ id, title, done, needsYou, position: 0 });
const task = (patch: Partial<Task>) => ({ status: 'doing', deletedAt: null, nextAction: '', subtasks: [], ...patch }) as unknown as Task;

describe('idle step', () => {
  it('finds the next step for Claude when no Claude thread is on an In progress task', () => {
    const t = task({ subtasks: [sub('a', 'Send the zips', true), sub('b', "Wait for Chris's notes"), sub('c', 'Try impeccable')] });
    expect(idleStep(t, false)).toEqual({ id: 'c', title: 'Try impeccable' });
    expect(idleStep(t, true)).toBeNull();
    expect(idleStep({ ...t, status: 'next' }, false)).toBeNull();
  });
  it('skips waits and flagged steps, and falls back to the next action', () => {
    expect(idleStep(task({ subtasks: [sub('b', 'Waiting on Jonas')] }), false)).toBeNull();
    expect(idleStep(task({ subtasks: [sub('b', 'Pick icons', false, true)] }), false)).toBeNull();
    expect(idleStep(task({ nextAction: 'Call the shop' }), false)).toEqual({ id: null, title: 'Call the shop' });
  });
  it('counts Claude as on it only while a linked thread is running', () => {
    const now = Date.parse('2026-10-07T12:00:00Z');
    expect(claudeIsOn({ activeAt: '2026-10-07T11:58:00Z', noteAt: '2026-10-07T01:00:00Z' } as never, now)).toBe(true);
    // Replied an hour ago and has been waiting since: stopped.
    expect(claudeIsOn({ activeAt: '2026-10-07T11:00:00Z', noteAt: '2026-10-07T11:00:00Z' } as never, now)).toBe(false);
    expect(claudeIsOn(undefined, now)).toBe(false);
  });
});
