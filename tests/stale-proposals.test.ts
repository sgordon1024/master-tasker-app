import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asClient, makeClient, startServer, ui, type TestServer } from './helpers.ts';

let s: TestServer;
beforeEach(async () => {
  s = await startServer();
});
afterEach(async () => {
  await s.stop();
});

const pending = async () => (await ui(s, 'GET', '/api/proposals?status=pending')).body.proposals as { id: string; body: { kind: string } }[];
const propose = (token: string, proposal: unknown) => asClient(s, token, 'POST', '/api/proposals', { proposal });

describe('suggestions that go out of date', () => {
  it('closes suggestions about a task once you finish or trash it, but keeps reopen', async () => {
    const { token } = await makeClient(s, { perms: ['read', 'propose'] });
    const a = (await ui(s, 'POST', '/api/tasks', { title: 'Prep the call', status: 'today' })).body.task;
    const b = (await ui(s, 'POST', '/api/tasks', { title: 'Old idea', status: 'next' })).body.task;
    const other = (await ui(s, 'POST', '/api/tasks', { title: 'Still going', status: 'next' })).body.task;
    await propose(token, { kind: 'note', taskId: a.id, text: 'Call moved to 2:30' });
    await propose(token, { kind: 'complete', taskId: a.id });
    await propose(token, { kind: 'note', taskId: b.id, text: 'Stale' });
    await propose(token, { kind: 'note', taskId: other.id, text: 'Keep me' });
    expect(await pending()).toHaveLength(4);

    await ui(s, 'POST', `/api/tasks/${a.id}/complete`, {});
    await ui(s, 'DELETE', `/api/tasks/${b.id}`);
    const left = await pending();
    expect(left).toHaveLength(1);
    expect(left[0].body).toMatchObject({ kind: 'note', taskId: other.id });

    await propose(token, { kind: 'reopen', taskId: a.id });
    expect(await pending()).toHaveLength(2);
  });

  it('lets a connection withdraw only its own suggestions', async () => {
    const mine = await makeClient(s, { name: 'Daily review', perms: ['read', 'propose'] });
    const theirs = await makeClient(s, { name: 'Other', perms: ['read', 'propose'] });
    const t = (await ui(s, 'POST', '/api/tasks', { title: 'Merge #66', status: 'next' })).body.task;
    const p = (await propose(mine.token, { kind: 'note', taskId: t.id, text: 'Merge it' })).body.proposal;
    expect((await asClient(s, theirs.token, 'POST', `/api/proposals/${p.id}/withdraw`, { why: 'no' })).status).toBe(404);
    const r = await asClient(s, mine.token, 'POST', `/api/proposals/${p.id}/withdraw`, { why: 'Merged already' });
    expect(r.status).toBe(200);
    expect(r.body.proposal.status).toBe('rejected');
    expect(await pending()).toHaveLength(0);
  });
});
