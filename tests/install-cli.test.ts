// npm run cli (server/cli.ts) finds a service installed with its own port and folders, the way
// scripts/service.sh does: from the installed LaunchAgent, when MT_PORT and MT_DATA_DIR aren't set.
// HOME is a throwaway folder, so the real LaunchAgent and data are never read.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
let home: string;
let server: ChildProcess | null = null;

/** Runs the CLI with only PATH and HOME, plus `env`. */
function cli(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'server', 'cli.ts'), ...args], { env: { PATH: process.env.PATH!, HOME: home, ...env }, encoding: 'utf8', timeout: 30_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** The server plist as scripts/service.sh writes it, for a service on its own port and folders. */
function installed(vars: Record<string, string>) {
  const plist = path.join(home, 'Library', 'LaunchAgents', 'local.master-tasker.server.plist');
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  const entries = Object.entries(vars).map(([k, v]) => `<key>${k}</key><string>${v}</string>`).join('');
  fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>local.master-tasker.server</string><key>EnvironmentVariables</key><dict>${entries}</dict></dict></plist>\n`);
}

async function freePort() {
  const srv = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const { port } = srv.address() as net.AddressInfo;
  await new Promise((r) => srv.close(r));
  return port;
}

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mt-cli-')));
});
afterEach(() => {
  server?.kill();
  server = null;
  fs.rmSync(home, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'darwin')('npm run cli', () => {
  it('uses the port and folders the service was installed with, when they are not set', async () => {
    const port = await freePort();
    const data = path.join(home, 'my data');
    installed({ MT_PORT: String(port), MT_DATA_DIR: data, MT_LOG_DIR: path.join(home, 'my logs') });
    // A stand-in for the installed app, answering health checks on its port.
    server = spawn(process.execPath, [path.join(ROOT, 'tests', 'fixtures', 'fake-server.mjs')], { env: { MT_PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve) => server!.stdout!.on('data', (d) => String(d).includes('listening') && resolve()));

    let r = cli(['health']);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ ok: true, db: 'ok' });

    r = cli(['token', 'create', '--name', 'Cursor', '--kind', 'other', '--areas', '*']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('✓ Gave “Cursor” access');
    expect(fs.existsSync(path.join(data, 'master-tasker.db'))).toBe(true);
    expect(fs.existsSync(path.join(home, 'Library', 'Application Support', 'MasterTasker'))).toBe(false);
    expect(cli(['token', 'list']).out).toContain('Cursor');

    // One you set still wins.
    const other = path.join(home, 'other data');
    r = cli(['token', 'list'], { MT_DATA_DIR: other });
    expect(r.code, r.err).toBe(0);
    expect(r.out).not.toContain('Cursor');
    expect(fs.existsSync(path.join(other, 'master-tasker.db'))).toBe(true);
    expect(cli(['health'], { MT_PORT: String(await freePort()) }).code).toBe(1);
  });
});
