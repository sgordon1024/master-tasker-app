import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { areaId, makeClient, startServer, ui, type TestServer } from './helpers.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const run = promisify(execFile);
let s: TestServer;
let dataDir: string;
let env: Record<string, string>;

beforeEach(async () => {
  s = await startServer();
  dataDir = path.join(s.dir, 'review-data');
  const dev = path.join(s.dir, 'development');
  fs.mkdirSync(dev, { recursive: true });
  fs.mkdirSync(path.join(dev, 'side-project'));
  fs.writeFileSync(path.join(dev, 'side-project', 'TODO.md'), '- [ ] ship it\n');
  env = { PATH: process.env.PATH!, HOME: s.dir, MT_DATA_DIR: dataDir, MT_DEV_ROOTS: dev, MT_CLAUDE_PROJECTS_DIR: path.join(s.dir, 'none'), MT_DEVSCAN_GH: '0', MASTER_TASKER_URL: s.base };
});
afterEach(async () => {
  await s.stop();
});

async function cli(...args: string[]) {
  try {
    const r = await run(process.execPath, ['automation/review.ts', ...args], { cwd: ROOT, env });
    return { ok: true, out: JSON.parse(r.stdout) };
  } catch (e) {
    return { ok: false, err: (e as { stderr: string }).stderr };
  }
}
async function writeToken(perms = ['read', 'propose']) {
  const { token } = await makeClient(s, { name: 'Daily review', perms });
  fs.mkdirSync(path.join(dataDir, 'review'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'review', 'token'), token, { mode: 0o600 });
}

describe('scheduled review', () => {
  it('refuses to run without a private token file, and says how to set it up', async () => {
    expect((await cli('start')).err).toMatch(/No review token.*npm run review:setup/);
    await writeToken();
    fs.chmodSync(path.join(dataDir, 'review', 'token'), 0o644);
    expect((await cli('start')).err).toContain('readable by other users');
  });

  it('gathers context, sends suggestions that wait for review, and moves the cursor only when finished', async () => {
    await writeToken();
    const work = await areaId(s, 'Clients');
    const started = await cli('start');
    expect(started.err ?? '').toBe('');
    const ctx = JSON.parse(fs.readFileSync(started.out.file, 'utf8'));
    expect(ctx.connection).toBe('Daily review');
    expect(ctx.tasks.length).toBeGreaterThan(0);
    expect(ctx.development.active.map((p: { name: string }) => p.name)).toEqual(['side-project']);
    expect(fs.statSync(started.out.file).mode & 0o077).toBe(0);

    const file = path.join(s.dir, 'suggestions.json');
    fs.writeFileSync(file, JSON.stringify([
      { proposal: { kind: 'create', task: { title: 'Ship side project', areaId: work } }, reason: 'Open TODO', dedupeKey: 'dev:side-project:ship-it', confidence: 0.7 },
      { proposal: { kind: 'question', areaId: work, question: 'Is side project work or personal?' }, reason: 'Not clear', dedupeKey: 'dev:side-project:area' },
      { proposal: { kind: 'create', task: { title: 'No key' } }, reason: 'x' },
    ]));
    const sent = await cli('propose', file);
    expect(sent.out).toMatchObject({ sent: 2, failed: 1 });
    expect(sent.out.results[2].error).toContain('dedupeKey');
    // Sending the same file again (a retried run) creates nothing new.
    const again = await cli('propose', file);
    expect(again.out.results.slice(0, 2).map((r: { id: string }) => r.id)).toEqual(sent.out.results.slice(0, 2).map((r: { id: string }) => r.id));
    expect((await ui(s, 'GET', '/api/proposals')).body.proposals).toHaveLength(2);
    // A read-and-propose key cannot change tasks.
    expect((await ui(s, 'GET', '/api/tasks?q=Ship%20side')).body.tasks).toHaveLength(0);

    // Not finished: the next run sees the same folder activity again.
    const retry = await cli('start');
    expect(retry.out.devFoldersWithActivity).toBe(1);
    expect((await cli('finish', retry.out.scanId, '--summary', '2 suggestions')).ok).toBe(true);
    expect((await cli('start')).out.devFoldersWithActivity).toBe(0);
    expect((await cli('status')).out.at(-1).summary).toBe('2 suggestions');
  });

  it('gives other routines tasks and suggestions without starting a run', async () => {
    await writeToken();
    const r = await cli('context');
    expect(r.err ?? '').toBe('');
    const ctx = JSON.parse(fs.readFileSync(r.out.file, 'utf8'));
    expect(ctx.tasks.length).toBeGreaterThan(0);
    expect(ctx.development).toBeUndefined();
    expect(fs.statSync(r.out.file).mode & 0o077).toBe(0);
    expect(fs.existsSync(path.join(dataDir, 'review', 'current.json'))).toBe(false);
    // The daily review still sees the folder activity, since context never touched its window.
    expect((await cli('start')).out.devFoldersWithActivity).toBe(1);
  });

  it('review:setup makes the connection, saves the token privately and prints the routine', async () => {
    const setup = async (...args: string[]) => {
      try {
        return { out: (await run(process.execPath, ['automation/review.ts', 'setup', ...args], { cwd: ROOT, env })).stdout, err: '' };
      } catch (e) {
        return { out: '', err: (e as { stderr: string }).stderr };
      }
    };
    const first = await setup();
    expect(first.err).toBe('');
    expect(first.out).toContain('Created the "Daily review" connection. It can read, suggest changes, start tasks and finish tasks it has proof for, in every area.');
    const file = path.join(dataDir, 'review', 'token');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    // The routine names this repo and this copy's address and data folder, since they aren't the defaults.
    expect(first.out).toContain('[master-tasker-review] Run the Master Tasker daily review.');
    expect(first.out).toContain(path.join(ROOT, 'docs', 'REVIEW.md'));
    expect(first.out).toContain(`MASTER_TASKER_URL=${s.base} MT_DATA_DIR=`);
    expect(first.out).toContain(path.join(ROOT, 'automation', 'review.ts'));
    expect((await cli('start')).ok).toBe(true);

    expect((await setup()).out).toContain('already works');
    const clients = () => ui(s, 'GET', '/api/clients').then((r) => r.body.clients.filter((c: any) => c.name === 'Daily review'));
    expect(await clients()).toHaveLength(1);
    expect((await clients())[0].scopes.perms).toEqual(['read', 'propose', 'start', 'complete']);

    // A revoked connection gets replaced, and it says so.
    await ui(s, 'POST', `/api/clients/${(await clients())[0].id}/revoke`);
    expect((await cli('start')).err).toMatch(/revoked or deleted.*review:setup/);
    const again = await setup('--suggest-only');
    expect(again.out).toContain('no longer worked');
    expect(again.out).toContain('It can read and suggest changes, in every area.');
    expect((await cli('start')).ok).toBe(true);
  });

  it('watches no code folders until you name some', async () => {
    delete env.MT_DEV_ROOTS;
    await writeToken();
    const none = await cli('start');
    expect(none.out.devFoldersTracked).toBe(0);
    const out = (await run(process.execPath, ['automation/review.ts', 'setup', '--folders', path.join(s.dir, 'development')], { cwd: ROOT, env })).stdout;
    expect(out).toContain(`Code folders it watches: ${path.join(s.dir, 'development')}`);
    expect(fs.readFileSync(path.join(dataDir, 'devscan', 'folders.txt'), 'utf8')).toContain(path.join(s.dir, 'development'));
    expect((await cli('start')).out.devFoldersWithActivity).toBe(1);
    const bad = await run(process.execPath, ['automation/review.ts', 'setup', '--folders', path.join(s.dir, 'nope')], { cwd: ROOT, env }).catch((e) => e);
    expect(bad.stderr).toContain('No folder at');
  });

  it('stops when automation is paused', async () => {
    await writeToken();
    await ui(s, 'PATCH', '/api/settings', { automationPaused: true });
    const r = await cli('start');
    expect(r.out.paused).toBe(true);
    expect((await cli('context')).out.paused).toBe(true);
  });
});
