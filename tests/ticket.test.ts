import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeClient, startServer, ui, type TestServer } from './helpers.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
let s: TestServer;
let data: string;

// Async, so the in-process test server can answer while the tool runs.
function ticket(args: string[], input?: unknown, opts: { cmd?: string; env?: Record<string, string> } = {}): Promise<{ out: any; err: string }> {
  return new Promise((resolve) => {
    const [cmd, first] = opts.cmd ? [opts.cmd, []] : [process.execPath, ['automation/ticket.ts']];
    const p = spawn(cmd, [...first, ...args], { cwd: ROOT, env: opts.env ?? { PATH: process.env.PATH!, MT_DATA_DIR: data, MASTER_TASKER_URL: s.base } });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ out: code === 0 ? JSON.parse(out) : null, err: err.trim() }));
    p.stdin.end(input === undefined ? '' : JSON.stringify(input));
  });
}

beforeEach(async () => {
  s = await startServer();
  data = path.join(s.dir, 'skill-data');
  const { token } = await makeClient(s, { name: 'Claude threads', perms: ['read', 'update', 'complete', 'start'] });
  fs.mkdirSync(path.join(data, 'claude'), { recursive: true });
  fs.writeFileSync(path.join(data, 'claude', 'token'), token, { mode: 0o600 });
});
afterEach(() => s.stop());

describe('ticket tool for the /master-tasker skill', () => {
  it('fills out an empty ticket, plans it, starts it, and works it', async () => {
    const id = (await ui(s, 'POST', '/api/tasks', { title: 'Collapse the nav' })).body.task.id;
    expect((await ticket(['get', id])).out.task.empty).toBe(true);

    const filled = await ticket(['fill', id, '-'], { notes: 'Icons only when narrow', nextAction: 'Read the code', area: 'clients', priority: 'high' });
    expect(filled.out).toMatchObject({ area: 'Clients', priority: 'high', empty: false });

    const plan = await ticket(['plan', id, '-'], ['Read the code', { title: 'Pick icons', needsYou: true }, 'Build it']);
    expect(plan.out).toEqual(['[ ] Read the code', '[you] Pick icons', '[ ] Build it']);

    expect((await ticket(['start', id])).out).toBe('doing');
    expect((await ticket(['done', id, 'read the code'])).out).toEqual({ done: 'Read the code' });

    // Only you check off what needs you, and the ticket can't be completed early.
    expect((await ticket(['done', id, 'Pick icons'])).err).toMatch(/needs you/);
    expect((await ticket(['complete', id])).err).toMatch(/Pick icons \(needs you\)/);

    // A new plan keeps finished and needs-you subtasks, drops the rest, and follows the new order.
    expect((await ticket(['plan', id, '-'], ['Write tests', 'Build it'])).out).toEqual(['[x] Read the code', '[ ] Write tests', '[ ] Build it', '[you] Pick icons']);

    const task = (await ui(s, 'GET', `/api/tasks/${id}`)).body.task;
    await ui(s, 'PATCH', `/api/tasks/${id}/subtasks/${task.subtasks.find((x: any) => x.title === 'Pick icons').id}`, { done: true });
    await ticket(['done', id, 'Write tests']);
    await ticket(['done', id, 'Build it']);
    expect((await ticket(['complete', id])).out.status).toBe('done');
  });

  it('flags the whole task when the thing that needs you is not a subtask', async () => {
    const id = (await ui(s, 'POST', '/api/tasks', { title: 'Ship it' })).body.task.id;
    expect((await ticket(['needs-you', id, 'Approve the copy'])).out).toEqual({ flagged: 'task', text: 'Approve the copy' });
    expect((await ui(s, 'GET', `/api/tasks/${id}`)).body.task.needsYou).toBe('Approve the copy');
    expect((await ticket(['complete', id])).err).toMatch(/needs you/);
  });

  it('refuses a token file others can read, and unknown areas', async () => {
    const id = (await ui(s, 'POST', '/api/tasks', { title: 'X' })).body.task.id;
    expect((await ticket(['fill', id, '-'], { area: 'Nowhere' })).err).toMatch(/No area called "Nowhere"/);
    fs.chmodSync(path.join(data, 'claude', 'token'), 0o644);
    expect((await ticket(['get', id])).err).toMatch(/readable by other users/);
  });
});

describe('where the ticket tool finds the app', () => {
  it('uses MT_PORT when there is no MASTER_TASKER_URL', async () => {
    const id = (await ui(s, 'POST', '/api/tasks', { title: 'Port check' })).body.task.id;
    const r = await ticket(['get', id], undefined, { env: { PATH: process.env.PATH!, MT_DATA_DIR: data, MT_PORT: String(s.port) } });
    expect(r.out.task.title).toBe('Port check');
  });

  it('runs from a linked skills folder with only its settings file, and no node on PATH', async () => {
    // A copy of the repo layout, so the real skill folder and its settings file are never touched.
    const repo = path.join(s.dir, 'repo');
    const skill = path.join(repo, 'claude', 'skills', 'master-tasker');
    fs.mkdirSync(skill, { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'claude', 'skills', 'master-tasker', 'ticket'), path.join(skill, 'ticket'));
    fs.chmodSync(path.join(skill, 'ticket'), 0o755);
    fs.symlinkSync(path.join(ROOT, 'automation'), path.join(repo, 'automation'));
    const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
    fs.writeFileSync(path.join(skill, '.local.env'), `# test\nMT_DATA_DIR=${q(data)}\nMASTER_TASKER_URL=${q(s.base)}\nMT_NODE=${q(process.execPath)}\n`);
    const skills = path.join(s.dir, 'home', '.claude', 'skills');
    fs.mkdirSync(skills, { recursive: true });
    fs.symlinkSync(skill, path.join(skills, 'master-tasker'));

    const id = (await ui(s, 'POST', '/api/tasks', { title: 'Linked runner' })).body.task.id;
    const r = await ticket(['get', id], undefined, { cmd: path.join(skills, 'master-tasker', 'ticket'), env: { PATH: '/usr/bin:/bin', HOME: path.join(s.dir, 'home') } });
    expect(r.err).toBe('');
    expect(r.out.task.title).toBe('Linked runner');
  });

  it('says how to fix it when the connection was revoked', async () => {
    const id = (await ui(s, 'POST', '/api/tasks', { title: 'Revoked' })).body.task.id;
    const clients = (await ui(s, 'GET', '/api/clients')).body.clients;
    await ui(s, 'POST', `/api/clients/${clients.find((c: any) => c.name === 'Claude threads').id}/revoke`);
    expect((await ticket(['get', id])).err).toMatch(/revoked or deleted.*Settings > AI assistants/);
    fs.rmSync(path.join(data, 'claude', 'token'));
    expect((await ticket(['get', id])).err).toMatch(/No Claude threads token.*install-skill\.sh/);
  });
});

describe('subtask order', () => {
  it('reorders only with every subtask listed once', async () => {
    const id = (await ui(s, 'POST', '/api/tasks', { title: 'Order', subtasks: ['a', 'b', 'c'] })).body.task.id;
    const ids = (await ui(s, 'GET', `/api/tasks/${id}`)).body.task.subtasks.map((x: any) => x.id);
    const r = await ui(s, 'PUT', `/api/tasks/${id}/subtasks/order`, { ids: [ids[2], ids[0], ids[1]] });
    expect(r.body.task.subtasks.map((x: any) => x.title)).toEqual(['c', 'a', 'b']);
    expect((await ui(s, 'PUT', `/api/tasks/${id}/subtasks/order`, { ids: [ids[0], ids[0], ids[1]] })).status).toBe(422);
    expect((await ui(s, 'PUT', `/api/tasks/${id}/subtasks/order`, { ids: [ids[0]] })).status).toBe(422);
  });

  it("never brings back a step you already ticked off, even when a plan or flag names it again", async () => {
    const id = (await ui(s, 'POST', '/api/tasks', { title: 'Book the session' })).body.task.id;
    await ticket(['plan', id, '-'], ['Find the notes', { title: 'Send the agenda', needsYou: true }, { title: 'Book it', needsYou: true }]);
    // You tick your two steps, then the thread, still working, sends the same plan again.
    const t = (await ui(s, 'GET', `/api/tasks/${id}`)).body.task;
    for (const st of t.subtasks.filter((x: any) => x.needsYou)) await ui(s, 'PATCH', `/api/tasks/${id}/subtasks/${st.id}`, { done: true });
    const again = await ticket(['plan', id, '-'], ['Find the notes', { title: 'Send the agenda', needsYou: true }, { title: 'Book it', needsYou: true }]);
    expect(again.out).toEqual({ subtasks: ['[x] Send the agenda', '[x] Book it', '[ ] Find the notes'], alreadyDone: ['Send the agenda', 'Book it'] });
    expect((await ticket(['needs-you', id, 'Book it'])).out).toEqual({ already: true, subtask: 'Book it' });
    const after = (await ui(s, 'GET', `/api/tasks/${id}`)).body.task;
    expect(after.needsYou).toBeFalsy();
    expect(after.subtasks).toHaveLength(3);
  });

  it('locks the order only when Claude plans steps that must happen in sequence, and you can unlock it', async () => {
    const id = (await ui(s, 'POST', '/api/tasks', { title: 'Sequence' })).body.task.id;
    await ticket(['plan', id, '-'], ['One', 'Two']);
    expect((await ui(s, 'GET', `/api/tasks/${id}`)).body.task.subtasksOrdered).toBe(false);
    await ticket(['plan', id, '-', '--ordered'], ['One', 'Two', 'Three']);
    let task = (await ui(s, 'GET', `/api/tasks/${id}`)).body.task;
    expect(task.subtasksOrdered).toBe(true);
    expect(task.subtasks.map((x: any) => x.title)).toEqual(['One', 'Two', 'Three']);
    task = (await ui(s, 'PUT', `/api/tasks/${id}/subtasks/order`, { ordered: false })).body.task;
    expect(task.subtasksOrdered).toBe(false);
    expect((await ui(s, 'PUT', `/api/tasks/${id}/subtasks/order`, {})).status).toBe(422);
  });
});
