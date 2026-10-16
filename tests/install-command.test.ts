// Install Master Tasker.command and Uninstall Master Tasker.command, the double-click installers. They run
// from a copy of the repo layout in a throwaway home folder, with answers typed on stdin. launchctl is
// tests/fixtures/fake-launchd, which starts tests/fixtures/fake-server.mjs as the app, npm does nothing,
// open writes down what it was asked to open, and curl refuses port 4820, the installed app's.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures');
const INSTALL = 'Install Master Tasker.command';
const UNINSTALL = 'Uninstall Master Tasker.command';
let home: string;
let fake: string;
let bin: string;
let opened: string;

/** A copy of the parts the installers use, at `where`, with the stand-in server as the app. */
function copyAt(where: string) {
  fs.mkdirSync(path.join(where, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(where, 'server'), { recursive: true });
  for (const f of [INSTALL, UNINSTALL, 'scripts/service.sh']) fs.copyFileSync(path.join(ROOT, f), path.join(where, f));
  fs.copyFileSync(path.join(FIXTURES, 'fake-server.mjs'), path.join(where, 'server', 'main.ts'));
  return where;
}

/** Double-clicks one of the installers in `folder`, with `answers` typed in. An env value of undefined leaves that variable out. */
function run(folder: string, file: string, answers: string, env: Record<string, string | undefined> = {}) {
  const all = { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, FAKE_LAUNCHCTL_DIR: fake, MT_NODE: path.join(bin, 'node'), MT_DATA_DIR: path.join(home, 'data'), MT_LOG_DIR: path.join(home, 'logs'), ...env };
  const r = spawnSync('/bin/zsh', [path.join(folder, file)], {
    env: Object.fromEntries(Object.entries(all).filter(([, v]) => v !== undefined)) as Record<string, string>,
    encoding: 'utf8',
    input: answers,
    timeout: 60_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr, opened: fs.existsSync(opened) ? fs.readFileSync(opened, 'utf8') : '' };
}

const plistPath = () => path.join(home, 'Library', 'LaunchAgents', 'local.master-tasker.server.plist');
const plistValue = (key: string) => spawnSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plistPath()], { encoding: 'utf8' }).stdout.trim();

async function freePort() {
  const srv = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const { port } = srv.address() as net.AddressInfo;
  await new Promise((r) => srv.close(r));
  return port;
}

function tool(name: string, text: string) {
  fs.writeFileSync(path.join(bin, name), text, { mode: 0o755 });
}

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mt-command-')));
  fake = path.join(home, 'launchd');
  bin = path.join(home, 'bin');
  opened = path.join(home, 'opened');
  fs.mkdirSync(fake);
  fs.mkdirSync(bin);
  fs.copyFileSync(path.join(FIXTURES, 'fake-launchctl'), path.join(bin, 'fake-launchctl'));
  fs.copyFileSync(path.join(FIXTURES, 'fake-launchd'), path.join(bin, 'launchctl'));
  fs.chmodSync(path.join(bin, 'fake-launchctl'), 0o755);
  fs.chmodSync(path.join(bin, 'launchctl'), 0o755);
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  tool('npm', '#!/bin/sh\nexit 0\n');
  tool('curl', '#!/bin/sh\ncase "$*" in *127.0.0.1:4820/*) exit 7 ;; esac\nexec /usr/bin/curl "$@"\n');
  tool('open', `#!/bin/sh\nprintf '%s\\n' "$*" >> '${opened}'\n`);
});
afterEach(() => {
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

describe.skipIf(process.platform !== 'darwin' || !fs.existsSync('/bin/zsh'))('Install Master Tasker.command', () => {
  it('offers to move the folder out of Downloads, moves it to ~/master-tasker, and installs from there', async () => {
    const downloads = copyAt(path.join(home, 'Downloads', 'master-tasker-main'));
    const port = await freePort();
    const r = run(downloads, INSTALL, 'y\n', { MT_PORT: String(port) });
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.out).toContain('in your Downloads folder');
    expect(r.out).toContain('Move Master Tasker to your home folder now? [Y/n]');
    const moved = path.join(home, 'master-tasker');
    expect(r.out).toContain(`✓ Moved it to ${moved}`);
    expect(fs.existsSync(downloads)).toBe(false);
    expect(fs.existsSync(path.join(moved, INSTALL))).toBe(true);
    // The service runs from the new place, and it opened.
    expect(plistValue('WorkingDirectory')).toBe(moved);
    expect(r.out).toContain(`✓ Running at http://127.0.0.1:${port}`);
    expect(r.opened).toBe(`http://127.0.0.1:${port}\n`);

    // Running it again, from the new place, updates the install in place.
    const again = run(moved, INSTALL, '', { MT_PORT: undefined });
    expect(again.code, again.out + again.err).toBe(0);
    expect(again.out).not.toContain('Move Master Tasker');
    expect(again.out).toContain(`✓ Running at http://127.0.0.1:${port}`);
  });

  it("moves nothing when you say no, or when there's already a master-tasker folder, and says how to do it in Finder", () => {
    const desktop = copyAt(path.join(home, 'Desktop', 'master-tasker-main'));
    let r = run(desktop, INSTALL, 'n\n');
    expect(r.code).toBe(1);
    expect(r.out).toContain('in your Desktop folder');
    expect(r.out).toContain('Nothing was moved');
    for (const step of ['press Command-C', 'choose Go > Home', 'press Command-Option-V']) expect(r.out).toContain(step);
    expect(fs.existsSync(desktop)).toBe(true);

    // No answer at all (the window was closed) is a no too.
    expect(run(desktop, INSTALL, '').out).toContain('Nothing was moved');

    fs.mkdirSync(path.join(home, 'master-tasker'));
    r = run(desktop, INSTALL, 'y\n');
    expect(r.code).toBe(1);
    expect(r.out).toContain('already has a folder called master-tasker, so nothing was moved');
    expect(r.out).toContain('rename it');
    expect(fs.existsSync(desktop)).toBe(true);
    expect(fs.readdirSync(path.join(home, 'master-tasker'))).toEqual([]);
    expect(fs.existsSync(plistPath())).toBe(false);
  });

  it('offers the next free port when another app has the port, and installs with it', async () => {
    const folder = copyAt(path.join(home, 'master-tasker'));
    // Another app listens on the port and never answers.
    const other = net.createServer().listen(0, '127.0.0.1');
    await new Promise((r) => other.once('listening', r));
    const taken = (other.address() as net.AddressInfo).port;
    try {
      const r = run(folder, INSTALL, 'y\n', { MT_PORT: String(taken) });
      expect(r.code, r.out + r.err).toBe(0);
      expect(r.err).toContain(`Something else is already using port ${taken}`);
      const port = Number(/Use port (\d+) instead\? \[Y\/n\]/.exec(r.out)?.[1]);
      expect(port).toBeGreaterThan(taken);
      expect(port).not.toBe(4820);
      expect(plistValue('EnvironmentVariables:MT_PORT')).toBe(String(port));
      expect(r.out).toContain(`✓ Running at http://127.0.0.1:${port}`);
      expect(r.out).toContain('press Set up again');
      expect(r.opened).toBe(`http://127.0.0.1:${port}\n`);
    } finally {
      other.close();
    }
  });

  it('says no to another port, and nothing is installed', async () => {
    const folder = copyAt(path.join(home, 'master-tasker'));
    const other = net.createServer().listen(0, '127.0.0.1');
    await new Promise((r) => other.once('listening', r));
    try {
      const r = run(folder, INSTALL, 'n\n', { MT_PORT: String((other.address() as net.AddressInfo).port) });
      expect(r.code).toBe(1);
      expect(r.out).toContain('Nothing changed. Quit the app that');
      expect(fs.existsSync(plistPath())).toBe(false);
    } finally {
      other.close();
    }
  });

  it('opens the Node.js download page when there is no Node to use', () => {
    const folder = copyAt(path.join(home, 'master-tasker'));
    tool('old-node', '#!/bin/sh\ncase "$1" in --version) echo v20.11.0 ;; -p) echo 20 ;; esac\n');
    const r = run(folder, INSTALL, '', { MT_NODE: path.join(bin, 'old-node'), MT_PORT: '4879' });
    expect(r.code).toBe(1);
    expect(r.err).toContain('Node v20.11.0, which is too old');
    expect(r.out).toContain('Press macOS Installer (.pkg), not the commands');
    expect(r.opened).toBe('https://nodejs.org/en/download\n');
    expect(fs.existsSync(plistPath())).toBe(false);
  });
});

describe.skipIf(process.platform !== 'darwin' || !fs.existsSync('/bin/zsh'))('Uninstall Master Tasker.command', () => {
  it('asks first, then uninstalls and keeps the tasks', async () => {
    const folder = copyAt(path.join(home, 'master-tasker'));
    const port = String(await freePort());
    expect(run(folder, INSTALL, '', { MT_PORT: port }).code).toBe(0);

    let r = run(folder, UNINSTALL, 'n\n', { MT_PORT: undefined });
    expect(r.code).toBe(0);
    expect(r.out).toContain('Uninstall Master Tasker? [y/N]');
    expect(r.out).toContain('Nothing changed');
    expect(fs.existsSync(plistPath())).toBe(true);

    r = run(folder, UNINSTALL, 'y\n', { MT_PORT: undefined });
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.out).toContain('✓ Removed the background service');
    expect(r.out).toContain(`Your tasks and backups: ${path.join(home, 'data')}`);
    expect(r.out).toContain('drag this Master Tasker folder to the Trash');
    expect(fs.existsSync(plistPath())).toBe(false);
    expect(fs.existsSync(path.join(home, 'data'))).toBe(true);
  });
});
