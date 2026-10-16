import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { asClient, linkThreads, makeClient, startServer, ui, type TestServer } from './helpers.ts';

const FAKE = path.resolve(import.meta.dirname, 'fixtures', 'fake-claude.mjs');
let s: TestServer;
afterEach(() => s.stop());

const line = (o: Record<string, unknown>) => JSON.stringify(o) + '\n';
function thread(sessionId: string, cwd: string, texts: { role: 'user' | 'assistant'; text: string }[]) {
  const dir = path.join(s.dir, 'claude-projects', '-app');
  fs.mkdirSync(dir, { recursive: true });
  const at = new Date().toISOString();
  fs.appendFileSync(path.join(dir, `${sessionId}.jsonl`), texts.map((t) => line({ type: t.role, sessionId, cwd, timestamp: at, message: { role: t.role, content: t.role === 'user' ? t.text : [{ type: 'text', text: t.text }] } })).join(''));
}
const getTask = async (id: string) => (await ui(s, 'GET', `/api/tasks/${id}`)).body.task;
async function waitForAnswer(id: string) {
  for (let i = 0; i < 60; i++) {
    const asks = (await ui(s, 'GET', `/api/tasks/${id}/asks`)).body.asks;
    if (asks.every((a: any) => a.status !== 'running')) return asks;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('ask never finished');
}

describe('needs you, with context', () => {
  it('keeps the why and the thread with each flag, and drops them when the flag clears', async () => {
    s = await startServer({ seed: false });
    const { token } = await makeClient(s, { perms: ['read', 'update'] });
    const t = (await ui(s, 'POST', '/api/tasks', { title: 'Ship the page', subtasks: ['Pick a page'] })).body.task;
    const r = await asClient(s, token, 'POST', `/api/tasks/${t.id}/needs-you`, { subtask: 'pick a page', detail: 'Start with ~/site/getting-started.html', sessionId: 'abc12345-0000' });
    expect(r.status).toBe(200);
    const sid = t.subtasks[0].id;
    expect(r.body.task.subtasks[0].needsYou).toBe(true);
    expect(r.body.task.youContext[sid]).toMatchObject({ detail: 'Start with ~/site/getting-started.html', sessionId: 'abc12345-0000' });

    await asClient(s, token, 'POST', `/api/tasks/${t.id}/needs-you`, { text: 'Approve the copy', detail: 'Draft is in the notes' });
    let task = await getTask(t.id);
    expect(task.needsYou).toBe('Approve the copy');
    expect(task.youContext.task.detail).toBe('Draft is in the notes');

    // Only you clear them, and the context goes with the flag.
    expect((await asClient(s, token, 'PATCH', `/api/tasks/${t.id}`, { baseRev: task.rev, patch: { needsYou: '' } })).status).toBe(403);
    await ui(s, 'PATCH', `/api/tasks/${t.id}`, { baseRev: task.rev, patch: { needsYou: '' } });
    await ui(s, 'PATCH', `/api/tasks/${t.id}/subtasks/${sid}`, { needsYou: false });
    task = await getTask(t.id);
    expect(task.youContext).toEqual({});
  });

  it('reads the why after a bar in a "Needs you:" line, and remembers the thread', async () => {
    s = await startServer({ seed: false });
    await linkThreads(s);
    const t = (await ui(s, 'POST', '/api/tasks', { title: 'Review it', subtasks: ['Decide on the PR'] })).body.task;
    thread('sess-1234-abcd', '/tmp', [
      { role: 'user', text: `Working on Master Tasker task ${t.id}` },
      { role: 'assistant', text: 'Needs you: Decide on the PR | The comparison is at ~/Desktop/compare.html. I would open it.' },
    ]);
    await ui(s, 'GET', `/api/tasks/${t.id}/threads?refresh=1`);
    const task = await getTask(t.id);
    const sid = task.subtasks[0].id;
    expect(task.subtasks[0].needsYou).toBe(true);
    expect(task.youContext[sid]).toMatchObject({ detail: 'The comparison is at ~/Desktop/compare.html. I would open it.', sessionId: 'sess-1234-abcd' });
    expect(task.youContext[sid].resumeCommand).toBe("cd '/tmp' && claude --resume sess-1234-abcd");
  });
});

describe('asking Claude about an item', () => {
  it('runs read-only on the thread that raised it, and saves the answer', async () => {
    s = await startServer({ seed: false, env: { MT_CLAUDE_BIN: FAKE } });
    await linkThreads(s);
    const t = (await ui(s, 'POST', '/api/tasks', { title: 'Review it', subtasks: ['Decide on the PR'] })).body.task;
    thread('sess-1234-abcd', '/tmp', [
      { role: 'user', text: `Working on Master Tasker task ${t.id}` },
      { role: 'assistant', text: 'Needs you: Decide on the PR | See the comparison.' },
    ]);
    await ui(s, 'GET', `/api/tasks/${t.id}/threads?refresh=1`);
    const sid = t.subtasks[0].id;
    const r = await ui(s, 'POST', `/api/tasks/${t.id}/asks`, { item: sid, question: 'Where is it?' });
    expect(r.body.ask.status).toBe('running');
    const [ask] = await waitForAnswer(t.id);
    expect(ask).toMatchObject({ status: 'done', answer: 'Answer to "Where is it?" (thread sess-1234-abcd, read-only true)' });

    await ui(s, 'POST', `/api/tasks/${t.id}/asks`, { item: sid, question: 'please fail' });
    const asks = await waitForAnswer(t.id);
    expect(asks[1]).toMatchObject({ status: 'error', answer: 'Not logged in' });
  });

  it('is only for you, and says so plainly, before saving anything, when Claude Code is not installed', async () => {
    s = await startServer({ seed: false });
    const { token } = await makeClient(s, { perms: ['read', 'update'] });
    const t = (await ui(s, 'POST', '/api/tasks', { title: 'X' })).body.task;
    expect((await asClient(s, token, 'POST', `/api/tasks/${t.id}/asks`, { item: 'task', question: 'hi' })).status).toBe(403);
    const r = await ui(s, 'POST', `/api/tasks/${t.id}/asks`, { item: 'task', question: 'hi' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ needs: 'claude-code', message: 'Ask needs Claude Code on this Mac. Set it up in Settings, under AI assistants.' });
    expect((await ui(s, 'GET', `/api/tasks/${t.id}/asks`)).body.asks).toEqual([]);
  });

  it('asks in plain, neutral words', async () => {
    const { askPrompt } = await import('../server/ask.ts');
    s = await startServer({ seed: false });
    const t = (await ui(s, 'POST', '/api/tasks', { title: 'Pick a logo' })).body.task;
    const task = (await ui(s, 'PATCH', `/api/tasks/${t.id}`, { baseRev: t.rev, patch: { needsYou: 'Choose one' } })).body.task;
    const prompt = askPrompt(task, 'task', 'Which is better?');
    expect(prompt).toContain('This is waiting on the user: "Choose one"');
    expect(prompt).toContain("The user's question: Which is better?");
    expect(prompt).not.toMatch(/\b(him|his|he|her|she)\b/i);
  });
});
