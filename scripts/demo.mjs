// A throwaway copy of Master Tasker with made-up tasks, for trying it out and for the README screenshots.
//   npm run demo                 opens http://127.0.0.1:4870, until you press Control-C
//   npm run demo -- --screenshots   writes docs/screenshot.png and docs/screenshot-dark.png, then stops
// Everything lives in a new temp folder that is deleted when it stops. It never reads or changes your real
// tasks, your background service, or your Claude setup: every path the server uses points inside that folder.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const shots = process.argv.includes('--screenshots');
const port = Number(process.env.MT_DEMO_PORT ?? 4870);
const base = `http://127.0.0.1:${port}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'master-tasker-demo-'));

const env = {
  ...process.env,
  MT_PORT: String(port),
  MT_HOST: '127.0.0.1',
  MT_SEED: '0',
  MT_FIRST_RUN: '0',
  MT_DATA_DIR: path.join(dir, 'data'),
  MT_LOG_DIR: path.join(dir, 'logs'),
  MT_CLAUDE_PROJECTS_DIR: path.join(dir, 'claude-projects'),
  MT_CLAUDE_APP_DIR: path.join(dir, 'claude-app'),
  MT_CLAUDE_APP_PATH: path.join(dir, 'Claude.app'),
  MT_CLAUDE_SKILLS_DIR: path.join(dir, 'claude-skills'),
  MT_SKILL_DIR: path.join(dir, 'skill'),
  MT_CLAUDE_DESKTOP_CONFIG: path.join(dir, 'claude_desktop_config.json'),
  MT_CLAUDE_BIN: '',
  MT_NOTIFY_BIN: '',
};

if (shots || !fs.existsSync(path.join(root, 'dist', 'index.html'))) {
  console.log('Building the app...');
  execFileSync('npx', ['vite', 'build', '--logLevel', 'warn'], { cwd: root, stdio: 'inherit' });
}

const server = spawn(process.execPath, ['server/main.ts'], { cwd: root, env, stdio: ['ignore', 'ignore', 'inherit'] });
let stopped = false;
function stop(code = 0) {
  if (stopped) return;
  stopped = true;
  server.kill('SIGTERM');
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(code);
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
server.on('exit', (code) => {
  if (!stopped) {
    console.error(`The demo server stopped (exit ${code}). Is port ${port} free? Pick another with MT_DEMO_PORT.`);
    stop(1);
  }
});

const HEADERS = { 'x-master-tasker': 'web', 'x-session-id': 'demo-seed', 'content-type': 'application/json' };
async function call(method, url, body, headers = HEADERS) {
  const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('The demo server did not start.');
}

/** A local date, n days from today, as YYYY-MM-DD. */
function day(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// A week in the life of a junior product designer.
async function seed() {
  const area = async (name, mode) => (await call('POST', '/api/areas', { name, mode })).area.id;
  const client = await area('Client work', 'work');
  const system = await area('Design system', 'work');
  const portfolio = await area('Portfolio', 'personal');
  const life = await area('Personal', 'personal');
  const project = async (areaId, name) => (await call('POST', '/api/projects', { areaId, name })).project.id;
  const checkout = await project(client, 'Checkout redesign');
  const research = await project(client, 'Onboarding study');
  const forms = await project(system, 'Forms');
  const cases = await project(portfolio, 'Case studies');
  const task = async (t) => (await call('POST', '/api/tasks', t)).task;

  const proto = await task({
    title: 'Prototype the new checkout flow',
    areaId: client,
    projectId: checkout,
    status: 'doing',
    priority: 'high',
    dueDate: day(2),
    notes: 'Three steps instead of five. Keep the address autofill from the last version.',
    subtasks: ['Map the steps people take today', 'Sketch the address step', 'Build the payment screen', 'Share it with Sam for feedback'],
  });
  for (const s of proto.subtasks.slice(0, 2)) await call('PATCH', `/api/tasks/${proto.id}/subtasks/${s.id}`, { done: true });

  // Today lists the newest first, so these go in from the bottom of the list up.
  await task({ title: 'Pick up groceries for the week', areaId: life, status: 'today' });
  await task({ title: 'Write the intro for the checkout case study', areaId: portfolio, projectId: cases, status: 'today', priority: 'low', subtasks: ['The problem in two sentences', 'What changed', 'One number that moved'] });
  await task({ title: 'Review button states with engineering', areaId: system, projectId: forms, status: 'today', dueDate: day(0), nextAction: 'Book 30 minutes with the web team' });
  await task({ title: 'Send the usability test summary', areaId: client, projectId: research, status: 'today', priority: 'medium', dueDate: day(-1), subtasks: ['Pull quotes from the five sessions', 'Rank the top three problems'] });
  const cover = await task({ title: 'Choose the cover image for the checkout case study', areaId: portfolio, projectId: cases, status: 'today' });
  await call('POST', `/api/tasks/${cover.id}/needs-you`, { text: 'Pick the before or the after shot' });

  await task({ title: 'Get the final copy from the content team', areaId: client, projectId: checkout, status: 'waiting', waitingOn: 'Content team, asked on Monday' });
  await task({ title: 'Audit spacing in the input fields', areaId: system, projectId: forms, status: 'next' });
  await task({ title: 'Add the empty states to the component library', areaId: system, status: 'next', priority: 'medium' });
  await task({ title: 'Book a dentist appointment', areaId: life, status: 'next', dueDate: day(3) });
  await task({ title: 'Idea: a dark version of the icon set', status: 'inbox' });

  for (const t of [
    { title: 'Update the color tokens doc', areaId: system, projectId: forms },
    { title: 'Pay the electric bill', areaId: life },
  ]) {
    const made = await task({ ...t, status: 'today' });
    await call('POST', `/api/tasks/${made.id}/complete`, {});
  }

  // One suggestion from an assistant, so For you has something to look at.
  const { token, client: sample } = await call('POST', '/api/clients', { name: 'Sample assistant', kind: 'other', scopes: { areas: '*', unfiled: true, perms: ['read', 'propose'] } });
  await call(
    'POST',
    '/api/proposals',
    { proposal: { kind: 'create', task: { title: 'Ask Sam for a portfolio review', areaId: portfolio, status: 'next' } }, reason: 'Sam offered in the design crit notes.' },
    { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  );
  // Its suggestion stays in For you, but no real app is behind it, so the demo doesn't show one as connected.
  await call('POST', `/api/clients/${sample.id}/revoke`);
}

async function screenshots() {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    for (const [scheme, file] of [['light', 'screenshot.png'], ['dark', 'screenshot-dark.png']]) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: scheme, reducedMotion: 'reduce' });
      await context.addInitScript(() => {
        localStorage.setItem('mt.firstRun.dismissed', '1');
        localStorage.setItem('mt.tour', 'seen');
      });
      const page = await context.newPage();
      await page.goto(`${base}/#/today`);
      await page.locator('.task').first().waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.mouse.move(0, 899);
      await page.screenshot({ path: path.join(root, 'docs', file) });
      console.log(`Wrote docs/${file}`);
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

try {
  await waitForServer();
  await seed();
  if (shots) {
    await screenshots();
    stop(0);
  } else {
    console.log(`\nMaster Tasker demo: ${base}\nMade-up tasks in a temp folder. Press Control-C to stop and delete it.\n`);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  stop(1);
}
