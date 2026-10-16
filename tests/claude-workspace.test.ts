// Work on this with Claude starts new threads in a folder of their own, <data folder>/workspace, not the home folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { linkThreads, startServer, tempDir, ui, type TestServer } from './helpers.ts';

let s: TestServer | null = null;
afterEach(async () => {
  await s?.stop();
  s = null;
});

const folderOf = async (srv: TestServer, id: string) => {
  const r = (await ui(srv, 'GET', `/api/tasks/${id}/claude-link`)).body;
  expect(new URL(r.url).searchParams.get('folder')).toBe(r.folder);
  return r.folder as string;
};
/** A Claude thread in `cwd` that mentions the task, so it's linked to it. */
function thread(srv: TestServer, sessionId: string, cwd: string, taskId: string) {
  const dir = path.join(srv.dir, 'claude-projects', '-somewhere');
  fs.mkdirSync(dir, { recursive: true });
  const line = { type: 'user', sessionId, cwd, timestamp: new Date().toISOString(), uuid: sessionId, message: { role: 'user', content: `/master-tasker ${taskId}` } };
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), `${JSON.stringify(line)}\n`);
}

describe("Claude's folder", () => {
  it('opens new threads in <data folder>/workspace, made on demand with a short README', async () => {
    s = await startServer({ seed: false });
    const workspace = path.join(s.dir, 'data', 'workspace');
    expect(fs.existsSync(workspace)).toBe(false);
    const t = (await ui(s, 'POST', '/api/tasks', { title: 'A task' })).body.task;
    expect(await folderOf(s, t.id)).toBe(workspace);
    expect(await folderOf(s, t.id)).not.toBe(os.homedir());
    const readme = fs.readFileSync(path.join(workspace, 'README.md'), 'utf8');
    expect(readme).toMatch(/Work on this with Claude starts new Claude threads in this folder/);
    expect(readme).not.toMatch(/—/);

    // A README you changed stays, and a deleted folder comes back.
    fs.writeFileSync(path.join(workspace, 'README.md'), 'mine');
    await folderOf(s, t.id);
    expect(fs.readFileSync(path.join(workspace, 'README.md'), 'utf8')).toBe('mine');
    fs.rmSync(workspace, { recursive: true });
    await folderOf(s, t.id);
    expect(fs.existsSync(path.join(workspace, 'README.md'))).toBe(true);
  });

  it("keeps a task's own folder from its last thread, but not the home folder older versions used", async () => {
    s = await startServer({ seed: false });
    await linkThreads(s);
    const project = tempDir('mt-project-');
    const a = (await ui(s, 'POST', '/api/tasks', { title: 'Has a project' })).body.task;
    const b = (await ui(s, 'POST', '/api/tasks', { title: 'Started in home' })).body.task;
    thread(s, 'sess-project', project, a.id);
    thread(s, 'sess-home', os.homedir(), b.id);
    expect((await ui(s, 'GET', `/api/tasks/${a.id}/threads?refresh=1`)).body.threads).toHaveLength(1);
    expect((await ui(s, 'GET', `/api/tasks/${b.id}/threads?refresh=1`)).body.threads).toHaveLength(1);
    expect(await folderOf(s, a.id)).toBe(project);
    expect(await folderOf(s, b.id)).toBe(path.join(s.dir, 'data', 'workspace'));
  });
});
