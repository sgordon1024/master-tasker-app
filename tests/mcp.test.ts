import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { areaId, listenEvents, makeClient, startServer, ui, type TestServer } from './helpers.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
let s: TestServer;

async function connect(token: string, name = 'test-assistant', env: Record<string, string> = { MASTER_TASKER_TOKEN: token }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'mcp/server.ts')],
    env: { ...env, MASTER_TASKER_URL: s.base, PATH: process.env.PATH ?? '' },
    stderr: 'ignore',
  });
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(transport);
  return client;
}

const text = (r: any) => r.content?.[0]?.text as string;
const json = (r: any) => JSON.parse(text(r));

beforeAll(async () => {
  s = await startServer();
});
afterAll(async () => {
  await s.stop();
});

describe('MCP server', () => {
  it('checks in when an app starts it, so Master Tasker can show that app as connected', async () => {
    const { token, id } = await makeClient(s, { name: 'Check-in app', kind: 'other' });
    const before = (await ui(s, 'GET', '/api/clients')).body.clients.find((c: { id: string }) => c.id === id);
    expect(before.lastUsedAt).toBeNull();
    const c = await connect(token);
    let after: { lastUsedAt: string | null } | undefined;
    for (let i = 0; i < 50 && !after?.lastUsedAt; i++) {
      await new Promise((r) => setTimeout(r, 50));
      after = (await ui(s, 'GET', '/api/clients')).body.clients.find((x: { id: string }) => x.id === id);
    }
    expect(after?.lastUsedAt).toBeTruthy();
    await c.close();
  });

  it('exposes only narrow task tools', async () => {
    const { token } = await makeClient(s);
    const c = await connect(token);
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(
      ['add_note', 'add_subtask', 'ask_question', 'complete_task', 'create_task', 'flag_needs_you', 'get_task', 'list_areas', 'list_my_proposals', 'list_tasks', 'plan_subtasks', 'propose_change', 'reopen_task', 'search_tasks', 'set_subtask_done', 'start_task', 'update_task', 'whoami'].sort(),
    );
    await c.close();
  });

  it('creates a task that appears live in the UI stream, attributed to the token', async () => {
    const live = listenEvents(s);
    await live.opened;
    const { token } = await makeClient(s, { name: 'Claude Desktop', kind: 'claude' });
    const c = await connect(token, 'Helper');
    const r = await c.callTool({ name: 'create_task', arguments: { title: 'Created over MCP', area: 'Clients', priority: 'high', idempotency_key: 'mcp-test-key-1' } });
    expect(r.isError).toBeFalsy();
    const { task } = json(r);
    const ev = await live.waitFor((e) => e.type === 'task' && e.task.id === task.id);
    expect(ev.task.title).toBe('Created over MCP');
    const act = (await ui(s, 'GET', `/api/activity?entityId=${task.id}`)).body.activity[0];
    expect(act.actor.label).toBe('Claude Desktop'); // from the token
    expect(act.actor.claimedName).toBe('Helper'); // what the client called itself; shown as unverified

    // A retry with the same idempotency key does not duplicate.
    const again = json(await c.callTool({ name: 'create_task', arguments: { title: 'Created over MCP', area: 'Clients', priority: 'high', idempotency_key: 'mcp-test-key-1' } }));
    expect(again.task.id).toBe(task.id);
    live.close();
    await c.close();
  });

  it('reports conflicts instead of overwriting', async () => {
    const { token } = await makeClient(s);
    const c = await connect(token);
    const { task } = json(await c.callTool({ name: 'create_task', arguments: { title: 'Conflict target', area: 'Clients' } }));
    await ui(s, 'PATCH', `/api/tasks/${task.id}`, { baseRev: 1, patch: { title: 'Renamed by you' } });
    const r = await c.callTool({ name: 'update_task', arguments: { task_id: task.id, base_rev: 1, title: 'Renamed by assistant' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Conflict/);
    expect((await ui(s, 'GET', `/api/tasks/${task.id}`)).body.task.title).toBe('Renamed by you');
    // Re-read and retry works.
    const fresh = json(await c.callTool({ name: 'get_task', arguments: { task_id: task.id } }));
    const ok = await c.callTool({ name: 'update_task', arguments: { task_id: task.id, base_rev: fresh.rev, next_action: 'Do the thing' } });
    expect(ok.isError).toBeFalsy();
    await c.close();
  });

  it('stays inside its scope', async () => {
    const work = await areaId(s, 'Clients');
    const pets = await areaId(s, 'Pets');
    await ui(s, 'POST', '/api/tasks', { title: 'Private Pets vet note', areaId: pets });
    const { token } = await makeClient(s, { areas: [work], unfiled: false });
    const c = await connect(token);
    const found = json(await c.callTool({ name: 'search_tasks', arguments: { query: 'Pets vet' } }));
    expect(found.tasks).toHaveLength(0);
    const r = await c.callTool({ name: 'create_task', arguments: { title: 'x', area: 'Pets' } });
    expect(r.isError).toBe(true);
    const areas = json(await c.callTool({ name: 'list_areas', arguments: {} }));
    expect(areas.map((a: { name: string }) => a.name)).toEqual(['Clients']);
    await c.close();
  });

  it('bounds list results', async () => {
    const { token } = await makeClient(s);
    const c = await connect(token);
    const r = await c.callTool({ name: 'list_tasks', arguments: { limit: 500 } });
    expect(r.isError).toBe(true); // schema caps limit at 50
    const ok = json(await c.callTool({ name: 'list_tasks', arguments: { limit: 2 } }));
    expect(ok.tasks.length).toBeLessThanOrEqual(2);
    await c.close();
  });

  it('sends proposals to the review queue, deduplicated by source key', async () => {
    const { token } = await makeClient(s, { kind: 'other', perms: ['read', 'propose'] });
    const c = await connect(token);
    const args = { kind: 'create', task: { title: 'Renew registration', area: 'Home' }, reason: 'Found a reminder email', dedupe_key: 'gmail:thread/xyz', confidence: 0.5 };
    const a = json(await c.callTool({ name: 'propose_change', arguments: args }));
    const b = json(await c.callTool({ name: 'propose_change', arguments: args }));
    expect(b.proposal_id).toBe(a.proposal_id);
    expect(b.deduplicated).toBe(true);
    const direct = await c.callTool({ name: 'create_task', arguments: { title: 'not allowed', area: 'Home' } });
    expect(direct.isError).toBe(true); // propose-only connection
    const queue = (await ui(s, 'GET', '/api/proposals')).body.proposals;
    expect(queue.filter((p: { id: string }) => p.id === a.proposal_id)).toHaveLength(1);
    await c.close();
  });

  it('asks a question and reads back your answer', async () => {
    const { token } = await makeClient(s, { perms: ['read', 'propose'] });
    const c = await connect(token);
    const q = json(await c.callTool({ name: 'ask_question', arguments: { question: 'Is the video still yours?', choices: ['Yes', 'No, Jonas has it'], area: 'Clients', reason: 'Seen in Slack', dedupe_key: 'slack:q1' } }));
    expect(q.status).toBe('pending');
    await ui(s, 'POST', `/api/proposals/${q.proposal_id}/answer`, { answer: 'No, Jonas has it' });
    const answered = json(await c.callTool({ name: 'list_my_proposals', arguments: { status: 'accepted' } }));
    expect(answered[0]).toMatchObject({ kind: 'question', question: 'Is the video still yours?', answer: 'No, Jonas has it', dedupe_key: 'slack:q1' });
    const again = json(await c.callTool({ name: 'ask_question', arguments: { question: 'Is the video still yours?', area: 'Clients', reason: 'Seen again', dedupe_key: 'slack:q1' } }));
    expect(again.answer).toBe('No, Jonas has it');
    await c.close();
  });

  it('reads the token from a private file, and refuses one others can read', async () => {
    const { token } = await makeClient(s);
    const file = path.join(s.dir, 'mcp-token');
    fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
    const c = await connect('', 'file-client', { MASTER_TASKER_TOKEN_FILE: file });
    expect(json(await c.callTool({ name: 'whoami', arguments: {} })).connection).toContain('test client');
    await c.close();
    // Readable by your group, or by everyone.
    for (const m of [0o640, 0o604, 0o644]) {
      fs.chmodSync(file, m);
      const open = spawnSync(process.execPath, ['mcp/server.ts'], { cwd: ROOT, env: { PATH: process.env.PATH, MASTER_TASKER_TOKEN_FILE: file, MASTER_TASKER_URL: s.base }, encoding: 'utf8', input: '' });
      expect(open.status, m.toString(8)).toBe(1);
      expect(open.stderr).toContain('readable by other users');
    }
    const missing = spawnSync(process.execPath, ['mcp/server.ts'], { cwd: ROOT, env: { PATH: process.env.PATH, MASTER_TASKER_TOKEN_FILE: path.join(s.dir, 'nope') }, encoding: 'utf8', input: '' });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('no file there');
  });

  it('says plainly when its connection was revoked', async () => {
    const { token, id } = await makeClient(s);
    const c = await connect(token);
    await ui(s, 'POST', `/api/clients/${id}/revoke`);
    const r = await c.callTool({ name: 'list_areas', arguments: {} });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/removed or deleted/);
    await c.close();
  });

  it('plans, starts and flags a task the way the skill does', async () => {
    const { token } = await makeClient(s, { name: 'Cursor', kind: 'other', perms: ['read', 'update', 'complete', 'start'] });
    const c = await connect(token);
    const id = (await ui(s, 'POST', '/api/tasks', { title: 'Write the launch post' })).body.task.id;
    const planned = json(await c.callTool({ name: 'plan_subtasks', arguments: { task_id: id, steps: ['Draft it', { title: 'Approve the draft', needs_you: true }, 'Post it'] } }));
    expect(planned).toEqual(['[ ] Draft it', '[you] Approve the draft', '[ ] Post it']);
    expect(json(await c.callTool({ name: 'start_task', arguments: { task_id: id } })).status).toBe('doing');

    // It can't tick off the step that needs you, and the task can't be finished early.
    const task = json(await c.callTool({ name: 'get_task', arguments: { task_id: id } }));
    expect(task.subtasks.find((x: any) => x.title === 'Approve the draft').needs_you).toBe(true);
    const approve = task.subtasks.find((x: any) => x.title === 'Approve the draft').id;
    expect((await c.callTool({ name: 'set_subtask_done', arguments: { task_id: id, subtask_id: approve, done: true } })).isError).toBe(true);
    expect((await c.callTool({ name: 'complete_task', arguments: { task_id: id } })).isError).toBe(true);

    // You tick it off. A new plan or flag that names it never brings it back.
    await ui(s, 'PATCH', `/api/tasks/${id}/subtasks/${approve}`, { done: true });
    const again = json(await c.callTool({ name: 'plan_subtasks', arguments: { task_id: id, steps: ['Draft it', { title: 'Approve the draft', needs_you: true }, 'Post it'] } }));
    expect(again).toEqual({ subtasks: ['[x] Approve the draft', '[ ] Draft it', '[ ] Post it'], alreadyDone: ['Approve the draft'] });
    expect(json(await c.callTool({ name: 'flag_needs_you', arguments: { task_id: id, what: 'Approve the draft' } }))).toEqual({ already: true, subtask: 'Approve the draft' });

    // A flag on an open step, with why, and one on the whole task.
    expect(json(await c.callTool({ name: 'flag_needs_you', arguments: { task_id: id, what: 'Post it', why: 'Needs your login' } }))).toEqual({ flagged: 'subtask', subtask: 'Post it', why: 'Needs your login' });
    expect(json(await c.callTool({ name: 'flag_needs_you', arguments: { task_id: id, what: 'Pick a publish date' } }))).toMatchObject({ flagged: 'task' });
    expect((await ui(s, 'GET', `/api/tasks/${id}`)).body.task.needsYou).toBe('Pick a publish date');
    const bad = await c.callTool({ name: 'plan_subtasks', arguments: { task_id: id, steps: [{ title: ' ' }] } });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/needs a title/);
    await c.close();
  });

  it('offers the ticket workflow as a prompt', async () => {
    const { token } = await makeClient(s);
    const c = await connect(token);
    const prompts = (await c.listPrompts()).prompts.map((p) => p.name);
    expect(prompts).toEqual(['work_task']);
    const p = await c.getPrompt({ name: 'work_task', arguments: { task_id: 't_abc123', context: 'It is for the newsletter' } });
    const body = (p.messages[0].content as { text: string }).text;
    expect(body).toContain('Master Tasker task t_abc123');
    expect(body).toContain('It is for the newsletter');
    for (const tool of ['get_task', 'plan_subtasks', 'start_task', 'flag_needs_you', 'set_subtask_done', 'complete_task']) expect(body).toContain(tool);
    await c.close();
  });

  it('refuses to start without a valid token or with a non-local URL', () => {
    const noToken = spawnSync(process.execPath, ['mcp/server.ts'], { cwd: ROOT, env: { PATH: process.env.PATH }, encoding: 'utf8', input: '' });
    expect(noToken.status).toBe(1);
    const remote = spawnSync(process.execPath, ['mcp/server.ts'], {
      cwd: ROOT,
      env: { PATH: process.env.PATH, MASTER_TASKER_TOKEN: `mt_${'a'.repeat(32)}`, MASTER_TASKER_URL: 'https://example.com' },
      encoding: 'utf8',
      input: '',
    });
    expect(remote.status).toBe(1);
    expect(remote.stderr).toContain('local address');
  });
});
