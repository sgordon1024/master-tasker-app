import { expect, test, type Page } from '@playwright/test';

// The tour opens by itself in a browser that has never opened the app. playwright.config.ts marks it seen for
// every other test; here each test starts with no saved prefs at all, like a first visit.
test.use({ storageState: { cookies: [], origins: [] } });

const tourOf = (page: Page) => page.getByRole('dialog', { name: 'How Master Tasker works' });

async function ready(page: Page) {
  await expect(page.locator('.conn-live:visible').first()).toBeVisible();
}

test('first run: the tour opens once, Next, Back and the arrow keys step through it, and Skip tour sticks', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop flow');
  await page.goto('/#/today');
  const tour = tourOf(page);
  const title = tour.getByRole('heading', { level: 2 });
  await expect(tour).toBeVisible();
  await expect(tour).toContainText('1 of 3');
  await expect(title).toHaveText('Capture it, then sort it');
  await expect(tour.getByRole('button', { name: 'Next' })).toBeFocused();

  await tour.getByRole('button', { name: 'Next' }).click();
  await expect(tour).toContainText('2 of 3');
  await expect(title).toHaveText('One thing at a time');
  await tour.getByRole('button', { name: 'Back' }).click();
  await expect(tour).toContainText('1 of 3');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(tour).toContainText('3 of 3');
  await expect(title).toHaveText('Your AI assistant helps. You stay in charge.');
  await expect(tour.getByRole('button', { name: 'Start using Master Tasker' })).toBeVisible();
  // Tab stays inside the tour.
  for (let i = 0; i < 4; i++) await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('.tour'))).toBe(true);

  await tour.getByRole('button', { name: 'Skip tour' }).click();
  await expect(tour).toHaveCount(0);
  // Focus goes back into the app, not lost on the page.
  await expect.poll(() => page.evaluate(() => (document.activeElement === document.body ? 'body' : document.activeElement?.closest('#root') ? 'app' : 'elsewhere'))).toBe('app');
  await page.reload();
  await ready(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
  await expect(tour).toHaveCount(0);
});

test('Take the tour brings it back: from More, from Getting started, and Esc or the last button closes it', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop flow');
  await page.goto('/#/today');
  await expect(tourOf(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(tourOf(page)).toHaveCount(0);

  const nav = page.getByRole('navigation', { name: 'Main' });
  await nav.getByRole('button', { name: 'More' }).click();
  await nav.getByRole('button', { name: 'Take the tour' }).click();
  const tour = tourOf(page);
  await expect(tour).toBeVisible();
  await expect(tour).toContainText('1 of 3');
  await page.keyboard.press('Escape');
  await expect(tour).toHaveCount(0);

  await page.getByRole('region', { name: 'Getting started' }).getByRole('button', { name: 'Take the tour' }).click();
  await expect(tour).toBeVisible();
  await tour.getByRole('button', { name: 'Next' }).click();
  await tour.getByRole('button', { name: 'Next' }).click();
  await tour.getByRole('button', { name: 'Start using Master Tasker' }).click();
  await expect(tour).toHaveCount(0);
  await page.reload();
  await ready(page);
  await expect(tour).toHaveCount(0);
});

test('someone who used the app before the tour existed is not shown it', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop flow');
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('seeded')) {
      localStorage.setItem('mt.firstRun.dismissed', '1');
      sessionStorage.setItem('seeded', '1');
    }
  });
  await page.goto('/#/today');
  await ready(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
  await expect(tourOf(page)).toHaveCount(0);
});

test('phone: the tour fits with no sideways scroll, and Take the tour is in the More drawer', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'phone layout');
  await page.goto('/#/today');
  const tour = tourOf(page);
  await expect(tour).toBeVisible();
  for (const n of [1, 2, 3]) {
    await expect(tour).toContainText(`${n} of 3`);
    const over = await page.evaluate(() =>
      [...document.querySelectorAll<Element>('.tour, .tour *')]
        .map((el) => ({ el: `${el.tagName}.${el.getAttribute('class') ?? ''}`, r: el.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 0 && (r.right > document.documentElement.clientWidth + 1 || r.left < -1))
        .map(({ el }) => el)
        .slice(0, 5),
    );
    expect(over).toEqual([]);
    if (n < 3) await tour.getByRole('button', { name: 'Next' }).tap();
  }
  await tour.getByRole('button', { name: 'Start using Master Tasker' }).tap();
  await expect(tour).toHaveCount(0);

  await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'More' }).tap();
  const drawer = page.getByRole('navigation', { name: 'Main' });
  await drawer.getByRole('button', { name: 'More' }).tap();
  await drawer.getByRole('button', { name: 'Take the tour' }).tap();
  await expect(drawer).toBeHidden();
  await expect(tour).toBeVisible();
  await tour.getByRole('button', { name: 'Skip tour' }).tap();
  await expect(tour).toHaveCount(0);
});
