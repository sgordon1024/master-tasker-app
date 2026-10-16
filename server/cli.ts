// Operations CLI. Usage: npm run cli -- <command> [options]
//   health                         Check the running service
//   backup                         Write a backup now (safe while running)
//   backups                        List backups
//   verify <file>                  Check a backup file is healthy
//   restore <file> --yes           Replace the database with a backup (service must be stopped)
//   token create --name N --kind claude|other --areas "Work,Personal"|"*" [--unfiled] [--perms read,create,update,complete,propose]
//   token list
//   token revoke <id>
// MT_PORT, MT_DATA_DIR and MT_LOG_DIR: what you set, else what the installed service uses, else the default.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { backupDatabase, listBackups, openDatabase, replaceDatabaseFile, verifyBackup } from './db.ts';
import { runningServerPid } from './app.ts';
import { loadConfig } from './config.ts';
import { initLog } from './log.ts';
import { createService, userCtx } from './service.ts';
import type { Permission } from '../shared/schema.ts';

/**
 * Fills in the port and folders the installed service was given, when you didn't set them, the same way
 * setting() in scripts/service.sh does. So this reaches a service installed with its own MT_PORT or MT_DATA_DIR.
 */
function withInstalledSettings(env: NodeJS.ProcessEnv, plist = path.join(os.homedir(), 'Library', 'LaunchAgents', 'local.master-tasker.server.plist')): NodeJS.ProcessEnv {
  const keys = ['MT_PORT', 'MT_DATA_DIR', 'MT_LOG_DIR'];
  if (keys.every((k) => env[k]) || !fs.existsSync(plist)) return env;
  let installed: Record<string, unknown>;
  try {
    installed = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).EnvironmentVariables ?? {};
  } catch {
    return env;
  }
  const out = { ...env };
  for (const k of keys) if (!out[k] && typeof installed[k] === 'string' && installed[k]) out[k] = installed[k];
  return out;
}

const config = loadConfig(withInstalledSettings(process.env));
initLog(config.logDir, { console: false });
const [cmd, sub, ...rest] = process.argv.slice(2);

async function serviceRunning(): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${config.port}/api/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

async function main() {
  switch (cmd) {
    case 'health': {
      try {
        const r = await fetch(`http://127.0.0.1:${config.port}/api/health`, { signal: AbortSignal.timeout(3000) });
        const body = await r.json();
        console.log(JSON.stringify(body, null, 2));
        process.exit(r.ok && body.ok && body.db === 'ok' ? 0 : 1);
      } catch {
        fail(`Not reachable on http://127.0.0.1:${config.port}`);
      }
      break;
    }
    case 'backup': {
      const db = openDatabase(config.dbPath, { backupDir: config.backupDir });
      const file = backupDatabase(db, config.backupDir, 'manual-cli');
      db.close();
      const check = verifyBackup(file);
      console.log(`✓ Backup written and verified (${check.tasks} tasks): ${file}`);
      break;
    }
    case 'backups': {
      for (const b of listBackups(config.backupDir)) console.log(`${b.createdAt}  ${(b.bytes / 1024).toFixed(0).padStart(6)} KB  ${b.name}`);
      break;
    }
    case 'verify': {
      if (!sub) fail('Usage: verify <file>');
      const check = verifyBackup(path.resolve(sub));
      if (!check.ok) fail(`Backup is not usable: ${check.problem}`);
      console.log(`✓ OK: schema v${check.schemaVersion}, ${check.tasks} tasks`);
      break;
    }
    case 'restore': {
      if (!sub) fail('Usage: restore <file> --yes');
      const file = path.resolve(sub);
      const check = verifyBackup(file);
      if (!check.ok) fail(`Backup is not usable: ${check.problem}`);
      if (runningServerPid(config) || (await serviceRunning())) fail('Master Tasker is running. Stop it first (./scripts/service.sh stop), or restore from Settings > Backups in the app.');
      if (!rest.includes('--yes')) fail(`This replaces ${config.dbPath} with ${file} (${check.tasks} tasks). Your current data is backed up first. Re-run with --yes.`);
      const { safetyBackup } = replaceDatabaseFile(config.dbPath, file, config.backupDir);
      const db = openDatabase(config.dbPath, { backupDir: config.backupDir });
      const n = (db.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n;
      db.close();
      console.log(`✓ Restored ${n} tasks from ${path.basename(file)}.`);
      if (safetyBackup) console.log(`  Previous data saved to ${safetyBackup}`);
      console.log('  Start the service again: ./scripts/service.sh start');
      break;
    }
    case 'token': {
      const db = openDatabase(config.dbPath, { backupDir: config.backupDir });
      const service = createService(db);
      const ctx = userCtx('cli');
      try {
        if (sub === 'list') {
          for (const c of service.listClients(ctx)) {
            const areas = c.scopes.areas === '*' ? '*' : c.scopes.areas.join(',');
            console.log(`${c.id}  ${c.kind.padEnd(8)} ${c.name.padEnd(24)} areas=${areas}${c.scopes.unfiled ? '+unfiled' : ''} perms=${c.scopes.perms.join(',')}${c.revokedAt ? '  REVOKED' : c.paused ? '  PAUSED' : ''}`);
          }
        } else if (sub === 'revoke') {
          if (!rest[0]) fail('Usage: token revoke <id>');
          service.revokeClient(ctx, rest[0]);
          // Its token file, if Settings made one, is no use any more.
          fs.rmSync(path.join(config.dataDir, 'tokens', path.basename(rest[0])), { force: true });
          console.log(`✓ Revoked ${rest[0]}`);
        } else if (sub === 'create') {
          const { values } = parseArgs({
            args: rest,
            options: { name: { type: 'string' }, kind: { type: 'string', default: 'other' }, areas: { type: 'string' }, unfiled: { type: 'boolean', default: false }, perms: { type: 'string', default: 'read,propose' } },
          });
          if (!values.name || !values.areas) fail('Usage: token create --name NAME --kind other --areas "Work,Personal" [--unfiled] [--perms read,create,update,complete,propose]');
          const all = service.listAreas(ctx);
          const areas =
            values.areas === '*'
              ? ('*' as const)
              : values.areas.split(',').map((n) => {
                  const a = all.find((x) => x.name.toLowerCase() === n.trim().toLowerCase() || x.id === n.trim());
                  if (!a) fail(`Unknown area "${n}". Areas: ${all.map((x) => x.name).join(', ')}`);
                  return a.id;
                });
          const { client, token } = service.createClient(ctx, {
            name: values.name,
            kind: values.kind,
            scopes: { areas, unfiled: values.unfiled, perms: values.perms!.split(',').map((p) => p.trim()) as Permission[] },
          });
          console.log(`✓ Gave “${client.name}” access (${client.id}, ${client.kind})`);
          console.log('  Token (shown once, store it in the assistant config):');
          console.log(`  ${token}`);
        } else fail('Usage: token create|list|revoke');
      } finally {
        db.close();
      }
      break;
    }
    default:
      console.log('Commands: health, backup, backups, verify <file>, restore <file> --yes, token create|list|revoke');
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
