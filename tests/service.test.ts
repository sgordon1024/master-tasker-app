// scripts/service.sh, with launchctl swapped for tests/fixtures/fake-launchctl and a throwaway home
// folder, so nothing here touches the real launchd, LaunchAgents or data. Builds are not run here.
// curl is a stand-in that refuses port 4820, so no test can take the installed app's answer for this copy's.
// Node downloads come from tests/fixtures/fake-dist.mjs, never from nodejs.org.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures');
const LABEL = 'local.master-tasker.server';
let home: string;
let fake: string;
let bin: string;
let servers: ChildProcess[] = [];

/** A copy of the scripts folder at `where`, so the script's own folder can be anywhere. */
function copyAt(where: string) {
  fs.mkdirSync(path.join(where, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts', 'service.sh'), path.join(where, 'scripts', 'service.sh'));
  return path.join(where, 'scripts', 'service.sh');
}

/** Runs a script with a command, or a command and its options. An env value of undefined leaves that variable out. */
function run(script: string, cmd: string | string[], env: Record<string, string | undefined> = {}) {
  const all = { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, FAKE_LAUNCHCTL_DIR: fake, MT_NODE: process.execPath, MT_PORT: '4879', ...env };
  const r = spawnSync('/bin/zsh', [script, ...(Array.isArray(cmd) ? cmd : cmd ? [cmd] : [])], {
    env: Object.fromEntries(Object.entries(all).filter(([, v]) => v !== undefined)) as Record<string, string>,
    encoding: 'utf8',
    input: '',
    timeout: 30_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr, calls: fs.existsSync(path.join(fake, 'calls')) ? fs.readFileSync(path.join(fake, 'calls'), 'utf8') : '' };
}

const plistPath = () => path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
/** A plist like the one install writes, for a service installed from `folder`. */
function installedFrom(folder: string, loadedFrom = plistPath()) {
  fs.mkdirSync(path.dirname(plistPath()), { recursive: true });
  fs.writeFileSync(
    plistPath(),
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>${LABEL}</string><key>ProgramArguments</key><array><string>/usr/local/bin/node</string><string>${folder}/server/main.ts</string></array><key>WorkingDirectory</key><string>${folder}</string></dict></plist>\n`,
  );
  fs.writeFileSync(path.join(fake, LABEL), loadedFrom);
}

const hcPlistPath = () => path.join(home, 'Library', 'LaunchAgents', 'local.master-tasker.healthcheck.plist');
const plistEnv = (file: string, key: string) => spawnSync('/usr/libexec/PlistBuddy', ['-c', `Print :EnvironmentVariables:${key}`, file], { encoding: 'utf8' }).stdout.trim();
const plistArgs = (file: string) => JSON.parse(spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }).stdout).ProgramArguments as string[];

function fixture(name: string, to: string) {
  fs.copyFileSync(path.join(FIXTURES, name), to);
  fs.chmodSync(to, 0o755);
}

/**
 * A copy that really starts: launchctl is tests/fixtures/fake-launchd, which runs the plist's server/main.ts,
 * here tests/fixtures/fake-server.mjs. npm does nothing. It runs next to the node the script picks, bin/node.
 */
function startable(where: string) {
  const script = copyAt(where);
  fs.mkdirSync(path.join(where, 'server'));
  fs.copyFileSync(path.join(FIXTURES, 'fake-server.mjs'), path.join(where, 'server', 'main.ts'));
  fixture('fake-launchctl', path.join(bin, 'fake-launchctl'));
  fixture('fake-launchd', path.join(bin, 'launchctl'));
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return script;
}

const NODE_VERSION = /^NODE_VERSION="([^"]+)"/m.exec(fs.readFileSync(path.join(ROOT, 'scripts', 'service.sh'), 'utf8'))![1];

/**
 * A folder laid out like nodejs.org/dist, with a stand-in Node for both Mac processors: its bin/node runs the
 * node running these tests, and its bin/npm does nothing. Returns the release folder in it.
 */
function fakeDist(dir: string) {
  const release = path.join(dir, `v${NODE_VERSION}`);
  const stage = path.join(dir, 'stage');
  fs.mkdirSync(release, { recursive: true });
  const sums: string[] = [];
  for (const arch of ['arm64', 'x64']) {
    const name = `node-v${NODE_VERSION}-darwin-${arch}`;
    fs.mkdirSync(path.join(stage, name, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(stage, name, 'bin', 'node'), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(stage, name, 'bin', 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const tarball = path.join(release, `${name}.tar.gz`);
    spawnSync('tar', ['-czf', tarball, '-C', stage, name]);
    sums.push(`${crypto.createHash('sha256').update(fs.readFileSync(tarball)).digest('hex')}  ${name}.tar.gz`);
  }
  fs.writeFileSync(path.join(release, 'SHASUMS256.txt'), `${sums.join('\n')}\n`);
  return release;
}

/** tests/fixtures/fake-dist.mjs serving `dir`, in its own process. Returns its address and the file it lists requests in. */
async function distServer(dir: string) {
  const log = path.join(home, 'dist-requests');
  fs.writeFileSync(log, '');
  const c = spawn(process.execPath, [path.join(FIXTURES, 'fake-dist.mjs'), dir, log], { stdio: ['ignore', 'pipe', 'inherit'] });
  servers.push(c);
  const port = await new Promise<number>((resolve, reject) => {
    c.stdout!.on('data', (d) => {
      const m = /listening (\d+)/.exec(String(d));
      if (m) resolve(Number(m[1]));
    });
    c.once('exit', (code) => reject(new Error(`fake dist exited with ${code}`)));
  });
  return { url: `http://127.0.0.1:${port}`, log };
}

async function freePort() {
  const srv = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const { port } = srv.address() as net.AddressInfo;
  await new Promise((r) => srv.close(r));
  return port;
}

/** A server answering health checks on `port`, in its own process so it answers while a script runs. */
async function serve(port: number, dataDir: string, log = '') {
  const c = spawn(process.execPath, [path.join(FIXTURES, 'fake-server.mjs')], { env: { MT_PORT: String(port), MT_DATA_DIR: dataDir, FAKE_SERVER_LOG: log }, stdio: ['ignore', 'pipe', 'inherit'] });
  servers.push(c);
  await new Promise<void>((resolve, reject) => {
    c.stdout!.on('data', (d) => String(d).includes('listening') && resolve());
    c.once('exit', (code) => reject(new Error(`fake server exited with ${code}`)));
  });
  return c;
}

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mt-service-')));
  fake = path.join(home, 'launchd');
  bin = path.join(home, 'bin');
  fs.mkdirSync(fake);
  fs.mkdirSync(bin);
  fixture('fake-launchctl', path.join(bin, 'launchctl'));
  fs.writeFileSync(path.join(bin, 'curl'), '#!/bin/sh\ncase "$*" in *127.0.0.1:4820/*) exit 7 ;; esac\nexec /usr/bin/curl "$@"\n', { mode: 0o755 });
});
afterEach(() => {
  for (const c of servers) c.kill();
  servers = [];
  // Servers fake-launchd started.
  for (const f of fs.readdirSync(fake).filter((n) => n.endsWith('.pid'))) {
    try {
      process.kill(Number(fs.readFileSync(path.join(fake, f), 'utf8')));
    } catch {
      // already gone
    }
  }
  fs.rmSync(home, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'darwin' || !fs.existsSync('/bin/zsh'))('service.sh', () => {
  it('checks Node before installing anything, and says where to get it', () => {
    const script = copyAt(path.join(home, 'mt'));
    const old = path.join(bin, 'old-node');
    fs.writeFileSync(old, '#!/bin/sh\ncase "$1" in --version) echo v20.11.0 ;; -p) echo 20 ;; esac\n', { mode: 0o755 });
    let r = run(script, 'install', { MT_NODE: old });
    // 3 tells the double-click installer to open nodejs.org.
    expect(r.code).toBe(3);
    expect(r.err).toContain('Node v20.11.0, which is too old');
    // Both ways to get it: a private copy, or the installer for the whole Mac.
    expect(r.err).toContain('./scripts/service.sh get-node');
    expect(r.err).toContain('https://nodejs.org/en/download and press macOS Installer (.pkg), not the commands');
    r = run(script, 'install', { MT_NODE: path.join(bin, 'no-node-here') });
    expect(r.err).toContain("this Mac doesn't have it");
    // Without a Terminal to ask in, it doesn't download anything.
    expect(r.out).not.toContain('Downloading');
    expect(fs.existsSync(plistPath())).toBe(false);
    expect(r.calls).not.toContain('bootstrap');
  });

  it('refuses a folder macOS keeps background apps out of, and says what to do', () => {
    for (const [where, name] of [['Downloads', 'Downloads'], ['Documents', 'Documents'], ['Desktop', 'Desktop'], ['Library/Mobile Documents/com~apple~CloudDocs', 'iCloud Drive']]) {
      const r = run(copyAt(path.join(home, where, 'master-tasker')), 'install');
      expect(r.code).toBe(1);
      expect(r.err).toContain(`inside your ${name} folder`);
      expect(r.err).toContain('Go > Home');
    }
    expect(fs.existsSync(plistPath())).toBe(false);
  });

  it('refuses a port something else is using, before building', async () => {
    const srv = net.createServer().listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const port = (srv.address() as net.AddressInfo).port;
    const r = run(copyAt(path.join(home, 'mt')), 'install', { MT_PORT: String(port) });
    srv.close();
    // 4 tells the double-click installer to offer another port.
    expect(r.code).toBe(4);
    expect(r.err).toContain(`already using port ${port}`);
    expect(r.out).toContain('✓ Node');
    expect(r.out).not.toContain('Installing what it needs');
  });

  it('shows where it was installed from and what launchd says', () => {
    const dir = path.join(home, 'mt');
    const script = copyAt(dir);
    installedFrom(dir);
    const r = run(script, 'status');
    expect(r.code).toBe(0);
    expect(r.out).toContain(`installed from: ${dir}`);
    expect(r.out).toContain('\n  state = running\n');
    expect(r.out).toContain('\n  pid = 4242\n');
    expect(r.out).toContain('health: not responding');
  });

  it('uninstalls even when the folder it was installed from is gone, and lists what is left', () => {
    const script = copyAt(path.join(home, 'mt'));
    installedFrom(path.join(home, 'moved-away'));
    const data = path.join(home, 'data');
    fs.mkdirSync(path.join(data, 'claude'), { recursive: true });
    fs.writeFileSync(path.join(data, 'claude', 'token'), 'x');
    // Install offers to take it over, but only when someone answers.
    let r = run(script, 'install', { MT_DATA_DIR: data });
    expect(r.code).toBe(1);
    expect(r.out).toContain('no longer exists');
    expect(r.err).toContain('answer y');
    expect(fs.readFileSync(plistPath(), 'utf8')).toContain('moved-away');

    r = run(script, 'uninstall', { MT_DATA_DIR: data });
    expect(r.code).toBe(0);
    expect(fs.existsSync(plistPath())).toBe(false);
    expect(r.calls).toContain(`bootout gui/${process.getuid!()}/${LABEL}`);
    expect(r.out).toContain(`Your tasks and backups: ${data}`);
    expect(r.out).toContain('The Claude threads token');
    // Nothing answers, so there's nothing to disconnect Claude from. It says so, and still uninstalls.
    expect(r.out).toContain("isn't running, so it couldn't undo the Claude setups, if any");
    // Deleting the tasks for good is Finder steps, not a command to paste.
    expect(r.out).toContain('Go > Go to Folder');
    expect(r.out).toContain('drag that folder to the Trash');
    expect(r.out).not.toContain('rm -rf');
  });

  it("leaves another folder's service alone", () => {
    const other = path.join(home, 'other-copy');
    fs.mkdirSync(other);
    const script = copyAt(path.join(home, 'mt'));
    installedFrom(other);
    for (const cmd of ['install', 'start', 'restart', 'stop', 'update', 'uninstall']) {
      const r = run(script, cmd);
      expect(r.code).toBe(1);
      expect(r.err).toContain(`Another Master Tasker folder owns the service: ${other}`);
    }
    expect(fs.existsSync(plistPath())).toBe(true);
    expect(fs.readFileSync(path.join(fake, 'calls'), 'utf8')).not.toMatch(/bootout|bootstrap|kickstart/);
  });

  it('never touches a service loaded from another home folder', () => {
    const script = copyAt(path.join(home, 'mt'));
    fs.writeFileSync(path.join(fake, LABEL), `/Users/you/Library/LaunchAgents/${LABEL}.plist`);
    const r = run(script, 'uninstall');
    expect(r.code).toBe(1);
    expect(r.err).toContain('another home folder');
    expect(r.calls).not.toMatch(/bootout|kickstart/);
  });

  it('update and installing again keep the port and folders picked at install', async () => {
    const script = startable(path.join(home, 'mt'));
    const node = path.join(bin, 'node');
    const port = String(await freePort());
    const picked = { MT_PORT: port, MT_DATA_DIR: path.join(home, 'my data'), MT_LOG_DIR: path.join(home, 'my logs') };
    let r = run(script, 'install', { ...picked, MT_NODE: node });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`✓ Running at http://127.0.0.1:${port}`);

    // Neither one is told the port or folders again.
    for (const cmd of ['update', 'install']) {
      r = run(script, cmd, { MT_PORT: undefined, MT_NODE: node });
      expect(r.code, r.err).toBe(0);
      expect(r.out).toContain(`✓ Running at http://127.0.0.1:${port}`);
      for (const [key, value] of Object.entries(picked)) {
        expect(plistEnv(plistPath(), key)).toBe(value);
        // The health check gets them too, so it checks the right port and keeps its count in the right folder.
        expect(plistEnv(hcPlistPath(), key)).toBe(value);
      }
    }
    expect(JSON.parse(fs.readFileSync(path.join(picked.MT_DATA_DIR, 'server.pid'), 'utf8')).port).toBe(Number(port));
    // Node 24's warning that SQLite is experimental stays out of launchd.err.log, where it looked like the error.
    expect(plistArgs(plistPath())).toEqual([node, '--no-warnings=ExperimentalWarning', path.join(home, 'mt', 'server', 'main.ts')]);

    // One you set still wins.
    const other = String(await freePort());
    r = run(script, 'update', { MT_PORT: other, MT_NODE: node });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`✓ Running at http://127.0.0.1:${other}`);
    expect(plistEnv(plistPath(), 'MT_PORT')).toBe(other);
    expect(plistEnv(plistPath(), 'MT_DATA_DIR')).toBe(picked.MT_DATA_DIR);
  });

  it("start doesn't take another server answering on its port for this copy", async () => {
    const dir = path.join(home, 'mt');
    const script = copyAt(dir);
    installedFrom(dir);
    const port = await freePort();
    const data = path.join(home, 'data');
    // Another copy of Master Tasker, with its own data folder, has the port and answers health checks.
    await serve(port, path.join(home, 'other-data'));
    let r = run(script, 'start', { MT_PORT: String(port), MT_DATA_DIR: data });
    expect(r.code).toBe(4);
    expect(r.err).toContain(`Another copy of Master Tasker is already running on port ${port}`);
    expect(r.out).not.toContain('Running');
    expect(r.calls).not.toMatch(/bootstrap|kickstart/);

    // Nor does a pid file in this copy's data folder, when that process isn't the one on the port.
    fs.mkdirSync(data);
    fs.writeFileSync(path.join(data, 'server.pid'), JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString() }));
    r = run(script, 'start', { MT_PORT: String(port), MT_DATA_DIR: data });
    expect(r.code).toBe(4);
    expect(r.err).toContain('Another copy of Master Tasker');
    expect(r.calls).not.toMatch(/bootstrap|kickstart/);
  });

  it('the health check restarts a server that stops answering twice in a row, in a data folder of your own', async () => {
    const hc = path.join(home, 'mt', 'scripts', 'healthcheck.sh');
    fs.mkdirSync(path.dirname(hc), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'scripts', 'healthcheck.sh'), hc);
    // Nothing answers on this port. The data folder doesn't exist yet.
    const data = path.join(home, 'my data');
    const env = { MT_PORT: String(await freePort()), MT_DATA_DIR: data, MT_LOG_DIR: path.join(home, 'my logs') };
    let r = run(hc, '', env);
    expect(r.out).toContain('health check failed (1 in a row)');
    expect(r.calls).not.toContain('kickstart');
    r = run(hc, '', env);
    expect(r.out).toContain('health check failed (2 in a row)');
    expect(r.calls).toContain(`kickstart -k gui/${process.getuid!()}/${LABEL}`);
    expect(fs.existsSync(path.join(data, '.healthcheck-failures'))).toBe(false);
  });

  it("open and status don't take another server answering on the port for this copy", async () => {
    const script = copyAt(path.join(home, 'mt'));
    // An open that writes down what it was asked to open, so no browser opens.
    const opened = path.join(home, 'opened');
    fs.writeFileSync(path.join(bin, 'open'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${opened}'\n`, { mode: 0o755 });
    const data = path.join(home, 'data');
    // Another copy of Master Tasker, with its own data folder, answers on the port.
    const port = await freePort();
    await serve(port, path.join(home, 'other-data'));
    let r = run(script, 'open', { MT_PORT: String(port), MT_DATA_DIR: data });
    expect(r.code).toBe(1);
    expect(r.err).toContain(`Something else is answering at http://127.0.0.1:${port}, not this Master Tasker`);
    expect(fs.existsSync(opened)).toBe(false);
    r = run(script, 'status', { MT_PORT: String(port), MT_DATA_DIR: data });
    expect(r.out).toContain(`health: something else is answering at http://127.0.0.1:${port}`);
    expect(r.out).not.toContain('"ok":true');

    // This copy's own server, keeping its pid file in this data folder.
    const mine = await freePort();
    await serve(mine, data);
    r = run(script, 'open', { MT_PORT: String(mine), MT_DATA_DIR: data });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`✓ Opened http://127.0.0.1:${mine}`);
    expect(fs.readFileSync(opened, 'utf8')).toBe(`http://127.0.0.1:${mine}\n`);
    r = run(script, 'status', { MT_PORT: String(mine), MT_DATA_DIR: data });
    expect(r.out).toContain('health: {"ok":true');
  });

  it('opens only when it is running, and logs say how to stop', async () => {
    const script = copyAt(path.join(home, 'mt'));
    expect(run(script, 'open').err).toContain("isn't running at http://127.0.0.1:4879");
    const logs = path.join(home, 'logs');
    const p = spawn('/bin/zsh', [script, 'logs'], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, MT_LOG_DIR: logs } });
    let out = '';
    await new Promise<void>((resolve) => p.stdout.on('data', (d) => (out += d) && out.includes('Control-C') && resolve()));
    p.kill();
    expect(out).toContain('launchd.err.log');
    expect(out).toContain('server.log');
    expect(fs.existsSync(path.join(logs, 'launchd.err.log'))).toBe(true);
  });

  it('get-node downloads Node just for this copy, checked against its checksum, and install then uses it', async () => {
    const dir = path.join(home, 'mt');
    const script = startable(dir);
    const dist = await distServer(path.dirname(fakeDist(path.join(home, 'dist'))));
    let r = run(script, 'get-node', { MT_NODE_DIST: dist.url });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`Downloading Node.js ${NODE_VERSION} for Master Tasker`);
    expect(r.out).toContain(`in ${dir}/.node. Only Master Tasker uses it.`);
    const asked = fs.readFileSync(dist.log, 'utf8');
    expect(asked).toMatch(new RegExp(`^/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-(arm64|x64)\\.tar\\.gz$`, 'm'));
    expect(asked).toContain(`/v${NODE_VERSION}/SHASUMS256.txt`);
    expect(fs.existsSync(path.join(dir, '.node-download'))).toBe(false);

    // With no MT_NODE, install picks it before any other Node, and the service runs with it.
    const node = path.join(dir, '.node', 'bin', 'node');
    r = run(script, 'install', { MT_NODE: undefined, MT_PORT: String(await freePort()), MT_DATA_DIR: path.join(home, 'data') });
    expect(r.code, r.err).toBe(0);
    expect(plistArgs(plistPath())[0]).toBe(node);
  });

  it('pins the checksums nodejs.org publishes for both Mac downloads, and checks them for downloads from nodejs.org', () => {
    const text = fs.readFileSync(path.join(ROOT, 'scripts', 'service.sh'), 'utf8');
    for (const arch of ['arm64', 'x64']) expect(text).toMatch(new RegExp(`^NODE_SHA256_${arch}="[0-9a-f]{64}"$`, 'm'));
    expect(text).toContain('"${(P)pinned}"');
  });

  it("get-node refuses a download that doesn't match its checksum, and changes nothing", async () => {
    const dir = path.join(home, 'mt');
    const script = copyAt(dir);
    const release = fakeDist(path.join(home, 'dist'));
    const sums = path.join(release, 'SHASUMS256.txt');
    const dist = await distServer(path.dirname(release));
    // The published checksums are for other files.
    fs.writeFileSync(sums, fs.readFileSync(sums, 'utf8').replace(/^[0-9a-f]{64}/gm, '0'.repeat(64)));
    let r = run(script, 'get-node', { MT_NODE_DIST: dist.url });
    expect(r.code).toBe(1);
    expect(r.err).toContain("doesn't match the checksum nodejs.org publishes for it, so it wasn't used");
    expect(r.err).toContain('macOS Installer (.pkg), not the commands');
    expect(fs.existsSync(path.join(dir, '.node'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.node-download'))).toBe(false);

    // No checksum for it at all is refused too, and a Node that's already there stays as it was.
    fs.writeFileSync(sums, '');
    fs.mkdirSync(path.join(dir, '.node', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.node', 'bin', 'node'), 'the one before');
    r = run(script, 'get-node', { MT_NODE_DIST: dist.url });
    expect(r.code).toBe(1);
    expect(r.err).toContain("doesn't match the checksum");
    expect(fs.readFileSync(path.join(dir, '.node', 'bin', 'node'), 'utf8')).toBe('the one before');

    // Nothing to download says so.
    fs.rmSync(release, { recursive: true });
    r = run(script, 'get-node', { MT_NODE_DIST: dist.url });
    expect(r.code).toBe(1);
    expect(r.err).toContain("The download didn't work");
    expect(fs.existsSync(path.join(dir, '.node-download'))).toBe(false);
  });

  it('install --yes moves a service whose folder is gone to this folder, without asking', async () => {
    const dir = path.join(home, 'mt');
    const script = startable(dir);
    installedFrom(path.join(home, 'moved-away'));
    const r = run(script, ['install', '--yes'], { MT_NODE: path.join(bin, 'node'), MT_PORT: String(await freePort()), MT_DATA_DIR: path.join(home, 'data') });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('as --yes says');
    expect(r.out).toContain('✓ Running at');
    expect(fs.readFileSync(plistPath(), 'utf8')).toContain(`<string>${dir}/server/main.ts</string>`);
  });

  it("uninstall doesn't ask another app on the port to disconnect Claude", async () => {
    const dir = path.join(home, 'mt');
    const script = copyAt(dir);
    installedFrom(dir);
    const port = await freePort();
    const log = path.join(home, 'requests');
    fs.writeFileSync(log, '');
    // Another copy of Master Tasker, with its own data folder, answers on the port.
    await serve(port, path.join(home, 'other-data'), log);
    const r = run(script, 'uninstall', { MT_PORT: String(port), MT_DATA_DIR: path.join(home, 'data') });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("couldn't undo the Claude setups");
    expect(fs.existsSync(plistPath())).toBe(false);
    expect(fs.readFileSync(log, 'utf8')).not.toMatch(/integrations|DELETE/);
  });
});
