import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REVIEW_MARKER } from '../automation/devscan.ts';
import { linkThreads, makeClient, asClient, startServer, ui, type TestServer } from './helpers.ts';

let s: TestServer;
beforeEach(async () => {
  s = await startServer({ seed: false });
  await linkThreads(s);
});
afterEach(async () => {
  await s.stop();
});

const claudeDir = () => path.join(s.dir, 'claude-projects');
const line = (o: Record<string, unknown>) => JSON.stringify(o) + '\n';
const msg = (sessionId: string, role: 'user' | 'assistant', content: unknown, cwd = '/Users/me/development/app') =>
  line({ type: role, sessionId, cwd, timestamp: new Date().toISOString(), uuid: Math.random().toString(36), message: { role, content } });
function thread(sessionId: string, body: string, folder = '-Users-me-development-app') {
  const dir = path.join(claudeDir(), folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${sessionId}.jsonl`), body);
}
const task = async (title: string) => (await ui(s, 'POST', '/api/tasks', { title })).body.task;
const threadsOf = async (id: string) => (await ui(s, 'GET', `/api/tasks/${id}/threads?refresh=1`)).body.threads;

describe('Claude threads', () => {
  it('links threads that mention a task, many to many, and keeps reading as threads grow', async () => {
    const a = await task('Ship the Android PR');
    const b = await task('Write release notes');
    thread('s-one', msg('s-one', 'user', `Working on Master Tasker task ${a.id}: Ship the Android PR`) + msg('s-one', 'assistant', [{ type: 'text', text: 'On it.' }]) + line({ type: 'custom-title', customTitle: 'Android PR', sessionId: 's-one' }));
    // Spaced JSON ("type": "user") is read too, not just the compact form Claude Code writes.
    thread('s-two', msg('s-two', 'user', `Also covers ${a.id} and ${b.id}`).replace('"type":', '"type": '));
    thread('s-none', msg('s-none', 'user', 'Unrelated work'));

    const ta = await threadsOf(a.id);
    expect(ta.map((t: any) => t.sessionId).sort()).toEqual(['s-one', 's-two']);
    const one = ta.find((t: any) => t.sessionId === 's-one');
    expect(one).toMatchObject({ title: 'Android PR', cwd: '/Users/me/development/app', mentions: 1, otherTasks: [] });
    expect(one.resumeCommand).toBe("cd '/Users/me/development/app' && claude --resume s-one");
    const two = ta.find((t: any) => t.sessionId === 's-two');
    expect(two.otherTasks.map((t: any) => t.id)).toEqual([b.id]);
    expect(two.title).toBe('Also covers “Ship the Android PR” and “Write release notes”');

    // New lines are picked up. A later thread mentioning b links to it too.
    expect((await threadsOf(b.id)).map((t: any) => t.sessionId)).toEqual(['s-two']);
    thread('s-one', msg('s-one', 'user', `Next, ${b.id}`));
    expect((await threadsOf(b.id)).map((t: any) => t.sessionId).sort()).toEqual(['s-one', 's-two']);
  });

  it('ignores tool output, unknown ids, half-written lines and the daily review', async () => {
    const a = await task('Real task');
    thread('s-tool', msg('s-tool', 'user', [{ type: 'tool_result', content: `listed ${a.id}` }]));
    thread('s-ghost', msg('s-ghost', 'user', 'see t_AAAAAAAAAAAAAA'));
    thread('s-review', msg('s-review', 'user', `${REVIEW_MARKER} daily review`) + msg('s-review', 'assistant', [{ type: 'text', text: `Suggested a change to ${a.id}` }]));
    // A line still being written (no newline yet) waits until it is complete.
    thread('s-partial', msg('s-partial', 'user', `About ${a.id}`).trimEnd());
    expect(await threadsOf(a.id)).toEqual([]);
    thread('s-partial', '\n');
    expect((await threadsOf(a.id)).map((t: any) => t.sessionId)).toEqual(['s-partial']);
  });

  it('links a thread that runs commands on a task, and applies its markers', async () => {
    const a = (await ui(s, 'POST', '/api/tasks', { title: 'Tidy nav', subtasks: ['Pin settings'] })).body.task;
    thread('s-cmd', msg('s-cmd', 'assistant', [{ type: 'tool_use', name: 'Bash', input: { command: `node ticket.ts get ${a.id}` } }]) + msg('s-cmd', 'assistant', [{ type: 'text', text: 'Done: Pin settings' }]));
    expect((await threadsOf(a.id)).map((t: any) => t.sessionId)).toEqual(['s-cmd']);
    expect((await ui(s, 'GET', `/api/tasks/${a.id}`)).body.task.subtasks[0].done).toBe(true);
  });

  it('unlinks a thread and keeps it unlinked, and is only for you', async () => {
    const a = await task('Unlink me');
    thread('s-x', msg('s-x', 'user', `Task ${a.id}`));
    expect(await threadsOf(a.id)).toHaveLength(1);
    expect((await ui(s, 'POST', `/api/tasks/${a.id}/threads/s-x/unlink`, {})).body.threads).toEqual([]);
    thread('s-x', msg('s-x', 'user', `Again ${a.id}`));
    expect(await threadsOf(a.id)).toEqual([]);
    expect((await ui(s, 'POST', `/api/tasks/${a.id}/threads/s-nope/unlink`, {})).status).toBe(404);

    const { token } = await makeClient(s, { perms: ['read'] });
    expect((await asClient(s, token, 'GET', `/api/tasks/${a.id}/threads`)).status).toBe(403);
  });
});

describe('In progress: current subtask and latest thinking', () => {
  it('highlights the subtask Claude says it is on and shows its latest decision, then its latest reply', async () => {
    const t = (await ui(s, 'POST', '/api/tasks', { title: 'Build thread links', status: 'doing', subtasks: ['Copy for Claude button', 'Show linked threads in the task'] })).body.task;
    const [first, second] = t.subtasks;
    thread('s-p', msg('s-p', 'user', `Master Tasker task ${t.id}`) + msg('s-p', 'assistant', [{ type: 'text', text: `**Now on:** copy for claude button\nDecision: copy plain text, not a link.` }]));
    let p = (await ui(s, 'GET', '/api/progress')).body.progress;
    expect(p).toEqual([expect.objectContaining({ taskId: t.id, subtaskId: first.id, note: 'copy plain text, not a link.', noteKind: 'decision' })]);

    await new Promise((r) => setTimeout(r, 5));
    thread('s-p', msg('s-p', 'assistant', [{ type: 'text', text: '- Now on: showing the linked threads in the task\nAdding the list under subtasks.' }]));
    await ui(s, 'GET', `/api/tasks/${t.id}/threads?refresh=1`);
    p = (await ui(s, 'GET', '/api/progress')).body.progress;
    expect(p[0]).toMatchObject({ subtaskId: second.id, noteKind: 'reply', note: '- Now on: showing the linked threads in the task Adding the list under subtasks.' });

    // Tasks that aren't in progress don't report.
    await ui(s, 'PATCH', `/api/tasks/${t.id}`, { baseRev: t.rev, patch: { status: 'today' } });
    expect((await ui(s, 'GET', '/api/progress')).body.progress).toEqual([]);
  });
});

describe('Needs you, and Claude ticking off its own subtasks', () => {
  it('ticks off what Claude finished, flags what needs you, and never ticks off something flagged for you', async () => {
    const t = (await ui(s, 'POST', '/api/tasks', { title: 'Wire the van', status: 'doing', subtasks: ['Sketch the fuse box', 'Pick the battery brand', 'Order the lugs'] })).body.task;
    const [sketch, battery, lugs] = t.subtasks;
    thread('s-m', msg('s-m', 'user', `Master Tasker task ${t.id}`) + msg('s-m', 'assistant', [{ type: 'text', text: 'Done: sketch the fuse box\nNeeds you: pick the battery brand\nDone: Pick the battery brand' }]));
    await ui(s, 'GET', `/api/tasks/${t.id}/threads?refresh=1`);
    let now = (await ui(s, 'GET', `/api/tasks/${t.id}`)).body.task;
    expect(now.subtasks.find((x: any) => x.id === sketch.id).done).toBe(true);
    expect(now.subtasks.find((x: any) => x.id === battery.id)).toMatchObject({ done: false, needsYou: true });
    const act = (await ui(s, 'GET', `/api/activity?entityId=${t.id}`)).body.activity;
    expect(act.some((a: any) => a.actor.label.startsWith('Claude (') && a.summary.includes('Checked off'))).toBe(true);

    // A task-level "Needs you" when it isn't a subtask.
    thread('s-m', msg('s-m', 'assistant', [{ type: 'text', text: 'Needs you: decide if the inverter goes under the bed' }]));
    await ui(s, 'GET', `/api/tasks/${t.id}/threads?refresh=1`);
    now = (await ui(s, 'GET', `/api/tasks/${t.id}`)).body.task;
    expect(now.needsYou).toBe('decide if the inverter goes under the bed');

    // Assistants can raise it but not clear it. You clear it by checking off or emptying it.
    const { token } = await makeClient(s, { perms: ['read', 'update'] });
    expect((await asClient(s, token, 'PATCH', `/api/tasks/${t.id}/subtasks/${battery.id}`, { done: true })).status).toBe(403);
    expect((await asClient(s, token, 'PATCH', `/api/tasks/${t.id}`, { baseRev: now.rev, patch: { needsYou: '' } })).status).toBe(403);
    expect((await asClient(s, token, 'PATCH', `/api/tasks/${t.id}/subtasks/${lugs.id}`, { needsYou: true })).body.task.subtasks[2].needsYou).toBe(true);
    const checked = (await ui(s, 'PATCH', `/api/tasks/${t.id}/subtasks/${battery.id}`, { done: true })).body.task;
    expect(checked.subtasks[1]).toMatchObject({ done: true, needsYou: false });
    expect((await ui(s, 'PATCH', `/api/tasks/${t.id}`, { baseRev: checked.rev, patch: { needsYou: '' } })).body.task.needsYou).toBe('');
  });

  it('does nothing while automation is paused', async () => {
    const t = (await ui(s, 'POST', '/api/tasks', { title: 'Paused work', status: 'doing', subtasks: ['Write the intro'] })).body.task;
    await ui(s, 'PATCH', '/api/settings', { automationPaused: true });
    thread('s-p2', msg('s-p2', 'user', `Task ${t.id}`) + msg('s-p2', 'assistant', [{ type: 'text', text: 'Done: write the intro' }]));
    await ui(s, 'GET', `/api/tasks/${t.id}/threads?refresh=1`);
    expect((await ui(s, 'GET', `/api/tasks/${t.id}`)).body.task.subtasks[0].done).toBe(false);
  });
});
