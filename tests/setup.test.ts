import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../server/db.ts';
import { asClient, makeClient, startServer, tempDir, ui, type TestServer } from './helpers.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const FAKE = path.resolve(import.meta.dirname, 'fixtures', 'fake-claude.mjs');
let s: TestServer;
afterEach(() => s?.stop());

const SAMPLE_AREAS = ['Clients', 'Side projects', 'Pets', 'Home', 'Hobbies', 'Personal'];

async function everything() {
  const { tasks, areas, projects } = (await ui(s, 'GET', '/api/sync')).body;
  const areaName = new Map<string, string>(areas.map((a: any) => [a.id, a.name]));
  return {
    areas: areas.map((a: any) => `${a.name} (${a.mode})`),
    projects: projects.map((p: any) => p.name),
    samples: tasks.filter((t: any) => t.isSample).map((t: any) => ({ title: t.title, area: t.areaId ? areaName.get(t.areaId) : null })),
    tasks: tasks.length,
  };
}
const settings = async () => (await ui(s, 'GET', '/api/settings')).body.settings;

describe('first-run setup', () => {
  it('starts a new install with the sample set, waiting for setup', async () => {
    s = await startServer();
    expect(await settings()).toMatchObject({ setupDone: false, ownerName: '', startedWithSamples: true });
    const all = await everything();
    expect(all.areas).toEqual(SAMPLE_AREAS.map((n) => `${n} (personal)`));
    expect(all.samples).toHaveLength(6);
  });

  it('Work and Personal: two areas, one each side, with the samples placed in them', async () => {
    s = await startServer();
    const r = await ui(s, 'POST', '/api/setup', { name: 'Ada', areas: 'work-personal', samples: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ reshaped: true, settings: { setupDone: true, ownerName: 'Ada', startedWithSamples: true } });
    const all = await everything();
    expect(all.areas).toEqual(['Work (work)', 'Personal (personal)']);
    expect(all.projects).toEqual(['Portfolio site']);
    expect(all.samples).toHaveLength(6);
    const where = Object.fromEntries(all.samples.map((x: any) => [x.title, x.area]));
    expect(where).toMatchObject({
      'Send the invoice for the logo project': 'Work',
      'Redesign the onboarding screens': 'Work',
      'Choose the hero photo for the portfolio': 'Personal',
      'Plan the weekend trip': 'Personal',
      'Sort the receipts folder by month': 'Personal',
    });
    // Nothing of the old sample set is left behind, not even its history.
    const activity = (await ui(s, 'GET', '/api/activity?limit=200')).body;
    const summaries = JSON.stringify(activity);
    expect(summaries).not.toMatch(/Side projects|Hobbies|Pets/);
    expect(summaries).toContain('Set up with Work and Personal, and sample tasks');
  });

  it('Work and Personal without samples: just the two areas', async () => {
    s = await startServer();
    const r = await ui(s, 'POST', '/api/setup', { areas: 'work-personal', samples: false });
    expect(r.body.settings).toMatchObject({ setupDone: true, ownerName: '', startedWithSamples: false });
    expect(await everything()).toEqual({ areas: ['Work (work)', 'Personal (personal)'], projects: [], samples: [], tasks: 0 });
  });

  it('the sample set, with samples, keeps what the install already has', async () => {
    s = await startServer();
    const before = await everything();
    const r = await ui(s, 'POST', '/api/setup', { areas: 'sample', samples: true });
    expect(r.body).toMatchObject({ reshaped: false, settings: { setupDone: true, startedWithSamples: true } });
    expect(await everything()).toEqual(before);
  });

  it('the sample set without samples: the six areas and no tasks', async () => {
    s = await startServer();
    await ui(s, 'POST', '/api/setup', { areas: 'sample', samples: false });
    expect(await everything()).toEqual({ areas: SAMPLE_AREAS.map((n) => `${n} (personal)`), projects: [], samples: [], tasks: 0 });
  });

  it('None with samples: the samples stay unfiled', async () => {
    s = await startServer();
    await ui(s, 'POST', '/api/setup', { areas: 'none', samples: true });
    const all = await everything();
    expect(all.areas).toEqual([]);
    expect(all.projects).toEqual([]);
    expect(all.samples).toHaveLength(6);
    expect(all.samples.every((x: any) => x.area === null)).toBe(true);
  });

  it('None without samples: empty, and it stays empty after a restart', async () => {
    s = await startServer();
    await ui(s, 'POST', '/api/setup', { areas: 'none', samples: false });
    expect(await everything()).toEqual({ areas: [], projects: [], samples: [], tasks: 0 });
    const dir = s.dir;
    await s.stop();
    s = await startServer({ dir });
    expect(await everything()).toEqual({ areas: [], projects: [], samples: [], tasks: 0 });
    expect((await settings()).setupDone).toBe(true);
  });

  it('Skip keeps the sample set, and keeps a name you typed', async () => {
    s = await startServer();
    const before = await everything();
    const r = await ui(s, 'POST', '/api/setup', { name: '  Ada  ' });
    expect(r.body).toMatchObject({ reshaped: false, settings: { setupDone: true, ownerName: 'Ada' } });
    expect(await everything()).toEqual(before);
    expect(JSON.stringify((await ui(s, 'GET', '/api/activity?limit=50')).body)).toContain('Skipped setup');
  });

  it('happens once', async () => {
    s = await startServer();
    await ui(s, 'POST', '/api/setup', {});
    const again = await ui(s, 'POST', '/api/setup', { areas: 'none', samples: false });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ setup: 'done' });
    expect((await everything()).areas).toHaveLength(6);
  });

  it('never reshapes once you have a task of your own', async () => {
    s = await startServer();
    await ui(s, 'POST', '/api/tasks', { title: 'Call the plumber' });
    const r = await ui(s, 'POST', '/api/setup', { name: 'Ada', areas: 'none', samples: false });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ setup: 'has-data', message: 'You already have tasks or areas of your own, so setup left them as they are.' });
    expect((await settings()).setupDone).toBe(false);
    const all = await everything();
    expect(all.areas).toHaveLength(6);
    expect(all.tasks).toBe(7);
    // The app then saves just the name.
    expect((await ui(s, 'POST', '/api/setup', { name: 'Ada' })).body.settings).toMatchObject({ setupDone: true, ownerName: 'Ada' });
  });

  it('never reshapes once you changed a sample, or added an area', async () => {
    s = await startServer();
    const sample = (await ui(s, 'GET', '/api/sync')).body.tasks.find((t: any) => t.isSample);
    await ui(s, 'PATCH', `/api/tasks/${sample.id}`, { baseRev: sample.rev, patch: { title: 'My own now' } });
    expect((await ui(s, 'POST', '/api/setup', { areas: 'work-personal', samples: true })).body.error).toMatchObject({ setup: 'has-data' });
    await s.stop();

    s = await startServer();
    await ui(s, 'POST', '/api/areas', { name: 'Garden' });
    expect((await ui(s, 'POST', '/api/setup', { areas: 'none', samples: true })).body.error).toMatchObject({ setup: 'has-data' });
    expect((await everything()).areas).toContain('Garden (personal)');
  });

  it('is only for you, and checks what it gets', async () => {
    s = await startServer();
    const { token } = await makeClient(s);
    expect((await asClient(s, token, 'POST', '/api/setup', { areas: 'none', samples: false })).status).toBe(403);
    for (const bad of [{ areas: 'none' }, { samples: true }, { areas: 'lots', samples: true }, { name: 'x'.repeat(61) }, { name: 'two\nlines' }, { theme: 'dark' }]) {
      expect((await ui(s, 'POST', '/api/setup', bad)).status).toBe(422);
    }
    expect((await settings()).setupDone).toBe(false);
    expect((await everything()).areas).toHaveLength(6);
  });

  it('MT_FIRST_RUN=0 marks a new install set up, with the sample set', async () => {
    s = await startServer({ env: { MT_FIRST_RUN: '0' } });
    expect(await settings()).toMatchObject({ setupDone: true, ownerName: '' });
    expect((await everything()).areas).toHaveLength(6);
  });

  it('your name can change in Settings', async () => {
    s = await startServer();
    expect((await ui(s, 'PATCH', '/api/settings', { ownerName: ' Ada ' })).body.settings.ownerName).toBe('Ada');
    expect((await ui(s, 'PATCH', '/api/settings', { ownerName: 'x'.repeat(61) })).status).toBe(422);
    expect((await ui(s, 'PATCH', '/api/settings', { ownerName: '' })).body.settings.ownerName).toBe('');
    const { token } = await makeClient(s);
    expect((await asClient(s, token, 'PATCH', '/api/settings', { ownerName: 'Bob' })).status).toBe(403);
  });
});

describe('migration 13: first-run setup', () => {
  // A database from before setup existed: what the app makes today, rolled back to v12 without the setting.
  async function v12(prepare: (srv: TestServer) => Promise<void> = async () => {}) {
    const dir = tempDir();
    s = await startServer({ dir });
    await prepare(s);
    const { dbPath, backupDir } = s.config;
    await s.stop();
    const db = openDatabase(dbPath, { backupDir });
    db.exec("DELETE FROM settings WHERE key IN ('setupDone', 'ownerName', 'startedWithSamples'); PRAGMA user_version = 12;");
    db.close();
    const after = openDatabase(dbPath, { backupDir });
    const row = after.prepare("SELECT value FROM settings WHERE key = 'setupDone'").get() as { value: string } | undefined;
    after.close();
    s = await startServer({ dir });
    return row?.value ?? null;
  }

  it('marks a database with your own tasks as set up', async () => {
    expect(await v12(async (srv) => void (await ui(srv, 'POST', '/api/tasks', { title: 'Call the plumber' })))).toBe('true');
    expect((await settings()).setupDone).toBe(true);
  });

  it('marks a database where you cleared the samples as set up', async () => {
    expect(await v12(async (srv) => void (await ui(srv, 'POST', '/api/samples/clear', {})))).toBe('true');
  });

  it('leaves an untouched sample install waiting for setup', async () => {
    expect(await v12()).toBeNull();
    expect((await settings()).setupDone).toBe(false);
  });

  it('leaves a brand-new database waiting for setup', async () => {
    const dir = tempDir();
    const db = openDatabase(path.join(dir, 'm.db'), { backupDir: path.join(dir, 'backups') });
    expect(db.prepare("SELECT value FROM settings WHERE key = 'setupDone'").get()).toBeUndefined();
    db.close();
  });
});

describe('your name, where assistants read it', () => {
  it('goes into the Ask prompt, and to Claude', async () => {
    const { askPrompt } = await import('../server/ask.ts');
    s = await startServer({ seed: false, env: { MT_CLAUDE_BIN: FAKE } });
    const t = (await ui(s, 'POST', '/api/tasks', { title: 'Pick a logo' })).body.task;
    expect(askPrompt(t, 'task', 'Which?', 'Ada')).toMatch(/^The user, Ada, is looking at their Master Tasker task/);
    expect(askPrompt(t, 'task', 'Which?')).toMatch(/^The user is looking at their Master Tasker task/);

    await ui(s, 'PATCH', '/api/settings', { ownerName: 'Ada' });
    await ui(s, 'POST', `/api/tasks/${t.id}/asks`, { item: 'task', question: 'Which one?' });
    let asks: any[] = [];
    for (let i = 0; i < 60; i++) {
      asks = (await ui(s, 'GET', `/api/tasks/${t.id}/asks`)).body.asks;
      if (asks.every((a) => a.status !== 'running')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(asks[0]).toMatchObject({ status: 'done', answer: expect.stringMatching(/ for Ada$/) });
  });

  it('comes back from the skill\'s ticket get, empty when not given', async () => {
    s = await startServer();
    const data = path.join(s.dir, 'skill-data');
    const { token } = await makeClient(s, { name: 'Claude threads', perms: ['read', 'update', 'complete', 'start'] });
    fs.mkdirSync(path.join(data, 'claude'), { recursive: true });
    fs.writeFileSync(path.join(data, 'claude', 'token'), token, { mode: 0o600 });
    const id = (await ui(s, 'POST', '/api/tasks', { title: 'Collapse the nav' })).body.task.id;
    const get = () =>
      new Promise<any>((resolve) => {
        const p = spawn(process.execPath, ['automation/ticket.ts', 'get', id], { cwd: ROOT, env: { PATH: process.env.PATH!, MT_DATA_DIR: data, MASTER_TASKER_URL: s.base } });
        let out = '';
        p.stdout.on('data', (d) => (out += d));
        p.on('close', () => resolve(JSON.parse(out)));
        p.stdin.end('');
      });
    expect((await get()).user).toEqual({ name: '' });
    await ui(s, 'POST', '/api/setup', { name: 'Ada' });
    const out = await get();
    expect(out.user).toEqual({ name: 'Ada' });
    expect(out.task.id).toBe(id);
  });

  it('goes into the MCP work_task prompt and whoami', async () => {
    s = await startServer();
    const { token } = await makeClient(s);
    const connect = async () => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.join(ROOT, 'mcp/server.ts')],
        env: { MASTER_TASKER_TOKEN: token, MASTER_TASKER_URL: s.base, PATH: process.env.PATH ?? '' },
        stderr: 'ignore',
      });
      const client = new Client({ name: 'test-assistant', version: '1.0.0' });
      await client.connect(transport);
      return client;
    };
    const promptText = async (c: Client) => ((await c.getPrompt({ name: 'work_task', arguments: { task_id: 't_abc123' } })).messages[0].content as { text: string }).text;
    const whoami = async (c: Client) => JSON.parse((await c.callTool({ name: 'whoami', arguments: {} }) as any).content[0].text);

    let c = await connect();
    expect(await promptText(c)).not.toContain("The user's name");
    expect((await whoami(c)).user_name).toBe('');
    await c.close();

    await ui(s, 'PATCH', '/api/settings', { ownerName: 'Ada' });
    c = await connect();
    expect(await promptText(c)).toContain(`The user's name is Ada. Use it when you talk to them, and when you write about them in the task, like "Ada picks the photo".`);
    expect((await whoami(c)).user_name).toBe('Ada');
    await c.close();
  });
});
