import { expect, test, type APIRequestContext } from '@playwright/test';

const OTHER = { 'x-master-tasker': 'web', 'x-session-id': 'e2e-wizard-other', 'content-type': 'application/json' };
const unique = (s: string) => `${s} ${Math.random().toString(36).slice(2, 7)}`;

// The Wizard is a Lab: switched on in Settings > Labs, which saves it in this browser.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mt.labs.wizard', '1'));
});

async function apiCreate(request: APIRequestContext, body: Record<string, unknown>) {
  const r = await request.post('/api/tasks', { headers: OTHER, data: body });
  expect(r.ok()).toBeTruthy();
  return (await r.json()).task;
}

test('wizard: keyboard through the knobs, open a task from the ledger, pause motion', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop flow');
  const title = unique('Wizard task');
  const t = await apiCreate(request, { title, status: 'doing' });
  await request.patch(`/api/tasks/${t.id}`, { headers: OTHER, data: { baseRev: t.rev, patch: { needsYou: 'Pick headline A or B' } } });

  await page.goto('/#/board');
  await page.keyboard.press('g');
  await page.keyboard.press('z');
  await expect(page.getByRole('heading', { name: 'Wizard', level: 1 })).toBeVisible();
  await expect(page.getByText('Visual activity is decorative. Task states come from Master Tasker.')).toBeVisible();

  // Knobs are plain sliders: arrows, Home and End.
  const blunt = page.getByRole('slider', { name: 'Bluntness' });
  await blunt.focus();
  await page.keyboard.press('End');
  await expect(blunt).toHaveValue('100');
  // The caption is about the oldest thing that needs you. Bluntness changes the words, never the facts.
  const caption = page.locator('.wz-caption-main');
  await expect(caption).toContainText('Needs you');
  const fact = (await caption.textContent())!.match(/Needs you: ([^.]+)\./)![1];
  await page.keyboard.press('Home');
  await expect(blunt).toHaveValue('0');
  await expect(caption).toContainText(fact);
  for (const name of ['Happiness', 'Caffeine']) {
    const s = page.getByRole('slider', { name });
    await s.focus();
    await page.keyboard.press('ArrowRight');
  }
  await expect(page.getByRole('slider', { name: 'Happiness' })).toHaveValue('61');

  // Every task is a row; Enter opens the usual detail pane, Escape closes it.
  const row = page.locator('.wz-row', { hasText: title });
  await expect(row).toContainText('Needs you: Pick headline A or B');
  await row.focus();
  await page.keyboard.press('Enter');
  const detail = page.getByRole('complementary', { name: 'Task details' });
  await expect(detail.getByLabel('Title')).toHaveValue(title);
  await page.keyboard.press('Escape');
  await expect(detail).toBeHidden();

  // Pause is decorative only.
  const pause = page.getByRole('button', { name: 'Pause motion' });
  await pause.click();
  await expect(page.getByRole('button', { name: 'Resume motion' })).toHaveAttribute('aria-pressed', 'true');

  // Moving the knobs never wrote to the task.
  const after = await (await request.get(`/api/tasks/${t.id}`, { headers: OTHER })).json();
  expect(after.task.rev).toBe(t.rev + 1);
});

test('wizard: a confirmed completion is stamped once', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop flow');
  const title = unique('Finish me');
  const t = await apiCreate(request, { title, status: 'doing' });
  await page.goto('/#/wizard');
  await expect(page.locator('.wz-row', { hasText: title })).toBeVisible();
  await expect(page.locator('.wz-stamp')).toHaveCount(0);
  await request.patch(`/api/tasks/${t.id}`, { headers: OTHER, data: { baseRev: t.rev, patch: { status: 'done' } } });
  await expect(page.locator('.wz-stamp')).toContainText(`Completed: ${title}`);
  await page.reload();
  await expect(page.locator('.wz-row', { hasText: title })).toBeAttached();
  await expect(page.locator('.wz-stamp')).toHaveCount(0);
});

test('wizard: phone width fits with no sideways scroll and reduced motion still works', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'phone layout');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('/#/wizard');
  await expect(page.getByRole('heading', { name: 'Spell ledger' })).toBeVisible();
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(sw).toBeLessThanOrEqual(cw);
  await page.getByText('Stage settings').click();
  await expect(page.getByRole('checkbox', { name: 'Eyes follow the cursor' })).toBeDisabled();
  await page.getByRole('button', { name: 'Shrink the wizard' }).click();
  await expect(page.locator('.wz-scene')).toHaveClass(/is-shrunk/);
});

test('wizard: full screen shows the stage and caption, and Escape brings you back', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop flow');
  await page.goto('/#/wizard');
  const open = page.getByRole('button', { name: 'Full screen' });
  await open.click();
  const stage = page.getByRole('dialog', { name: 'Wizard, full screen' });
  await expect(stage).toBeVisible();
  await expect(stage.getByText('Visual activity is decorative. Task states come from Master Tasker.')).toBeVisible();
  const box = await stage.boundingBox();
  expect(box?.width).toBe(page.viewportSize()!.width);
  await expect(page.getByRole('button', { name: 'Exit full screen' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(stage).toBeHidden();
  await expect(open).toBeFocused();
});
