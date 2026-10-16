// Tokens stay out of places they could leak from: the idempotency table (and so backups), the settings that
// Settings > AI assistants shows to paste, and app settings files. Connections made in Settings save their token to a file only you can read.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';
import { userCtx } from '../server/service.ts';
import { agentSnippets } from '../web/src/snippets.ts';
import { asClient, startServer, tempDir, ui, type TestServer } from './helpers.ts';

let s: TestServer | null = null;
afterEach(async () => {
  await s?.stop();
  s = null;
});

const mode = (f: string) => fs.statSync(f).mode & 0o777;
const newConnection = { name: 'Cursor', kind: 'other', scopes: { areas: '*', unfiled: true, perms: ['read', 'propose'] } };
/** Every answer the idempotency table keeps, as one string. */
const kept = (srv: TestServer) => (srv.app.service.db().prepare('SELECT response FROM idempotency').all() as { response: string }[]).map((r) => r.response).join('\n');

/** Starts the MCP server the way an app would from its settings, and asks who it is. */
async function whoamiWith(srv: TestServer, server: { command: string; args: string[]; env: Record<string, string> }) {
  const transport = new StdioClientTransport({ command: server.command, args: server.args, env: { ...server.env, PATH: process.env.PATH ?? '' }, stderr: 'ignore' });
  const client = new Client({ name: 'settings-check', version: '1.0.0' });
  await client.connect(transport);
  const r = await client.callTool({ name: 'whoami', arguments: {} });
  await client.close();
  return JSON.parse((r as any).content[0].text);
}

describe('idempotency never keeps a token', () => {
  it("leaves a new connection's token out, and a retry is told to make a new one", async () => {
    s = await startServer({ seed: false });
    const key = { 'idempotency-key': 'make-cursor-1' };
    const made = await ui(s, 'POST', '/api/clients', newConnection, key);
    expect(made.status).toBe(200);
    expect(made.body.token).toMatch(/^mt_[A-Za-z0-9]{32}$/);
    expect(kept(s)).not.toContain(made.body.token);
    expect(kept(s)).not.toMatch(/mt_[A-Za-z0-9]{32}/);

    // The retry doesn't make a second connection, and says why there's no token.
    const again = await ui(s, 'POST', '/api/clients', newConnection, key);
    expect(again.status).toBe(409);
    expect(again.headers.get('idempotent-replay')).toBe('true');
    expect(again.body.error.message).toBe('This connection was already created, and its token is shown only once. Make a new one.');
    expect(JSON.stringify(again.body)).not.toContain(made.body.token);
    expect((await ui(s, 'GET', '/api/clients')).body.clients.filter((c: any) => c.name === 'Cursor')).toHaveLength(1);

    // Other answers still replay as they were, with any token in them blanked out.
    const task = await ui(s, 'POST', '/api/tasks', { title: 'Paste the key', notes: `old: ${made.body.token}` }, { 'idempotency-key': 'task-with-token' });
    expect(task.status).toBe(201);
    expect(kept(s)).not.toContain(made.body.token);
    const replay = await ui(s, 'POST', '/api/tasks', { title: 'Paste the key', notes: `old: ${made.body.token}` }, { 'idempotency-key': 'task-with-token' });
    expect(replay.status).toBe(201);
    expect(replay.body.task.id).toBe(task.body.task.id);
  });

  it('scrubs tokens from answers kept before this, when the app starts', async () => {
    const dir = tempDir();
    s = await startServer({ dir, seed: false });
    const token = (await ui(s, 'POST', '/api/clients', newConnection)).body.token as string;
    const insert = s.app.service.db().prepare('INSERT INTO idempotency (actor_id, key, method, path, body_hash, status, response, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    insert.run('local-ui', 'old-key', 'POST', '/api/clients', 'x', 200, JSON.stringify({ client: { id: 'c_old' }, token }), new Date().toISOString());
    insert.run('local-ui', 'old-note', 'POST', '/api/tasks', 'y', 201, JSON.stringify({ task: { notes: `key ${token}` } }), new Date().toISOString());
    expect(kept(s)).toContain(token);
    await s.stop();

    s = await startServer({ dir, seed: false });
    expect(kept(s)).not.toContain(token);
    const rows = s.app.service.db().prepare('SELECT key, status FROM idempotency ORDER BY key').all();
    expect(rows).toEqual([
      { key: 'old-key', status: 409 },
      { key: 'old-note', status: 201 },
    ]);
  });
});

describe('AI assistants: a token file instead of the token', () => {
  it('saves the token to a private file, and the settings to paste name the file, never the token', async () => {
    // A space in the path, like Application Support.
    const dir = path.join(tempDir(), 'Application Support');
    fs.mkdirSync(dir);
    s = await startServer({ dir, seed: false });
    const r = await ui(s, 'POST', '/api/clients', { ...newConnection, tokenFile: true }, { 'idempotency-key': 'make-cursor-file' });
    expect(r.status).toBe(200);
    const { token, client } = r.body;
    const file = path.join(s.dir, 'data', 'tokens', client.id);
    expect(client.tokenFile).toBe(file);
    expect(fs.readFileSync(file, 'utf8')).toBe(token);
    expect(mode(file)).toBe(0o600);
    expect(mode(path.dirname(file))).toBe(0o700);
    expect(kept(s)).not.toContain(token);
    expect(kept(s)).not.toContain(file);

    const paths = (await ui(s, 'GET', '/api/integrations')).body.integrations.paths;
    const snippets = agentSnippets(client.tokenFile, paths);
    // In the order Settings > AI assistants lists them.
    expect(snippets.map((x) => x.id)).toEqual(['claude-code', 'codex', 'vscode', 'cursor', 'gemini', 'windsurf', 'other']);
    expect(snippets.map((x) => x.label)).toEqual(['Claude Code', 'Codex (ChatGPT)', 'GitHub Copilot (VS Code)', 'Cursor', 'Gemini CLI', 'Windsurf (Devin Desktop)', 'Other app']);
    for (const x of snippets) {
      expect(x.text, x.id).not.toContain(token);
      expect(x.text, x.id).not.toMatch(/mt_[A-Za-z0-9]{32}/);
      expect(x.text, x.id).toContain('MASTER_TASKER_TOKEN_FILE');
      expect(x.text, x.id).not.toMatch(/MASTER_TASKER_TOKEN\b(?!_FILE)/);
    }
    // The space in the path is quoted for the shell.
    expect(snippets[0].text).toContain(`-e 'MASTER_TASKER_TOKEN_FILE=${file}'`);
    // Codex gets its own command too, so nobody pastes its settings file twice.
    const codex = snippets.find((x) => x.id === 'codex')!;
    expect(codex.text).toMatch(/^codex mcp add master-tasker \\\n/);
    expect(codex.text).toContain(`--env 'MASTER_TASKER_TOKEN_FILE=${file}'`);
    expect(codex.text).toContain(`-- ${paths.node} ${paths.mcpServer}`);
    expect(codex.where).toContain('only once');

    // The JSON ones are only the entry, without braces around it, to paste among the servers an app already has.
    const json = snippets.filter((x) => ['vscode', 'cursor', 'gemini', 'windsurf', 'other'].includes(x.id));
    for (const x of json) {
      expect(x.text, x.id).toMatch(/^"master-tasker": \{\n/);
      expect(x.text, x.id).toMatch(/\n\}$/);
      expect(x.where, x.id).toContain('after any servers already there');
    }
    const parse = (id: string) => JSON.parse(`{${snippets.find((x) => x.id === id)!.text}}`)['master-tasker'];
    expect(parse('cursor').type).toBe('stdio');
    expect(parse('vscode').type).toBe('stdio');
    // Gemini CLI and Windsurf take command, args and env, with no type.
    for (const id of ['gemini', 'windsurf']) expect(Object.keys(parse(id)), id).toEqual(['command', 'args', 'env']);
    expect(snippets.find((x) => x.id === 'gemini')!.where).toContain('~/.gemini/settings.json');
    expect(snippets.find((x) => x.id === 'windsurf')!.where).toContain('~/.config/devin/mcp_config.json');
    expect(snippets.find((x) => x.id === 'cursor')!.where).not.toContain('Add new global MCP server');

    // Pasted as is, the settings work.
    expect((await whoamiWith(s, parse('cursor'))).connection).toContain('Cursor');
  });

  it('gives no file unless asked, and revoking deletes the file', async () => {
    s = await startServer({ seed: false });
    const plain = await ui(s, 'POST', '/api/clients', newConnection);
    expect(plain.body.client.tokenFile).toBeUndefined();
    expect(fs.existsSync(path.join(s.dir, 'data', 'tokens', plain.body.client.id))).toBe(false);

    const { client, token } = (await ui(s, 'POST', '/api/clients', { ...newConnection, tokenFile: true })).body;
    expect(fs.existsSync(client.tokenFile)).toBe(true);
    expect((await ui(s, 'POST', `/api/clients/${client.id}/revoke`, {})).status).toBe(200);
    expect(fs.existsSync(client.tokenFile)).toBe(false);
    expect((await asClient(s, token, 'GET', '/api/whoami')).status).toBe(401);
  });

  it('tidies up the file of a connection revoked some other way, when the app starts', async () => {
    const dir = tempDir();
    s = await startServer({ dir, seed: false });
    const keep = (await ui(s, 'POST', '/api/clients', { ...newConnection, tokenFile: true })).body.client;
    const gone = (await ui(s, 'POST', '/api/clients', { ...newConnection, name: 'Codex', tokenFile: true })).body.client;
    // As npm run cli -- token revoke does: straight to the database.
    s.app.service.revokeClient(userCtx('cli'), gone.id);
    expect(fs.existsSync(gone.tokenFile)).toBe(true);
    await s.stop();

    s = await startServer({ dir, seed: false });
    expect(fs.existsSync(gone.tokenFile)).toBe(false);
    expect(fs.existsSync(keep.tokenFile)).toBe(true);
  });

  it('deletes the file right away when you revoke from the command line', async () => {
    const dir = tempDir();
    s = await startServer({ dir, seed: false });
    const keep = (await ui(s, 'POST', '/api/clients', { ...newConnection, tokenFile: true })).body.client;
    const gone = (await ui(s, 'POST', '/api/clients', { ...newConnection, name: 'Codex', tokenFile: true })).body.client;
    await s.stop();
    const env = { ...process.env, MT_DATA_DIR: path.join(dir, 'data'), MT_LOG_DIR: path.join(dir, 'logs'), MT_PORT: '1' };
    const r = spawnSync(process.execPath, ['server/cli.ts', 'token', 'revoke', gone.id], { cwd: path.resolve(import.meta.dirname, '..'), env, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(fs.existsSync(gone.tokenFile)).toBe(false);
    expect(fs.existsSync(keep.tokenFile)).toBe(true);
    s = await startServer({ dir, seed: false });
  });
});
