// Settings > AI assistants: Claude's one-sentence status, assistants that can work tasks, which settings tab a
// connection opens on, and showing a connection's settings again.
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { ClientInfo, Integrations } from '../shared/schema.ts';
import { agentForName, appForClient, assistantPrompt, assistantStatusLine, connectedAssistants, waitingAssistants } from '../web/src/assistants.ts';
import { canLine, seesLine, settingsTabFor } from '../web/src/components/Access.tsx';
import { claudeSummary, OTHER_APP_PERMS } from '../web/src/components/Connect.tsx';
import { AGENT_IDS, AGENT_LABEL } from '../web/src/snippets.ts';
import { asClient, startServer, ui, type TestServer } from './helpers.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
let s: TestServer | null = null;
afterEach(async () => {
  await s?.stop();
  s = null;
});

const base: Integrations = {
  claudeApp: { found: false },
  claudeCode: { found: false },
  skill: { state: 'missing', tokenWorks: false, upToDate: false },
  desktop: { state: 'missing', tokenWorks: false, unreadable: false },
  threadLinking: false,
  skillReady: false,
  ready: false,
  paths: { node: '/usr/bin/node', mcpServer: '/x/mcp/server.ts', url: 'http://127.0.0.1:4820' },
  checkedAt: new Date().toISOString(),
};
const ready = { skill: { state: 'linked', tokenWorks: true, upToDate: true }, skillReady: true } as const;

describe('The Claude setup says what it found in one sentence', () => {
  it('names what is on this Mac, then whether Master Tasker is connected', () => {
    expect(claudeSummary({ ...base, claudeApp: { found: true } })).toBe("Claude app found. Master Tasker isn't connected yet.");
    expect(claudeSummary({ ...base, claudeCode: { found: true }, ...ready })).toBe('Claude Code found. Master Tasker is connected. Claude works on your tasks in Terminal.');
    expect(claudeSummary({ ...base, claudeApp: { found: true }, claudeCode: { found: true }, ...ready, ready: true, desktop: { state: 'connected', tokenWorks: true, unreadable: false } })).toBe(
      'Claude app and Claude Code found. Master Tasker is connected, in Claude chats too.',
    );
    expect(claudeSummary({ ...base, claudeApp: { found: true }, skill: { state: 'linked', tokenWorks: false, upToDate: true } })).toBe("Claude app found. Master Tasker's connection stopped working. Set up again fixes it.");
    expect(claudeSummary({ ...base, claudeApp: { found: true }, skill: { state: 'other', tokenWorks: false, upToDate: false } })).toMatch(/^Claude app found\. Another copy of Master Tasker has the \/master-tasker command/);
    expect(claudeSummary({ ...base, claudeApp: { found: true }, desktop: { state: 'connected', tokenWorks: true, unreadable: false } })).toBe('Claude app found. Claude chats can read your tasks. Set up Claude Code so Claude can work on them too.');
  });
});

describe('the settings tab a connection opens on', () => {
  it("follows the app in the connection's name, or the generic tab for apps without one", () => {
    expect(agentForName('Cursor')).toBe('cursor');
    expect(agentForName('Cursor on my laptop')).toBe('cursor');
    expect(agentForName('VS Code')).toBe('vscode');
    expect(agentForName('vscode at work')).toBe('vscode');
    expect(agentForName('GitHub Copilot')).toBe('vscode');
    expect(agentForName('Codex')).toBe('codex');
    expect(agentForName('ChatGPT')).toBe('codex');
    expect(agentForName('Claude Code in Terminal')).toBe('claude-code');
    expect(agentForName('Claude Desktop')).toBe('claude-code');
    expect(agentForName('Gemini CLI')).toBe('gemini');
    expect(agentForName('Windsurf')).toBe('windsurf');
    expect(agentForName('Devin Desktop')).toBe('windsurf');
    expect(agentForName('Other assistant')).toBe('other');
    expect(agentForName('My helper')).toBeUndefined();
    // No app in the name: what the caller suggests, else its kind.
    expect(settingsTabFor({ name: 'My helper', kind: 'claude' })).toBe('claude-code');
    expect(settingsTabFor({ name: 'My helper', kind: 'other' })).toBe('other');
    expect(settingsTabFor({ name: 'My helper', kind: 'other' }, 'codex')).toBe('codex');
    expect(settingsTabFor({ name: 'Windsurf', kind: 'claude' }, 'claude-code')).toBe('windsurf');
  });

  it('lists the apps in one order, with Windsurf under its new name too', () => {
    expect(AGENT_IDS.map((a) => AGENT_LABEL[a])).toEqual(['Claude Code', 'Codex (ChatGPT)', 'GitHub Copilot (VS Code)', 'Cursor', 'Gemini CLI', 'Windsurf (Devin Desktop)', 'Other app']);
  });
});

describe('which assistants are connected', () => {
  const client = (name: string, kind: 'claude' | 'other', more: Partial<ClientInfo> = {}): ClientInfo => ({
    id: `c_${name}`,
    name,
    kind,
    scopes: { areas: '*', unfiled: true, perms: ['read', 'propose'] },
    limits: { writesPerDay: 200, proposalsPerDay: 100 },
    paused: false,
    createdAt: '',
    lastUsedAt: null,
    revokedAt: null,
    usageToday: { writes: 0, proposals: 0 },
    ...more,
  });

  const used = { lastUsedAt: '2026-10-15T09:00:00Z' };

  it('counts any live connection that has been used, Claude once however many it has, and never the daily review', () => {
    expect(connectedAssistants(null)).toEqual([]);
    expect(connectedAssistants([client('Daily review', 'claude')])).toEqual([]);
    expect(connectedAssistants([client('Claude threads', 'claude'), client('Claude Desktop', 'claude')])).toEqual(['Claude']);
    expect(connectedAssistants([client('Cursor', 'other', used), client('Claude threads', 'claude'), client('Cursor', 'other')])).toEqual(['Cursor', 'Claude']);
    // Paused or removed: not connected right now.
    expect(connectedAssistants([client('Cursor', 'other', { paused: true }), client('Codex', 'other', { revokedAt: '2026-10-01T00:00:00Z' })])).toEqual([]);
    // Given a key it never used: waiting, not connected. Claude's own setups are checked by Master Tasker, so they count.
    expect(connectedAssistants([client('Cursor', 'other')])).toEqual([]);
    expect(waitingAssistants([client('Cursor', 'other'), client('Claude threads', 'claude')])).toEqual(['Cursor']);
    expect(waitingAssistants([client('Cursor', 'other'), client('Cursor', 'other', used)])).toEqual([]);
    expect(appForClient(client('Claude Desktop', 'claude'))).toBe('claude-code');
    expect(appForClient(client('Cursor', 'other'))).toBe('cursor');
  });

  it('says so in the sidebar: none, one by name, how many, or what Claude threads are on', () => {
    expect(assistantStatusLine([])).toBe('No assistant connected');
    expect(assistantStatusLine(['Cursor'])).toBe('Cursor connected');
    expect(assistantStatusLine(['Cursor', 'Claude'])).toBe('2 assistants connected');
    expect(assistantStatusLine(['Claude'], 2)).toBe('Claude: working on 2');
    expect(assistantStatusLine([], 0, ['Cursor'])).toBe('Waiting for Cursor');
    expect(assistantStatusLine([], 0, ['Cursor', 'Codex'])).toBe('Waiting for 2 assistants');
    expect(assistantStatusLine(['Claude'], 0, ['Cursor'])).toBe('Claude connected');
  });

  it('gives any assistant the same prompt, with the task id and title in it', () => {
    expect(assistantPrompt({ id: 't_abc123', title: 'Write the case study intro' })).toBe(
      'Use the Master Tasker tools to work on task t_abc123 ("Write the case study intro"): read it, plan it into steps, start it, tick steps off as you finish them, and flag anything only I can decide or do as Needs you.',
    );
  });

  it('says what a connection can see and do in plain words', () => {
    const areas = [{ id: 'a1', name: 'Work' }, { id: 'a2', name: 'Home' }] as never[];
    expect(`${seesLine({ areas: '*', unfiled: true, perms: [] }, areas)} · ${canLine(OTHER_APP_PERMS.suggest)}`).toBe('Can see all areas · Can read and suggest changes');
    expect(canLine(OTHER_APP_PERMS.work)).toBe('Can read, suggest, edit and complete');
    expect(canLine(['read', 'create'])).toBe('Can read and create tasks');
    expect(seesLine({ areas: ['a1', 'a2'], unfiled: true, perms: [] }, areas)).toBe('Can see Work, Home and unfiled Inbox items');
    expect(seesLine({ areas: '*', unfiled: false, perms: [] }, areas)).toBe('Can see all areas, not unfiled Inbox items');
  });
});

describe('showing settings again', () => {
  it('lists the token file of each live connection that has one, never the token', async () => {
    s = await startServer({ seed: false });
    const made = (await ui(s, 'POST', '/api/clients', { name: 'Cursor', kind: 'other', scopes: { areas: '*', unfiled: true, perms: ['read'] }, tokenFile: true })).body;
    const plain = (await ui(s, 'POST', '/api/clients', { name: 'Script', kind: 'other', scopes: { areas: '*', unfiled: true, perms: ['read'] } })).body;
    let list = (await ui(s, 'GET', '/api/clients')).body;
    const byName = (n: string) => list.clients.find((c: any) => c.name === n);
    expect(byName('Cursor').tokenFile).toBe(made.client.tokenFile);
    expect(byName('Script').tokenFile).toBeUndefined();
    expect(JSON.stringify(list)).not.toContain(made.token);
    expect(JSON.stringify(list)).not.toContain(plain.token);
    // Revoked: its file is gone, and so is the path.
    await ui(s, 'POST', `/api/clients/${made.client.id}/revoke`, {});
    list = (await ui(s, 'GET', '/api/clients')).body;
    expect(byName('Cursor').tokenFile).toBeUndefined();
  });
});

describe('AI assistants: Let it work on tasks', () => {
  async function connect(token: string) {
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'mcp/server.ts')], env: { MASTER_TASKER_TOKEN: token, MASTER_TASKER_URL: s!.base, PATH: process.env.PATH ?? '' }, stderr: 'ignore' });
    const client = new Client({ name: 'other-app', version: '1.0.0' });
    await client.connect(transport);
    return client;
  }
  const make = async (perms: string[]) => (await ui(s!, 'POST', '/api/clients', { name: 'Cursor', kind: 'other', scopes: { areas: '*', unfiled: true, perms }, tokenFile: true })).body.token as string;
  const text = (r: any) => r.content?.[0]?.text as string;

  it('gives what the work_task workflow uses: plan, start, tick off steps and finish', async () => {
    s = await startServer({ seed: false });
    const c = await connect(await make(OTHER_APP_PERMS.work));
    const t = (await ui(s, 'POST', '/api/tasks', { title: 'Tidy the brief' })).body.task;
    const call = (name: string, args: Record<string, unknown>) => c.callTool({ name, arguments: args });
    let r = await call('add_note', { task_id: t.id, text: 'Done when: the brief is one page.' });
    expect(r.isError).toBeFalsy();
    r = await call('plan_subtasks', { task_id: t.id, steps: ['Cut the intro', 'Check the Done when line'] });
    expect(r.isError).toBeFalsy();
    expect((await call('start_task', { task_id: t.id })).isError).toBeFalsy();
    const task = (await ui(s, 'GET', `/api/tasks/${t.id}`)).body.task;
    expect(task.status).toBe('doing');
    for (const sub of task.subtasks) expect((await call('set_subtask_done', { task_id: t.id, subtask_id: sub.id, done: true })).isError).toBeFalsy();
    expect((await call('complete_task', { task_id: t.id, why: 'Cut to one page.' })).isError).toBeFalsy();
    expect((await ui(s, 'GET', `/api/tasks/${t.id}`)).body.task.status).toBe('done');
    // It still can't clear Needs you. That refusal isn't about access, so it doesn't send you to Settings.
    const u = (await ui(s, 'POST', '/api/tasks', { title: 'Needs a signature', subtasks: ['Sign it'] })).body.task;
    await ui(s, 'PATCH', `/api/tasks/${u.id}/subtasks/${u.subtasks[0].id}`, { needsYou: true });
    r = await call('set_subtask_done', { task_id: u.id, subtask_id: u.subtasks[0].id, done: true });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/needs you/i);
    expect(text(r)).not.toMatch(/Settings > AI assistants/);
    await c.close();
  });

  it('without it, says plainly where to change its access', async () => {
    s = await startServer({ seed: false });
    const token = await make(OTHER_APP_PERMS.suggest);
    expect((await asClient(s, token, 'GET', '/api/whoami')).body.scopes.perms).toEqual(['read', 'propose']);
    const c = await connect(token);
    const t = (await ui(s, 'POST', '/api/tasks', { title: 'Read only' })).body.task;
    const plan = await c.callTool({ name: 'plan_subtasks', arguments: { task_id: t.id, steps: ['One'] } });
    expect(plan.isError).toBe(true);
    expect(text(plan)).toBe('This connection does not have "update" permission. Change its access in Master Tasker > Settings > AI assistants.');
    const start = await c.callTool({ name: 'start_task', arguments: { task_id: t.id } });
    expect(text(start)).toBe('This connection does not have "start" permission. Change its access in Master Tasker > Settings > AI assistants.');
    await c.close();
  });
});
