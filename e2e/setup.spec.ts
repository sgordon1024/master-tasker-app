import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// First-run setup shows on a brand-new install. The shared test server is already set up (MT_FIRST_RUN=0 in
// playwright.config.ts), so each test here starts its own new install, in a temp folder, on a free port.
// That's a new origin with no saved prefs too, so the tour opens after setup, as it would on a real first visit.
test.use({ storageState: { cookies: [], origins: [] } });

const ROOT = path.resolve(import.meta.dirname, '..');
const HEADERS = { 'x-master-tasker': 'web', 'x-session-id': 'e2e-setup-check' };
let server: ChildProcess;
let dir: string;
let base: string;

test.beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-e2e-setup-'));
  const data = path.join(dir, 'data');
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    MT_PORT: '0',
    MT_DATA_DIR: data,
    MT_LOG_DIR: path.join(dir, 'logs'),
    MT_CLAUDE_PROJECTS_DIR: path.join(dir, 'claude-projects'),
    MT_CLAUDE_APP_DIR: path.join(dir, 'claude-app'),
    MT_CLAUDE_APP_PATH: path.join(dir, 'Claude.app'),
    MT_CLAUDE_SKILLS_DIR: path.join(dir, 'claude-skills'),
    MT_CLAUDE_DESKTOP_CONFIG: path.join(dir, 'claude_desktop_config.json'),
    MT_SKILL_DIR: path.join(dir, 'skill'),
    MT_CLAUDE_BIN: '',
    MT_NOTIFY_BIN: '',
  };
  server = spawn(process.execPath, ['server/main.ts'], { cwd: ROOT, env, stdio: 'ignore' });
  const pid = path.join(data, 'server.pid');
  await expect.poll(() => fs.existsSync(pid) && JSON.parse(fs.readFileSync(pid, 'utf8')).port, { timeout: 15_000 }).toBeTruthy();
  base = `http://127.0.0.1:${JSON.parse(fs.readFileSync(pid, 'utf8')).port}`;
});

test.afterEach(async () => {
  const done = new Promise((r) => server.once('exit', r));
  server.kill('SIGTERM');
  await done;
  fs.rmSync(dir, { recursive: true, force: true });
});

const setupOf = (page: Page) => page.getByRole('dialog', { name: 'Set up Master Tasker' });
const tourOf = (page: Page) => page.getByRole('dialog', { name: 'How Master Tasker works' });

async function state(page: Page) {
  const sync = await (await page.request.get(`${base}/api/sync`, { headers: HEADERS })).json();
  return {
    areas: sync.areas.map((a: { name: string; mode: string }) => `${a.name} (${a.mode})`),
    samples: sync.tasks.filter((t: { isSample: boolean }) => t.isSample).length,
    name: sync.settings.ownerName,
    setupDone: sync.settings.setupDone,
  };
}

/** Reload, wait for the tasks, and check neither setup nor the tour comes back. */
async function staysDone(page: Page) {
  await page.reload();
  await expect(page.locator('.conn-live:visible').first()).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
  await expect(setupOf(page)).toHaveCount(0);
  await expect(tourOf(page)).toHaveCount(0);
}

test('fill it in: your name, Work and Personal, with samples, then the tour', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  await page.goto(`${base}/#/today`);
  const setup = setupOf(page);
  await expect(setup).toBeVisible();
  // The tour waits until setup is done.
  await expect(tourOf(page)).toHaveCount(0);
  const name = setup.getByRole('textbox', { name: /Your name/ });
  // On a phone, focus starts on the title, so the keyboard doesn't cover the screen.
  if (phone) await expect(setup.getByRole('heading', { name: 'Welcome' })).toBeFocused();
  else await expect(name).toBeFocused();

  const areas = setup.getByRole('group', { name: 'Starter areas' });
  const samples = setup.getByRole('group', { name: 'Sample tasks' });
  await expect(areas.getByRole('radio', { name: /Work and Personal/ })).toBeChecked();
  await expect(samples.getByRole('radio', { name: 'Yes, add them' })).toBeChecked();

  await name.fill('Ada');
  await setup.getByRole('button', { name: 'Continue' }).click();
  await expect(setup).toHaveCount(0);
  await expect(tourOf(page)).toBeVisible();
  expect(await state(page)).toEqual({ areas: ['Work (work)', 'Personal (personal)'], samples: 6, name: 'Ada', setupDone: true });

  await tourOf(page).getByRole('button', { name: 'Skip tour' }).click();
  await expect(tourOf(page)).toHaveCount(0);
  if (!phone) {
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('button', { name: /^Work( \d+)?$/ })).toBeVisible();
    await expect(nav.getByRole('button', { name: /^Personal( \d+)?$/ })).toBeVisible();
  }
  await staysDone(page);

  // The name is in Settings, to change.
  await page.goto(`${base}/#/settings?section=general`);
  await expect(page.getByRole('textbox', { name: 'Your name' })).toHaveValue('Ada');
});

test('None, no samples: an empty start, and it stays that way', async ({ page }) => {
  await page.goto(`${base}/#/today`);
  const setup = setupOf(page);
  await expect(setup).toBeVisible();
  await setup.getByRole('radio', { name: /None, I.ll add my own/ }).check();
  await setup.getByRole('radio', { name: 'No thanks' }).check();
  await setup.getByRole('button', { name: 'Continue' }).click();
  await expect(setup).toHaveCount(0);
  await expect(tourOf(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(tourOf(page)).toHaveCount(0);
  expect(await state(page)).toEqual({ areas: [], samples: 0, name: '', setupDone: true });
  await staysDone(page);
  // Nothing to clear, so Getting started doesn't ask.
  const start = page.getByRole('region', { name: 'Getting started' });
  await expect(start).toContainText('Connect an AI assistant');
  await expect(start).not.toContainText('Clear the sample tasks');
});

test('Skip setup keeps the sample set, and it does not come back', async ({ page }) => {
  await page.goto(`${base}/#/today`);
  const setup = setupOf(page);
  await expect(setup).toBeVisible();
  await setup.getByRole('button', { name: /Skip setup/ }).click();
  await expect(setup).toHaveCount(0);
  await expect(tourOf(page)).toBeVisible();
  await page.keyboard.press('Escape');
  const s = await state(page);
  expect(s).toMatchObject({ samples: 6, name: '', setupDone: true });
  expect(s.areas).toHaveLength(6);
  await staysDone(page);
});

test('Esc skips, and keeps the name you typed; Tab stays inside', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'keyboard flow');
  await page.goto(`${base}/#/today`);
  const setup = setupOf(page);
  await expect(setup).toBeVisible();
  await page.keyboard.type('Ada');
  // Name, the areas, the samples, Continue, then round to Skip setup and back to the name.
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('.setup'))).toBe(true);
  }
  // Arrow keys move between the options.
  await setup.getByRole('radio', { name: /Work and Personal/ }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(setup.getByRole('radio', { name: /The sample set/ })).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(setup).toHaveCount(0);
  const s = await state(page);
  expect(s).toMatchObject({ name: 'Ada', samples: 6, setupDone: true });
  expect(s.areas).toHaveLength(6);
});

test('a short window opens at the top, with the title in view', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop window');
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto(base);
  const setup = setupOf(page);
  await expect(setup.getByLabel('Your name')).toBeFocused();
  await expect(setup.getByRole('heading', { name: 'Welcome' })).toBeInViewport({ ratio: 1 });
  expect(await setup.locator('.setup-main').evaluate((el) => el.scrollTop)).toBe(0);
});
