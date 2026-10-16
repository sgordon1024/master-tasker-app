import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Task } from '../shared/schema.ts';
import { areaId, asClient, listenEvents, makeClient, startServer, ui, type TestServer } from './helpers.ts';

let s: TestServer;
beforeEach(async () => {
  s = await startServer();
});
afterEach(async () => {
  await s.stop();
});

const create = (body: Record<string, unknown>, headers?: Record<string, string>) => ui(s, 'POST', '/api/tasks', body, headers);

describe('task editing', () => {
  it('starts with clearly labeled sample data in the six areas', async () => {
    const sync = await ui(s, 'GET', '/api/sync');
    expect(sync.body.areas.map((a: { name: string }) => a.name)).toEqual(['Clients', 'Side projects', 'Pets', 'Home', 'Hobbies', 'Personal']);
    const tasks: Task[] = sync.body.tasks;
    expect(tasks).toHaveLength(6);
    for (const t of tasks) {
      expect(t.isSample).toBe(true);
      // The Sample chip marks them. Titles read like real tasks, with no keyboard instructions.
      expect(t.title).not.toMatch(/^Sample|press|drag/i);
    }
    // One idea each: overdue, needs you, in progress with a step done, waiting, Claude finished, a Focus candidate.
    const today = new Date().toLocaleDateString('en-CA');
    expect(tasks.some((t) => t.dueDate && t.dueDate < today && t.status !== 'done')).toBe(true);
    expect(tasks.find((t) => t.needsYou)?.youContext.task?.detail).toBeTruthy();
    const doing = tasks.find((t) => t.status === 'doing')!;
    expect(doing.subtasks.map((x) => x.done)).toEqual([true, false, false]);
    expect(tasks.find((t) => t.status === 'waiting')?.waitingOn).toBeTruthy();
    expect(tasks.find((t) => t.status === 'done')?.finishedBy?.by).toBe('Your assistant');
    expect(tasks.some((t) => /focus/i.test(t.nextAction))).toBe(true);
  });

  it('clears the samples in one go and says which, so it can be undone', async () => {
    const r = await ui(s, 'POST', '/api/samples/clear', {});
    expect(r.body.tasks).toBe(6);
    expect(r.body.ids).toHaveLength(6);
    const restored = await ui(s, 'POST', `/api/tasks/${r.body.ids[0]}/restore`, {});
    expect(restored.body.task.deletedAt).toBeNull();
  });

  it('accepts a caller-chosen task id, so optimistic rows and live events match', async () => {
    const id = 't_ClientChosen01';
    const c = await create({ id, title: 'Chosen id' }, { 'Idempotency-Key': 'chosen-1' });
    expect(c.status).toBe(201);
    expect(c.body.task.id).toBe(id);
    const retry = await create({ id, title: 'Chosen id' }, { 'Idempotency-Key': 'chosen-1' });
    expect(retry.body.task.id).toBe(id);
    expect((await create({ id, title: 'Someone else' })).status).toBe(409);
    expect((await create({ id: 'not-an-id', title: 'Bad' })).status).toBe(422);
  });

  it('creates and edits every task field', async () => {
    const work = await areaId(s, 'Clients');
    const c = await create({ title: '  Write the plan  ', areaId: work, status: 'next', priority: 'high', dueDate: '2030-01-15', nextAction: 'Open doc', waitingOn: '', links: [{ url: 'https://example.com', label: 'Doc' }], subtasks: ['One', 'Two'] });
    expect(c.status).toBe(201);
    const t = c.body.task;
    expect(t.title).toBe('Write the plan');
    expect(t.subtasks.map((x: { title: string }) => x.title)).toEqual(['One', 'Two']);
    expect(t.rev).toBe(1);

    const u = await ui(s, 'PATCH', `/api/tasks/${t.id}`, { baseRev: 1, patch: { notes: 'Some notes', status: 'waiting', waitingOn: 'Sam', dueDate: null } });
    expect(u.status).toBe(200);
    expect(u.body.task).toMatchObject({ notes: 'Some notes', status: 'waiting', waitingOn: 'Sam', dueDate: null, rev: 2 });

    const sub = await ui(s, 'PATCH', `/api/tasks/${t.id}/subtasks/${t.subtasks[0].id}`, { done: true });
    expect(sub.body.task.subtasks[0].done).toBe(true);

    const done = await ui(s, 'POST', `/api/tasks/${t.id}/complete`, {});
    expect(done.body.task.status).toBe('done');
    expect(done.body.task.completedAt).toBeTruthy();
    const reopened = await ui(s, 'POST', `/api/tasks/${t.id}/reopen`, {});
    expect(reopened.body.task.status).toBe('waiting'); // back to where it was
  });

  it('rejects invalid input with the shared validation rules', async () => {
    expect((await create({ title: '' })).status).toBe(422);
    expect((await create({ title: 'x', dueDate: '2026-02-30' })).status).toBe(422);
    expect((await create({ title: 'x', status: 'someday' })).status).toBe(422);
    expect((await create({ title: 'x', links: [{ url: 'javascript:alert(1)' }] })).status).toBe(422);
    expect((await create({ title: 'x', bogus: true })).status).toBe(422);
    expect((await create({ title: 'x'.repeat(501) })).status).toBe(422);
  });

  it('keeps project and area consistent', async () => {
    const areas = (await ui(s, 'GET', '/api/areas')).body;
    const project = areas.projects[0];
    const otherArea = areas.areas.find((a: { id: string }) => a.id !== project.areaId).id;
    const c = await create({ title: 'p', projectId: project.id });
    expect(c.body.task.areaId).toBe(project.areaId);
    expect((await create({ title: 'p', projectId: project.id, areaId: otherArea })).status).toBe(422);
    // Moving to another area drops a project that no longer fits.
    const moved = await ui(s, 'PATCH', `/api/tasks/${c.body.task.id}`, { baseRev: 1, patch: { areaId: otherArea } });
    expect(moved.body.task).toMatchObject({ areaId: otherArea, projectId: null });
  });

  it('puts each area on the work or personal side, and lets you change it', async () => {
    const areas = (await ui(s, 'GET', '/api/areas')).body.areas;
    expect(Object.fromEntries(areas.map((a: { name: string; mode: string }) => [a.name, a.mode]))).toEqual({
      Clients: 'personal', 'Side projects': 'personal', Pets: 'personal', Home: 'personal', 'Hobbies': 'personal', Personal: 'personal',
    });
    const pets = areas.find((a: { name: string }) => a.name === 'Pets');
    expect((await ui(s, 'PATCH', `/api/areas/${pets.id}`, { mode: 'work' })).body.area.mode).toBe('work');
    expect((await ui(s, 'PATCH', `/api/areas/${pets.id}`, { mode: 'office' })).status).toBe(422);
    expect((await ui(s, 'POST', '/api/areas', { name: 'Client X', mode: 'work' })).body.area.mode).toBe('work');
    expect((await ui(s, 'POST', '/api/areas', { name: 'Garden' })).body.area.mode).toBe('personal');
  });

  it('soft-deletes into Trash and restores', async () => {
    const t = (await create({ title: 'Trash me' })).body.task;
    await ui(s, 'DELETE', `/api/tasks/${t.id}`);
    expect((await ui(s, 'GET', `/api/tasks/${t.id}`)).status).toBe(404);
    expect((await ui(s, 'GET', '/api/trash')).body.tasks.some((x: { id: string }) => x.id === t.id)).toBe(true);
    const r = await ui(s, 'POST', `/api/tasks/${t.id}/restore`, {});
    expect(r.body.task.deletedAt).toBeNull();
  });
});

describe('simultaneous updates', () => {
  const otherTab = { 'x-session-id': 'session-ui-test-2' };

  it('merges edits to different fields from two places', async () => {
    const t = (await create({ title: 'Shared' })).body.task;
    const a = await ui(s, 'PATCH', `/api/tasks/${t.id}`, { baseRev: 1, patch: { title: 'Shared, renamed' } });
    expect(a.status).toBe(200);
    const b = await ui(s, 'PATCH', `/api/tasks/${t.id}`, { baseRev: 1, patch: { priority: 'high' } }, otherTab);
    expect(b.status).toBe(200);
    expect(b.body.task).toMatchObject({ title: 'Shared, renamed', priority: 'high', rev: 3 });
  });

  it('refuses to silently overwrite the same field and returns the current copy', async () => {
    const t = (await create({ title: 'Original' })).body.task;
    await ui(s, 'PATCH', `/api/tasks/${t.id}`, { baseRev: 1, patch: { notes: 'from tab one' } });
    const b = await ui(s, 'PATCH', `/api/tasks/${t.id}`, { baseRev: 1, patch: { notes: 'from tab two' } }, otherTab);
    expect(b.status).toBe(409);
    expect(b.body.error.code).toBe('conflict');
    expect(b.body.error.fields).toEqual(['notes']);
    expect(b.body.error.current.notes).toBe('from tab one');
    // Nothing was lost: tab one's note is intact, tab two can retry knowingly.
    const retry = await ui(s, 'PATCH', `/api/tasks/${t.id}`, { baseRev: b.body.error.current.rev, patch: { notes: 'from tab one\n\nfrom tab two' } }, otherTab);
    expect(retry.status).toBe(200);
    expect(retry.body.task.notes).toBe('from tab one\n\nfrom tab two');
  });

  it('does not treat your own back-to-back edits from one tab as a conflict', async () => {
    const t = (await create({ title: 'Typing' })).body.task;
    expect((await ui(s, 'PATCH', `/api/tasks/${t.id}`, { baseRev: 1, patch: { title: 'Typing a' } })).status).toBe(200);
    expect((await ui(s, 'PATCH', `/api/tasks/${t.id}`, { baseRev: 1, patch: { title: 'Typing ab' } })).status).toBe(200);
  });

  it('flags an assistant note added while you were editing notes', async () => {
    const { token } = await makeClient(s);
    const t = (await create({ title: 'Notes race', notes: 'v1' })).body.task;
    await asClient(s, token, 'POST', `/api/tasks/${t.id}/notes`, { text: 'Assistant context' });
    const mine = await ui(s, 'PATCH', `/api/tasks/${t.id}`, { baseRev: 1, patch: { notes: 'v1 edited' } });
    expect(mine.status).toBe(409);
    expect(mine.body.error.current.notes).toContain('Assistant context');
  });

  it('handles a burst of concurrent writers without losing any', async () => {
    const t = (await create({ title: 'Burst' })).body.task;
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => ui(s, 'POST', `/api/tasks/${t.id}/subtasks`, { title: `Sub ${i}` }, { 'x-session-id': `session-burst-${i}` })),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    const final = (await ui(s, 'GET', `/api/tasks/${t.id}`)).body.task;
    expect(final.subtasks).toHaveLength(20);
    expect(final.rev).toBe(21);
  });
});

describe('duplicates and retries', () => {
  it('replays the original response for a retried request with the same idempotency key', async () => {
    const key = crypto.randomUUID();
    const [a, b] = await Promise.all([create({ title: 'Once' }, { 'idempotency-key': key }), create({ title: 'Once' }, { 'idempotency-key': key })]);
    expect(a.body.task.id).toBe(b.body.task.id);
    const c = await create({ title: 'Once' }, { 'idempotency-key': key });
    expect(c.body.task.id).toBe(a.body.task.id);
    expect(c.headers.get('idempotent-replay')).toBe('true');
    const all = (await ui(s, 'GET', '/api/tasks?q=Once&limit=50')).body.tasks;
    expect(all).toHaveLength(1);
  });

  it('refuses to reuse a key for a different request', async () => {
    const key = crypto.randomUUID();
    await create({ title: 'First' }, { 'idempotency-key': key });
    const r = await create({ title: 'Different' }, { 'idempotency-key': key });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('idempotency_mismatch');
  });

  it('scopes idempotency keys per caller', async () => {
    const { token } = await makeClient(s);
    const key = crypto.randomUUID();
    const a = await create({ title: 'Mine' }, { 'idempotency-key': key });
    const b = await asClient(s, token, 'POST', '/api/tasks', { title: 'Theirs', areaId: await areaId(s, 'Clients') }, { 'idempotency-key': key });
    expect(b.body.task.id).not.toBe(a.body.task.id);
  });

  it('guards against an assistant creating the same task twice without a key', async () => {
    const { token } = await makeClient(s);
    const work = await areaId(s, 'Clients');
    const a = await asClient(s, token, 'POST', '/api/tasks', { title: 'Call the bank', areaId: work });
    const b = await asClient(s, token, 'POST', '/api/tasks', { title: 'call the bank', areaId: work });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.deduplicated).toBe(true);
    expect(b.body.task.id).toBe(a.body.task.id);
  });
});

describe('identity and scoped access', () => {
  it('records who made each change from the token, not from a claimed name', async () => {
    const { token } = await makeClient(s, { name: 'desktop', kind: 'other' });
    const work = await areaId(s, 'Clients');
    const t = await asClient(s, token, 'POST', '/api/tasks', { title: 'From a helper', areaId: work }, { 'x-actor-name': 'Claude' });
    const act = (await ui(s, 'GET', `/api/activity?entityId=${t.body.task.id}`)).body.activity[0];
    expect(act.actor.label).toBe('desktop');
    expect(act.actor.kind).toBe('client');
    expect(act.actor.claimedName).toBe('Claude');
  });

  it('limits a connection to its areas', async () => {
    const work = await areaId(s, 'Clients');
    const pets = await areaId(s, 'Pets');
    const { token } = await makeClient(s, { areas: [work], unfiled: false });
    const list = await asClient(s, token, 'GET', '/api/tasks?includeDone=true&limit=50');
    expect(list.body.tasks.length).toBeGreaterThan(0);
    expect(list.body.tasks.every((t: { areaId: string }) => t.areaId === work)).toBe(true);
    const petsTask = (await create({ title: 'Pets only', areaId: pets })).body.task;
    expect((await asClient(s, token, 'GET', `/api/tasks/${petsTask.id}`)).status).toBe(404);
    expect((await asClient(s, token, 'PATCH', `/api/tasks/${petsTask.id}`, { baseRev: 1, patch: { title: 'x' } })).status).toBe(404);
    expect((await asClient(s, token, 'POST', '/api/tasks', { title: 'sneak', areaId: pets })).status).toBe(403);
    const mine = await asClient(s, token, 'POST', '/api/tasks', { title: 'Defaults to my one area' });
    expect(mine.body.task.areaId).toBe(work);
    // Cannot move a task out of its allowed area.
    expect((await asClient(s, token, 'PATCH', `/api/tasks/${mine.body.task.id}`, { baseRev: 1, patch: { areaId: pets } })).status).toBe(403);
    const areas = (await asClient(s, token, 'GET', '/api/areas')).body.areas;
    expect(areas.map((a: { id: string }) => a.id)).toEqual([work]);
  });

  it('enforces permissions', async () => {
    const { token } = await makeClient(s, { perms: ['read', 'propose'] });
    const work = await areaId(s, 'Clients');
    expect((await asClient(s, token, 'POST', '/api/tasks', { title: 'nope', areaId: work })).status).toBe(403);
    const t = (await create({ title: 'protected', areaId: work })).body.task;
    expect((await asClient(s, token, 'POST', `/api/tasks/${t.id}/complete`, {})).status).toBe(403);
  });

  it('lets a "start" connection move tasks into In progress and nothing else', async () => {
    const work = await areaId(s, 'Clients');
    const t = (await create({ title: 'Active work', areaId: work, status: 'next' })).body.task;
    const { token: readOnly } = await makeClient(s, { perms: ['read', 'propose'] });
    expect((await asClient(s, readOnly, 'POST', `/api/tasks/${t.id}/start`, {})).status).toBe(403);

    const { token } = await makeClient(s, { perms: ['read', 'propose', 'start'] });
    const r = await asClient(s, token, 'POST', `/api/tasks/${t.id}/start`, {});
    expect(r.status).toBe(200);
    expect(r.body.task.status).toBe('doing');
    // Starting again is a no-op, and the same token still can't edit or complete.
    expect((await asClient(s, token, 'POST', `/api/tasks/${t.id}/start`, {})).body.task.rev).toBe(r.body.task.rev);
    expect((await asClient(s, token, 'PATCH', `/api/tasks/${t.id}`, { baseRev: r.body.task.rev, patch: { status: 'today' } })).status).toBe(403);
    expect((await asClient(s, token, 'POST', `/api/tasks/${t.id}/complete`, {})).status).toBe(403);

    const done = (await create({ title: 'Finished', areaId: work, status: 'done' })).body.task;
    expect((await asClient(s, token, 'POST', `/api/tasks/${done.id}/start`, {})).status).toBe(409);
    expect((await ui(s, 'GET', '/api/tasks?status=doing')).body.tasks.filter((x: Task) => !x.isSample).map((x: Task) => x.id)).toEqual([t.id]);
  });

  it('keeps app-only actions away from tokens', async () => {
    const { token } = await makeClient(s);
    expect((await asClient(s, token, 'GET', '/api/clients')).status).toBe(403);
    expect((await asClient(s, token, 'POST', '/api/clients', {})).status).toBe(403);
    expect((await asClient(s, token, 'GET', '/api/export')).status).toBe(403);
    expect((await asClient(s, token, 'POST', '/api/backups', {})).status).toBe(403);
    const t = (await create({ title: 'no delete', areaId: await areaId(s, 'Clients') })).body.task;
    expect((await asClient(s, token, 'DELETE', `/api/tasks/${t.id}`)).status).toBe(403);
  });

  it('rejects bad tokens, revoked tokens, foreign hosts and header-less writes', async () => {
    const { token, id } = await makeClient(s);
    expect((await asClient(s, 'mt_' + 'x'.repeat(32), 'GET', '/api/tasks')).status).toBe(401);
    await ui(s, 'POST', `/api/clients/${id}/revoke`, {});
    expect((await asClient(s, token, 'GET', '/api/tasks')).status).toBe(401);
    const noHeader = await fetch(`${s.base}/api/tasks`, { method: 'POST', body: JSON.stringify({ title: 'csrf' }), headers: { 'content-type': 'application/json' } });
    expect(noHeader.status).toBe(401);
    const crossSite = await fetch(`${s.base}/api/sync`, { headers: { 'sec-fetch-site': 'cross-site' } });
    expect(crossSite.status).toBe(403);
    const badOrigin = await fetch(`${s.base}/api/tasks`, { method: 'POST', body: '{"title":"x"}', headers: { origin: 'http://evil.example', 'x-master-tasker': 'web' } });
    expect(badOrigin.status).toBe(403);
    const rebinding = await new Promise<number>((resolve) => {
      import('node:http').then(({ default: http }) => {
        http.get({ host: '127.0.0.1', port: s.port, path: '/api/sync', headers: { host: 'evil.example:80' } }, (r) => resolve(r.statusCode ?? 0));
      });
    });
    expect(rebinding).toBe(421);
  });
});

describe('automation controls', () => {
  it('pauses all automation, then a single connection', async () => {
    const { token, id } = await makeClient(s);
    const work = await areaId(s, 'Clients');
    await ui(s, 'PATCH', '/api/settings', { automationPaused: true });
    const r = await asClient(s, token, 'POST', '/api/tasks', { title: 'paused', areaId: work });
    expect(r.status).toBe(423);
    expect((await asClient(s, token, 'GET', '/api/tasks')).status).toBe(200); // reads still work
    expect((await create({ title: 'you are never paused' })).status).toBe(201);
    await ui(s, 'PATCH', '/api/settings', { automationPaused: false });
    await ui(s, 'PATCH', `/api/clients/${id}`, { paused: true });
    expect((await asClient(s, token, 'POST', '/api/tasks', { title: 'paused', areaId: work })).status).toBe(423);
  });

  it('logs what changed about an assistant in plain words, and refuses changes once its access is removed', async () => {
    const { id } = await makeClient(s, { name: 'Cursor', kind: 'other' });
    await ui(s, 'PATCH', `/api/clients/${id}`, { paused: true });
    await ui(s, 'PATCH', `/api/clients/${id}`, { paused: false });
    await ui(s, 'PATCH', `/api/clients/${id}`, { scopes: { areas: '*', unfiled: true, perms: ['read'] } });
    await ui(s, 'POST', `/api/clients/${id}/revoke`, {});
    const log = (await ui(s, 'GET', `/api/activity?entityId=${id}`)).body.activity.map((e: { summary: string }) => e.summary);
    expect(log).toEqual(['Removed access for “Cursor”', 'Changed what “Cursor” can do', 'Resumed “Cursor”', 'Paused “Cursor”', 'Gave “Cursor” access']);
    const r = await ui(s, 'PATCH', `/api/clients/${id}`, { paused: true });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toBe("This app's access was removed. Connect it again instead.");
  });

  it('enforces daily usage limits', async () => {
    const { token } = await makeClient(s, { limits: { writesPerDay: 2, proposalsPerDay: 1 } });
    const work = await areaId(s, 'Clients');
    expect((await asClient(s, token, 'POST', '/api/tasks', { title: 'a', areaId: work })).status).toBe(201);
    expect((await asClient(s, token, 'POST', '/api/tasks', { title: 'b', areaId: work })).status).toBe(201);
    const third = await asClient(s, token, 'POST', '/api/tasks', { title: 'c', areaId: work });
    expect(third.status).toBe(429);
    expect((await asClient(s, token, 'POST', '/api/proposals', { proposal: { kind: 'create', task: { title: 'p1', areaId: work } } })).status).toBe(201);
    expect((await asClient(s, token, 'POST', '/api/proposals', { proposal: { kind: 'create', task: { title: 'p2', areaId: work } } })).status).toBe(429);
  });
});

describe('review queue', () => {
  it('deduplicates repeated suggestions and applies only what you accept', async () => {
    const { token } = await makeClient(s, { kind: 'other', perms: ['read', 'propose'] });
    const work = await areaId(s, 'Clients');
    const body = { proposal: { kind: 'create', task: { title: 'Reply to vendor', areaId: work } }, dedupeKey: 'gmail:thread/abc', reason: 'Unanswered thread', confidence: 0.6 };
    const a = await asClient(s, token, 'POST', '/api/proposals', body);
    const b = await asClient(s, token, 'POST', '/api/proposals', body);
    expect(b.body.deduplicated).toBe(true);
    expect(b.body.proposal.id).toBe(a.body.proposal.id);
    expect(b.body.proposal.seenCount).toBe(2);
    const pending = (await ui(s, 'GET', '/api/proposals')).body.proposals;
    expect(pending).toHaveLength(1);
    // Nothing applied yet.
    expect((await ui(s, 'GET', '/api/tasks?q=Reply%20to%20vendor')).body.tasks).toHaveLength(0);

    const accepted = await ui(s, 'POST', `/api/proposals/${a.body.proposal.id}/accept`, {});
    expect(accepted.body.task.title).toBe('Reply to vendor');
    expect(accepted.body.task.createdBy).toBe('You via test client');
    // Same source item arriving again does not create a second task.
    const again = await asClient(s, token, 'POST', '/api/proposals', body);
    expect(again.body.deduplicated).toBe(true);
    expect((await ui(s, 'GET', '/api/tasks?q=Reply%20to%20vendor')).body.tasks).toHaveLength(1);
  });

  it('asks questions instead of guessing, and returns your answer only to the asker', async () => {
    const work = await areaId(s, 'Clients');
    const pets = await areaId(s, 'Pets');
    const { token } = await makeClient(s, { areas: [work], unfiled: false, perms: ['read', 'propose'] });
    const t = (await create({ title: 'Explainer video', areaId: work })).body.task;
    const body = { proposal: { kind: 'question', taskId: t.id, question: 'Is this still yours?', choices: ['Still mine', 'Jonas has it'] }, dedupeKey: 'slack:p123', reason: 'Jonas said he is making them' };
    const q1 = await asClient(s, token, 'POST', '/api/proposals', body);
    expect(q1.status).toBe(201);
    expect((await asClient(s, token, 'POST', '/api/proposals', body)).body.deduplicated).toBe(true);
    // Scope still applies to questions.
    const outside = await asClient(s, token, 'POST', '/api/proposals', { proposal: { kind: 'question', areaId: pets, question: 'Pets thing?' }, reason: 'x' });
    expect(outside.status).toBe(403);
    // Questions are answered, not accepted, and only you can answer.
    expect((await ui(s, 'POST', `/api/proposals/${q1.body.proposal.id}/accept`, {})).status).toBe(400);
    expect((await asClient(s, token, 'POST', `/api/proposals/${q1.body.proposal.id}/answer`, { answer: 'Mine' })).status).toBe(403);
    const ans = await ui(s, 'POST', `/api/proposals/${q1.body.proposal.id}/answer`, { answer: 'Jonas has it' });
    expect(ans.body.proposal).toMatchObject({ status: 'accepted', answer: 'Jonas has it' });
    // Answering changes no task.
    expect((await ui(s, 'GET', `/api/tasks/${t.id}`)).body.task.rev).toBe(t.rev);
    const mine = (await asClient(s, token, 'GET', '/api/proposals?status=accepted')).body.proposals;
    expect(mine[0].answer).toBe('Jonas has it');
    // Asking the same thing again is suppressed, so it never nags.
    expect((await asClient(s, token, 'POST', '/api/proposals', body)).body.suppressed).toBe(true);
  });

  it('remembers rejections so the same suggestion does not come back', async () => {
    const { token } = await makeClient(s, { perms: ['read', 'propose'] });
    const t = (await create({ title: 'Keep open', areaId: await areaId(s, 'Clients') })).body.task;
    const body = { proposal: { kind: 'complete', taskId: t.id }, dedupeKey: 'calendar:event/1', reason: 'No longer on the calendar' };
    const p = await asClient(s, token, 'POST', '/api/proposals', body);
    await ui(s, 'POST', `/api/proposals/${p.body.proposal.id}/reject`, {});
    const again = await asClient(s, token, 'POST', '/api/proposals', body);
    expect(again.body.suppressed).toBe(true);
    expect((await ui(s, 'GET', '/api/proposals')).body.proposals).toHaveLength(0);
    expect((await ui(s, 'GET', `/api/tasks/${t.id}`)).body.task.status).not.toBe('done');
  });
});

describe('live updates', () => {
  it('pushes changes from a connection to the UI stream immediately', async () => {
    const live = listenEvents(s);
    await live.opened;
    const { token } = await makeClient(s);
    const created = await asClient(s, token, 'POST', '/api/tasks', { title: 'Live from assistant', areaId: await areaId(s, 'Clients') });
    const ev = await live.waitFor((e) => e.type === 'task' && e.task.id === created.body.task.id);
    expect(ev.task.title).toBe('Live from assistant');
    live.close();
  });

  it('reconciles after a dropped connection using the change counter', async () => {
    const before = (await ui(s, 'GET', '/api/sync')).body.seq;
    // Changes made while "disconnected".
    const t = (await create({ title: 'Made while offline' })).body.task;
    await ui(s, 'DELETE', `/api/tasks/${t.id}`);
    const delta = (await ui(s, 'GET', `/api/sync?since=${before}`)).body;
    expect(delta.full).toBe(false);
    const seen = delta.tasks.find((x: { id: string }) => x.id === t.id);
    expect(seen.deletedAt).toBeTruthy(); // deletions are part of the delta
    expect(delta.seq).toBeGreaterThan(before);
  });
});

describe('export and import', () => {
  it('round-trips into a fresh install without duplicating on a second import', async () => {
    await create({ title: 'Exported task', notes: 'with notes', subtasks: ['a'] });
    const exported = (await ui(s, 'GET', '/api/export')).body;
    const other = await startServer({ seed: false });
    try {
      const r1 = await ui(other, 'POST', '/api/import', exported);
      expect(r1.body.tasks).toBe(exported.tasks.length);
      expect(r1.body.backup).toMatch(/pre-import/);
      const r2 = await ui(other, 'POST', '/api/import', exported);
      expect(r2.body.tasks).toBe(0);
      const found = (await ui(other, 'GET', '/api/tasks?q=Exported')).body.tasks[0];
      expect(found).toMatchObject({ title: 'Exported task', notes: 'with notes' });
      expect(found.subtasks).toHaveLength(1);
    } finally {
      await other.stop();
    }
  });
});
