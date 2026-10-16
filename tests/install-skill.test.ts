// scripts/install-skill.sh, run from a copy of the repo layout with a throwaway home folder and data
// folder, so the real skill link, token and settings file are never touched.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer, ui, type TestServer } from './helpers.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const exec = promisify(execFile);
let s: TestServer;
let repo: string;
let home: string;
let data: string;

const skillDir = () => path.join(repo, 'claude', 'skills', 'master-tasker');
const link = () => path.join(home, '.claude', 'skills', 'master-tasker');
const tokenFile = () => path.join(data, 'claude', 'token');

// Async, so the in-process test server can answer while the script runs. An env value of undefined leaves that variable out.
async function install(arg?: string, env: Record<string, string | undefined> = {}) {
  try {
    const r = await exec('/bin/zsh', [path.join(repo, 'scripts', 'install-skill.sh'), ...(arg ? [arg] : [])], {
      env: { PATH: process.env.PATH!, HOME: home, MT_PORT: String(s.port), MT_DATA_DIR: data, MT_CLAUDE_SKILLS_DIR: path.join(home, '.claude', 'skills'), ...env },
    });
    return { code: 0, out: r.stdout, err: r.stderr };
  } catch (e) {
    const x = e as { code: number; stdout: string; stderr: string };
    return { code: x.code, out: x.stdout, err: x.stderr };
  }
}

beforeEach(async () => {
  s = await startServer();
  repo = path.join(s.dir, 'repo');
  home = path.join(s.dir, 'home');
  data = path.join(s.dir, 'skill-data');
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.mkdirSync(skillDir(), { recursive: true });
  fs.mkdirSync(home);
  fs.copyFileSync(path.join(ROOT, 'scripts', 'install-skill.sh'), path.join(repo, 'scripts', 'install-skill.sh'));
  for (const f of ['ticket', 'SKILL.md']) fs.copyFileSync(path.join(ROOT, 'claude', 'skills', 'master-tasker', f), path.join(skillDir(), f));
  fs.chmodSync(path.join(skillDir(), 'ticket'), 0o755);
  fs.symlinkSync(path.join(ROOT, 'automation'), path.join(repo, 'automation'));
});
afterEach(() => s.stop());

describe.skipIf(!fs.existsSync('/bin/zsh'))('install-skill.sh', () => {
  it('connects, saves a private token, writes the settings file and links the skill', async () => {
    const r = await install();
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain('Created the "Claude threads" connection');
    expect(r.out).toContain('Checked: the skill reaches Master Tasker');
    expect(fs.statSync(tokenFile()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(tokenFile())).mode & 0o777).toBe(0o700);
    expect(fs.realpathSync(link())).toBe(fs.realpathSync(skillDir()));
    const env = fs.readFileSync(path.join(skillDir(), '.local.env'), 'utf8');
    expect(env).toContain(`MT_DATA_DIR='${path.resolve(data)}'`);
    expect(env).toContain(`MASTER_TASKER_URL='http://127.0.0.1:${s.port}'`);
    expect(env).toMatch(/^MT_NODE='\/.+node'$/m);
    const clients = (await ui(s, 'GET', '/api/clients')).body.clients;
    expect(clients.find((c: any) => c.name === 'Claude threads').scopes).toEqual({ areas: '*', unfiled: true, perms: ['read', 'update', 'complete', 'start'] });
    // Like Set up Claude Code in the app, it turns on linking threads to tasks.
    expect((await ui(s, 'GET', '/api/settings')).body.settings.threadLinking).toBe(true);

    // Running it again keeps a token that still works.
    const again = await install();
    expect(again.out).toContain('already works');
    expect((await ui(s, 'GET', '/api/clients')).body.clients.filter((c: any) => c.name === 'Claude threads')).toHaveLength(1);
  });

  it('replaces a token whose connection was revoked, and says so', async () => {
    await install();
    const old = fs.readFileSync(tokenFile(), 'utf8');
    const id = (await ui(s, 'GET', '/api/clients')).body.clients.find((c: any) => c.name === 'Claude threads').id;
    await ui(s, 'POST', `/api/clients/${id}/revoke`);
    const r = await install();
    expect(r.code).toBe(0);
    expect(r.out).toContain('stopped working');
    expect(r.out).toContain('Checked: the skill reaches Master Tasker');
    expect(fs.readFileSync(tokenFile(), 'utf8')).not.toBe(old);
  });

  it('never puts the token on a command line, where anyone on this Mac could see it', async () => {
    // A curl that writes down its arguments, then runs the real one.
    const bin = path.join(s.dir, 'bin');
    const seen = path.join(s.dir, 'curl-args');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${seen}'\nexec /usr/bin/curl "$@"\n`, { mode: 0o755 });
    const PATH = `${bin}:${process.env.PATH}`;
    await install(undefined, { PATH });
    // The second run checks the saved token.
    const r = await install(undefined, { PATH });
    expect(r.out).toContain('already works');
    const args = fs.readFileSync(seen, 'utf8');
    expect(args).toContain('/api/whoami');
    expect(args).not.toContain(fs.readFileSync(tokenFile(), 'utf8'));
  });

  it.skipIf(!fs.existsSync('/usr/libexec/PlistBuddy'))('uses the port and data folder the service was installed with, when they are not set', async () => {
    // The server plist as scripts/service.sh writes it, for a service on another port and data folder.
    const plist = path.join(home, 'Library', 'LaunchAgents', 'local.master-tasker.server.plist');
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>local.master-tasker.server</string><key>EnvironmentVariables</key><dict><key>MT_PORT</key><string>${s.port}</string><key>MT_DATA_DIR</key><string>${data}</string></dict></dict></plist>\n`,
    );
    // A curl that refuses 4820, so the default can never reach the installed app on this Mac.
    const bin = path.join(s.dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'curl'), '#!/bin/sh\ncase "$*" in *127.0.0.1:4820/*) exit 7 ;; esac\nexec /usr/bin/curl "$@"\n', { mode: 0o755 });
    const r = await install(undefined, { MT_PORT: undefined, MT_DATA_DIR: undefined, PATH: `${bin}:${process.env.PATH}` });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain('Checked: the skill reaches Master Tasker');
    expect(fs.statSync(tokenFile()).mode & 0o777).toBe(0o600);
    const env = fs.readFileSync(path.join(skillDir(), '.local.env'), 'utf8');
    expect(env).toContain(`MT_DATA_DIR='${path.resolve(data)}'`);
    expect(env).toContain(`MASTER_TASKER_URL='http://127.0.0.1:${s.port}'`);

    // One you set still wins.
    expect((await install(undefined, { MT_PORT: '1', MT_DATA_DIR: undefined, PATH: `${bin}:${process.env.PATH}` })).err).toContain("isn't running at http://127.0.0.1:1");
  });

  it('uses MT_NODE when you set it, else the Node the service runs with', async () => {
    const mine = path.join(s.dir, 'my-node');
    fs.symlinkSync(process.execPath, mine);
    let r = await install(undefined, { MT_NODE: mine });
    expect(r.code, r.err).toBe(0);
    const env = () => fs.readFileSync(path.join(skillDir(), '.local.env'), 'utf8');
    expect(env()).toContain(`MT_NODE='${mine}'`);

    // The installed service's Node, from its plist.
    const service = path.join(s.dir, 'service-node');
    fs.symlinkSync(process.execPath, service);
    const plist = path.join(home, 'Library', 'LaunchAgents', 'local.master-tasker.server.plist');
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>ProgramArguments</key><array><string>${service}</string><string>--no-warnings=ExperimentalWarning</string><string>${repo}/server/main.ts</string></array></dict></plist>\n`,
    );
    r = await install();
    expect(r.code, r.err).toBe(0);
    expect(env()).toContain(`MT_NODE='${service}'`);

    // An MT_NODE that's too old is refused, not swapped for another.
    const old = path.join(s.dir, 'old-node');
    fs.writeFileSync(old, '#!/bin/sh\necho 20\n', { mode: 0o755 });
    r = await install(undefined, { MT_NODE: old });
    expect(r.code).toBe(1);
    expect(r.err).toContain(`MT_NODE is ${old}, which isn't Node.js 24 or newer`);
  });

  it("the skill's runner falls back to the Node downloaded for this copy when its settings name one that's gone", async () => {
    await install();
    // The Node that ./scripts/service.sh get-node puts in the folder, and a settings file naming one that was deleted.
    const marker = path.join(s.dir, 'private-node-ran');
    fs.mkdirSync(path.join(repo, '.node', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.node', 'bin', 'node'), `#!/bin/sh\ntouch '${marker}'\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });
    const envFile = path.join(skillDir(), '.local.env');
    fs.writeFileSync(envFile, fs.readFileSync(envFile, 'utf8').replace(/^MT_NODE=.*$/m, "MT_NODE='/no/such/node'"));
    const r = await exec(path.join(link(), 'ticket'), ['get', 't_00000000000000']).catch((e) => e);
    expect(String(r.stderr) + String(r.stdout)).toContain('not found');
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('pre-approves its runner, and calls it the same way every time, so Claude Code needs no permission for it', () => {
    const skill = fs.readFileSync(path.join(ROOT, 'claude', 'skills', 'master-tasker', 'SKILL.md'), 'utf8');
    const front = /^---\n([\s\S]*?)\n---\n/.exec(skill)![1];
    expect(front).toMatch(/^allowed-tools:\n {2}- Bash\(\$\{CLAUDE_SKILL_DIR\}\/ticket \*\)$/m);
    // Every call is the runner by its full path, with no variable set first.
    const calls = [...skill.matchAll(/(\S*)\/ticket (get|fill|plan|start|done|needs-you|note|complete)\b/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(5);
    expect(new Set(calls)).toEqual(new Set(['${CLAUDE_SKILL_DIR}', '`${CLAUDE_SKILL_DIR}']));
    expect(skill).not.toMatch(/\bT=|"\$T"/);
  });

  it('says plainly when the app is not running', async () => {
    const r = await install(undefined, { MT_PORT: '1' });
    expect(r.code).toBe(1);
    expect(r.err).toContain("Master Tasker isn't running at http://127.0.0.1:1");
    expect(fs.existsSync(tokenFile())).toBe(false);
    expect(fs.existsSync(link())).toBe(false);
  });

  it("won't take over a skill another folder owns, or a real folder", async () => {
    const other = path.join(s.dir, 'other-skill');
    fs.mkdirSync(other);
    fs.mkdirSync(path.dirname(link()), { recursive: true });
    fs.symlinkSync(other, link());
    let r = await install();
    expect(r.code).toBe(1);
    expect(r.err).toContain('another copy of the skill');
    expect((await install('uninstall')).err).toContain('belongs to another Master Tasker folder');
    fs.unlinkSync(link()); // rmSync refuses a symlink to a folder on some Node 24 releases
    fs.mkdirSync(link());
    r = await install();
    expect(r.code).toBe(1);
    expect(r.err).toContain('is a real folder');
    expect(fs.existsSync(tokenFile())).toBe(false);
  });

  it('uninstall removes the link, the token file and the settings file', async () => {
    await install();
    const r = await install('uninstall');
    expect(r.code).toBe(0);
    expect(fs.existsSync(link())).toBe(false);
    expect(fs.existsSync(tokenFile())).toBe(false);
    expect(fs.existsSync(path.join(skillDir(), '.local.env'))).toBe(false);
    expect(r.out).toContain('Settings > AI assistants');
  });
});
