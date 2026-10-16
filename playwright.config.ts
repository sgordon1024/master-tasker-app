import { defineConfig } from '@playwright/test';

// An uncommon port, so it won't clash with a running copy of the app. MT_E2E_PORT lets two copies run their tests at once.
const PORT = Number(process.env.MT_E2E_PORT) || 4843;

// Everything Claude-related points inside .data/e2e, never at this Mac's real Claude setup:
// a stand-in Claude app, an empty skills folder, a copy of the skill, and a Claude Desktop settings file
// that already has someone else's entry, so the tests can check it's kept.
const E2E = '.data/e2e';
const DESKTOP_CONFIG = `${E2E}/claude-desktop/claude_desktop_config.json`;
const prepare = [
  `rm -rf ${E2E}`,
  `mkdir -p ${E2E}/Applications/Claude.app ${E2E}/skill ${E2E}/claude-desktop`,
  `cp -R tests/fixtures/claude-app ${E2E}/claude-app`,
  `cp -R claude/skills/master-tasker ${E2E}/skill/master-tasker`,
  `rm -f ${E2E}/skill/master-tasker/.local.env`,
  `printf '%s' '{"mcpServers":{"someone-else":{"command":"/usr/bin/true"}},"keepMe":true}' > ${DESKTOP_CONFIG}`,
].join(' && ');
const env = [
  `MT_CLAUDE_APP_DIR=${E2E}/claude-app`,
  `MT_CLAUDE_APP_PATH=${E2E}/Applications/Claude.app`,
  `MT_CLAUDE_SKILLS_DIR=${E2E}/claude-skills`,
  `MT_SKILL_DIR=${E2E}/skill/master-tasker`,
  `MT_CLAUDE_DESKTOP_CONFIG=${DESKTOP_CONFIG}`,
  `MT_DATA_DIR=${E2E}/data`,
  `MT_LOG_DIR=${E2E}/logs`,
  `MT_CLAUDE_PROJECTS_DIR=${E2E}/claude-projects`,
  'MT_CLAUDE_BIN=tests/fixtures/fake-claude.mjs',
  'MT_NOTIFY_BIN=',
  // Set up already, so first-run setup doesn't cover the app. e2e/setup.spec.ts starts its own server to show it.
  'MT_FIRST_RUN=0',
  `MT_PORT=${PORT}`,
].join(' ');

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI, // a stray test.only fails the run instead of quietly skipping the rest
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // Every test starts with the tour already seen, so it doesn't cover the app. e2e/tour.spec.ts clears this.
    storageState: { cookies: [], origins: [{ origin: `http://127.0.0.1:${PORT}`, localStorage: [{ name: 'mt.tour', value: 'seen' }] }] },
    // On your Mac: the installed Google Chrome, no browser download. On CI (which sets CI): Playwright's own Chromium, from `npx playwright install chromium`.
    channel: process.env.CI ? undefined : 'chrome',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'phone', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
  ],
  webServer: {
    command: `${prepare} && ${env} node server/main.ts`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
