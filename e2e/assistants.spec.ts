import fs from 'node:fs';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Settings > AI assistants with an app other than Claude, on a Mac without Claude: connecting it, what changes once
// it's connected, and what it shows when it finishes a task.

const OTHER = { 'x-master-tasker': 'web', 'x-session-id': 'e2e-other-device', 'content-type': 'application/json' };

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

/** No Claude on this Mac, and nothing set up for it. */
async function noClaude(page: Page, request: APIRequestContext) {
  expect((await request.delete('/api/integrations/claude-code', { headers: OTHER })).ok()).toBeTruthy();
  expect((await request.delete('/api/integrations/claude-desktop', { headers: OTHER })).ok()).toBeTruthy();
  await page.route('**/api/integrations**', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const res = await route.fetch();
    const body = await res.json();
    if (body.integrations) Object.assign(body.integrations, { claudeApp: { found: false }, claudeCode: { found: false }, skillReady: false, ready: false });
    await route.fulfill({ response: res, json: body });
  });
}

/** What an app's tools do when it starts them: check in with the key in its token file. */
async function checkIn(request: APIRequestContext, name: string) {
  const { clients } = await (await request.get('/api/clients')).json();
  const c = clients.find((x: { name: string; revokedAt: string | null; tokenFile?: string }) => x.name === name && !x.revokedAt && x.tokenFile);
  expect(c).toBeTruthy();
  const token = fs.readFileSync(c.tokenFile, 'utf8').trim();
  expect((await request.get('/api/whoami', { headers: { authorization: `Bearer ${token}` } })).ok()).toBeTruthy();
}

/** Remove every assistant's access, so no assistant is connected. The daily review is the app's own, so it stays. */
async function removeAllAccess(request: APIRequestContext) {
  const { clients } = await (await request.get('/api/clients')).json();
  for (const c of clients) {
    if (c.revokedAt || c.name === 'Daily review') continue;
    expect((await request.post(`/api/clients/${c.id}/revoke`, { headers: OTHER })).ok()).toBeTruthy();
  }
}

test('without Claude: connecting Cursor ticks Getting started, the sidebar names it, and tasks offer a prompt to paste', async ({ page, request }) => {
  await noClaude(page, request);
  await removeAllAccess(request);
  // Keep what the app copies, instead of reading the real clipboard.
  await page.addInitScript(() => {
    navigator.clipboard.writeText = async (text: string) => void ((window as any).__copied = text);
  });
  await open(page, '#/today');
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('button', { name: 'No assistant connected' })).toBeVisible();
  const card = page.getByRole('region', { name: 'Getting started' });
  const step = card.getByRole('listitem').filter({ hasText: 'Connect an AI assistant' });
  await expect(step).toContainText('Claude, Codex, Copilot, Cursor, Gemini and others can plan and work your tasks.');
  await expect(step).not.toContainText('(done)');
  await step.getByRole('button', { name: 'Connect an assistant' }).click();
  await expect(page).toHaveURL(/#\/settings\?section=assistants$/);

  const section = page.getByRole('region', { name: 'AI assistants' });
  await expect(section).toBeInViewport();
  await expect(section).toContainText('Let an AI assistant read your tasks and work on them. Pick the app you use.');
  await expect(section.getByRole('radio')).toHaveText(['Claude', 'Codex (ChatGPT)', 'GitHub Copilot (VS Code)', 'Cursor', 'Gemini CLI', 'Windsurf (Devin Desktop)', 'Other app']);
  await section.getByRole('radio', { name: 'Cursor' }).click();
  await expect(section.getByRole('radio', { name: 'Cursor' })).toHaveAttribute('aria-checked', 'true');
  await section.getByRole('checkbox', { name: /Let it work on tasks/ }).check();
  await section.getByRole('button', { name: 'Connect Cursor' }).click();
  const reveal = section.getByRole('region', { name: 'Settings for Cursor' });
  await expect(reveal.getByLabel('Cursor settings')).toContainText('MASTER_TASKER_TOKEN_FILE');
  // Without Claude, the way to start work is the prompt in a task's ⋯ menu.
  await expect(section).toContainText("Open a task and choose Copy prompt for your assistant in its ⋯ menu. Paste it into Cursor's chat.");
  await reveal.getByRole('button', { name: 'I saved it' }).click();
  // A key alone isn't a connection: until Cursor uses it, it's waiting.
  await expect(section.getByRole('radio', { name: 'Cursor' })).toContainText('Not used yet');
  const row = section.getByRole('region', { name: 'Assistants with access' }).getByRole('listitem').filter({ hasText: 'Cursor' });
  await expect(row).toContainText('Can see all areas · Can read, suggest, edit and complete');
  await expect(row).toContainText("Cursor hasn't used it yet. Paste its settings into Cursor (Show settings), then quit and reopen Cursor.");
  await expect(nav).toContainText('Waiting for Cursor');
  // Cursor starts Master Tasker's tools, which check in with its key.
  await checkIn(request, 'Cursor');
  // Coming back to the browser from Cursor checks again, with no reload.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(section.getByRole('radio', { name: 'Cursor' })).toContainText('Connected');
  await expect(nav).toContainText('Cursor connected');

  // Getting started ticks the step.
  await open(page, '#/today');
  await expect(page.getByRole('region', { name: 'Getting started' }).getByRole('listitem').filter({ hasText: 'Connect an AI assistant' })).toContainText('(done)');
  await expect(page.getByRole('navigation', { name: 'Main' })).toContainText('Cursor connected');

  // A task's ⋯ menu copies a prompt for it, and offers nothing that needs Claude.
  const title = unique('Plan the launch email');
  const t = await apiCreate(request, { title, status: 'today' });
  await open(page, `#/today?task=${t.id}`);
  const detail = page.getByRole('complementary', { name: 'Task details' });
  await expect(detail.getByRole('button', { name: 'Work on this with Claude' })).toHaveCount(0);
  await detail.getByRole('button', { name: 'More actions' }).click();
  const menu = page.getByRole('menu', { name: 'More actions' });
  await expect(menu.getByRole('menuitem', { name: 'Connect an AI assistant' })).toHaveCount(0);
  await menu.getByRole('menuitem', { name: 'Copy prompt for your assistant' }).click();
  await expect(page.locator('.toast', { hasText: "Copied. Paste it into your assistant's chat." })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__copied)).toBe(
    `Use the Master Tasker tools to work on task ${t.id} ("${title}"): read it, plan it into steps, start it, tick steps off as you finish them, and flag anything only I can decide or do as Needs you.`,
  );
});

test('a task another assistant finished says Finished by its name, on the toast, in For you and on the card', async ({ page, request }) => {
  await noClaude(page, request);
  const made = await request.post('/api/clients', { headers: OTHER, data: { name: 'Cursor', kind: 'other', scopes: { areas: '*', unfiled: true, perms: ['read', 'update', 'complete'] } } });
  const { client, token } = await made.json();
  const title = unique('Rename the press photos');
  const t = await apiCreate(request, { title, status: 'doing' });
  await open(page, '#/foryou');
  const done = await request.post(`/api/tasks/${t.id}/complete`, { headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, data: { why: 'Renamed all 12' } });
  expect(done.ok()).toBeTruthy();
  await expect(page.locator('.toast', { hasText: `Cursor finished “${title}` })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: /^Finished for you/ })).toBeVisible();
  const item = page.locator('.finished-item', { hasText: title });
  await expect(item).toContainText('Renamed all 12');
  await expect(item).toContainText('Cursor');
  await open(page, '#/done');
  await expect(page.locator(`[data-task-id="${t.id}"]`)).toContainText('Finished by Cursor');
  expect((await request.post(`/api/clients/${client.id}/revoke`, { headers: OTHER })).ok()).toBeTruthy();
});

test('Connections is part of AI assistants now, and its old link lands on Assistants with access', async ({ page }) => {
  await open(page, '#/settings');
  const sections = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(sections.getByRole('button')).toHaveText(['General', 'AI assistants', 'Backups', 'Labs', 'Advanced']);
  await expect(page.getByRole('region', { name: 'Connections' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Connections' })).toHaveCount(0);
  await sections.getByRole('button', { name: 'AI assistants' }).click();
  const assistants = page.getByRole('region', { name: 'AI assistants' });
  await expect(assistants).toBeInViewport();

  await open(page, '#/settings?section=connections');
  const access = assistants.getByRole('region', { name: 'Assistants with access' });
  await expect(access).toBeInViewport();
  await expect(access.getByRole('heading', { name: 'Assistants with access' })).toBeFocused();
});

test("Claude and another app both connected: a task offers Claude's buttons and a prompt for the other app", async ({ page, request }) => {
  await page.route('**/api/integrations**', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const res = await route.fetch();
    const body = await res.json();
    if (body.integrations) Object.assign(body.integrations, { claudeApp: { ...body.integrations.claudeApp, found: true }, skillReady: true, ready: true });
    await route.fulfill({ response: res, json: body });
  });
  const made = await request.post('/api/clients', { headers: OTHER, data: { name: unique('Cursor'), kind: 'other', scopes: { areas: '*', unfiled: true, perms: ['read', 'propose'] } } });
  expect(made.ok()).toBeTruthy();
  const { client, token } = await made.json();
  // It has used its key, so it counts as connected.
  expect((await request.get('/api/whoami', { headers: { authorization: `Bearer ${token}` } })).ok()).toBeTruthy();
  const t = await apiCreate(request, { title: unique('Both assistants'), status: 'today' });
  await open(page, `#/today?task=${t.id}`);
  const detail = page.getByRole('complementary', { name: 'Task details' });
  await detail.getByRole('button', { name: 'More actions' }).click();
  const menu = page.getByRole('menu', { name: 'More actions' });
  await expect(menu.getByRole('menuitem', { name: 'Work on this with Claude' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Copy prompt for Claude', exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Copy prompt for your assistant' })).toBeVisible();
  await page.keyboard.press('Escape');
  expect((await request.post(`/api/clients/${client.id}/revoke`, { headers: OTHER })).ok()).toBeTruthy();
});
