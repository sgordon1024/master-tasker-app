import { expect, test, type Page } from '@playwright/test';

test.beforeEach(({}, info) => {
  test.skip(info.project.name !== 'phone', 'phone layout');
});

async function noHorizontalOverflow(page: Page) {
  const over = await page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    const offenders: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      if (el.closest('.board, .sidebar:not(.is-open), .toasts')) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > w + 1 || r.left < -1)) offenders.push(`${el.tagName}.${el.className}`);
    }
    return offenders.slice(0, 5);
  });
  expect(over).toEqual([]);
}

test('phone layout: tab bar, drawer, capture, full-screen details', async ({ page }) => {
  await page.goto('/#/today');
  await expect(page.locator('.conn-live:visible').first()).toBeVisible();
  const tabs = page.getByRole('navigation', { name: 'Views' });
  await expect(tabs).toBeVisible();
  for (const name of [/^Today/, /^Inbox/, /^For you/, /^In progress/, /^More/]) await expect(tabs.getByRole('button', { name })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden();
  await noHorizontalOverflow(page);
  await page.screenshot({ path: 'test-results/screens/phone-today.png' });

  await tabs.getByRole('button', { name: /Inbox/ }).tap();
  await expect(page.getByRole('heading', { name: 'Inbox', level: 1 })).toBeVisible();
  await page.getByLabel('New task title').fill('Phone capture');
  await page.getByLabel('New task title').press('Enter');
  const item = page.locator('[data-task-id]', { hasText: 'Phone capture' });
  await expect(item).toBeVisible();
  await noHorizontalOverflow(page);

  await item.locator('.task-title').tap();
  const detail = page.getByRole('complementary', { name: 'Task details' });
  await expect(detail).toBeVisible();
  const box = await detail.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(389);
  await page.waitForTimeout(400); // let the sheet animation finish
  await page.screenshot({ path: 'test-results/screens/phone-detail.png' });
  // On a phone the panel is a page: "‹ Back" at the top left, and no X.
  await expect(detail.getByRole('button', { name: 'Close details' })).toBeHidden();
  await detail.getByRole('button', { name: 'Back' }).tap();
  await expect(detail).toBeHidden();

  await tabs.getByRole('button', { name: 'More' }).tap();
  const drawer = page.getByRole('navigation', { name: 'Main' });
  await expect(drawer).toBeVisible();
  await page.screenshot({ path: 'test-results/screens/phone-drawer.png' });
  await drawer.getByRole('button', { name: 'Board' }).tap();
  await expect(drawer).toBeHidden();
  // Phones start the board as a list.
  await expect(page.getByRole('heading', { name: 'Board', level: 1 })).toBeVisible();
  await expect(page.locator('.groups')).toBeVisible();
  await expect(page.getByRole('button', { name: 'List' })).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: 'test-results/screens/phone-board.png' });
});

test('phone: touch targets meet the WCAG 2.2 24px minimum', async ({ page }) => {
  await page.goto('/#/inbox');
  await expect(page.locator('.conn-live:visible').first()).toBeVisible();
  const small = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.tabbar button, .capture-input, .check, .icon-btn.menu-btn')]
      .map((el) => ({ el: el.className, ...el.getBoundingClientRect().toJSON() }))
      .filter((r) => r.height < 24 || r.width < 24),
  );
  expect(small).toEqual([]);
});

test('phone: AI assistants and a new connection fit with no sideways scroll', async ({ page }) => {
  // The old Claude link opens AI assistants with Claude picked.
  await page.goto('/#/settings?section=claude');
  await expect(page.locator('.conn-live:visible').first()).toBeVisible();
  const section = page.getByRole('region', { name: 'AI assistants' });
  // The status rows wait behind Details.
  await section.locator('.connect-details > summary').tap();
  await expect(section.getByRole('list', { name: "What's set up" })).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({ path: 'test-results/screens/phone-ai-assistants.png', fullPage: true });
  // The settings to paste wrap instead of pushing the page wider.
  await section.getByRole('radio', { name: 'Other app' }).tap();
  await section.getByRole('button', { name: 'Connect your app' }).tap();
  await expect(section.getByLabel('Other app settings')).toBeVisible();
  await noHorizontalOverflow(page);
  await section.getByRole('button', { name: 'I saved it' }).tap();
});

test('phone: browser Back closes an open task, and editing a field never scrolls sideways', async ({ page }) => {
  await page.goto('/#/today');
  await expect(page.locator('.conn-live:visible').first()).toBeVisible();
  const first = page.locator('[data-task-id] .task-title').first();
  await first.tap();
  const detail = page.getByRole('complementary', { name: 'Task details' });
  await expect(detail).toBeVisible();
  const back = detail.getByRole('button', { name: 'Back' });
  const box = (await back.boundingBox())!;
  expect(Math.round(box.width)).toBeGreaterThanOrEqual(44);
  expect(Math.round(box.height)).toBeGreaterThanOrEqual(44);
  await detail.getByLabel('Notes').tap();
  await page.keyboard.type('A note typed on a phone');
  await noHorizontalOverflow(page);
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(sw).toBeLessThanOrEqual(cw);
  await page.goBack();
  await expect(detail).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Today', level: 1 })).toBeVisible();
});

test('phone header: one summary line, search behind an icon, one menu button, Getting started after the tasks, and only capture stays up', async ({ page }) => {
  await page.goto('/#/today');
  await expect(page.locator('.conn-live:visible').first()).toBeVisible();
  const topbar = page.locator('.topbar');
  // The tab bar's More is the only way to the menu.
  await expect(page.getByRole('button', { name: 'Open menu' })).toHaveCount(0);
  // One line under the title: how the day is going, then what is overdue or due.
  const summary = page.locator('.summary-row');
  await expect(summary).toContainText(/\d+ of \d+ done/);
  expect((await summary.boundingBox())!.height).toBeLessThanOrEqual(30);
  await noHorizontalOverflow(page);

  // Search waits behind an icon, and takes the whole bar while it is open.
  const search = page.getByLabel('Search tasks');
  await expect(search).toBeHidden();
  await topbar.getByRole('button', { name: 'Search' }).tap();
  await expect(search).toBeFocused();
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeHidden();
  await search.press('Escape');
  await expect(search).toBeHidden();
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();

  // Getting started comes after the tasks, so the tasks come first.
  const lastTask = (await page.locator('.content [data-task-id]').last().boundingBox())!;
  const card = (await page.getByRole('region', { name: 'Getting started' }).boundingBox())!;
  expect(card.y).toBeGreaterThan(lastTask.y);

  // Scrolled, the title goes up with the page, and capture stays at the top.
  await page.locator('.main').evaluate((m) => m.scrollTo(0, 300));
  await expect.poll(async () => Math.round((await page.locator('.capture-row').boundingBox())!.y)).toBe(0);
  expect((await topbar.boundingBox())!.y).toBeLessThan(0);
});
