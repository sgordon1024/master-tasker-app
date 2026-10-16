// The Claude setup in Settings > AI assistants: detection, setting up and removing the skill and Claude Desktop, and the routes.
// Every path here is in a temp folder (see startServer), never the real ~/.claude or Claude Desktop.
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeBinCandidates } from '../server/config.ts';
import { openDatabase } from '../server/db.ts';
import { REPO, stableNode } from '../server/integrations.ts';
import { initLog } from '../server/log.ts';
import { migrations } from '../server/migrations.ts';
import { asClient, makeClient, startServer, tempDir, ui, type TestServer } from './helpers.ts';

const FAKE = path.resolve(import.meta.dirname, 'fixtures', 'fake-claude.mjs');
let s: TestServer | null = null;
afterEach(async () => {
  await s?.stop();
  s = null;
});

/** A server with the Claude app "installed" and a copy of the skill to link. */
async function withClaude(opts: { app?: boolean; dir?: string; env?: Record<string, string> } = {}) {
  const dir = opts.dir ?? tempDir();
  if (opts.app !== false) fs.mkdirSync(path.join(dir, 'Applications', 'Claude.app'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'skill', 'master-tasker'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skill', 'master-tasker', 'SKILL.md'), '---\nname: master-tasker\n---\n');
  s = await startServer({ dir, seed: false, env: opts.env });
  return s;
}
const status = async (srv: TestServer, refresh = true) => (await ui(srv, 'GET', `/api/integrations${refresh ? '?refresh=1' : ''}`)).body.integrations;
const p = (srv: TestServer) => ({
  skillLink: path.join(srv.dir, 'claude-skills', 'master-tasker'),
  skillDir: path.join(srv.dir, 'skill', 'master-tasker'),
  env: path.join(srv.dir, 'skill', 'master-tasker', '.local.env'),
  token: path.join(srv.dir, 'data', 'claude', 'token'),
  desktop: path.join(srv.dir, 'claude-desktop', 'claude_desktop_config.json'),
  tokens: path.join(srv.dir, 'data', 'tokens'),
});
const mode = (f: string) => fs.statSync(f).mode & 0o777;
const TOKEN = /mt_[A-Za-z0-9]{32}/;

describe('finding Claude', () => {
  it('reports nothing set up on a fresh install, in plain states', async () => {
    s = await startServer({ seed: false });
    const i = await status(s);
    expect(i).toMatchObject({
      claudeApp: { found: false },
      claudeCode: { found: false },
      skill: { state: 'missing', tokenWorks: false },
      desktop: { state: 'missing', tokenWorks: false, unreadable: false },
      threadLinking: false,
      skillReady: false,
      ready: false,
      paths: { node: stableNode(), mcpServer: path.join(REPO, 'mcp', 'server.ts'), url: `http://127.0.0.1:${s.port}` },
    });
  });

  it('finds the app and Claude Code, and notices changes when asked to check again', async () => {
    const srv = await withClaude({ env: { MT_CLAUDE_BIN: FAKE } });
    expect(await status(srv)).toMatchObject({ claudeApp: { found: true }, claudeCode: { found: true } });
    fs.rmSync(path.join(srv.dir, 'Applications', 'Claude.app'), { recursive: true });
    // Cached briefly, rechecked on request.
    expect((await status(srv, false)).claudeApp.found).toBe(true);
    expect((await status(srv)).claudeApp.found).toBe(false);
  });

  it('looks for Claude Code beyond the fixed places: npm global, ~/.npm-global and nvm', () => {
    const home = tempDir('mt-home-');
    fs.mkdirSync(path.join(home, '.nvm', 'versions', 'node', 'v22.3.0', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(home, '.nvm', 'versions', 'node', 'v24.10.0', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(home, '.nvm', 'alias'), { recursive: true });
    fs.writeFileSync(path.join(home, '.nvm', 'alias', 'default'), '22\n');
    fs.writeFileSync(path.join(home, '.npmrc'), 'prefix=~/npm-prefix\n');
    const list = claudeBinCandidates(home, { NVM_BIN: '/custom/nvm/bin' });
    expect(list.slice(0, 4)).toEqual(['/opt/homebrew/bin/claude', '/usr/local/bin/claude', path.join(home, '.local', 'bin', 'claude'), path.join(home, '.claude', 'local', 'claude')]);
    expect(list).toContain(path.join(path.dirname(process.execPath), 'claude'));
    expect(list).toContain(path.join(home, 'npm-prefix', 'bin', 'claude'));
    expect(list).toContain(path.join(home, '.npm-global', 'bin', 'claude'));
    expect(list).toContain('/custom/nvm/bin/claude');
    // nvm's default version first, then the rest, newest first.
    const nvm = list.filter((x) => x.includes('/.nvm/'));
    expect(nvm).toEqual([path.join(home, '.nvm', 'versions', 'node', 'v22.3.0', 'bin', 'claude'), path.join(home, '.nvm', 'versions', 'node', 'v24.10.0', 'bin', 'claude')]);
  });

  it('is only for you: connections get 403', async () => {
    s = await startServer({ seed: false });
    const { token } = await makeClient(s);
    expect((await asClient(s, token, 'GET', '/api/integrations')).status).toBe(403);
    expect((await asClient(s, token, 'POST', '/api/integrations/claude-code', {})).status).toBe(403);
    expect((await asClient(s, token, 'POST', '/api/integrations/claude-desktop', {})).status).toBe(403);
    expect((await asClient(s, token, 'DELETE', '/api/integrations/claude-desktop')).status).toBe(403);
  });
});

describe('Set up Claude Code', () => {
  it('links the skill, writes .local.env and a private token, and turns on thread linking', async () => {
    const srv = await withClaude();
    const f = p(srv);
    const r = await ui(srv, 'POST', '/api/integrations/claude-code', {});
    expect(r.status).toBe(200);
    expect(r.body.integrations).toMatchObject({ skill: { state: 'linked', tokenWorks: true, upToDate: true }, threadLinking: true, ready: true });

    expect(fs.lstatSync(f.skillLink).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(f.skillLink)).toBe(f.skillDir);
    expect(fs.readFileSync(f.env, 'utf8')).toBe(`MT_DATA_DIR='${path.join(srv.dir, 'data')}'\nMASTER_TASKER_URL='http://127.0.0.1:${srv.port}'\nMT_NODE='${stableNode()}'\n`);

    const token = fs.readFileSync(f.token, 'utf8');
    expect(token).toMatch(/^mt_[A-Za-z0-9]{32}$/);
    expect(mode(f.token)).toBe(0o600);
    expect(mode(path.dirname(f.token))).toBe(0o700);
    const who = await asClient(srv, token, 'GET', '/api/whoami');
    expect(who.body).toMatchObject({ actor: { label: 'Claude threads' }, scopes: { areas: '*', unfiled: true, perms: ['read', 'update', 'complete', 'start'] } });
    expect((await ui(srv, 'GET', '/api/settings')).body.settings.threadLinking).toBe(true);

    // Pressing it again keeps the same working token and the same one connection.
    await ui(srv, 'POST', '/api/integrations/claude-code', {});
    expect(fs.readFileSync(f.token, 'utf8')).toBe(token);
    expect((await ui(srv, 'GET', '/api/clients')).body.clients.filter((c: any) => c.name === 'Claude threads')).toHaveLength(1);
  });

  it('counts a .local.env written by the install script, with its comment line, as up to date', async () => {
    const srv = await withClaude();
    const f = p(srv);
    await ui(srv, 'POST', '/api/integrations/claude-code', {});
    fs.writeFileSync(f.env, `# Written by scripts/install-skill.sh\n${fs.readFileSync(f.env, 'utf8')}`);
    expect(await status(srv)).toMatchObject({ skill: { upToDate: true }, ready: true });
    fs.writeFileSync(f.env, `MT_DATA_DIR='/somewhere/else'\n`);
    expect(await status(srv)).toMatchObject({ skill: { upToDate: false }, ready: false });
  });

  it('writes the Node link that survives updates when it points at this same Node', () => {
    const dir = tempDir();
    const real = path.join(dir, 'Cellar', 'node', '24.1.0', 'bin', 'node');
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, '');
    const link = path.join(dir, 'bin-node');
    fs.symlinkSync(real, link);
    expect(stableNode(real, [path.join(dir, 'missing'), link])).toBe(link);
    // A link to some other Node doesn't count.
    const other = path.join(dir, 'other-node');
    fs.writeFileSync(other, '');
    expect(stableNode(other, [link])).toBe(other);
  });

  it('single-quotes values with quotes in them', async () => {
    const dir = path.join(tempDir(), "Riley's stuff");
    fs.mkdirSync(dir);
    const srv = await withClaude({ dir });
    await ui(srv, 'POST', '/api/integrations/claude-code', {});
    expect(fs.readFileSync(p(srv).env, 'utf8').split('\n')[0]).toBe(`MT_DATA_DIR='${path.join(dir, 'data').replace("'", "'\\''")}'`);
  });

  it('replaces a token whose connection was revoked or deleted', async () => {
    const srv = await withClaude();
    const f = p(srv);
    await ui(srv, 'POST', '/api/integrations/claude-code', {});
    const first = fs.readFileSync(f.token, 'utf8');
    const conn = (await ui(srv, 'GET', '/api/clients')).body.clients.find((c: any) => c.name === 'Claude threads');
    await ui(srv, 'POST', `/api/clients/${conn.id}/revoke`, {});
    expect(await status(srv)).toMatchObject({ skill: { state: 'linked', tokenWorks: false }, ready: false });

    await ui(srv, 'POST', '/api/integrations/claude-code', {});
    const second = fs.readFileSync(f.token, 'utf8');
    expect(second).not.toBe(first);
    expect((await asClient(srv, second, 'GET', '/api/whoami')).status).toBe(200);
    expect(mode(f.token)).toBe(0o600);

    // A token file that names nothing at all is replaced too.
    fs.writeFileSync(f.token, 'mt_' + 'x'.repeat(32), { mode: 0o600 });
    await ui(srv, 'POST', '/api/integrations/claude-code', {});
    expect(fs.readFileSync(f.token, 'utf8')).not.toBe('mt_' + 'x'.repeat(32));
    expect((await status(srv)).ready).toBe(true);
  });

  it('refuses when the skill name is taken by another folder, and never removes it or the token it may use', async () => {
    const srv = await withClaude();
    const f = p(srv);
    const other = path.join(srv.dir, 'someone-else', 'master-tasker');
    fs.mkdirSync(other, { recursive: true });
    fs.mkdirSync(path.dirname(f.skillLink), { recursive: true });
    fs.symlinkSync(other, f.skillLink);
    expect((await status(srv)).skill.state).toBe('other');

    const r = await ui(srv, 'POST', '/api/integrations/claude-code', {});
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/already has a master-tasker skill from another folder/);
    expect(fs.readlinkSync(f.skillLink)).toBe(other);
    expect(fs.existsSync(f.token)).toBe(false);

    // The token file is shared by every copy using this data folder, so the other skill may use it.
    // Remove takes out only this copy's .local.env, and leaves the token file and its connection.
    const { token } = await makeClient(srv, { name: 'Claude threads', perms: ['read', 'update', 'complete', 'start'] });
    fs.mkdirSync(path.dirname(f.token), { recursive: true });
    fs.writeFileSync(f.token, token, { mode: 0o600 });
    fs.writeFileSync(f.env, `MT_DATA_DIR='${path.join(srv.dir, 'data')}'\n`);
    const d = await ui(srv, 'DELETE', '/api/integrations/claude-code');
    expect(d.status).toBe(200);
    expect(d.body.message).toMatch(/left alone/);
    expect(fs.readlinkSync(f.skillLink)).toBe(other);
    expect(fs.readFileSync(f.token, 'utf8')).toBe(token);
    expect((await asClient(srv, token, 'GET', '/api/whoami')).status).toBe(200);
    expect(fs.existsSync(f.env)).toBe(false);

    // A real folder with that name is left alone too.
    fs.unlinkSync(f.skillLink);
    fs.mkdirSync(f.skillLink);
    expect((await ui(srv, 'POST', '/api/integrations/claude-code', {})).status).toBe(409);
    expect(fs.statSync(f.skillLink).isDirectory()).toBe(true);
  });

  it('replaces a link to a skill folder that is gone, as after this copy moved', async () => {
    const srv = await withClaude();
    const f = p(srv);
    fs.mkdirSync(path.dirname(f.skillLink), { recursive: true });
    fs.symlinkSync(path.join(srv.dir, 'old-place', 'claude', 'skills', 'master-tasker'), f.skillLink);
    expect((await status(srv)).skill.state).toBe('missing');

    const r = await ui(srv, 'POST', '/api/integrations/claude-code', {});
    expect(r.status).toBe(200);
    expect(r.body.integrations).toMatchObject({ skill: { state: 'linked', tokenWorks: true, upToDate: true }, ready: true });
    expect(fs.readlinkSync(f.skillLink)).toBe(f.skillDir);

    // Remove takes a link like that away too.
    fs.unlinkSync(f.skillLink);
    fs.symlinkSync(path.join(srv.dir, 'old-place', 'claude', 'skills', 'master-tasker'), f.skillLink);
    expect((await ui(srv, 'DELETE', '/api/integrations/claude-code')).status).toBe(200);
    expect(() => fs.lstatSync(f.skillLink)).toThrow();
  });

  it('Remove unlinks it, revokes its connection and deletes its files', async () => {
    const srv = await withClaude();
    const f = p(srv);
    await ui(srv, 'POST', '/api/integrations/claude-code', {});
    const token = fs.readFileSync(f.token, 'utf8');
    const r = await ui(srv, 'DELETE', '/api/integrations/claude-code');
    expect(r.status).toBe(200);
    expect(r.body.integrations).toMatchObject({ skill: { state: 'missing', tokenWorks: false }, ready: false });
    expect(fs.existsSync(f.skillLink)).toBe(false);
    expect(fs.existsSync(f.token)).toBe(false);
    expect(fs.existsSync(f.env)).toBe(false);
    expect(fs.existsSync(path.join(f.skillDir, 'SKILL.md'))).toBe(true);
    expect((await asClient(srv, token, 'GET', '/api/whoami')).status).toBe(401);
  });

  it('works without the Claude app: the skill is ready for Claude Code in Terminal', async () => {
    const srv = await withClaude({ app: false, env: { MT_CLAUDE_BIN: FAKE } });
    const r = await ui(srv, 'POST', '/api/integrations/claude-code', {});
    expect(r.status).toBe(200);
    expect(r.body.integrations).toMatchObject({ claudeApp: { found: false }, claudeCode: { found: true }, skillReady: true, ready: false });
    fs.mkdirSync(path.join(srv.dir, 'Applications', 'Claude.app'), { recursive: true });
    expect(await status(srv)).toMatchObject({ skillReady: true, ready: true });
  });

  it('Remove turns thread linking off again when Set up turned it on, and says so', async () => {
    const srv = await withClaude();
    await ui(srv, 'POST', '/api/integrations/claude-code', {});
    expect((await status(srv)).threadLinking).toBe(true);
    const r = await ui(srv, 'DELETE', '/api/integrations/claude-code');
    expect(r.body.message).toBe('Removed the skill from Claude Code and removed its access. Thread linking is off again, since Set up turned it on.');
    expect(r.body.integrations.threadLinking).toBe(false);
    expect((await ui(srv, 'GET', '/api/settings')).body.settings.threadLinking).toBe(false);
  });

  it('Remove leaves thread linking on when you turned it on yourself, before or after Set up', async () => {
    const srv = await withClaude();
    // On before Set up: Set up didn't turn it on.
    await ui(srv, 'PATCH', '/api/settings', { threadLinking: true });
    await ui(srv, 'POST', '/api/integrations/claude-code', {});
    let r = await ui(srv, 'DELETE', '/api/integrations/claude-code');
    expect(r.body.message).toBe('Removed the skill from Claude Code and removed its access.');
    expect(r.body.integrations.threadLinking).toBe(true);

    // Off, then Set up turns it on, then you switch it yourself: it's your choice from then on.
    await ui(srv, 'PATCH', '/api/settings', { threadLinking: false });
    await ui(srv, 'POST', '/api/integrations/claude-code', {});
    await ui(srv, 'PATCH', '/api/settings', { threadLinking: false });
    await ui(srv, 'PATCH', '/api/settings', { threadLinking: true });
    r = await ui(srv, 'DELETE', '/api/integrations/claude-code');
    expect(r.body.integrations.threadLinking).toBe(true);
    expect(r.body.message).not.toMatch(/Thread linking/);
  });
});

describe('Add to Claude Desktop', () => {
  const unrelated = { theme: 'dark', mcpServers: { files: { command: '/usr/bin/files-mcp', args: ['--root', '/tmp'] } } };
  const writeConfig = (srv: TestServer, text: string) => {
    fs.mkdirSync(path.dirname(p(srv).desktop), { recursive: true });
    fs.writeFileSync(p(srv).desktop, text);
  };
  const backups = (srv: TestServer) => fs.readdirSync(path.dirname(p(srv).desktop)).filter((n) => n.includes('.backup-'));
  const entryOf = (srv: TestServer) => JSON.parse(fs.readFileSync(p(srv).desktop, 'utf8')).mcpServers['master-tasker'];
  /** The entry this copy writes: its MCP server, with a token file in this copy's data folder. */
  const current = (srv: TestServer) => ({
    command: stableNode(),
    args: [path.join(REPO, 'mcp', 'server.ts')],
    env: { MASTER_TASKER_TOKEN_FILE: expect.stringMatching(new RegExp(`^${p(srv).tokens}/c_`)), MASTER_TASKER_URL: `http://127.0.0.1:${srv.port}` },
  });
  const connections = async (srv: TestServer) => (await ui(srv, 'GET', '/api/clients')).body.clients.filter((c: any) => c.name === 'Claude Desktop' && !c.revokedAt);

  it('merges one entry, keeps every other one, and backs up the old file first', async () => {
    const srv = await withClaude();
    const before = JSON.stringify(unrelated, null, 2);
    writeConfig(srv, before);
    const r = await ui(srv, 'POST', '/api/integrations/claude-desktop', {});
    expect(r.status).toBe(200);
    expect(r.body.message).toBe('Added to Claude Desktop. Quit Claude fully and reopen it.');
    expect(r.body.integrations.desktop).toEqual({ state: 'connected', tokenWorks: true, unreadable: false });

    const [backup] = backups(srv);
    expect(r.body.backup).toBe(backup);
    expect(fs.readFileSync(path.join(path.dirname(p(srv).desktop), backup), 'utf8')).toBe(before);

    const text = fs.readFileSync(p(srv).desktop, 'utf8');
    const after = JSON.parse(text);
    expect(after.theme).toBe('dark');
    expect(after.mcpServers.files).toEqual(unrelated.mcpServers.files);
    const entry = after.mcpServers['master-tasker'];
    expect(entry).toEqual(current(srv));
    expect(mode(p(srv).desktop)).toBe(0o600);
    // The token is in its own file, readable only by you, and nowhere in Claude's settings.
    const file = entry.env.MASTER_TASKER_TOKEN_FILE;
    const token = fs.readFileSync(file, 'utf8');
    expect(token).toMatch(TOKEN);
    expect(text).not.toContain(token);
    expect(text).not.toMatch(TOKEN);
    expect(mode(file)).toBe(0o600);
    expect(mode(path.dirname(file))).toBe(0o700);
    const who = await asClient(srv, token, 'GET', '/api/whoami');
    expect(who.body).toMatchObject({ actor: { label: 'Claude Desktop' }, scopes: { areas: '*', perms: ['read', 'propose'] } });

    // Remove: backs up again, takes out only its own entry, revokes the token and deletes its file.
    const d = await ui(srv, 'DELETE', '/api/integrations/claude-desktop');
    expect(d.body.message).toBe('Removed from Claude Desktop. Quit Claude fully and reopen it.');
    expect(backups(srv)).toHaveLength(2);
    expect(JSON.parse(fs.readFileSync(p(srv).desktop, 'utf8'))).toEqual(unrelated);
    expect((await asClient(srv, token, 'GET', '/api/whoami')).status).toBe(401);
    expect(fs.existsSync(file)).toBe(false);
    expect(d.body.integrations.desktop.state).toBe('missing');
  });

  it('writes an entry that works as Claude starts it', async () => {
    const srv = await withClaude();
    await ui(srv, 'POST', '/api/integrations/claude-desktop', {});
    const entry = entryOf(srv);
    const transport = new StdioClientTransport({ command: entry.command, args: entry.args, env: { ...entry.env, PATH: process.env.PATH ?? '' }, stderr: 'ignore' });
    const client = new Client({ name: 'claude-desktop-check', version: '1.0.0' });
    await client.connect(transport);
    const r = await client.callTool({ name: 'whoami', arguments: {} });
    await client.close();
    expect(JSON.parse((r as any).content[0].text).connection).toBe('Claude Desktop');
  });

  it('creates the file when Claude Desktop has none yet', async () => {
    const srv = await withClaude();
    const r = await ui(srv, 'POST', '/api/integrations/claude-desktop', {});
    expect(r.status).toBe(200);
    expect(r.body.backup).toBeNull();
    expect(Object.keys(JSON.parse(fs.readFileSync(p(srv).desktop, 'utf8')).mcpServers)).toEqual(['master-tasker']);
  });

  it('refuses a file it cannot read, and changes nothing', async () => {
    const srv = await withClaude();
    writeConfig(srv, '{ "mcpServers": { oops ');
    const r = await ui(srv, 'POST', '/api/integrations/claude-desktop', {});
    expect(r.status).toBe(422);
    expect(r.body.error.message).toMatch(/has a mistake in it, so Master Tasker left it alone/);
    expect(fs.readFileSync(p(srv).desktop, 'utf8')).toBe('{ "mcpServers": { oops ');
    expect(backups(srv)).toEqual([]);
    expect((await ui(srv, 'GET', '/api/clients')).body.clients).toEqual([]);
    expect((await status(srv)).desktop).toMatchObject({ state: 'missing', unreadable: true });
    expect((await ui(srv, 'DELETE', '/api/integrations/claude-desktop')).status).toBe(422);

    // mcpServers that isn't an object is a mistake too.
    writeConfig(srv, '{ "mcpServers": [] }');
    expect((await ui(srv, 'POST', '/api/integrations/claude-desktop', {})).status).toBe(422);
  });

  it("leaves another copy's master-tasker entry alone", async () => {
    const srv = await withClaude();
    const elsewhere = path.join(srv.dir, 'elsewhere', 'mcp', 'server.ts');
    fs.mkdirSync(path.dirname(elsewhere), { recursive: true });
    fs.writeFileSync(elsewhere, '');
    const theirs = { mcpServers: { 'master-tasker': { command: 'node', args: [elsewhere], env: { MASTER_TASKER_TOKEN: 'mt_theirs' } } } };
    writeConfig(srv, JSON.stringify(theirs));
    expect((await status(srv)).desktop.state).toBe('other');
    const r = await ui(srv, 'POST', '/api/integrations/claude-desktop', {});
    expect(r.status).toBe(409);
    expect(JSON.parse(fs.readFileSync(p(srv).desktop, 'utf8'))).toEqual(theirs);
    const d = await ui(srv, 'DELETE', '/api/integrations/claude-desktop');
    expect(d.body.message).toMatch(/left alone/);
    expect(JSON.parse(fs.readFileSync(p(srv).desktop, 'utf8'))).toEqual(theirs);
  });

  it('says its own entry needs an update after this copy moved or its port changed, and Update fixes it', async () => {
    const srv = await withClaude();
    const read = () => entryOf(srv);
    const tokenIn = (entry: any) => fs.readFileSync(entry.env.MASTER_TASKER_TOKEN_FILE, 'utf8');

    // This copy used to live somewhere else: that mcp/server.ts is gone, and so is its connection.
    const gone = path.join(srv.dir, 'old-place', 'mcp', 'server.ts');
    writeConfig(srv, JSON.stringify({ mcpServers: { 'master-tasker': { command: 'node', args: [gone], env: { MASTER_TASKER_TOKEN: 'mt_' + 'x'.repeat(32), MASTER_TASKER_URL: 'http://127.0.0.1:4830' } } } }));
    expect((await status(srv)).desktop).toEqual({ state: 'outdated', tokenWorks: false, unreadable: false });
    let r = await ui(srv, 'POST', '/api/integrations/claude-desktop', {});
    expect(r.status).toBe(200);
    expect(r.body.message).toBe('Updated Master Tasker in Claude Desktop. Quit Claude fully and reopen it.');
    expect(r.body.backup).toMatch(/^claude_desktop_config\.backup-/);
    expect(r.body.integrations.desktop).toEqual({ state: 'connected', tokenWorks: true, unreadable: false });
    expect(read()).toEqual(current(srv));
    const token = tokenIn(read());

    // Its port changed: same server file, old address. Update keeps the working token and fixes the address.
    writeConfig(srv, JSON.stringify({ mcpServers: { 'master-tasker': { ...read(), env: { ...read().env, MASTER_TASKER_URL: 'http://127.0.0.1:4830' } } } }));
    expect((await status(srv)).desktop).toEqual({ state: 'outdated', tokenWorks: true, unreadable: false });
    r = await ui(srv, 'POST', '/api/integrations/claude-desktop', {});
    expect(r.status).toBe(200);
    expect(read()).toEqual(current(srv));
    expect(tokenIn(read())).toBe(token);

    // A token that is a connection here makes it this copy's, even from another folder.
    const elsewhere = path.join(srv.dir, 'elsewhere', 'mcp', 'server.ts');
    fs.mkdirSync(path.dirname(elsewhere), { recursive: true });
    fs.writeFileSync(elsewhere, '');
    writeConfig(srv, JSON.stringify({ mcpServers: { 'master-tasker': { command: 'node', args: [elsewhere], env: { MASTER_TASKER_TOKEN: token, MASTER_TASKER_URL: `http://127.0.0.1:${srv.port}` } } } }));
    expect((await status(srv)).desktop.state).toBe('outdated');
    expect((await ui(srv, 'POST', '/api/integrations/claude-desktop', {})).status).toBe(200);
    expect(read()).toEqual(current(srv));
    expect(tokenIn(read())).toBe(token);
    expect(await connections(srv)).toHaveLength(1);

    // So does this copy's token file, with a live connection in it.
    writeConfig(srv, JSON.stringify({ mcpServers: { 'master-tasker': { command: 'node', args: [elsewhere], env: { MASTER_TASKER_TOKEN_FILE: read().env.MASTER_TASKER_TOKEN_FILE } } } }));
    expect((await status(srv)).desktop).toEqual({ state: 'outdated', tokenWorks: true, unreadable: false });
    expect((await ui(srv, 'POST', '/api/integrations/claude-desktop', {})).status).toBe(200);
    expect(tokenIn(read())).toBe(token);
    // A token file somewhere else doesn't, so another copy's entry is left alone.
    const theirs = path.join(srv.dir, 'elsewhere', 'token');
    fs.writeFileSync(theirs, token, { mode: 0o600 });
    writeConfig(srv, JSON.stringify({ mcpServers: { 'master-tasker': { command: 'node', args: [elsewhere], env: { MASTER_TASKER_TOKEN_FILE: theirs } } } }));
    expect((await status(srv)).desktop.state).toBe('other');

    // Remove takes out an old entry of its own too.
    writeConfig(srv, JSON.stringify({ mcpServers: { 'master-tasker': { command: 'node', args: [gone], env: { MASTER_TASKER_TOKEN: 'mt_old' } } } }));
    const d = await ui(srv, 'DELETE', '/api/integrations/claude-desktop');
    expect(d.body.message).toBe('Removed from Claude Desktop. Quit Claude fully and reopen it.');
    expect(JSON.parse(fs.readFileSync(p(srv).desktop, 'utf8')).mcpServers).toEqual({});
  });

  it('says an entry with the token written into it needs an update, and Update moves the token to a file', async () => {
    const srv = await withClaude();
    // What Add to Claude Desktop used to write.
    const { token } = await makeClient(srv, { name: 'Claude Desktop', perms: ['read', 'propose'] });
    const old = { command: stableNode(), args: [path.join(REPO, 'mcp', 'server.ts')], env: { MASTER_TASKER_TOKEN: token, MASTER_TASKER_URL: `http://127.0.0.1:${srv.port}` } };
    writeConfig(srv, JSON.stringify({ ...unrelated, mcpServers: { ...unrelated.mcpServers, 'master-tasker': old } }, null, 2));
    expect((await status(srv)).desktop).toEqual({ state: 'outdated', tokenWorks: true, unreadable: false });

    const r = await ui(srv, 'POST', '/api/integrations/claude-desktop', {});
    expect(r.status).toBe(200);
    expect(r.body.integrations.desktop).toEqual({ state: 'connected', tokenWorks: true, unreadable: false });
    // Backed up first, as Add does.
    expect(backups(srv)).toEqual([r.body.backup]);
    expect(fs.readFileSync(path.join(path.dirname(p(srv).desktop), r.body.backup), 'utf8')).toContain(token);
    const text = fs.readFileSync(p(srv).desktop, 'utf8');
    expect(text).not.toMatch(TOKEN);
    expect(JSON.parse(text).mcpServers.files).toEqual(unrelated.mcpServers.files);
    expect(entryOf(srv)).toEqual(current(srv));
    // Same connection, now in a file.
    expect(fs.readFileSync(entryOf(srv).env.MASTER_TASKER_TOKEN_FILE, 'utf8')).toBe(token);
    expect(await connections(srv)).toHaveLength(1);
  });

  it('leaves a settings file that is a link alone, so a token never lands in the folder it points to', async () => {
    const srv = await withClaude();
    const real = path.join(srv.dir, 'dotfiles', 'claude_desktop_config.json');
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.mkdirSync(path.dirname(p(srv).desktop), { recursive: true });
    fs.symlinkSync(real, p(srv).desktop);
    const text = JSON.stringify(unrelated, null, 2);
    fs.writeFileSync(real, text);

    const r = await ui(srv, 'POST', '/api/integrations/claude-desktop', {});
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/is a link to a file somewhere else, so Master Tasker left it alone/);
    expect(fs.lstatSync(p(srv).desktop).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, 'utf8')).toBe(text);
    expect(backups(srv)).toEqual([]);
    expect((await ui(srv, 'GET', '/api/clients')).body.clients).toEqual([]);

    // Remove doesn't write through it, or replace it, either.
    const ours = JSON.stringify({ mcpServers: { 'master-tasker': { command: stableNode(), args: [path.join(REPO, 'mcp', 'server.ts')], env: { MASTER_TASKER_URL: `http://127.0.0.1:${srv.port}` } } } });
    fs.writeFileSync(real, ours);
    expect((await ui(srv, 'DELETE', '/api/integrations/claude-desktop')).status).toBe(409);
    expect(fs.lstatSync(p(srv).desktop).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, 'utf8')).toBe(ours);
  });

  it('says its own entry needs an update when the Node it runs is gone, as after a Homebrew upgrade', async () => {
    const srv = await withClaude();
    await ui(srv, 'POST', '/api/integrations/claude-desktop', {});
    const gone = path.join(srv.dir, 'Cellar', 'node', '24.1.0', 'bin', 'node');
    writeConfig(srv, JSON.stringify({ ...unrelated, mcpServers: { ...unrelated.mcpServers, 'master-tasker': { ...entryOf(srv), command: gone } } }));
    expect((await status(srv)).desktop).toEqual({ state: 'outdated', tokenWorks: true, unreadable: false });
    // A Node that's there but can't run counts as gone too.
    const notRunnable = path.join(srv.dir, 'not-node');
    fs.writeFileSync(notRunnable, '', { mode: 0o644 });
    writeConfig(srv, JSON.stringify({ mcpServers: { 'master-tasker': { ...entryOf(srv), command: notRunnable } } }));
    expect((await status(srv)).desktop.state).toBe('outdated');
    // A bare name is looked up on Claude's own PATH, which Master Tasker can't see, so it isn't flagged.
    writeConfig(srv, JSON.stringify({ mcpServers: { 'master-tasker': { ...entryOf(srv), command: 'node' } } }));
    expect((await status(srv)).desktop.state).toBe('connected');

    writeConfig(srv, JSON.stringify({ mcpServers: { 'master-tasker': { ...entryOf(srv), command: gone } } }));
    const r = await ui(srv, 'POST', '/api/integrations/claude-desktop', {});
    expect(r.body.integrations.desktop).toEqual({ state: 'connected', tokenWorks: true, unreadable: false });
    expect(entryOf(srv).command).toBe(stableNode());
  });

  it("keeps only the newest 3 of its own backups in Claude's folder, and nothing else there is touched", async () => {
    const srv = await withClaude();
    writeConfig(srv, JSON.stringify(unrelated));
    const dir = path.dirname(p(srv).desktop);
    // Someone else's backups and notes, and two old ones of ours from the same second.
    fs.writeFileSync(path.join(dir, 'claude_desktop_config.backup-mine.json'), '{}');
    fs.writeFileSync(path.join(dir, 'claude_desktop_config.json.bak'), '{}');
    fs.writeFileSync(path.join(dir, 'claude_desktop_config.backup-20200101-000000.json'), '{}');
    fs.writeFileSync(path.join(dir, 'claude_desktop_config.backup-20200101-000000-2.json'), '{}');
    for (let n = 0; n < 3; n++) {
      expect((await ui(srv, 'POST', '/api/integrations/claude-desktop', {})).status).toBe(200);
      expect((await ui(srv, 'DELETE', '/api/integrations/claude-desktop')).status).toBe(200);
    }
    const ours = backups(srv).filter((f) => /\.backup-\d{8}-\d{6}(-\d+)?\.json$/.test(f));
    expect(ours).toHaveLength(3);
    expect(ours.some((f) => f.startsWith('claude_desktop_config.backup-2020'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'claude_desktop_config.backup-mine.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'claude_desktop_config.json.bak'))).toBe(true);
    // The newest one is the file as it was before the last change.
    const last = (await ui(srv, 'POST', '/api/integrations/claude-desktop', {})).body.backup;
    expect(backups(srv).filter((f) => /\.backup-\d{8}-\d{6}(-\d+)?\.json$/.test(f))).toContain(last);
    expect(JSON.parse(fs.readFileSync(path.join(dir, last), 'utf8'))).toEqual({ ...unrelated, mcpServers: unrelated.mcpServers });
  });

  it('needs the Claude app', async () => {
    const srv = await withClaude({ app: false });
    const r = await ui(srv, 'POST', '/api/integrations/claude-desktop', {});
    expect(r.status).toBe(409);
    expect(r.body.error.message).toBe('Install the Claude app first, then try again.');
    expect(fs.existsSync(p(srv).desktop)).toBe(false);
  });

  it('re-adding keeps the working token, so it stays one connection', async () => {
    const srv = await withClaude();
    await ui(srv, 'POST', '/api/integrations/claude-desktop', {});
    const first = entryOf(srv).env.MASTER_TASKER_TOKEN_FILE;
    const t1 = fs.readFileSync(first, 'utf8');
    await ui(srv, 'POST', '/api/integrations/claude-desktop', {});
    expect(entryOf(srv).env.MASTER_TASKER_TOKEN_FILE).toBe(first);
    expect(fs.readFileSync(first, 'utf8')).toBe(t1);
    expect((await ui(srv, 'GET', '/api/clients')).body.clients.filter((c: any) => c.name === 'Claude Desktop')).toHaveLength(1);

    // Access removed in Settings > AI assistants: its file goes, and Add again makes a new connection.
    const id = (await connections(srv))[0].id;
    await ui(srv, 'POST', `/api/clients/${id}/revoke`, {});
    expect(fs.existsSync(first)).toBe(false);
    expect((await status(srv)).desktop).toEqual({ state: 'connected', tokenWorks: false, unreadable: false });
    await ui(srv, 'POST', '/api/integrations/claude-desktop', {});
    expect((await status(srv)).desktop).toEqual({ state: 'connected', tokenWorks: true, unreadable: false });
    expect(fs.readFileSync(entryOf(srv).env.MASTER_TASKER_TOKEN_FILE, 'utf8')).not.toBe(t1);
  });
});

describe('thread linking is opt-in', () => {
  it('reads no thread files until you turn it on', async () => {
    s = await startServer({ seed: false });
    const t = (await ui(s, 'POST', '/api/tasks', { title: 'Linked later' })).body.task;
    const dir = path.join(s.dir, 'claude-projects', '-app');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sess-opt-in.jsonl'), JSON.stringify({ type: 'user', cwd: '/tmp', timestamp: new Date().toISOString(), message: { role: 'user', content: `About ${t.id}` } }) + '\n');
    expect((await ui(s, 'GET', `/api/tasks/${t.id}/threads?refresh=1`)).body.threads).toEqual([]);
    expect((await ui(s, 'GET', '/api/progress')).body.progress).toEqual([]);
    expect(s.app.service.db().prepare('SELECT count(*) AS n FROM claude_threads').get()).toEqual({ n: 0 });

    const r = await ui(s, 'PATCH', '/api/settings', { threadLinking: true });
    expect(r.body.settings.threadLinking).toBe(true);
    expect((await status(s)).threadLinking).toBe(true);
    expect((await ui(s, 'GET', `/api/tasks/${t.id}/threads?refresh=1`)).body.threads.map((x: any) => x.sessionId)).toEqual(['sess-opt-in']);
  });

  it('stays on for existing installs that already linked threads', () => {
    const dir = tempDir();
    initLog(path.join(dir, 'logs'), { console: false });
    const file = path.join(dir, 'old.db');
    const old = openDatabase(file, { backupDir: path.join(dir, 'backups'), migrations: migrations.filter((m) => m.version <= 9) });
    old.prepare("INSERT INTO claude_threads (session_id, file) VALUES ('s-old', '/x.jsonl')").run();
    old.close();
    const db = openDatabase(file, { backupDir: path.join(dir, 'backups') });
    expect(db.prepare("SELECT value FROM settings WHERE key = 'threadLinking'").get()).toEqual({ value: 'true' });
    db.close();

    const fresh = openDatabase(path.join(dir, 'new.db'), { backupDir: path.join(dir, 'backups') });
    expect(fresh.prepare("SELECT value FROM settings WHERE key = 'threadLinking'").get()).toBeUndefined();
    fresh.close();
  });
});

describe('connections', () => {
  it('can change what a connection sees and does after it is made, checked like creating one', async () => {
    s = await startServer();
    const { id, token } = await makeClient(s, { areas: '*', perms: ['read'] });
    const areas = (await ui(s, 'GET', '/api/areas')).body.areas;
    const r = await ui(s, 'PATCH', `/api/clients/${id}`, { scopes: { areas: [areas[0].id], unfiled: false, perms: ['read', 'propose'] } });
    expect(r.status).toBe(200);
    expect(r.body.client.scopes).toEqual({ areas: [areas[0].id], unfiled: false, perms: ['read', 'propose'] });
    expect((await asClient(s, token, 'GET', '/api/whoami')).body.scopes.perms).toEqual(['read', 'propose']);

    expect((await ui(s, 'PATCH', `/api/clients/${id}`, { scopes: { areas: ['a_doesnotexist0000'], unfiled: false, perms: ['read'] } })).status).toBe(422);
    expect((await ui(s, 'PATCH', `/api/clients/${id}`, { scopes: { areas: '*', unfiled: true, perms: [] } })).status).toBe(422);
    expect((await asClient(s, token, 'PATCH', `/api/clients/${id}`, { scopes: { areas: '*', unfiled: true, perms: ['read', 'create'] } })).status).toBe(403);

    await ui(s, 'POST', `/api/clients/${id}/revoke`, {});
    expect((await ui(s, 'PATCH', `/api/clients/${id}`, { scopes: { areas: '*', unfiled: true, perms: ['read'] } })).status).toBe(409);
  });
});

describe('Accept all', () => {
  it("accepts one connection's pending suggestions, leaves questions and other connections alone", async () => {
    s = await startServer({ seed: false });
    const a = await makeClient(s, { name: 'Desktop', perms: ['read', 'propose'] });
    const b = await makeClient(s, { name: 'Other', perms: ['read', 'propose'] });
    const propose = (token: string, title: string) => asClient(s!, token, 'POST', '/api/proposals', { proposal: { kind: 'create', task: { title } } });
    await propose(a.token, 'One');
    await propose(a.token, 'Two');
    const three = (await propose(a.token, 'Three')).body.proposal;
    await asClient(s, a.token, 'POST', '/api/proposals', { proposal: { kind: 'question', question: 'Which area?' } });
    await propose(b.token, 'Not this one');

    // Only the ones you can see, when you say which.
    let r = await ui(s, 'POST', '/api/proposals/accept-all', { clientId: a.id, ids: [three.id] });
    expect(r.body).toEqual({ accepted: 1, failed: [] });
    r = await ui(s, 'POST', '/api/proposals/accept-all', { clientId: a.id });
    expect(r.body).toEqual({ accepted: 2, failed: [] });
    const titles = (await ui(s, 'GET', '/api/sync')).body.tasks.map((t: any) => t.title).sort();
    expect(titles).toEqual(['One', 'Three', 'Two']);
    const pending = (await ui(s, 'GET', '/api/proposals?status=pending')).body.proposals;
    expect(pending.map((x: any) => x.body.kind === 'question' ? 'question' : x.body.task.title).sort()).toEqual(['Not this one', 'question']);
    expect((await asClient(s, a.token, 'POST', '/api/proposals/accept-all', { clientId: a.id })).status).toBe(403);
  });
});
