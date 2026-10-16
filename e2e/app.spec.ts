import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

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

const row = (page: Page, title: string) => page.locator('[data-task-id]', { hasText: title });

/** The app's own select menus: the button is named "Label: Value"; pick an option from the menu it opens. */
const menuButton = (scope: Page | Locator, label: string) => scope.getByRole('button', { name: new RegExp(`^${label}(:|$)`) });
async function pick(page: Page, scope: Page | Locator, label: string, option: string) {
  await menuButton(scope, label).first().click();
  await page.getByRole('menuitemradio', { name: option, exact: true }).click();
}

test('quick capture, inline rename and detail edits persist across reload', async ({ page }) => {
  await open(page, '#/inbox');
  const title = unique('Captured task');
  await page.keyboard.press('n');
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  await expect(row(page, title)).toBeVisible();

  // Inline rename with E.
  await row(page, title).focus();
  await page.keyboard.press('e');
  const renamed = `${title} renamed`;
  await page.getByLabel('Task title', { exact: true }).fill(renamed);
  await page.keyboard.press('Enter');
  await expect(row(page, renamed)).toBeVisible();

  // Open details with Enter, set fields.
  await row(page, renamed).focus();
  await page.keyboard.press('Enter');
  const detail = page.getByRole('complementary', { name: 'Task details' });
  await detail.getByLabel('Next action').fill('Call the shop');
  // Waiting on only shows while the task is in Waiting.
  await expect(detail.getByLabel('Waiting on')).toHaveCount(0);
  await detail.getByLabel('Notes').fill('Line one');
  await detail.getByLabel('Next action').focus(); // blur notes to save
  await pick(page, detail, 'Priority', 'High');
  await detail.getByLabel('New subtask').fill('Step one');
  await detail.getByLabel('New subtask').press('Enter');
  // Links hide behind "+ Link" until there is one.
  await detail.getByRole('button', { name: 'Link', exact: true }).click();
  await detail.getByLabel('Link URL').fill('example.com/source');
  await detail.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(detail.getByRole('link', { name: 'https://example.com/source' })).toBeVisible();
  await expect(page.locator('.conn:visible .conn-label')).toHaveText('Saved on this Mac');

  await page.reload();
  await expect(page.locator('.conn-live:visible').first()).toBeVisible();
  // The open task is in the address, so it's still open after the reload.
  await expect(detail).toBeVisible();
  await expect(detail.getByLabel('Next action')).toHaveValue('Call the shop');
  await expect(detail.getByRole('link', { name: 'https://example.com/source' })).toBeVisible();
  await expect(detail.getByLabel('Notes')).toHaveValue('Line one');
  await expect(menuButton(detail, 'Priority')).toHaveAccessibleName('Priority: High');
  await expect(detail.getByLabel('Subtask title')).toHaveValue('Step one');
});

test('keyboard: move between columns, complete, reorder, and keyboard drag on the board', async ({ page, request }) => {
  const a = await apiCreate(request, { title: unique('Keyboard A'), status: 'inbox' });
  const b = await apiCreate(request, { title: unique('Keyboard B'), status: 'inbox' });
  await open(page, '#/board');
  const inbox = page.locator('section[data-status="inbox"]');
  const today = page.locator('section[data-status="today"]');
  await expect(inbox.locator(`[data-task-id="${a.id}"]`)).toBeVisible();

  // ] moves right one column.
  await page.locator(`[data-task-id="${a.id}"]`).focus();
  await page.keyboard.press(']');
  await expect(today.locator(`[data-task-id="${a.id}"]`)).toBeVisible();

  // Space picks up, arrow moves, Space drops (accessible drag and drop).
  await page.locator(`[data-task-id="${b.id}"]`).focus();
  // dnd-kit starts listening on the next tick, so pause like a person would.
  await page.keyboard.press('Space');
  await page.waitForTimeout(150);
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(150);
  await page.keyboard.press('Space');
  await expect(today.locator(`[data-task-id="${b.id}"]`)).toBeVisible();
  await expect(page.locator('#DndLiveRegion-0, [id^="DndLiveRegion"]').first()).toContainText(/Dropped .* in Today/);

  // After the drop animation, focus returns to the dropped card. Wait for that before moving on.
  await expect(page.locator(`[data-task-id="${b.id}"]`)).toBeFocused();

  // X completes. Done is folded to a rail with its count; Enter on it opens it.
  await page.locator(`[data-task-id="${a.id}"]`).focus();
  await page.keyboard.press('x');
  await expect(page.locator(`section[data-status="today"] [data-task-id="${a.id}"]`)).toHaveCount(0);
  await page.getByRole('button', { name: /^Show Done, \d+ tasks?$/ }).press('Enter');
  await expect(page.locator(`section[data-status="done"] [data-task-id="${a.id}"]`)).toBeVisible();
  await page.getByRole('button', { name: 'Fold Done away' }).click();
  await expect(page.getByRole('button', { name: /^Show Done/ })).toHaveAttribute('aria-expanded', 'false');

  // Server agrees.
  const check = await (await request.get(`/api/tasks/${b.id}`)).json();
  expect(check.task.status).toBe('today');
});

test('mouse drag and drop moves a card between columns', async ({ page, request }) => {
  const t = await apiCreate(request, { title: unique('Drag me'), status: 'next' });
  await open(page, '#/board');
  const card = page.locator(`[data-task-id="${t.id}"]`);
  const target = page.locator('section[data-status="today"] .column-body');
  const from = await card.boundingBox();
  const to = await target.boundingBox();
  await page.mouse.move(from!.x + 40, from!.y + 15);
  await page.mouse.down();
  await page.mouse.move(from!.x + 60, from!.y + 30, { steps: 4 });
  await page.mouse.move(to!.x + to!.width / 2, to!.y + 40, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator(`section[data-status="today"] [data-task-id="${t.id}"]`)).toBeVisible();
  await expect.poll(async () => (await (await request.get(`/api/tasks/${t.id}`)).json()).task.status).toBe('today');
});

test('changes made elsewhere appear live without a refresh', async ({ page, request }) => {
  await open(page, '#/inbox');
  const title = unique('Arrived live');
  const t = await apiCreate(request, { title });
  await expect(row(page, title)).toBeVisible();
  await request.patch(`/api/tasks/${t.id}`, { headers: OTHER, data: { baseRev: 1, patch: { title: `${title} edited` } } });
  await expect(row(page, `${title} edited`)).toBeVisible();
});

test('a collision shows a choice and loses nothing', async ({ page, request }) => {
  const title = unique('Collide');
  const t = await apiCreate(request, { title, notes: 'Original' });
  await open(page, `#/inbox?task=${t.id}`);
  const notes = page.getByRole('complementary', { name: 'Task details' }).getByLabel('Notes');
  await notes.click();
  await notes.fill('Original plus my edit');
  // Another device edits the same field while you type.
  await request.patch(`/api/tasks/${t.id}`, { headers: OTHER, data: { baseRev: 1, patch: { notes: 'Original plus their edit' } } });
  await expect(page.getByText('This changed somewhere else while you were typing')).toBeVisible();
  await page.getByRole('complementary', { name: 'Task details' }).getByLabel('Next action').click(); // blur saves
  const dialog = page.getByRole('dialog', { name: 'Two edits collided' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Original plus their edit');
  await expect(dialog).toContainText('Original plus my edit');
  await dialog.getByRole('button', { name: 'Keep both notes' }).click();
  await expect.poll(async () => (await (await request.get(`/api/tasks/${t.id}`)).json()).task.notes).toBe('Original plus their edit\n\nOriginal plus my edit');
});

test('a rejected save rolls back and says so', async ({ page, request }) => {
  const title = unique('Rollback');
  const t = await apiCreate(request, { title, status: 'inbox' });
  await open(page, '#/inbox');
  await page.route(`**/api/tasks/${t.id}`, (route) =>
    route.request().method() === 'PATCH'
      ? route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: { code: 'validation', message: 'Rejected by the server (test)' } }) })
      : route.continue(),
  );
  await row(page, title).focus();
  await page.keyboard.press('3'); // to Next
  await expect(page.getByRole('alert').filter({ hasText: 'Rejected by the server (test)' })).toBeVisible();
  await expect(row(page, title)).toBeVisible(); // still in Inbox: rolled back
  expect((await (await request.get(`/api/tasks/${t.id}`)).json()).task.status).toBe('inbox');
});

test('losing the connection is shown honestly, edits wait and then save', async ({ page, context, request }) => {
  const title = unique('Offline edit');
  const t = await apiCreate(request, { title, status: 'inbox' });
  await open(page, '#/inbox');
  await context.setOffline(true);
  await expect(page.locator('.conn').first()).toHaveClass(/conn-(offline|reconnecting)/, { timeout: 10_000 });
  await row(page, title).focus();
  await page.keyboard.press('p'); // priority: none -> low
  await expect(page.locator('.conn-detail')).toHaveText(/waiting to save|Saving/);
  await context.setOffline(false);
  await expect(page.locator('.conn-live:visible').first()).toBeVisible({ timeout: 20_000 });
  await expect.poll(async () => (await (await request.get(`/api/tasks/${t.id}`)).json()).task.priority, { timeout: 20_000 }).toBe('low');
  // Exactly one write happened (idempotent retries).
  const act = await (await request.get(`/api/activity?entityId=${t.id}`, { headers: OTHER })).json();
  expect(act.activity.filter((e: { action: string }) => e.action === 'updated')).toHaveLength(1);
});

test('search and filters narrow the list, with a useful empty state', async ({ page, request }) => {
  const title = unique('Needle haystack');
  await apiCreate(request, { title, priority: 'high', status: 'next' });
  await open(page, '#/next');
  await page.keyboard.press('/');
  await page.keyboard.type('needle');
  await expect(row(page, title)).toBeVisible();
  await expect(menuButton(page, 'Filter by priority')).toHaveCount(0);
  await page.getByRole('button', { name: /^Filter/ }).click();
  await pick(page, page, 'Filter by priority', 'Low');
  await expect(page.getByText('No matching tasks')).toBeVisible();
  await page.getByRole('button', { name: 'Clear search and filters' }).click();
  await expect(page.getByLabel('Search tasks')).toHaveValue('');
});

test('desktop screenshots for visual review', async ({ page }) => {
  await open(page, '#/board');
  await page.screenshot({ path: 'test-results/screens/desktop-board.png' });
  await open(page, '#/today');
  await page.screenshot({ path: 'test-results/screens/desktop-today.png' });
});

test('appearance: dark mode switch and color themes persist', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await open(page, '#/settings');
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-theme', 'light');
  await expect(page.getByRole('radiogroup', { name: 'Color theme' }).getByRole('radio')).toHaveCount(6);

  const appearance = page.getByRole('radiogroup', { name: 'Light or dark' });
  await expect(appearance.getByRole('radio', { name: 'Match my Mac' })).toHaveAttribute('aria-checked', 'true');
  await appearance.getByRole('radio', { name: 'Dark' }).click();
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await expect(appearance.getByRole('radio', { name: 'Match my Mac' })).toHaveAttribute('aria-checked', 'false');
  await page.getByRole('radio', { name: 'Lagoon' }).click();
  await expect(page.getByRole('radio', { name: 'Lagoon' })).toHaveAttribute('aria-checked', 'true');
  const accent = () => html.evaluate((el) => el.style.getPropertyValue('--seed-accent'));
  expect(await accent()).toBe('#3CD3C0');

  await page.reload();
  await expect(html).toHaveAttribute('data-theme', 'dark');
  expect(await accent()).toBe('#3CD3C0');

  await page.getByRole('radiogroup', { name: 'Light or dark' }).getByRole('radio', { name: 'Match my Mac' }).click();
  await expect(html).toHaveAttribute('data-theme', 'light');
  expect(await accent()).toBe('#0F766E');

  // A theme an older version offered falls back to the nearest one still here.
  await page.evaluate(() => localStorage.setItem('mt.color', 'grape'));
  await page.reload();
  await expect(page.getByRole('radio', { name: 'Lavender' })).toHaveAttribute('aria-checked', 'true');
  expect(await page.evaluate(() => localStorage.getItem('mt.color'))).toBe('lavender');
});

test('home is always Today; what needs you is a red link in its summary and leads For you', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();

  const t = await apiCreate(request, { title: unique('Decide'), status: 'doing', subtasks: ['Pick the color'] });
  const patched = await request.patch(`/api/tasks/${t.id}`, { headers: OTHER, data: { baseRev: t.rev, patch: { needsYou: 'Choose between the two logos' } } });
  expect(patched.ok()).toBeTruthy();
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
  await page.locator('.view-summary').getByRole('button', { name: /needs? you$/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'For you' })).toBeVisible();
  await expect(page.locator('.you-item', { hasText: 'Choose between the two logos' })).toBeVisible();
  // Every item has its own buttons, and the task name opens the task.
  const item = page.locator('.you-item', { hasText: 'Choose between the two logos' });
  await expect(item.getByRole('button', { name: 'Handled: Choose between the two logos' })).toBeVisible();
  await item.locator('.you-item-title').click();
  const detail = page.getByRole('complementary', { name: 'Task details' });
  await expect(detail.locator('.you-panel')).toContainText('Choose between the two logos');
  await detail.locator('.you-panel').getByRole('button', { name: 'Handled: Choose between the two logos' }).click();
  await expect(detail.locator('.you-panel')).toHaveCount(0);

  // Flag a subtask for yourself: the card gets the loud banner until you check it off.
  await detail.getByRole('button', { name: 'Flag Pick the color as needing you' }).click();
  await page.keyboard.press('Escape');
  await open(page, '#/doing');
  const card = page.locator(`[data-task-id="${t.id}"]`);
  await expect(card.locator('.you-banner')).toContainText('Pick the color');
  await card.click();
  await detail.locator('.you-panel').getByRole('button', { name: 'Not mine: Pick the color' }).click();
  await expect(card.locator('.you-banner')).toHaveCount(0);
  // Hand back, from the subtask row itself.
  await detail.getByRole('button', { name: 'Flag Pick the color as needing you' }).click();
  await detail.getByRole('button', { name: 'Hand back Pick the color' }).click();
  await expect(detail.getByRole('button', { name: 'Flag Pick the color as needing you' })).toBeAttached();
  await detail.getByRole('button', { name: 'Flag Pick the color as needing you' }).click();
  await detail.locator('.you-panel').getByRole('button', { name: 'Handled: Pick the color' }).click();
  await expect(card.locator('.you-banner')).toHaveCount(0);

  // Reply instead: the answer goes on the task for your assistant, and it stops waiting on you.
  const fresh = (await (await request.get(`/api/tasks/${t.id}`)).json()).task;
  await request.patch(`/api/tasks/${t.id}`, { headers: OTHER, data: { baseRev: fresh.rev, patch: { needsYou: 'Is the logo test done?' } } });
  const panel = detail.locator('.you-panel');
  await panel.getByRole('button', { name: 'Reply: Is the logo test done?' }).click();
  await panel.getByRole('textbox', { name: 'Reply about Is the logo test done?' }).fill('It counts, but it is not over yet');
  // Copying is its own button. Save reply only saves.
  await expect(panel.getByRole('button', { name: 'Copy reply' })).toBeVisible();
  await panel.getByRole('button', { name: /Save reply/ }).click();
  await expect(panel).toHaveCount(0);
  await expect.poll(async () => (await (await request.get(`/api/tasks/${t.id}`)).json()).task.notes).toContain('You replied to "Is the logo test done?": It counts, but it is not over yet');
  // Saved, and no longer waiting on you, before anything else changes it.
  await expect.poll(async () => (await (await request.get(`/api/tasks/${t.id}`)).json()).task.needsYou).toBe('');

  // The why shows under the ask, and Ask gets an answer right there.
  await request.post(`/api/tasks/${t.id}/needs-you`, { headers: OTHER, data: { text: 'Pick the final logo', detail: 'Both are in ~/Desktop/logos. I lean toward the blue one.' } });
  await expect(panel.locator('.you-detail')).toContainText('I lean toward the blue one');
  await expect(panel.locator('.you-path')).toHaveText('~/Desktop/logos');
  await panel.getByRole('button', { name: 'Ask about: Pick the final logo' }).click();
  await panel.getByRole('textbox', { name: 'Ask about Pick the final logo' }).fill('Why blue?');
  await panel.getByRole('button', { name: /^Ask/ }).last().click();
  await expect(panel.locator('.you-ask')).toContainText('Answer to "Why blue?"');
  await expect(panel.locator('.you-ask')).toContainText('read-only true');
  await panel.getByRole('button', { name: 'Handled: Pick the final logo' }).click();
  await expect(panel).toHaveCount(0);
});

test('sidebar: a flat top group, More for the rest, areas collapse, and it shrinks to icons', async ({ page }) => {
  await open(page, '#/board');
  const nav = page.getByRole('navigation', { name: 'Main' });
  for (const name of [/^Today/, /^Inbox/, /^For you/, /^In progress/, /^Board/]) await expect(nav.getByRole('button', { name })).toBeVisible();
  // Activity, Trash and Settings wait under More. Wizard and Routines are Labs, off until you turn them on.
  await expect(nav.getByRole('button', { name: /^Settings/ })).toHaveCount(0);
  await nav.getByRole('button', { name: 'More' }).click();
  for (const name of [/^Activity/, /^Trash/, /^Settings/]) await expect(nav.getByRole('button', { name })).toBeVisible();
  await expect(nav.getByRole('button', { name: /^Wizard/ })).toHaveCount(0);
  await nav.getByRole('button', { name: 'More' }).click();
  const work = nav.getByRole('button', { name: /^Clients( \d+)?$/ });
  await nav.getByRole('button', { name: /^Areas/ }).click();
  await expect(work).toHaveCount(0);
  await nav.getByRole('button', { name: /^Areas/ }).click();
  await expect(work).toBeVisible();

  const resizer = page.getByRole('separator', { name: 'Resize sidebar' });
  const box = (await resizer.boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + 200, { steps: 5 });
  await page.mouse.up();
  expect((await nav.boundingBox())!.width).toBeGreaterThan(330);
  await page.mouse.move(box.x + 80, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(60, box.y + 200, { steps: 8 });
  await page.mouse.up();
  await expect(nav).toHaveClass(/is-icons/);
  expect((await nav.boundingBox())!.width).toBeLessThan(80);
  await page.reload();
  await expect(nav).toHaveClass(/is-icons/);
  await nav.getByRole('button', { name: 'Expand sidebar' }).click();
  await expect(nav).not.toHaveClass(/is-icons/);
  await nav.getByRole('button', { name: 'More' }).click();
  await expect(nav.getByRole('button', { name: /^Settings/ })).toBeVisible();
});

test('S puts a card in In progress, where it leads Today and the board, and S again puts it back where it was', async ({ page, request }) => {
  const title = unique('Focus work');
  const t = await apiCreate(request, { title, status: 'next' });
  await open(page, '#/board');
  const doing = page.locator('section[data-status="doing"]');
  await page.locator(`[data-task-id="${t.id}"]`).focus();
  await page.keyboard.press('s');
  const card = doing.locator(`[data-task-id="${t.id}"]`);
  await expect(card).toBeVisible();
  await expect(card).toHaveClass(/is-doing/);
  await expect(page.locator('section[data-status]').first()).toHaveAttribute('data-status', 'doing');
  expect((await (await request.get(`/api/tasks/${t.id}`)).json()).task.status).toBe('doing');

  await open(page, '#/today');
  await expect(page.locator('section[data-status]').first()).toHaveAttribute('data-status', 'doing');
  await expect(page.locator(`section[data-status="doing"] [data-task-id="${t.id}"]`)).toBeVisible();
  await row(page, title).focus();
  await page.keyboard.press('s');
  // It came from Next, so Stop puts it back in Next.
  await expect.poll(async () => (await (await request.get(`/api/tasks/${t.id}`)).json()).task.status).toBe('next');
  await expect(row(page, title)).toHaveCount(0);
});

test('a Claude thread that mentions a task shows on it, with the current subtask and latest decision', async ({ page, request }) => {
  // Thread linking reads Claude Code's thread files, so it's off until you turn it on.
  expect((await request.patch('/api/settings', { headers: OTHER, data: { threadLinking: true } })).ok()).toBeTruthy();
  // Claude's notes on a card only show once Claude is set up (all inside .data/e2e).
  expect((await request.post('/api/integrations/claude-code', { headers: OTHER, data: {} })).ok()).toBeTruthy();
  const t = await apiCreate(request, { title: unique('Thread linked'), status: 'doing', subtasks: ['Draft the plan', 'Wire the button'] });
  const dir = path.resolve('.data/e2e/claude-projects/-Users-me-development-demo');
  fs.mkdirSync(dir, { recursive: true });
  const at = new Date().toISOString();
  const lines = [
    { type: 'user', cwd: '/Users/me/development/demo', timestamp: at, message: { role: 'user', content: `Master Tasker task ${t.id}: ${t.title}` } },
    { type: 'assistant', cwd: '/Users/me/development/demo', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'Now on: Wire the button\nDecision: use the existing toast for feedback.' }] } },
    { type: 'custom-title', customTitle: 'Demo thread' },
  ];
  fs.writeFileSync(path.join(dir, `e2e-${t.id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  await open(page, `#/doing?task=${t.id}`);
  const detail = page.getByRole('complementary', { name: 'Task details' });
  // Threads and History wait behind Details. The app checks threads every few seconds; the refresh button checks right away.
  await detail.getByText('Details', { exact: true }).click();
  await detail.getByRole('button', { name: 'Look for new threads' }).click();
  const card = page.locator(`.task-card[data-task-id="${t.id}"], .task-row[data-task-id="${t.id}"]`).first();
  await expect(card.locator('.now-subtask.is-current')).toContainText('Wire the button');
  await expect(card.locator('.now-note')).toContainText('use the existing toast for feedback');
  await expect(detail.locator('.subtask.is-current')).toHaveCount(1);
  await expect(detail.locator('.thread-title')).toHaveText('Demo thread');
  await detail.getByRole('button', { name: 'Unlink Demo thread' }).click();
  await expect(detail.getByText('No threads yet')).toBeVisible();
});

test('Work and Personal modes show one side, keep unfiled tasks, and file new tasks on that side', async ({ page, request }) => {
  const areas = (await (await request.get('/api/areas', { headers: OTHER })).json()).areas as { id: string; name: string }[];
  const id = (n: string) => areas.find((a) => a.name === n)!.id;
  // Every area starts on the personal side, so there is no Showing menu yet. Put Clients on the work side for this test.
  await page.goto('/#/next');
  await expect(page.getByRole('button', { name: 'Show work, personal or both' })).toHaveCount(0);
  expect((await request.patch(`/api/areas/${id('Clients')}`, { headers: OTHER, data: { mode: 'work' } })).ok()).toBeTruthy();
  try {
    await modes(page, request, id);
  } finally {
    await request.patch(`/api/areas/${id('Clients')}`, { headers: OTHER, data: { mode: 'personal' } });
  }
});

async function modes(page: Page, request: APIRequestContext, id: (n: string) => string) {
  const work = await apiCreate(request, { title: unique('Mode work'), status: 'next', areaId: id('Clients') });
  const home = await apiCreate(request, { title: unique('Mode home'), status: 'next', areaId: id('Home') });
  const loose = await apiCreate(request, { title: unique('Mode unfiled'), status: 'next' });
  await open(page, '#/next');
  // "Showing: Both" in the toolbar, there because areas exist on both sides.
  const mode = page.getByRole('button', { name: 'Show work, personal or both' });
  const pick = async (name: string) => {
    await mode.click();
    await page.getByRole('menuitemradio', { name }).click();
  };
  const shown = (t: { id: string }) => page.locator(`[data-task-id="${t.id}"]`);
  await expect(mode).toHaveText(/Showing: Both/);

  await pick('Work');
  await expect(mode).toHaveText(/Showing: Work/);
  await expect(shown(work)).toBeVisible();
  await expect(shown(loose)).toBeVisible();
  await expect(shown(home)).toHaveCount(0);
  const title = unique('Captured at work');
  await page.keyboard.press('n');
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await (await request.get(`/api/tasks?q=${encodeURIComponent(title)}`, { headers: OTHER })).json()).tasks[0]?.areaId).toBe(id('Clients'));

  await page.keyboard.press('Escape');
  await page.locator('body').click({ position: { x: 600, y: 20 } });
  await page.keyboard.press('m'); // Work -> Personal
  await expect(mode).toHaveText(/Showing: Personal/);
  await expect(shown(home)).toBeVisible();
  await expect(shown(work)).toHaveCount(0);
  await page.reload();
  await expect(mode).toHaveText(/Showing: Personal/);
  await mode.click();
  await expect(page.getByRole('menuitemradio', { name: 'Personal' })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('menuitemradio', { name: 'Both' }).click();
  await expect(shown(work)).toBeVisible();
}

test('Routines lists routines, their tasks and sources, and a source can be switched off and on', async ({ page }) => {
  // The Claude app here has routines, so Routines shows under More without turning on the Lab. Old #/sources links still work.
  await open(page, '#/sources');
  await expect(page.getByRole('heading', { level: 1, name: 'Routines' })).toBeVisible();
  const daily = page.locator('.routine', { hasText: 'Daily review' });
  await expect(daily).toContainText('Every day at 8am and 2pm');
  await expect(daily).toContainText('Every open task');
  const gmail = daily.getByRole('switch', { name: 'Daily review reads Gmail' });
  const was = await gmail.getAttribute('aria-checked');
  await gmail.click();
  await expect(gmail).toHaveAttribute('aria-checked', was === 'true' ? 'false' : 'true');
  await page.reload();
  await expect(gmail).toHaveAttribute('aria-checked', was === 'true' ? 'false' : 'true');
  await gmail.click();
  await expect(gmail).toHaveAttribute('aria-checked', was ?? 'true');
  await expect(page.getByRole('textbox', { name: 'Describe the source to add' })).toBeVisible();
});

test('Work on this with Claude asks for a new-thread link for the task and for one subtask', async ({ page, request, isMobile }) => {
  test.skip(isMobile, 'The Claude app is on the Mac, so phones do not show this');
  // Claude is set up (all inside .data/e2e), so the buttons open Claude instead of Settings.
  expect((await request.post('/api/integrations/claude-code', { headers: OTHER, data: {} })).ok()).toBeTruthy();
  // Don't actually leave the page for claude://
  await page.addInitScript(() => Object.defineProperty(window, '__mtOpen', { value: (u: string) => ((window as any).__opened = u) }));
  const title = unique('Start me');
  const t = await apiCreate(request, { title, status: 'today', subtasks: ['First step'] });
  await open(page, `#/today?task=${t.id}`);
  const link = page.waitForResponse((r) => r.url().includes(`/api/tasks/${t.id}/claude-link`) && !r.url().includes('subtask'));
  await page.getByRole('button', { name: 'Work on this with Claude' }).click();
  expect(new URL((await (await link).json()).url).searchParams.get('q')).toBe(`/master-tasker ${t.id}`);
  // It can't know Claude opened, so it says it's opening, not that it worked.
  await expect(page.locator('.toast', { hasText: 'Opening Claude…' })).toBeVisible();
  const sub = page.waitForResponse((r) => r.url().includes(`/api/tasks/${t.id}/claude-link?subtask=`));
  await page.getByRole('button', { name: 'Work on First step with Claude' }).click();
  expect(new URL((await (await sub).json()).url).searchParams.get('q')).toContain('Start with the subtask: "First step"');
});

test('you can drag subtasks into your own order, unless Claude locked them in sequence', async ({ page, request, isMobile }) => {
  test.skip(isMobile, 'Desktop keyboard check');
  const t = await apiCreate(request, { title: unique('Reorder me'), status: 'today', subtasks: ['Alpha', 'Bravo', 'Charlie'] });
  await open(page, `#/today?task=${t.id}`);
  const detail = page.getByRole('complementary', { name: 'Task details' });
  const titles = () => detail.locator('.subtask .subtask-title').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
  // Keyboard: pick Charlie up with Space, move it up two, drop it.
  await detail.getByRole('button', { name: 'Move Charlie' }).focus();
  await page.keyboard.press('Space');
  await page.waitForTimeout(150);
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(150);
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(150);
  await page.keyboard.press('Space');
  await expect.poll(titles).toEqual(['Charlie', 'Alpha', 'Bravo']);
  // Keyboard: pick Alpha up with Space, move it down one, drop it.
  await detail.getByRole('button', { name: 'Move Alpha' }).focus();
  await page.keyboard.press('Space');
  await page.waitForTimeout(150);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(150);
  await page.keyboard.press('Space');
  await expect.poll(titles).toEqual(['Charlie', 'Bravo', 'Alpha']);
  await page.reload();
  await expect.poll(titles).toEqual(['Charlie', 'Bravo', 'Alpha']);

  await request.put(`/api/tasks/${t.id}/subtasks/order`, { headers: OTHER, data: { ordered: true } });
  await expect(detail.getByRole('button', { name: 'Move Alpha' })).toHaveCount(0);
  await detail.getByRole('button', { name: /Unlock to reorder/ }).click();
  await expect(detail.getByRole('button', { name: 'Move Alpha' })).toBeVisible();
});

test('moving a task into Waiting asks what it is waiting on and saves it as a note', async ({ page, request }) => {
  const title = unique('Wait for it');
  const t = await apiCreate(request, { title, status: 'today' });
  await open(page, `#/today?task=${t.id}`);
  const detail = page.getByRole('complementary', { name: 'Task details' });
  await pick(page, detail, 'Status', 'Waiting');
  const dialog = page.getByRole('dialog', { name: 'What are you waiting on?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox').fill('Michael to confirm the dates');
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await (await request.get(`/api/tasks/${t.id}`, { headers: OTHER })).json()).task).toMatchObject({ status: 'waiting', waitingOn: 'Michael to confirm the dates' });
  await expect.poll(async () => (await (await request.get(`/api/tasks/${t.id}`, { headers: OTHER })).json()).task.notes).toContain('Waiting on Michael to confirm the dates');
});

test('clicking the open card again, or empty space, closes the task panel', async ({ page, request }) => {
  const title = unique('Close me');
  await apiCreate(request, { title, status: 'today' });
  await open(page, '#/today');
  const detail = page.getByRole('complementary', { name: 'Task details' });
  await row(page, title).locator('.task-title').click();
  await expect(detail).toBeVisible();
  await row(page, title).locator('.task-title').click();
  await expect(detail).toBeHidden();
  await row(page, title).locator('.task-title').click();
  await expect(detail).toBeVisible();
  await detail.getByRole('textbox').first().click();
  await expect(detail).toBeVisible();
  await page.locator('#main').dispatchEvent('click');
  await expect(detail).toBeHidden();
});

test('a task an assistant finished waits in For you until you press Got it', async ({ page, request }) => {
  const title = unique('Finished by an assistant');
  const t = await apiCreate(request, { title, status: 'doing' });
  const c = await request.post('/api/clients', { headers: OTHER, data: { name: 'Claude threads e2e', kind: 'claude', scopes: { areas: '*', unfiled: true, perms: ['read', 'update', 'complete'] } } });
  const token = (await c.json()).token;
  // Old #/review links land on For you.
  await open(page, '#/review');
  await expect(page.getByRole('heading', { level: 1, name: 'For you' })).toBeVisible();
  const done = await request.post(`/api/tasks/${t.id}/complete`, { headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, data: { why: 'Shipped the nav, tests pass' } });
  expect(done.ok()).toBeTruthy();
  // The toast names the connection that finished it.
  await expect(page.locator('.toast', { hasText: `Claude threads e2e finished “${title}` })).toBeVisible();
  const item = page.locator('.finished-item', { hasText: title });
  await expect(item).toContainText('Shipped the nav, tests pass');
  await item.getByRole('button', { name: 'Got it' }).click();
  await expect(item).toHaveCount(0);
  await expect.poll(async () => (await (await request.get(`/api/tasks/${t.id}`, { headers: OTHER })).json()).task.finishedBy).toBeNull();
});

test('focus mode shows one step at a time, parks stray thoughts in Inbox, and finishes the task', async ({ page, request }) => {
  const title = unique('Focus on this');
  const t = await apiCreate(request, { title, status: 'today', notes: 'Done when: both steps are done.', subtasks: ['First step', 'Second step'] });
  await open(page, `#/today?task=${t.id}`);
  // Focus is in the task's ⋯ menu. The shell behind it goes inert.
  await page.getByRole('complementary', { name: 'Task details' }).getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: /Focus/ }).click();
  const focus = page.getByRole('dialog', { name: `Focus: ${title}` });
  await expect(focus.getByRole('heading', { name: 'First step' })).toBeVisible();
  await expect(focus).toContainText('Step 1 of 2');
  await expect(focus).toContainText('both steps are done.');
  const thought = unique('Stray thought');
  await focus.getByLabel(/Park it here/).fill(thought);
  await focus.getByLabel(/Park it here/).press('Enter');
  await expect(focus).toContainText('Parked in Inbox');
  await focus.getByRole('button', { name: /Done, next step/ }).click();
  await expect(focus.getByRole('heading', { name: 'Second step' })).toBeVisible();
  await focus.getByRole('button', { name: /Done, next step/ }).click();
  await expect(page.locator('.app')).toHaveAttribute('inert', '');
  await focus.getByRole('button', { name: /Complete task/ }).click();
  await expect(focus.getByRole('heading', { name: 'Done.' })).toBeVisible();
  // Seconds of focus say so, and the week so far shows under it.
  await expect(focus).toContainText(/2 steps · (Under a minute|\d+ min focused)/);
  await expect(focus.getByRole('region', { name: /^This week: \d+ done$/ })).toBeVisible();
  await expect(focus.getByRole('button', { name: 'Back to Today' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(focus).toHaveCount(0);
  await expect(page.locator('.app')).not.toHaveAttribute('inert');
  await expect.poll(async () => (await (await request.get(`/api/tasks/${t.id}`, { headers: OTHER })).json()).task.status).toBe('done');
  const all = await (await request.get('/api/sync', { headers: OTHER })).json();
  expect(all.tasks.find((x: { title: string }) => x.title === thought)?.status).toBe('inbox');
});

const isoDay = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

test('finishing a task: the row stays struck through, folds away, and the toast counts today with Undo', async ({ page, request }) => {
  const title = unique('Finish me');
  const t = await apiCreate(request, { title, status: 'today' });
  await open(page, '#/today');
  const r = row(page, title);
  await r.getByRole('checkbox', { name: `Complete ${title}` }).click();
  // Struck through where it was for a moment, then it folds away.
  await expect(r).toHaveClass(/is-finishing/);
  await expect(r).toHaveClass(/is-done/);
  await expect(r).toHaveCount(0);
  const toast = page.locator('.toast', { hasText: /^Done · \d+ today/ });
  await expect(toast).toBeVisible();
  // The header says how the day is going; the sidebar badge is a plain count of what is left.
  await expect(page.locator('.today-progress')).toContainText(/\d+ of \d+ done/);
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /^Today/ }).locator('.badge')).toHaveText(/^\d+$/);
  // Hovering holds the toast, and Undo puts it back where it was.
  await toast.hover();
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(r).toBeVisible();
  await expect.poll(async () => (await (await request.get(`/api/tasks/${t.id}`)).json()).task.status).toBe('today');
});

test('the task panel header is Mark done, Start, ⋯ and Close, and never overflows at 1440 or 1180', async ({ page, request }) => {
  const t = await apiCreate(request, { title: unique('Header check with a fairly long title to push things around'), status: 'today' });
  for (const width of [1440, 1180]) {
    await page.setViewportSize({ width, height: 900 });
    await open(page, `#/today?task=${t.id}`);
    const detail = page.getByRole('complementary', { name: 'Task details' });
    const head = detail.locator('.detail-head');
    const shown = await head.getByRole('button').evaluateAll((els) => els.filter((e) => e.checkVisibility()).map((e) => e.getAttribute('aria-label') || e.textContent?.trim()));
    expect(shown).toEqual(['Mark done', 'Start', 'More actions', 'Close details']);
    expect(await head.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const close = (await detail.getByRole('button', { name: 'Close details' }).boundingBox())!;
    const panel = (await detail.boundingBox())!;
    expect(close.x + close.width).toBeLessThanOrEqual(Math.min(width, panel.x + panel.width));
    // One filled button in the panel.
    await expect(detail.locator('.btn-primary:visible')).toHaveCount(1);
    // The rest is in the ⋯ menu.
    await detail.getByRole('button', { name: 'More actions' }).click();
    await expect(page.getByRole('menu', { name: 'More actions' }).getByRole('menuitem', { name: 'Move to Trash' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(detail.getByRole('button', { name: 'More actions' })).toBeFocused();
  }
});

test('notes save on their own a moment after you stop typing, and Esc saves too', async ({ page, request }) => {
  const t = await apiCreate(request, { title: unique('Autosave'), status: 'today' });
  await open(page, `#/today?task=${t.id}`);
  const detail = page.getByRole('complementary', { name: 'Task details' });
  const notes = detail.getByLabel('Notes');
  await notes.click();
  await notes.pressSequentially('Typed and left alone');
  await expect(notes).toBeFocused();
  await expect.poll(async () => (await (await request.get(`/api/tasks/${t.id}`)).json()).task.notes, { timeout: 5000 }).toBe('Typed and left alone');
  await notes.pressSequentially(', then Esc');
  await page.keyboard.press('Escape');
  await expect(notes).not.toBeFocused();
  await expect(detail).toBeVisible();
  await expect.poll(async () => (await (await request.get(`/api/tasks/${t.id}`)).json()).task.notes).toBe('Typed and left alone, then Esc');
});

test('area ⋯ menu: rename, color, archive with Undo, and delete that asks where its tasks go', async ({ page, request }) => {
  const name = unique('Garden');
  const made = await request.post('/api/areas', { headers: OTHER, data: { name, mode: 'personal' } });
  expect(made.ok()).toBeTruthy();
  const area = (await made.json()).area;
  const t = await apiCreate(request, { title: unique('Plant bulbs'), status: 'next', areaId: area.id });
  await open(page, '#/today');
  const nav = page.getByRole('navigation', { name: 'Main' });
  const areaOf = async () => ((await (await request.get('/api/areas', { headers: OTHER })).json()).areas as { id: string; name: string; color: string; archived: boolean }[]).find((a) => a.id === area.id);

  // Double-click renames.
  await nav.getByRole('button', { name: new RegExp(`^${name}( \\d+)?$`) }).dblclick();
  await nav.getByRole('textbox', { name: 'Area name' }).fill(`${name} beds`);
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await areaOf())?.name).toBe(`${name} beds`);

  // Color, from the menu.
  await nav.getByRole('button', { name: `${name} beds options` }).click();
  const menu = page.getByRole('menu', { name: `${name} beds options` });
  await menu.getByRole('menuitemradio', { name: 'Teal' }).click();
  await expect.poll(async () => (await areaOf())?.color.toLowerCase()).toBe('#058379');

  // Archive, then Undo.
  await nav.getByRole('button', { name: `${name} beds options` }).click();
  await menu.getByRole('menuitem', { name: 'Archive' }).click();
  const renamed = nav.getByRole('button', { name: new RegExp(`^${name} beds( \\d+)?$`) });
  await expect(renamed).toHaveCount(0);
  await page.locator('.toast', { hasText: 'Archived' }).getByRole('button', { name: 'Undo' }).click();
  await expect(renamed).toBeVisible();

  // Delete asks in the app's own dialog, and its task goes where you say.
  await nav.getByRole('button', { name: `${name} beds options` }).click();
  await menu.getByRole('menuitem', { name: 'Delete…' }).click();
  const dialog = page.getByRole('dialog', { name: `Delete “${name} beds”?` });
  await expect(dialog).toContainText('It has 1 task');
  await dialog.getByLabel('Move tasks to').selectOption({ label: 'Unfiled' });
  await dialog.getByRole('button', { name: 'Move and delete' }).click();
  await expect(page.locator('.toast', { hasText: 'Moved 1 task to Unfiled' })).toBeVisible();
  expect(await areaOf()).toBeUndefined();
  expect((await (await request.get(`/api/tasks/${t.id}`)).json()).task.areaId).toBeNull();
  const log = (await (await request.get('/api/activity?limit=20', { headers: OTHER })).json()).activity.map((e: { summary: string }) => e.summary);
  expect(log).toContain(`Deleted area “${name} beds” and moved 1 task to Unfiled`);
});

test('For you has Needs you, Finished for you and Suggestions, and its badge counts what needs you', async ({ page, request }) => {
  const t = await apiCreate(request, { title: unique('Needs a call'), status: 'today' });
  await request.post(`/api/tasks/${t.id}/needs-you`, { headers: OTHER, data: { text: 'Call the bank' } });
  await open(page, '#/foryou');
  for (const name of [/^Needs you/, /^Finished for you/, /^Suggestions/]) await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
  await expect(page.locator('.you-item', { hasText: 'Call the bank' })).toBeVisible();
  const n = await page.locator('.you-item').count();
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /^For you/ }).locator('.badge-you')).toHaveText(String(n));
  expect((await request.delete(`/api/tasks/${t.id}`, { headers: OTHER })).ok()).toBeTruthy();
});

test('first run: a Getting started card on Today with three steps, and dismissing it sticks', async ({ page }) => {
  await open(page, '#/today');
  const card = page.getByRole('region', { name: 'Getting started' });
  await expect(card).toBeVisible();
  await expect(card.getByRole('listitem')).toHaveCount(3);
  await expect(card).toContainText('Clear the sample tasks');
  await expect(card).toContainText('Connect an AI assistant');
  await expect(card.getByRole('button', { name: /^Clear \d+ samples?$/ })).toBeVisible();
  // Try Focus opens Focus on a task, and the step is ticked.
  await card.getByRole('button', { name: 'Try Focus' }).click();
  await expect(page.getByRole('dialog', { name: /^Focus: / })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card.getByRole('listitem').filter({ hasText: 'Try Focus' })).toContainText('(done)');
  await card.getByRole('button', { name: 'Dismiss getting started' }).click();
  await expect(card).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.conn-live:visible').first()).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Getting started' })).toHaveCount(0);
});

test('the Today summary: the date, then each count is a link, and the board agrees with the sidebar', async ({ page, request }) => {
  const late = await apiCreate(request, { title: unique('Late one'), status: 'next', dueDate: isoDay(-3) });
  const planned = await apiCreate(request, { title: unique('Planned one'), status: 'today' });
  await open(page, '#/today');
  const summary = page.locator('.view-summary');
  await expect(summary.getByRole('button').first()).toHaveText(/^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}$/);
  const overdue = summary.getByRole('button', { name: /^\d+ overdue$/ });
  await overdue.click();
  await expect(overdue).toHaveAttribute('aria-pressed', 'true');
  await expect(row(page, late.title)).toBeVisible();
  await expect(row(page, planned.title)).toHaveCount(0);
  await summary.getByRole('button').first().click();
  await expect(overdue).toHaveAttribute('aria-pressed', 'false');
  await expect(row(page, planned.title)).toBeVisible();

  // The Today column on the board counts what the sidebar counts: planned, plus anything due or overdue.
  const badge = await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /^Today/ }).locator('.badge').textContent();
  await open(page, '#/board');
  await expect(page.locator('section[data-status="today"] .column-head .count')).toHaveText(badge!.trim());
  await expect(page.locator('section[data-status="today"] .ghost', { hasText: late.title })).toBeVisible();
});

test('capture reads a day and a priority, says what it read, and Undo puts the words back', async ({ page, request }) => {
  await open(page, '#/inbox');
  const base = unique('Call the vet');
  await page.keyboard.press('n');
  await page.keyboard.type(`${base} tomorrow !high`);
  await expect(page.locator('.capture-parsed')).toHaveText(/^Due .+ · High priority$/);
  await page.keyboard.press('Enter');
  const toast = page.locator('.toast', { hasText: `Added “${base}”` });
  await expect(toast).toContainText('High priority');
  const find = async () => (await (await request.get(`/api/tasks?q=${encodeURIComponent(base)}`, { headers: OTHER })).json()).tasks[0];
  await expect.poll(find).toMatchObject({ title: base, dueDate: isoDay(1), priority: 'high' });
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(find).toMatchObject({ title: `${base} tomorrow !high`, dueDate: null, priority: 'none' });
});

test('⌘K goes anywhere, and Cmd-click picks several tasks to finish at once', async ({ page, request }) => {
  const a = await apiCreate(request, { title: unique('Pick A'), status: 'next' });
  const b = await apiCreate(request, { title: unique('Pick B'), status: 'next' });
  await open(page, '#/next');
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: 'Go anywhere or do anything' });
  await expect(palette).toBeVisible();
  await page.keyboard.type('Go to Waiting');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Waiting' })).toBeVisible();

  await open(page, '#/next');
  await row(page, a.title).locator('.task-title').click({ modifiers: ['ControlOrMeta'] });
  await row(page, b.title).locator('.task-title').click({ modifiers: ['ControlOrMeta'] });
  const bar = page.getByRole('toolbar', { name: '2 selected' });
  await expect(bar).toBeVisible();
  await bar.getByRole('button', { name: 'Mark done' }).click();
  await expect.poll(async () => (await (await request.get(`/api/tasks/${b.id}`)).json()).task.status).toBe('done');
  expect((await (await request.get(`/api/tasks/${a.id}`)).json()).task.status).toBe('done');
  await expect(bar).toHaveCount(0);
});

test('Today lists an In progress task once, even when it is also due today', async ({ page, request }) => {
  const t = await apiCreate(request, { title: unique('Started and due'), status: 'doing', dueDate: isoDay(0) });
  await open(page, '#/today');
  await expect(page.locator(`section[data-status="doing"] [data-task-id="${t.id}"]`)).toBeVisible();
  await expect(page.locator(`[data-task-id="${t.id}"]`)).toHaveCount(1);
  // The board keeps its slim In progress row; the Today page doesn't need one above its own group.
  await expect(page.locator('.content .group-slim')).toHaveCount(0);
});

test('closing the task panel stays on the view you are on, even after moving to another one', async ({ page, request }) => {
  const title = unique('Close and stay');
  await apiCreate(request, { title, status: 'today' });
  const detail = page.getByRole('complementary', { name: 'Task details' });
  const heading = (name: string) => page.getByRole('heading', { level: 1, name });

  // Opened on Today, then moved to Inbox with the panel still open: closing it stays in Inbox.
  await open(page, '#/today');
  await row(page, title).locator('.task-title').click();
  await expect(detail).toBeVisible();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /^Inbox/ }).click();
  await expect(heading('Inbox')).toBeVisible();
  await expect(detail).toBeVisible();
  await detail.getByRole('button', { name: 'Close details' }).click();
  await expect(detail).toBeHidden();
  await expect(heading('Inbox')).toBeVisible();
  await expect(page).toHaveURL(/#\/inbox$/);

  // Opened and closed on the same view: still there, and Back doesn't reopen it.
  await open(page, '#/today');
  await row(page, title).locator('.task-title').click();
  await expect(page).toHaveURL(/#\/today\?task=/);
  await detail.getByRole('button', { name: 'Close details' }).click();
  await expect(detail).toBeHidden();
  await expect(page).toHaveURL(/#\/today$/);
  await expect(heading('Today')).toBeVisible();
});

test('Today says where you stand: done of the day with a ring, this week links to Done, and Next, Waiting and Done are one click away', async ({ page, request }) => {
  const title = unique('Stand here');
  await apiCreate(request, { title, status: 'today' });
  await open(page, '#/today');
  const progress = page.locator('.today-progress');
  await expect(progress.locator('.progress-ring')).toBeVisible();
  const read = async () => {
    const m = /(\d+) of (\d+) done/.exec((await progress.textContent()) ?? '');
    return m ? [Number(m[1]), Number(m[2])] : null;
  };
  const before = await read();
  expect(before).not.toBeNull();
  await row(page, title).getByRole('checkbox', { name: `Complete ${title}` }).click();
  // One more done, out of the same day.
  await expect.poll(read).toEqual([before![0] + 1, before![1]]);
  await progress.getByRole('button', { name: /^\d+\sthis week$/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Done' })).toBeVisible();

  const nav = page.getByRole('navigation', { name: 'Main' });
  for (const name of ['Next', 'Waiting', 'Done']) {
    await nav.getByRole('button', { name: new RegExp(`^${name}( \\d+)?$`) }).click();
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  }
  // The Today badge is a plain count, the same one the board's Today column shows.
  await expect(nav.getByRole('button', { name: /^Today/ }).locator('.badge')).toHaveText(/^\d+$/);
});

test('end of day: with everything on Today done, the page says so in place, with no dialog', async ({ page, request }) => {
  const title = unique('Last one today');
  const t = await apiCreate(request, { title, status: 'today' });
  // Other tests leave tasks on Today. Show this page only the one task made here, plus what is done.
  const today = isoDay(0);
  const onToday = (x: { id: string; status: string; dueDate: string | null }) => x.id !== t.id && x.status !== 'done' && (x.status === 'today' || x.status === 'doing' || (!!x.dueDate && x.dueDate <= today));
  await page.route('**/api/sync**', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    if (Array.isArray(body.tasks)) body.tasks = body.tasks.filter((x: { id: string; status: string; dueDate: string | null }) => !onToday(x));
    await route.fulfill({ response: res, json: body });
  });
  await open(page, '#/today');
  await expect(page.locator('.content [data-task-id]')).toHaveCount(1);
  await row(page, title).getByRole('checkbox', { name: `Complete ${title}` }).click();
  const done = page.getByRole('region', { name: "Today's done" });
  await expect(done).toBeVisible();
  await expect(done).toContainText(/\d+ done today · \d+ this week/);
  await expect(done).toContainText('Enjoy the rest of your day.');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.today-progress')).toContainText(/(\d+) of \1 done/);
  // Undo brings the task back, and the page goes back to the list.
  await page.locator('.toast', { hasText: /^Done · \d+ today/ }).getByRole('button', { name: 'Undo' }).click();
  await expect(row(page, title)).toBeVisible();
  await expect(done).toHaveCount(0);
});

test('capture: a full-width row of its own, a hint on focus, and #area with a date files and dates the task', async ({ page, request }) => {
  await open(page, '#/inbox');
  const input = page.getByLabel('New task title');
  const syntax = page.locator('#capture-help .capture-syntax');
  await expect(syntax).toHaveCount(0);
  const topbar = (await page.locator('.topbar').boundingBox())!;
  const field = (await page.locator('.capture-field').boundingBox())!;
  // Under the title and tools, as wide as the list.
  expect(field.y).toBeGreaterThanOrEqual(topbar.y + topbar.height - 1);
  expect(field.width).toBeGreaterThan(900);
  await input.click();
  await expect(syntax).toHaveText(/^Try #\S+, fri, Oct 20, in 3 days or !high$/);
  const base = unique('Plant bulbs');
  await page.keyboard.type(`${base} #home in 3 days`);
  await expect(syntax).toHaveCount(0);
  await expect(page.locator('.capture-parsed')).toHaveText(/^Due .+ · In Home$/);
  // What it read sits under the field, so the field keeps its width.
  expect((await page.locator('.capture-field').boundingBox())!.width).toBe(field.width);
  await page.keyboard.press('Enter');
  await expect(page.locator('.toast', { hasText: `Added “${base}”` })).toContainText('In Home');
  const areas = (await (await request.get('/api/areas', { headers: OTHER })).json()).areas as { id: string; name: string }[];
  const home = areas.find((a) => a.name === 'Home')!.id;
  await expect.poll(async () => (await (await request.get(`/api/tasks?q=${encodeURIComponent(base)}`, { headers: OTHER })).json()).tasks[0]).toMatchObject({ title: base, areaId: home, dueDate: isoDay(3) });
});
