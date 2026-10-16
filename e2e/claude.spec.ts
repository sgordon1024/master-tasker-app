import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

// Settings > AI assistants: the Claude panel, other apps and Assistants with access, and what the app shows before
// any assistant is connected.
// The e2e server points every Claude path inside .data/e2e (see playwright.config.ts), never at the real setup.

const OTHER = { 'x-master-tasker': 'web', 'x-session-id': 'e2e-other-device', 'content-type': 'application/json' };
const E2E = path.resolve('.data/e2e');
const PORT = Number(process.env.MT_E2E_PORT) || 4843; // the same port as playwright.config.ts
const FILES = {
  skillLink: path.join(E2E, 'claude-skills', 'master-tasker'),
  skillDir: path.join(E2E, 'skill', 'master-tasker'),
  env: path.join(E2E, 'skill', 'master-tasker', '.local.env'),
  token: path.join(E2E, 'data', 'claude', 'token'),
  desktop: path.join(E2E, 'claude-desktop', 'claude_desktop_config.json'),
};

test.beforeEach(({}, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop flows');
});

const unique = (s: string) => `${s} ${Math.random().toString(36).slice(2, 7)}`;

async function apiCreate(request: APIRequestContext, body: Record<string, unknown>) {
  const r = await request.post('/api/tasks', { headers: OTHER, data: body });
  expect(r.ok()).toBeTruthy();
  return (await r.json()).task;
}

async function open(page: Page, hash: string) {
  await page.goto(`/${hash}`);
  await expect(page.locator('.conn-live:visible').first()).toBeVisible();
}

/** The four status rows wait behind Details, closed until you open them. */
async function openDetails(section: Locator) {
  const details = section.locator('.connect-details');
  if ((await details.getAttribute('open')) === null) await details.locator('> summary').click();
}

/** Undo both setups, so each test starts from "Claude isn't connected". */
async function disconnect(request: APIRequestContext) {
  expect((await request.delete('/api/integrations/claude-code', { headers: OTHER })).ok()).toBeTruthy();
  expect((await request.delete('/api/integrations/claude-desktop', { headers: OTHER })).ok()).toBeTruthy();
}

/** Remove every assistant's access, so no assistant is connected. The daily review is the app's own, so it stays. */
async function removeAllAccess(request: APIRequestContext) {
  const { clients } = await (await request.get('/api/clients')).json();
  for (const c of clients) {
    if (c.revokedAt || c.name === 'Daily review') continue;
    expect((await request.post(`/api/clients/${c.id}/revoke`, { headers: OTHER })).ok()).toBeTruthy();
  }
}

/** Settings > AI assistants, and the Claude panel inside it. */
const assistants = (page: Page) => page.getByRole('region', { name: 'AI assistants' });
const claudePanel = (page: Page) => assistants(page).getByRole('group', { name: 'Claude', exact: true });

test('before any assistant is connected, the task shows no Claude buttons, and its ⋯ menu offers Connect an AI assistant', async ({ page, request }) => {
  await disconnect(request);
  await removeAllAccess(request);
  const title = unique('Not set up yet');
  const t = await apiCreate(request, { title, status: 'doing', subtasks: ['First step'] });
  await open(page, `#/doing?task=${t.id}`);
  const detail = page.getByRole('complementary', { name: 'Task details' });
  await expect(detail.getByRole('group', { name: 'Claude' })).toHaveCount(0);
  await expect(detail.getByRole('button', { name: 'Work on this with Claude' })).toHaveCount(0);
  // No play button on subtasks, and no "Claude isn't on it" on the card, until Claude is set up.
  await expect(detail.getByRole('button', { name: 'Work on First step with Claude' })).toHaveCount(0);
  await expect(page.locator(`[data-task-id="${t.id}"] .now-start`)).toHaveCount(0);

  await detail.getByRole('button', { name: 'More actions' }).click();
  const menu = page.getByRole('menu', { name: 'More actions' });
  await expect(menu.getByRole('menuitem', { name: /Copy prompt/ })).toHaveCount(0);
  await menu.getByRole('menuitem', { name: 'Connect an AI assistant' }).click();
  await expect(page).toHaveURL(/#\/settings\?section=assistants$/);
  await expect(assistants(page)).toBeInViewport();
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'No assistant connected' })).toBeVisible();
  // Nothing is picked until you pick. Claude shows its own setup.
  await expect(assistants(page).getByRole('radio', { checked: true })).toHaveCount(0);
  await assistants(page).getByRole('radio', { name: 'Claude' }).click();
  const section = claudePanel(page);
  await openDetails(section);
  await expect(section.getByRole('listitem').filter({ hasText: '/master-tasker in Claude Code' })).toContainText('Not connected');
  await expect(section.getByRole('button', { name: 'Set up Claude Code' })).toBeEnabled();
});

test('Ask is hidden when Claude Code is missing, and Reply is still there', async ({ page, request }) => {
  // The e2e server has a stand-in Claude Code, so pretend this Mac doesn't.
  await page.route('**/api/integrations**', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.integrations.claudeCode.found = false;
    await route.fulfill({ response: res, json: body });
  });
  const t = await apiCreate(request, { title: unique('Ask without Claude Code'), status: 'today' });
  await request.post(`/api/tasks/${t.id}/needs-you`, { headers: OTHER, data: { text: 'Pick a date' } });
  await open(page, `#/today?task=${t.id}`);
  const panel = page.getByRole('complementary', { name: 'Task details' }).locator('.you-panel');
  await expect(panel.getByRole('button', { name: 'Reply: Pick a date' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Ask about: Pick a date' })).toHaveCount(0);
  await expect(panel).not.toContainText('Needs Claude Code');
  // Leave nothing waiting on you for the tests after this one.
  expect((await request.delete(`/api/tasks/${t.id}`, { headers: OTHER })).ok()).toBeTruthy();
});

/** Answer GET /api/integrations as this Mac would, with `change` applied. Setup calls go through untouched. */
async function pretend(page: Page, change: (i: Record<string, any>) => void) {
  await page.route('**/api/integrations**', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const res = await route.fetch();
    const body = await res.json();
    if (body.integrations) change(body.integrations);
    await route.fulfill({ response: res, json: body });
  });
}

test('no Claude on this Mac: the Claude panel says so plainly, with a link to get the app', async ({ page }) => {
  await pretend(page, (i) => {
    i.claudeApp.found = false;
    i.claudeCode.found = false;
  });
  // The old link still works, with Claude picked.
  await open(page, '#/settings?section=claude');
  await expect(assistants(page).getByRole('radio', { name: 'Claude' })).toHaveAttribute('aria-checked', 'true');
  const section = claudePanel(page);
  await expect(section.getByRole('heading', { name: "Claude isn't on this Mac" })).toBeVisible();
  await expect(section.getByRole('link', { name: 'Get the Claude app' }).first()).toBeVisible();
  await expect(section.getByRole('button', { name: 'Check again' })).toBeVisible();
  await expect(section.locator('.connect-details')).toHaveCount(0);
});

test('Claude Code only: the task button copies a prompt for Terminal, and the sidebar says Claude is connected', async ({ page, request }) => {
  await pretend(page, (i) => {
    i.claudeApp.found = false;
    i.claudeCode.found = true;
    i.skillReady = true;
    i.ready = false;
  });
  // The connection Set up Claude Code makes. Any Claude connection reads as Claude.
  const made = await request.post('/api/clients', { headers: OTHER, data: { name: 'Claude threads', kind: 'claude', scopes: { areas: '*', unfiled: true, perms: ['read', 'update', 'complete', 'start'] } } });
  const { client } = await made.json();
  const t = await apiCreate(request, { title: unique('Terminal only'), status: 'today', subtasks: ['First step'] });
  await open(page, `#/today?task=${t.id}`);
  const detail = page.getByRole('complementary', { name: 'Task details' });
  const copy = detail.getByRole('group', { name: 'Claude' }).getByRole('button', { name: 'Copy prompt for Claude Code' });
  await expect(copy).toBeVisible();
  await expect(copy).toHaveAttribute('title', 'Copies a prompt to paste into Claude Code in Terminal.');
  await expect(detail.getByRole('button', { name: 'Work on this with Claude' })).toHaveCount(0);
  // The ⋯ menu doesn't offer the same thing twice.
  await detail.getByRole('button', { name: 'More actions' }).click();
  const menu = page.getByRole('menu', { name: 'More actions' });
  await expect(menu.getByRole('menuitem', { name: 'Copy prompt for Claude Code' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Copy prompt', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('navigation', { name: 'Main' })).not.toContainText('No assistant connected');
  await expect(page.getByRole('navigation', { name: 'Main' })).toContainText(/Claude connected|\d assistants connected/);
  expect((await request.post(`/api/clients/${client.id}/revoke`, { headers: OTHER })).ok()).toBeTruthy();
});

test('the Claude panel: both setup buttons write their files in place, and Remove undoes them', async ({ page, request }) => {
  await disconnect(request);
  // Start with thread linking off, so Set up is what turns it on.
  expect((await request.patch('/api/settings', { headers: OTHER, data: { threadLinking: false } })).ok()).toBeTruthy();
  await open(page, '#/settings?section=claude');
  const section = claudePanel(page);
  const row = (name: string) => section.getByRole('listitem').filter({ hasText: name });

  // Set up Claude Code: links the skill, writes .local.env and a private token, turns on thread linking.
  await section.getByRole('button', { name: 'Set up Claude Code' }).click();
  await expect(section.getByRole('status').filter({ hasText: 'Claude Code is set up.' })).toBeVisible();
  await openDetails(section);
  await expect(row('/master-tasker in Claude Code')).toContainText('Connected');
  await expect(section.getByText('Try it: open any task and press Work on this with Claude.')).toBeVisible();
  await expect(section.getByRole('switch', { name: 'Link Claude threads to tasks' })).toHaveAttribute('aria-checked', 'true');
  expect(fs.readlinkSync(FILES.skillLink)).toBe(FILES.skillDir);
  const envText = fs.readFileSync(FILES.env, 'utf8');
  expect(envText).toContain(`MASTER_TASKER_URL='http://127.0.0.1:${PORT}'`);
  expect(envText).toContain(`MT_DATA_DIR='${path.join(E2E, 'data')}'`);
  expect(fs.statSync(FILES.token).mode & 0o777).toBe(0o600);

  // Add to Claude Desktop: keeps the other entries, backs up first, and says to restart Claude.
  await section.getByRole('button', { name: 'Add to Claude Desktop' }).click();
  await expect(section.getByRole('status').filter({ hasText: 'Quit Claude fully and reopen it' })).toBeVisible();
  await expect(row('Claude Desktop chat')).toContainText('Added');
  const added = JSON.parse(fs.readFileSync(FILES.desktop, 'utf8'));
  expect(added.keepMe).toBe(true);
  expect(added.mcpServers['someone-else']).toEqual({ command: '/usr/bin/true' });
  expect(added.mcpServers['master-tasker'].args[0]).toMatch(/mcp\/server\.ts$/);
  // The entry names a token file only this user can read, never the token itself.
  const entryEnv = added.mcpServers['master-tasker'].env;
  expect(entryEnv.MASTER_TASKER_TOKEN).toBeUndefined();
  expect(fs.statSync(entryEnv.MASTER_TASKER_TOKEN_FILE).mode & 0o777).toBe(0o600);
  expect(fs.readFileSync(entryEnv.MASTER_TASKER_TOKEN_FILE, 'utf8').trim()).toMatch(/^mt_/);
  expect(fs.readFileSync(FILES.desktop, 'utf8')).not.toContain('mt_');
  expect(fs.readdirSync(path.dirname(FILES.desktop)).some((f) => f.startsWith('claude_desktop_config.backup-'))).toBe(true);

  // Remove both.
  await section.getByRole('button', { name: 'Remove from Claude Desktop' }).click();
  await expect(section.getByRole('status').filter({ hasText: 'Removed from Claude Desktop' })).toBeVisible();
  const removed = JSON.parse(fs.readFileSync(FILES.desktop, 'utf8'));
  expect(removed.mcpServers).toEqual({ 'someone-else': { command: '/usr/bin/true' } });
  await section.getByRole('button', { name: 'Remove from Claude Code' }).click();
  await openDetails(section);
  await expect(row('/master-tasker in Claude Code')).toContainText('Not connected');
  // Set up turned thread linking on, so Remove turns it off again.
  await expect(section.getByRole('switch', { name: 'Link Claude threads to tasks' })).toHaveAttribute('aria-checked', 'false');
  expect(fs.existsSync(FILES.skillLink)).toBe(false);
  expect(fs.existsSync(FILES.token)).toBe(false);
});

test('Claude Desktop: an entry that keeps the token in Claude’s settings shows Needs update, and Update moves it to a token file', async ({ page, request }) => {
  await disconnect(request);
  expect((await request.post('/api/integrations/claude-desktop', { headers: OTHER })).ok()).toBeTruthy();
  // Write the entry the way older versions did: the token itself, in Claude's settings file.
  const json = JSON.parse(fs.readFileSync(FILES.desktop, 'utf8'));
  const entry = json.mcpServers['master-tasker'];
  const token = fs.readFileSync(entry.env.MASTER_TASKER_TOKEN_FILE, 'utf8').trim();
  entry.env = { MASTER_TASKER_TOKEN: token, MASTER_TASKER_URL: entry.env.MASTER_TASKER_URL };
  fs.writeFileSync(FILES.desktop, `${JSON.stringify(json, null, 2)}\n`);

  await open(page, '#/settings?section=claude');
  const section = claudePanel(page);
  const row = section.getByRole('listitem').filter({ hasText: 'Claude Desktop chat' });
  // The app checks Claude's settings every few seconds; Check again looks now.
  await section.getByRole('button', { name: 'Check again' }).click();
  await openDetails(section);
  await expect(row).toContainText('Needs update');
  await expect(section.getByText("keeps the token in Claude's settings file")).toBeVisible();
  await section.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(section.getByRole('status').filter({ hasText: 'Updated Master Tasker in Claude Desktop' })).toBeVisible();
  await expect(row).toContainText('Added');

  const updated = JSON.parse(fs.readFileSync(FILES.desktop, 'utf8'));
  const env = updated.mcpServers['master-tasker'].env;
  expect(env.MASTER_TASKER_TOKEN).toBeUndefined();
  expect(fs.readFileSync(env.MASTER_TASKER_TOKEN_FILE, 'utf8').trim()).toBe(token);
  expect(fs.readFileSync(FILES.desktop, 'utf8')).not.toContain('mt_');
  expect(updated.keepMe).toBe(true);
  await disconnect(request);
});

test('another app: Connect Cursor shows settings to paste that name its private file, using this Mac’s paths', async ({ page, request }) => {
  await removeAllAccess(request);
  await open(page, '#/settings?section=assistants');
  const section = assistants(page);
  await section.getByRole('radio', { name: 'Cursor' }).click();
  await expect(section.getByRole('checkbox', { name: /Let it work on tasks/ })).not.toBeChecked();
  await section.getByRole('button', { name: 'Connect Cursor' }).click();
  const reveal = section.getByRole('region', { name: 'Settings for Cursor' });
  const code = reveal.getByLabel('Cursor settings');
  // The entry to paste inside mcpServers, and where it goes.
  await expect(code).toContainText('"master-tasker": {');
  await expect(reveal).toContainText('inside the mcpServers braces in ~/.cursor/mcp.json');
  await expect(code).toContainText('MASTER_TASKER_TOKEN_FILE');
  await expect(code).not.toContainText('mt_');
  await expect(code).toContainText(path.resolve('mcp/server.ts'));
  await reveal.getByRole('radio', { name: 'Codex' }).click();
  await expect(reveal.getByLabel('Codex (ChatGPT) settings')).toContainText('codex mcp add master-tasker');
  await reveal.getByRole('radio', { name: 'GitHub Copilot' }).click();
  await expect(reveal.getByLabel('GitHub Copilot (VS Code) settings')).toContainText('"type": "stdio"');
  await expect(section).toContainText("Assistants on the web, such as chatgpt.com and claude.ai, and phone apps can't connect.");
  await reveal.getByRole('button', { name: 'I saved it' }).click();
  await expect(reveal).toHaveCount(0);
  // Not used yet, unless an earlier test's Cursor already checked in.
  await expect(section.getByRole('radio', { name: 'Cursor' })).toContainText(/Not used yet|Connected/);
  // Its settings can be shown again any time, from Assistants with access.
  const access = section.getByRole('region', { name: 'Assistants with access' });
  const card = access.getByRole('listitem').filter({ hasText: 'Cursor' });
  await expect(card).toContainText('Can see all areas · Can read and suggest changes');
  await card.getByRole('button', { name: 'Show settings for Cursor' }).click();
  await expect(access.getByLabel('Cursor settings')).toContainText('MASTER_TASKER_TOKEN_FILE');
});

test('Add access for a script: all areas by default, the button says why it is off, and access can be changed later', async ({ page }) => {
  // The old Connections link lands on Assistants with access.
  await open(page, '#/settings?section=connections');
  const connections = page.getByRole('region', { name: 'Assistants with access' });
  await expect(connections).toBeInViewport();
  await connections.locator('summary', { hasText: 'Advanced' }).click();
  const form = connections.getByRole('form', { name: 'Add access for a script' });
  await expect(form.getByRole('checkbox', { name: 'All areas' })).toBeChecked();
  await expect(form.getByText('New areas are included.')).toBeVisible();
  const create = form.getByRole('button', { name: 'Add access', exact: true });
  await expect(create).toBeDisabled();
  await expect(create).toHaveAccessibleDescription('Give it a name first.');
  const name = unique('Form check');
  await form.getByRole('textbox', { name: 'Name' }).fill(name);
  await form.getByRole('checkbox', { name: 'All areas' }).uncheck();
  await form.getByRole('checkbox', { name: 'Unfiled Inbox items' }).uncheck();
  await expect(create).toHaveAccessibleDescription('Pick at least one area, or unfiled Inbox items.');
  await form.getByRole('checkbox', { name: 'All areas' }).check();
  await create.click();
  const reveal = connections.getByRole('region', { name: `Settings for ${name}` });
  await expect(reveal.getByLabel('Other app settings')).toContainText('"master-tasker": {');
  await reveal.getByRole('button', { name: 'I saved it' }).click();

  const card = connections.getByRole('listitem').filter({ hasText: name });
  await expect(card).toContainText('Can see all areas, not unfiled Inbox items · Can read and suggest changes');
  await card.getByRole('button', { name: `Change access for ${name}` }).click();
  const edit = connections.getByRole('form', { name: `Change ${name}` });
  await edit.getByRole('checkbox', { name: 'Propose changes' }).uncheck();
  await edit.getByRole('checkbox', { name: 'Create tasks' }).check();
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await expect(card).toContainText('Can read and create tasks');
  // Details has today's use and the daily limits.
  await card.locator('summary', { hasText: 'Details' }).click();
  await expect(card).toContainText('Today: 0 changes, 0 suggestions. Daily limits: 200 changes, 100 suggestions.');
});

test('For you: Accept all for one connection asks first, with the count', async ({ page, request }) => {
  const label = unique('Bulk helper');
  const made = await request.post('/api/clients', { headers: OTHER, data: { name: label, kind: 'other', scopes: { areas: '*', unfiled: true, perms: ['read', 'propose'] } } });
  const { token } = await made.json();
  const titles = [unique('Bulk one'), unique('Bulk two')];
  for (const title of titles) {
    const r = await request.post('/api/proposals', { headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, data: { proposal: { kind: 'create', task: { title } } } });
    expect(r.ok()).toBeTruthy();
  }
  await open(page, '#/review');
  const bar = page.locator('.accept-all-row', { hasText: label });
  await expect(bar).toContainText(`2 suggestions from ${label}`);
  await bar.getByRole('button', { name: 'Accept all' }).click();
  const confirm = page.getByRole('group', { name: /Accept all from/ });
  await expect(confirm).toContainText('Accept 2 suggestions');
  await confirm.getByRole('button', { name: 'Accept 2' }).click();
  await expect(page.locator('.toast', { hasText: 'Accepted 2 suggestions' })).toBeVisible();
  const sync = await (await request.get('/api/sync')).json();
  for (const title of titles) expect(sync.tasks.some((t: { title: string }) => t.title === title)).toBe(true);
});
