import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { listBackups, openDatabase, verifyBackup } from '../server/db.ts';
import { LATEST_SCHEMA, migrations, type Migration } from '../server/migrations.ts';
import { listenEvents, startServer, tempDir, ui } from './helpers.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitHealthy(port: number, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not become healthy');
}

function spawnServer(dir: string, port: number): ChildProcess {
  return spawn(process.execPath, ['server/main.ts'], {
    cwd: ROOT,
    env: { ...process.env, MT_DATA_DIR: path.join(dir, 'data'), MT_LOG_DIR: path.join(dir, 'logs'), MT_PORT: String(port) },
    stdio: 'ignore',
  });
}

const H = { 'x-master-tasker': 'web', 'content-type': 'application/json', 'x-session-id': 'durability-1' };

describe('restart persistence', () => {
  it('keeps edits across a clean restart', async () => {
    const dir = tempDir();
    const a = await startServer({ dir });
    const t = (await ui(a, 'POST', '/api/tasks', { title: 'Survives restart' })).body.task;
    await ui(a, 'PATCH', `/api/tasks/${t.id}`, { baseRev: 1, patch: { notes: 'edited before restart', priority: 'high' } });
    const seqBefore = (await ui(a, 'GET', '/api/sync')).body.seq;
    await a.stop();

    const b = await startServer({ dir });
    const after = (await ui(b, 'GET', `/api/tasks/${t.id}`)).body.task;
    expect(after).toMatchObject({ title: 'Survives restart', notes: 'edited before restart', priority: 'high', rev: 2 });
    expect((await ui(b, 'GET', '/api/sync')).body.seq).toBe(seqBefore);
    // Samples are seeded once, never again.
    expect((await ui(b, 'GET', '/api/areas')).body.areas).toHaveLength(6);
    await b.stop();
  });

  it('keeps acknowledged writes after the process is killed with SIGKILL', async () => {
    const dir = tempDir();
    const port = await freePort();
    let proc = spawnServer(dir, port);
    await waitHealthy(port);
    const r = await fetch(`http://127.0.0.1:${port}/api/tasks`, { method: 'POST', headers: H, body: JSON.stringify({ title: 'Written right before a crash' }) });
    const { task } = await r.json();
    proc.kill('SIGKILL');
    await new Promise((res) => proc.once('exit', res));

    proc = spawnServer(dir, port);
    await waitHealthy(port);
    const back = await (await fetch(`http://127.0.0.1:${port}/api/tasks/${task.id}`)).json();
    expect(back.task.title).toBe('Written right before a crash');
    proc.kill('SIGTERM');
    await new Promise((res) => proc.once('exit', res));
  }, 30_000);
});

describe('backups and restore', () => {
  it('restores a backup from the app, keeps a safety copy, and tells live clients to resync', async () => {
    const s = await startServer();
    const keep = (await ui(s, 'POST', '/api/tasks', { title: 'Keep me' })).body.task;
    const backup = (await ui(s, 'POST', '/api/backups', {})).body.name;
    const later = (await ui(s, 'POST', '/api/tasks', { title: 'Made after the backup' })).body.task;
    await ui(s, 'DELETE', `/api/tasks/${keep.id}`);
    const live = listenEvents(s);
    await live.opened;

    const r = await ui(s, 'POST', '/api/backups/restore', { name: backup });
    expect(r.status).toBe(200);
    expect(r.body.safetyBackup).toMatch(/pre-restore/);
    await live.waitFor((e) => e.type === 'reset');
    live.close();

    expect((await ui(s, 'GET', `/api/tasks/${keep.id}`)).status).toBe(200);
    expect((await ui(s, 'GET', `/api/tasks/${later.id}`)).status).toBe(404);
    // The pre-restore safety copy still has the newer task.
    const safety = listBackups(s.config.backupDir).find((b) => b.name === r.body.safetyBackup)!;
    const db = new DatabaseSync(safety.file, { readOnly: true });
    expect(db.prepare('SELECT title FROM tasks WHERE id = ?').get(later.id)).toBeTruthy();
    db.close();
    // The server keeps working after the swap.
    expect((await ui(s, 'POST', '/api/tasks', { title: 'After restore' })).status).toBe(201);
    await s.stop();
  });

  it('rejects restoring a file that is not a healthy backup', async () => {
    const s = await startServer();
    expect((await ui(s, 'POST', '/api/backups/restore', { name: '../../etc/passwd' })).status).toBe(404);
    const junk = path.join(s.config.backupDir, 'master-tasker-20990101-000000-junk.db');
    fs.writeFileSync(junk, 'not a database');
    expect(verifyBackup(junk).ok).toBe(false);
    expect((await ui(s, 'POST', '/api/backups/restore', { name: path.basename(junk) })).status).toBe(422);
    expect((await ui(s, 'GET', '/api/health')).body.db).toBe('ok');
    await s.stop();
  });

  it('restores with the CLI when the service is stopped', async () => {
    const dir = tempDir();
    const port = await freePort();
    const s = await startServer({ dir, port });
    const t = (await ui(s, 'POST', '/api/tasks', { title: 'In the backup' })).body.task;
    const name = (await ui(s, 'POST', '/api/backups', {})).body.name;
    await ui(s, 'DELETE', `/api/tasks/${t.id}`);
    const file = path.join(s.config.backupDir, name);
    const env = { ...process.env, MT_DATA_DIR: path.join(dir, 'data'), MT_LOG_DIR: path.join(dir, 'logs'), MT_PORT: String(port) };

    const refused = spawnSync(process.execPath, ['server/cli.ts', 'restore', file, '--yes'], { cwd: ROOT, env, encoding: 'utf8' });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('is running');
    await s.stop();

    const noYes = spawnSync(process.execPath, ['server/cli.ts', 'restore', file], { cwd: ROOT, env, encoding: 'utf8' });
    expect(noYes.status).toBe(1);
    const ok = spawnSync(process.execPath, ['server/cli.ts', 'restore', file, '--yes'], { cwd: ROOT, env, encoding: 'utf8' });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain('Restored');

    const again = await startServer({ dir });
    expect((await ui(again, 'GET', `/api/tasks/${t.id}`)).body.task.deletedAt).toBeNull();
    await again.stop();
  }, 30_000);
});

describe('migrations', () => {
  it('backs up an existing database before migrating it', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'm.db');
    const backupDir = path.join(dir, 'backups');
    openDatabase(dbPath, { backupDir }).close();
    expect(listBackups(backupDir)).toHaveLength(0); // brand-new database: nothing to back up

    const next = LATEST_SCHEMA + 1;
    const extra: Migration = { version: next, name: 'add column', destructive: false, up: (db) => db.exec('ALTER TABLE tasks ADD COLUMN extra TEXT') };
    const db = openDatabase(dbPath, { backupDir, migrations: [...migrations, extra] });
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(next);
    db.close();
    const backups = listBackups(backupDir);
    expect(backups).toHaveLength(1);
    expect(backups[0].reason).toBe(`pre-migration-v${LATEST_SCHEMA}-to-v${next}`);
  });

  it('upgrades a real v1 database to the latest schema, keeping its data', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'm.db');
    const backupDir = path.join(dir, 'backups');
    const v1 = openDatabase(dbPath, { backupDir, migrations: migrations.slice(0, 1) });
    v1.exec("INSERT INTO counters (name, value) VALUES ('probe', 7)");
    v1.close();
    const db = openDatabase(dbPath, { backupDir });
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(LATEST_SCHEMA);
    expect(db.prepare("SELECT value FROM counters WHERE name = 'probe'").get()).toEqual({ value: 7 });
    expect((db.prepare('PRAGMA table_info(proposals)').all() as { name: string }[]).map((c) => c.name)).toContain('answer');
    db.close();
    expect(listBackups(backupDir)[0].reason).toBe(`pre-migration-v1-to-v${LATEST_SCHEMA}`);
  });

  it('moves areas from the old palette to the new one, and leaves picked colors alone', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'm.db');
    const backupDir = path.join(dir, 'backups');
    const v11 = openDatabase(dbPath, { backupDir, migrations: migrations.filter((m) => m.version <= 11) });
    const add = v11.prepare("INSERT INTO areas (id, name, color, position, created_at, updated_at) VALUES (?, ?, ?, 0, '2026-01-01', '2026-01-01')");
    add.run('a1', 'Work', '#2563EB');
    add.run('a2', 'Home', '#be185d');
    add.run('a3', 'Mine', '#123456');
    v11.close();
    const db = openDatabase(dbPath, { backupDir });
    const colors = Object.fromEntries((db.prepare('SELECT id, color FROM areas').all() as { id: string; color: string }[]).map((r) => [r.id, r.color]));
    db.close();
    expect(colors).toEqual({ a1: '#526AC3', a2: '#AB4A7D', a3: '#123456' });
    expect(listBackups(backupDir)[0].reason).toBe(`pre-migration-v11-to-v${LATEST_SCHEMA}`);
  });

  it('rolls back a failing migration and leaves data intact', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'm.db');
    const backupDir = path.join(dir, 'backups');
    const db1 = openDatabase(dbPath, { backupDir });
    db1.exec("INSERT INTO counters (name, value) VALUES ('probe', 42)");
    db1.close();
    const bad: Migration = {
      version: LATEST_SCHEMA + 1,
      name: 'broken',
      destructive: true,
      up: (db) => {
        db.exec('DELETE FROM counters');
        throw new Error('boom');
      },
    };
    expect(() => openDatabase(dbPath, { backupDir, migrations: [...migrations, bad] })).toThrow(/rolled back/);
    const db2 = new DatabaseSync(dbPath);
    expect((db2.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(LATEST_SCHEMA);
    expect(db2.prepare("SELECT value FROM counters WHERE name = 'probe'").get()).toEqual({ value: 42 });
    db2.close();
  });

  it('refuses to open a database from a newer app version', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'm.db');
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA user_version = 99');
    db.close();
    expect(() => openDatabase(dbPath, { backupDir: path.join(dir, 'b') })).toThrow(/newer than this app/);
  });
});
