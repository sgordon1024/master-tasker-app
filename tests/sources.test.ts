import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeLink } from '../server/app.ts';
import { describeSchedule, detectSources } from '../server/sources.ts';
import { asClient, makeClient, startServer, ui, type TestServer } from './helpers.ts';

const FIXTURE = path.resolve(import.meta.dirname, 'fixtures', 'claude-app');
let s: TestServer;
afterEach(() => s?.stop());

async function withApp() {
  s = await startServer({ seed: false });
  fs.cpSync(FIXTURE, path.join(s.dir, 'claude-app'), { recursive: true });
  return path.join(s.dir, 'claude-app', 'acct', 'org');
}

describe('sources', () => {
  it('describes schedules in plain words', () => {
    expect(describeSchedule('0 8,14 * * *', null)).toBe('Every day at 8am and 2pm');
    expect(describeSchedule('30 7 * * 1-5', null)).toBe('Weekdays at 7:30am');
    expect(describeSchedule('*/5 * * * *', null)).toBe('*/5 * * * *');
  });

  it('finds what a routine reads from its words and its tools', () => {
    const keys = detectSources({ description: '', prompt: 'Look at /Users/x/development/Chassis/notes.md', tools: ['mcp__abc__slack_search_public'] }).map((x) => x.key);
    expect(keys).toEqual(['slack', 'files:Chassis']);
  });

  it('finds Granola by name or by its meeting tools', () => {
    expect(detectSources({ description: 'Pulls Granola transcripts', prompt: '', tools: [] }).map((x) => x.key)).toEqual(['granola']);
    expect(detectSources({ description: '', prompt: '', tools: ['mcp__granola__get_meeting_transcript'] }).map((x) => x.key)).toEqual(['granola']);
  });

  it('lists routines with their tickets, last run and sources', async () => {
    const org = await withApp();
    const t = (await ui(s, 'POST', '/api/tasks', { title: 'Act on the notes' })).body.task;
    fs.writeFileSync(path.join(org, 'routines', 'watch', 'state.json'), JSON.stringify({ cardId: t.id }));
    const r = await ui(s, 'GET', '/api/sources');
    expect(r.status).toBe(200);
    const [daily, watch] = r.body.routines;
    expect(daily).toMatchObject({ name: 'Daily review', schedule: 'Every day at 8am and 2pm', allTasks: true, paused: false, enforced: false });
    expect(daily.sources.map((x: any) => x.key)).toEqual(['gmail', 'slack', 'dev']);
    expect(watch.tickets).toEqual([{ id: t.id, title: 'Act on the notes', status: t.status }]);
    expect(watch.lastRunLink).toBe('claude://code/continue?session=local_run1');
  });

  it('switching a source off adds the check line once, and the check reports it', async () => {
    const org = await withApp();
    const file = path.join(org, 'routines', 'daily', 'SKILL.md');
    let r = await ui(s, 'PATCH', '/api/sources/daily-review', { source: 'gmail', on: false });
    expect(r.status).toBe(200);
    expect(r.body.routine.enforced).toBe(true);
    expect(r.body.routine.sources.find((x: any) => x.key === 'gmail').on).toBe(false);
    await ui(s, 'PATCH', '/api/sources/daily-review', { paused: true });
    const text = fs.readFileSync(file, 'utf8');
    expect(text.match(/master-tasker:sources/g)).toHaveLength(1);
    expect(text.startsWith('---\nname: daily-review')).toBe(true);
    // It runs this copy's check by its full path, with this app's data folder, wherever the copy lives.
    const q = (p: string) => (/^[A-Za-z0-9_./:@%+=-]+$/.test(p) ? p : `'${p}'`);
    expect(text).toContain(`MT_DATA_DIR=${q(s.config.dataDir)} node ${q(path.resolve(import.meta.dirname, '..', 'automation', 'sources.ts'))} check daily-review`);

    const out = JSON.parse(execFileSync(process.execPath, ['automation/sources.ts', 'check', 'daily-review'], { env: { ...process.env, MT_DATA_DIR: s.config.dataDir } }).toString());
    expect(out).toMatchObject({ paused: true, off: ['Gmail'] });

    r = await ui(s, 'PATCH', '/api/sources/daily-review', { source: 'jira', on: false });
    expect(r.status).toBe(400);
  });

  it('is yours only', async () => {
    await withApp();
    const { token } = await makeClient(s, { perms: ['read', 'update'] });
    expect((await asClient(s, token, 'GET', '/api/sources')).status).toBe(403);
    expect((await asClient(s, token, 'PATCH', '/api/sources/daily-review', { paused: true })).status).toBe(403);
  });

  it('a new source request makes a ticket and a link that starts Claude on it', async () => {
    await withApp();
    const r = await ui(s, 'POST', '/api/sources/request', { text: 'Check my Notion board' });
    expect(r.status).toBe(200);
    expect(r.body.task.title).toBe('Add a source: Check my Notion board');
    expect(decodeURIComponent(r.body.url)).toContain(`/master-tasker ${r.body.task.id}`);
  });
});

describe('start in Claude', () => {
  it('links a new thread to the ticket, or one subtask', async () => {
    s = await startServer({ seed: false });
    const t = (await ui(s, 'POST', '/api/tasks', { title: 'Ship it', subtasks: ['Write "the" copy'] })).body.task;
    let r = await ui(s, 'GET', `/api/tasks/${t.id}/claude-link`);
    expect(r.body.url).toMatch(/^claude:\/\/code\/new\?q=/);
    expect(new URL(r.body.url).searchParams.get('q')).toBe(`/master-tasker ${t.id}`);
    r = await ui(s, 'GET', `/api/tasks/${t.id}/claude-link?subtask=${t.subtasks[0].id}`);
    expect(new URL(r.body.url).searchParams.get('q')).toBe(`/master-tasker ${t.id} Start with the subtask: "Write 'the' copy"`);
    expect((await ui(s, 'GET', `/api/tasks/${t.id}/claude-link?subtask=s_nope`)).status).toBe(404);
    expect(claudeLink('t_1', undefined, '/a b')).toContain('folder=%2Fa%20b');
    // A new thread that picks up where the last one stopped.
    r = await ui(s, 'GET', `/api/tasks/${t.id}/claude-link?continue=1`);
    expect(new URL(r.body.url).searchParams.get('q')).toMatch(new RegExp(`^/master-tasker ${t.id} The last thread on this .* stopped\\. Read the ticket again`));
  });

  it('opens a known thread in the app, and says null for one it does not know', async () => {
    await withApp();
    expect((await ui(s, 'GET', '/api/claude/open?session=cli-run-1')).body.url).toBe('claude://code/continue?session=local_run1');
    expect((await ui(s, 'GET', '/api/claude/open?session=nope')).body.url).toBeNull();
  });
});
