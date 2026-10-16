import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asClient, makeClient, startServer, ui, type TestServer } from './helpers.ts';

let s: TestServer;
let logFile: string;

beforeEach(async () => {
  s = await startServer({ env: { MT_NOTIFY_BIN: path.resolve(import.meta.dirname, 'fixtures/fake-notify.mjs') } });
  logFile = path.join(s.dir, 'notify.log');
  process.env.MT_NOTIFY_LOG = logFile;
});
afterEach(async () => {
  await s.stop();
});

const notified = async () => {
  for (let i = 0; i < 40 && !fs.existsSync(logFile); i++) await new Promise((r) => setTimeout(r, 50));
  return fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};
const task = async (body: Record<string, unknown>) => (await ui(s, 'POST', '/api/tasks', { status: 'doing', ...body })).body.task;

describe('when Claude finishes a ticket', () => {
  it('marks it done, records what got done, and notifies you', async () => {
    const { token } = await makeClient(s, { name: 'Claude threads', perms: ['read', 'update', 'complete'] });
    const t = await task({ title: 'Ship the nav' });
    const r = await asClient(s, token, 'POST', `/api/tasks/${t.id}/complete`, { why: 'Shipped it, tests pass', sessionId: 'abc12345-thread' });
    expect(r.status).toBe(200);
    expect(r.body.task.status).toBe('done');
    expect(r.body.task.finishedBy).toMatchObject({ by: 'Claude threads', why: 'Shipped it, tests pass', sessionId: 'abc12345-thread' });
    const [args] = await notified();
    expect(args).toContain('Claude threads finished a task · thread ready to archive');
    expect(args).toContain('Shipped it, tests pass');
    expect(args).toContain('Ship the nav');
  });

  it('Got it and Reopen both clear it; only you can press Got it', async () => {
    const { token } = await makeClient(s, { perms: ['read', 'update', 'complete'] });
    const a = await task({ title: 'One' });
    const b = await task({ title: 'Two' });
    await asClient(s, token, 'POST', `/api/tasks/${a.id}/complete`, {});
    await asClient(s, token, 'POST', `/api/tasks/${b.id}/complete`, {});
    expect((await asClient(s, token, 'POST', `/api/tasks/${a.id}/finished/seen`, {})).status).toBe(403);
    const seen = await ui(s, 'POST', `/api/tasks/${a.id}/finished/seen`, {});
    expect(seen.body.task).toMatchObject({ status: 'done', finishedBy: null });
    const reopened = await ui(s, 'POST', `/api/tasks/${b.id}/reopen`, {});
    expect(reopened.body.task.finishedBy).toBeNull();
    expect(reopened.body.task.status).not.toBe('done');
  });

  it("won't finish a ticket with open subtasks or something waiting on you", async () => {
    const { token } = await makeClient(s, { perms: ['read', 'update', 'complete'] });
    const t = await task({ title: 'Half done' });
    await ui(s, 'POST', `/api/tasks/${t.id}/subtasks`, { title: 'Pick the icons' });
    const r = await asClient(s, token, 'POST', `/api/tasks/${t.id}/complete`, {});
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/Pick the icons/);
    const u = await task({ title: 'Needs a call' });
    expect((await asClient(s, token, 'POST', `/api/tasks/${u.id}/needs-you`, { text: 'Call the shop' })).status).toBe(200);
    expect((await asClient(s, token, 'POST', `/api/tasks/${u.id}/complete`, {})).status).toBe(409);
    expect(await notified()).toEqual([]);
  });

  it('the daily review has to say how it knows', async () => {
    const { token } = await makeClient(s, { name: 'Daily review', perms: ['read', 'propose', 'start', 'complete'] });
    const t = await task({ title: 'Merge the PR' });
    expect((await asClient(s, token, 'POST', `/api/tasks/${t.id}/complete`, {})).status).toBe(422);
    const r = await asClient(s, token, 'POST', `/api/tasks/${t.id}/complete`, { why: 'PR #12 merged', link: 'https://github.com/o/r/pull/12' });
    expect(r.body.task.finishedBy).toMatchObject({ by: 'Daily review', why: 'PR #12 merged', link: 'https://github.com/o/r/pull/12' });
  });

  it('you completing it yourself is quiet, and the Mac notification can be turned off', async () => {
    const mine = await task({ title: 'Mine' });
    expect((await ui(s, 'POST', `/api/tasks/${mine.id}/complete`, {})).body.task.finishedBy).toBeNull();
    await ui(s, 'PATCH', '/api/settings', { macNotify: false });
    const { token } = await makeClient(s, { perms: ['read', 'update', 'complete'] });
    const t = await task({ title: 'Quiet' });
    expect((await asClient(s, token, 'POST', `/api/tasks/${t.id}/complete`, {})).body.task.finishedBy).toBeTruthy();
    expect(await notified()).toEqual([]);
  });
});
