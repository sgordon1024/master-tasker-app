import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { asClient, linkThreads, makeClient, startServer, ui, type TestServer } from './helpers.ts';

let s: TestServer;
afterEach(() => s.stop());

const line = (o: Record<string, unknown>) => JSON.stringify(o) + '\n';
function thread(sessionId: string, texts: { role: 'user' | 'assistant'; text: string }[]) {
  const dir = path.join(s.dir, 'claude-projects', '-app');
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  fs.appendFileSync(
    path.join(dir, `${sessionId}.jsonl`),
    texts.map((t) => line({ type: t.role, sessionId, cwd: '/tmp/app', timestamp: new Date(Date.parse('2026-10-08T10:00:00Z') + n++ * 60_000).toISOString(), message: { role: t.role, content: t.role === 'user' ? t.text : [{ type: 'text', text: t.text }] } })).join(''),
  );
}

describe('thread history for a new thread', () => {
  it('gives a Claude connection how the last thread on the ticket ended, leaving out its own thread', async () => {
    s = await startServer({ seed: false });
    await linkThreads(s);
    const t = (await ui(s, 'POST', '/api/tasks', { title: 'Onboard' })).body.task;
    thread('aaaa1111-old', [
      { role: 'user', text: `/master-tasker ${t.id}` },
      { role: 'assistant', text: `Working on Master Tasker task ${t.id}. Decision: the wiki lives in Confluence.` },
      { role: 'user', text: 'Alex said the kickoff moved to Monday' },
      { role: 'assistant', text: 'Noted. Next I would build the calendar.' },
    ]);
    thread('bbbb2222-new', [{ role: 'user', text: `/master-tasker ${t.id} pick up` }]);
    const { token } = await makeClient(s, { kind: 'claude', perms: ['read', 'update'] });
    const r = await asClient(s, token, 'GET', `/api/tasks/${t.id}/history?except=bbbb2222-new`);
    expect(r.status).toBe(200);
    expect(r.body.threads).toHaveLength(1);
    expect(r.body.latest.messages.map((m: any) => m.text)).toEqual([
      `/master-tasker ${t.id}`,
      `Working on Master Tasker task ${t.id}. Decision: the wiki lives in Confluence.`,
      'Alex said the kickoff moved to Monday',
      'Noted. Next I would build the calendar.',
    ]);
    expect(r.body.latest.file).toMatch(/aaaa1111-old\.jsonl$/);

    const other = await makeClient(s, { kind: 'other', perms: ['read'] });
    expect((await asClient(s, other.token, 'GET', `/api/tasks/${t.id}/history`)).status).toBe(403);
  });
});
