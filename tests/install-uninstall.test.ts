// scripts/service.sh uninstall, against a real Master Tasker in this process, with Claude Code and Claude
// Desktop set up in a throwaway folder. Uninstall asks the app to undo both before it stops it, the way the
// Remove buttons in Settings > AI assistants do. launchctl is tests/fixtures/fake-launchctl, so the real
// launchd and LaunchAgents are never touched, and curl refuses port 4820, the installed app's. When the
// script boots the service out, the test stops the server, as launchd would.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer, ui, type TestServer } from './helpers.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const LABEL = 'local.master-tasker.server';
const exec = promisify(execFile);
let s: TestServer;
let home: string;
let repo: string;
let bin: string;
let fake: string;
let stopped: Promise<void> | null;

const skillLink = () => path.join(s.config.claudeSkillsDir, 'master-tasker');
const desktop = () => JSON.parse(fs.readFileSync(s.config.claudeDesktopConfig, 'utf8'));

// Async, so the in-process server can answer while the script runs.
async function uninstall() {
  const booted = path.join(fake, 'booted-out');
  const watch = setInterval(() => {
    if (!stopped && fs.existsSync(booted)) stopped = s.stop();
  }, 50);
  try {
    const r = await exec('/bin/zsh', [path.join(repo, 'scripts', 'service.sh'), 'uninstall'], {
      env: { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, FAKE_LAUNCHCTL_DIR: fake, MT_PORT: String(s.port), MT_DATA_DIR: s.config.dataDir, MT_LOG_DIR: s.config.logDir },
    });
    return { code: 0, out: r.stdout, err: r.stderr };
  } catch (e) {
    const x = e as { code: number; stdout: string; stderr: string };
    return { code: x.code, out: x.stdout, err: x.stderr };
  } finally {
    clearInterval(watch);
  }
}

beforeEach(async () => {
  s = await startServer();
  stopped = null;
  home = path.join(s.dir, 'home');
  repo = path.join(s.dir, 'repo');
  bin = path.join(s.dir, 'bin');
  fake = path.join(s.dir, 'launchd');
  for (const d of [path.join(repo, 'scripts'), bin, fake, s.config.skillDir, path.dirname(s.config.claudeDesktopConfig), s.config.claudeAppPath]) fs.mkdirSync(d, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts', 'service.sh'), path.join(repo, 'scripts', 'service.sh'));
  fs.writeFileSync(path.join(s.config.skillDir, 'SKILL.md'), '---\nname: master-tasker\n---\n');
  fs.copyFileSync(path.join(ROOT, 'tests', 'fixtures', 'fake-launchctl'), path.join(bin, 'fake-launchctl'));
  fs.chmodSync(path.join(bin, 'fake-launchctl'), 0o755);
  fs.writeFileSync(path.join(bin, 'launchctl'), '#!/bin/zsh\n"${0:h}/fake-launchctl" "$@"\n[[ "$1" == bootout ]] && touch "$FAKE_LAUNCHCTL_DIR/booted-out"\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'curl'), '#!/bin/sh\ncase "$*" in *127.0.0.1:4820/*) exit 7 ;; esac\nexec /usr/bin/curl "$@"\n', { mode: 0o755 });
  // Installed from this copy, and loaded.
  const plist = path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>${LABEL}</string><key>ProgramArguments</key><array><string>${process.execPath}</string><string>${repo}/server/main.ts</string></array><key>WorkingDirectory</key><string>${repo}</string></dict></plist>\n`,
  );
  fs.writeFileSync(path.join(fake, LABEL), plist);
});
afterEach(() => stopped ?? s.stop());

describe.skipIf(process.platform !== 'darwin' || !fs.existsSync('/bin/zsh'))('service.sh uninstall', () => {
  it('disconnects Claude Code and Claude Desktop while the app is still running, then stops it', async () => {
    // Someone else's server in Claude Desktop stays.
    fs.writeFileSync(s.config.claudeDesktopConfig, JSON.stringify({ mcpServers: { other: { command: '/bin/echo' } } }));
    expect((await ui(s, 'POST', '/api/integrations/claude-code')).status).toBe(200);
    expect((await ui(s, 'POST', '/api/integrations/claude-desktop')).status).toBe(200);
    expect(fs.existsSync(skillLink())).toBe(true);
    expect(desktop().mcpServers['master-tasker']).toBeTruthy();

    const r = await uninstall();
    expect(r.code, r.err).toBe(0);
    expect(fs.existsSync(skillLink())).toBe(false);
    expect(desktop().mcpServers['master-tasker']).toBeUndefined();
    expect(desktop().mcpServers.other).toEqual({ command: '/bin/echo' });
    // Their tokens went with them.
    expect(fs.existsSync(path.join(s.config.dataDir, 'claude', 'token'))).toBe(false);
    expect(fs.readdirSync(path.join(s.config.dataDir, 'tokens'))).toEqual([]);
    // Each says what the app did, before the service goes.
    const lines = r.out.split('\n');
    const done = lines.findIndex((l) => l.startsWith('✓ Removed the background service'));
    expect(lines.filter((l, i) => l.startsWith('✓ ') && i < done)).toHaveLength(2);
    expect(r.out).not.toContain("couldn't undo the Claude setups");
    expect(fs.readFileSync(path.join(fake, 'calls'), 'utf8')).toContain(`bootout gui/${process.getuid!()}/${LABEL}`);
  });

  it('asks only about what is set up', async () => {
    const r = await uninstall();
    expect(r.code, r.err).toBe(0);
    expect(r.out.split('\n').filter((l) => l.startsWith('✓ '))).toEqual(['✓ Removed the background service. Master Tasker won\'t start at login any more.']);
    expect(r.out).not.toContain('✗');
  });
});
