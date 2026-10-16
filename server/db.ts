import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LATEST_SCHEMA, migrations, type Migration } from './migrations.ts';
import { log } from './log.ts';

export type DB = DatabaseSync;

export function openDatabase(dbPath: string, opts: { backupDir: string; migrations?: Migration[] }): DB {
  // Only you can read your tasks: new folders are 0700 and the database files 0600.
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const existed = fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0;
  const db = new DatabaseSync(dbPath);
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      fs.chmodSync(f, 0o600);
    } catch {}
  }
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  migrate(db, { existed, backupDir: opts.backupDir, list: opts.migrations ?? migrations });
  return db;
}

export function schemaVersion(db: DB): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

function migrate(db: DB, opts: { existed: boolean; backupDir: string; list: Migration[] }) {
  const current = schemaVersion(db);
  const latest = opts.list[opts.list.length - 1].version;
  if (current > latest) {
    throw new Error(`Database schema v${current} is newer than this app (v${latest}). Update the app or restore an older backup.`);
  }
  const pending = opts.list.filter((m) => m.version > current);
  if (pending.length === 0) return;

  // Always back up an existing database before changing its schema.
  if (opts.existed) {
    const file = backupDatabase(db, opts.backupDir, `pre-migration-v${current}-to-v${latest}`);
    log.info('pre-migration backup written', { file });
  } else if (pending.some((m) => m.destructive) && current > 0) {
    throw new Error('Refusing to run a destructive migration without a backup.');
  }

  for (const m of pending) {
    if (m.foreignKeysOff) db.exec('PRAGMA foreign_keys = OFF'); // has no effect inside a transaction, so set it first
    db.exec('BEGIN IMMEDIATE');
    try {
      m.up(db);
      if (m.foreignKeysOff) {
        const broken = db.prepare('PRAGMA foreign_key_check').all();
        if (broken.length) throw new Error(`foreign key check failed (${broken.length} rows)`);
      }
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
      log.info('migration applied', { version: m.version, name: m.name });
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration v${m.version} (${m.name}) failed and was rolled back: ${(err as Error).message}`);
    } finally {
      if (m.foreignKeysOff) db.exec('PRAGMA foreign_keys = ON');
    }
  }
}

/** Run fn inside a write transaction. Nested calls join the outer transaction. */
export function tx<T>(db: DB, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}

function stamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
}

/** Consistent online copy via VACUUM INTO. Safe while the server is running. */
export function backupDatabase(db: DB, backupDir: string, reason: string): string {
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const safeReason = reason.replace(/[^a-z0-9-]/gi, '-').slice(0, 60);
  let file = path.join(backupDir, `master-tasker-${stamp()}-${safeReason}.db`);
  for (let i = 2; fs.existsSync(file); i++) file = file.replace(/(-\d+)?\.db$/, `-${i}.db`);
  db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
  fs.chmodSync(file, 0o600);
  return file;
}

export interface BackupInfo {
  file: string;
  name: string;
  bytes: number;
  createdAt: string;
  reason: string;
}

export function listBackups(backupDir: string): BackupInfo[] {
  if (!fs.existsSync(backupDir)) return [];
  return fs
    .readdirSync(backupDir)
    .filter((n) => /^master-tasker-.*\.db$/.test(n))
    .map((name) => {
      const file = path.join(backupDir, name);
      const st = fs.statSync(file);
      const reason = name.replace(/^master-tasker-\d{8}-\d{6}-/, '').replace(/\.db$/, '');
      return { file, name, bytes: st.size, createdAt: st.mtime.toISOString(), reason };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

/** Keep the newest `keep` automatic backups. Safety backups (pre-*) are kept for 90 days. */
export function pruneBackups(backupDir: string, keep: number) {
  const all = listBackups(backupDir);
  const auto = all.filter((b) => b.reason.startsWith('auto'));
  for (const b of auto.slice(keep)) fs.rmSync(b.file);
  const cutoff = Date.now() - 90 * 24 * 3600 * 1000;
  const safety = all.filter((b) => !b.reason.startsWith('auto'));
  // Never delete the 10 most recent safety backups, regardless of age.
  for (const b of safety.slice(10)) if (Date.parse(b.createdAt) < cutoff) fs.rmSync(b.file);
}

export interface BackupCheck {
  ok: boolean;
  schemaVersion: number;
  tasks: number;
  problem?: string;
}

/** Open a backup read-only and confirm it is a healthy Master Tasker database. */
export function verifyBackup(file: string): BackupCheck {
  if (!fs.existsSync(file)) return { ok: false, schemaVersion: 0, tasks: 0, problem: 'File not found' };
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    if (integrity.integrity_check !== 'ok') return { ok: false, schemaVersion: 0, tasks: 0, problem: `Integrity check: ${integrity.integrity_check}` };
    const version = schemaVersion(db);
    if (version < 1) return { ok: false, schemaVersion: version, tasks: 0, problem: 'Not a Master Tasker database' };
    if (version > LATEST_SCHEMA) return { ok: false, schemaVersion: version, tasks: 0, problem: `Backup is schema v${version}, newer than this app` };
    const tasks = (db.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n;
    return { ok: true, schemaVersion: version, tasks };
  } catch (err) {
    return { ok: false, schemaVersion: 0, tasks: 0, problem: (err as Error).message };
  } finally {
    db?.close();
  }
}

/**
 * Replace the live database file with a verified backup.
 * The caller must have closed its connection first. The current file is backed up before replacement.
 */
export function replaceDatabaseFile(dbPath: string, backupFile: string, backupDir: string): { safetyBackup: string | null } {
  const check = verifyBackup(backupFile);
  if (!check.ok) throw new Error(`Backup failed verification: ${check.problem}`);
  let safetyBackup: string | null = null;
  if (fs.existsSync(dbPath)) {
    const current = new DatabaseSync(dbPath);
    try {
      safetyBackup = backupDatabase(current, backupDir, 'pre-restore');
    } finally {
      current.close();
    }
  }
  const tmp = `${dbPath}.restore-tmp`;
  fs.copyFileSync(backupFile, tmp);
  for (const suffix of ['-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
  fs.renameSync(tmp, dbPath);
  return { safetyBackup };
}
