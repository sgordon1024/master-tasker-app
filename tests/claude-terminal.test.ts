// Claude Code only, without the Claude app: the skill is enough to work tasks, the Claude buttons copy a prompt to
// paste in Terminal, and with the app they open a claude:// link. The browser parts run against a real test server.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Integrations } from '../shared/schema.ts';
import { claudeLink } from '../server/app.ts';
import { assistantStatusLine, connectedAssistants } from '../web/src/assistants.ts';
import { claudeAppReady, claudeInTerminal, claudeReady, openUrl, startThread, workWithClaude, workWithClaudeLabel } from '../web/src/claude.ts';
import { store } from '../web/src/store.ts';
import { startServer, tempDir, ui, type TestServer } from './helpers.ts';

const FAKE = path.resolve(import.meta.dirname, 'fixtures', 'fake-claude.mjs');
const realFetch = globalThis.fetch;
let s: TestServer | null = null;
afterEach(async () => {
  vi.unstubAllGlobals();
  await s?.stop();
  s = null;
});

/** Claude Code "installed" (a stand-in), the app only when asked, and the skill set up. */
async function setUp(app: boolean) {
  const dir = tempDir();
  if (app) fs.mkdirSync(path.join(dir, 'Applications', 'Claude.app'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'skill', 'master-tasker'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skill', 'master-tasker', 'SKILL.md'), '---\nname: master-tasker\n---\n');
  s = await startServer({ dir, seed: false, env: { MT_CLAUDE_BIN: FAKE } });
  const r = await ui(s, 'POST', '/api/integrations/claude-code', {});
  expect(r.status).toBe(200);
  return { srv: s, integrations: r.body.integrations as Integrations };
}

/** A browser page, as far as claude.ts needs one: the API on the test server, a clipboard, and no leaving the page. */
function browser(srv: TestServer, integrations: Integrations, clipboard: 'text' | 'item' = 'text') {
  const copied: string[] = [];
  const opened: string[] = [];
  vi.stubGlobal('fetch', (p: string, init?: RequestInit) => realFetch(p.startsWith('/') ? srv.base + p : p, init));
  vi.stubGlobal('window', { __mtOpen: (u: string) => opened.push(u) });
  if (clipboard === 'item') {
    // Safari's way: the copy starts right away and fills in when the text arrives.
    vi.stubGlobal(
      'ClipboardItem',
      class {
        items: Record<string, Promise<Blob>>;
        constructor(items: Record<string, Promise<Blob>>) {
          this.items = items;
        }
      },
    );
    vi.stubGlobal('navigator', { clipboard: { write: async ([item]: { items: Record<string, Promise<Blob>> }[]) => void copied.push(await (await item.items['text/plain']).text()) } });
  } else {
    vi.stubGlobal('navigator', { clipboard: { writeText: async (t: string) => void copied.push(t) } });
  }
  (store as unknown as { set: (p: { integrations: Integrations }) => void }).set({ integrations });
  const toasts = () => store.getSnapshot().toasts.map((t) => t.message);
  return { copied, opened, toasts };
}

describe('Claude Code without the Claude app', () => {
  it('counts the skill as ready on its own, and the app as a separate thing', async () => {
    const { srv, integrations: i } = await setUp(false);
    expect(i).toMatchObject({ claudeApp: { found: false }, claudeCode: { found: true }, skillReady: true, ready: false });
    expect(claudeReady(i)).toBe(true);
    expect(claudeAppReady(i)).toBe(false);
    expect(claudeInTerminal(i)).toBe(true);
    expect(workWithClaudeLabel(i)).toBe('Copy prompt for Claude Code');
    // The sidebar counts the skill's connection as Claude.
    const clients = async () => (await ui(srv, 'GET', '/api/clients')).body.clients;
    expect(assistantStatusLine(connectedAssistants(await clients()))).toBe('Claude connected');
    expect(assistantStatusLine(connectedAssistants(await clients()), 2)).toBe('Claude: working on 2');

    // The skill stops working: nothing is ready, whatever is installed.
    const conn = (await ui(srv, 'GET', '/api/clients')).body.clients.find((c: any) => c.name === 'Claude threads');
    await ui(srv, 'POST', `/api/clients/${conn.id}/revoke`, {});
    const after = (await ui(srv, 'GET', '/api/integrations?refresh=1')).body.integrations;
    expect(after).toMatchObject({ skillReady: false, ready: false });
    expect(claudeReady(after)).toBe(false);
    expect(assistantStatusLine(connectedAssistants(await clients()))).toBe('No assistant connected');
    expect(workWithClaudeLabel(after)).toBe('Work on this with Claude');
  });

  it('Copy prompt for Claude Code copies a prompt that starts with /master-tasker and the task id, and opens nothing', async () => {
    const { srv, integrations } = await setUp(false);
    const page = browser(srv, integrations);
    const t = (await ui(srv, 'POST', '/api/tasks', { title: 'Write the brief', subtasks: ['Find the old one'] })).body.task;
    await workWithClaude(t.id);
    expect(page.copied).toEqual([`/master-tasker ${t.id}`]);
    expect(page.opened).toEqual([]);
    expect(page.toasts().at(-1)).toBe('Copied a prompt for Claude Code. Open Terminal, type claude and press Return, then paste it and press Return.');

    // One subtask, the same way.
    await workWithClaude(t.id, { subtaskId: t.subtasks[0].id });
    expect(page.copied.at(-1)).toBe(`/master-tasker ${t.id} Start with the subtask: "Find the old one"`);
  });

  it("copies the way Safari allows, starting while the click still counts", async () => {
    const { srv, integrations } = await setUp(false);
    const page = browser(srv, integrations, 'item');
    const t = (await ui(srv, 'POST', '/api/tasks', { title: 'Safari copy' })).body.task;
    await workWithClaude(t.id);
    expect(page.copied).toEqual([`/master-tasker ${t.id}`]);
  });

  it('never sends a new-thread link to a Mac without the app: it copies its message instead', async () => {
    const { srv, integrations } = await setUp(false);
    const page = browser(srv, integrations);
    openUrl(claudeLink('t_abcdefghijklmn', undefined, '/some/folder'));
    await vi.waitFor(() => expect(page.copied).toEqual(['/master-tasker t_abcdefghijklmn']));
    expect(page.opened).toEqual([]);
    // An existing thread's link still opens.
    openUrl('claude://code/continue?session=local_1');
    expect(page.opened).toEqual(['claude://code/continue?session=local_1']);
    // A caller can say what happened first.
    await startThread({ url: claudeLink('t_abcdefghijklmn', undefined, '/x'), prompt: '/master-tasker t_abcdefghijklmn' }, 'Saved as a task. ');
    expect(page.toasts().at(-1)).toMatch(/^Saved as a task\. Copied a prompt for Claude Code\./);
  });
});

describe('with the Claude app', () => {
  it('Work on this with Claude opens a claude:// link in the app, and says the browser may ask first', async () => {
    const { srv, integrations: i } = await setUp(true);
    expect(i).toMatchObject({ claudeApp: { found: true }, skillReady: true, ready: true });
    expect(claudeAppReady(i)).toBe(true);
    expect(claudeInTerminal(i)).toBe(false);
    expect(workWithClaudeLabel(i)).toBe('Work on this with Claude');

    const page = browser(srv, i);
    const t = (await ui(srv, 'POST', '/api/tasks', { title: 'Open in the app' })).body.task;
    await workWithClaude(t.id);
    expect(page.copied).toEqual([]);
    expect(page.opened).toHaveLength(1);
    const url = new URL(page.opened[0]);
    expect(url.protocol).toBe('claude:');
    expect(url.searchParams.get('q')).toBe(`/master-tasker ${t.id}`);
    expect(page.toasts().at(-1)).toBe('Opening Claude… Your browser may ask to open Claude. Then press Enter there.');
  });

  it('uses the link form Claude documents: claude://code/new with q and folder', async () => {
    const { srv } = await setUp(true);
    const t = (await ui(srv, 'POST', '/api/tasks', { title: 'Link form' })).body.task;
    const r = (await ui(srv, 'GET', `/api/tasks/${t.id}/claude-link`)).body;
    const url = new URL(r.url);
    expect(`${url.protocol}//${url.host}${url.pathname}`).toBe('claude://code/new');
    expect([...url.searchParams.keys()]).toEqual(['q', 'folder']);
    expect(url.searchParams.get('folder')).toBe(r.folder);
    // The same message, for Terminal.
    expect(r.prompt).toBe(url.searchParams.get('q'));
  });
});
