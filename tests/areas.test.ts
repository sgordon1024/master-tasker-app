import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { areaId, asClient, listenEvents, makeClient, startServer, ui, type TestServer } from './helpers.ts';

let s: TestServer;
beforeEach(async () => {
  s = await startServer({ seed: false });
});
afterEach(async () => {
  await s.stop();
});

const newArea = async (name: string, mode: 'work' | 'personal' = 'personal') => (await ui(s, 'POST', '/api/areas', { name, mode })).body.area;
const activity = async () => (await ui(s, 'GET', '/api/activity?limit=50')).body.activity.map((e: { summary: string }) => e.summary) as string[];

describe('managing areas from the app', () => {
  it('renames, recolors, moves sides and archives, and says so in Activity', async () => {
    const a = await newArea('Garden');
    expect((await ui(s, 'PATCH', `/api/areas/${a.id}`, { name: 'Yard' })).body.area.name).toBe('Yard');
    expect((await ui(s, 'PATCH', `/api/areas/${a.id}`, { color: '#0F766E' })).body.area.color).toBe('#0F766E');
    expect((await ui(s, 'PATCH', `/api/areas/${a.id}`, { mode: 'work' })).body.area.mode).toBe('work');
    expect((await ui(s, 'PATCH', `/api/areas/${a.id}`, { archived: true })).body.area.archived).toBe(true);
    expect((await ui(s, 'PATCH', `/api/areas/${a.id}`, { archived: false })).body.area.archived).toBe(false);
    const log = await activity();
    expect(log).toContain('Renamed area “Garden” to “Yard”');
    expect(log).toContain('Changed the color of area “Yard”');
    expect(log).toContain('Moved area “Yard” to Work');
    expect(log).toContain('Archived area “Yard”');
    expect(log).toContain('Restored area “Yard”');
  });

  it('deletes an empty area', async () => {
    const a = await newArea('Empty');
    const live = listenEvents(s);
    await live.opened;
    const r = await ui(s, 'DELETE', `/api/areas/${a.id}`);
    expect(r.status).toBe(200);
    expect(r.body.moved).toBe(0);
    await live.waitFor((e) => e.type === 'area-deleted' && e.id === a.id);
    live.close();
    expect((await ui(s, 'GET', '/api/areas')).body.areas.find((x: { id: string }) => x.id === a.id)).toBeUndefined();
    expect(await activity()).toContain('Deleted area “Empty”');
  });

  it('will not delete an area with tasks until you say where they go', async () => {
    const a = await newArea('Busy');
    await ui(s, 'POST', '/api/tasks', { title: 'Still here', areaId: a.id });
    const r = await ui(s, 'DELETE', `/api/areas/${a.id}`);
    expect(r.status).toBe(409);
    expect(r.body.error.tasks).toBe(1);
    expect((await ui(s, 'DELETE', `/api/areas/${a.id}`, { moveTo: a.id })).status).toBe(422);
  });

  it('moves tasks and projects to another area, or to Unfiled, then deletes', async () => {
    const from = await newArea('Old');
    const to = await newArea('New');
    const project = (await ui(s, 'POST', '/api/projects', { areaId: from.id, name: 'Kitchen' })).body.project;
    const t1 = (await ui(s, 'POST', '/api/tasks', { title: 'In a project', projectId: project.id })).body.task;
    const t2 = (await ui(s, 'POST', '/api/tasks', { title: 'Loose', areaId: from.id })).body.task;
    const trashed = (await ui(s, 'POST', '/api/tasks', { title: 'Binned', areaId: from.id })).body.task;
    await ui(s, 'DELETE', `/api/tasks/${trashed.id}`);

    const r = await ui(s, 'DELETE', `/api/areas/${from.id}`, { moveTo: to.id });
    expect(r.status).toBe(200);
    expect(r.body.moved).toBe(2);
    const moved1 = (await ui(s, 'GET', `/api/tasks/${t1.id}`)).body.task;
    expect(moved1).toMatchObject({ areaId: to.id, projectId: project.id });
    expect((await ui(s, 'GET', `/api/tasks/${t2.id}`)).body.task.areaId).toBe(to.id);
    // A task in Trash still has somewhere valid to go back to.
    const back = await ui(s, 'POST', `/api/tasks/${trashed.id}/restore`, {});
    expect(back.body.task.areaId).toBe(to.id);
    expect(await activity()).toContain('Deleted area “Old” and moved 2 tasks to New');

    const r2 = await ui(s, 'DELETE', `/api/areas/${to.id}`, { moveTo: null });
    expect(r2.status).toBe(200);
    expect((await ui(s, 'GET', `/api/tasks/${t1.id}`)).body.task).toMatchObject({ areaId: null, projectId: null });
    expect((await ui(s, 'GET', '/api/areas')).body.projects).toHaveLength(0);
  });

  it('is app-only: a connection cannot rename or delete areas', async () => {
    await newArea('Work', 'work');
    const work = await areaId(s, 'Work');
    const { token } = await makeClient(s, { areas: '*', perms: ['read', 'create', 'update', 'complete'] });
    expect((await asClient(s, token, 'DELETE', `/api/areas/${work}`)).status).toBe(403);
    expect((await asClient(s, token, 'PATCH', `/api/areas/${work}`, { name: 'Mine' })).status).toBe(403);
  });
});

describe('Stop and Reopen put a task back where it was', () => {
  it('Stop returns a started task to the status it came from', async () => {
    const t = (await ui(s, 'POST', '/api/tasks', { title: 'Plan', status: 'next' })).body.task;
    const started = (await ui(s, 'POST', `/api/tasks/${t.id}/start`, {})).body.task;
    expect(started).toMatchObject({ status: 'doing', startedFrom: 'next' });
    const stopped = (await ui(s, 'POST', `/api/tasks/${t.id}/stop`, {})).body.task;
    expect(stopped.status).toBe('next');
    expect(await activity()).toContain('Stopped “Plan”, back to Next');
  });

  it('Stop falls back to Today for a task created in progress', async () => {
    const t = (await ui(s, 'POST', '/api/tasks', { title: 'Already going', status: 'doing' })).body.task;
    expect((await ui(s, 'POST', `/api/tasks/${t.id}/stop`, {})).body.task.status).toBe('today');
  });

  it('Reopen returns a done task to where it was, and Stop still knows where it started', async () => {
    const t = (await ui(s, 'POST', '/api/tasks', { title: 'Write', status: 'waiting' })).body.task;
    await ui(s, 'POST', `/api/tasks/${t.id}/start`, {});
    const done = (await ui(s, 'POST', `/api/tasks/${t.id}/complete`, {})).body.task;
    expect(done.prevStatus).toBe('doing');
    expect((await ui(s, 'POST', `/api/tasks/${t.id}/reopen`, {})).body.task.status).toBe('doing');
    expect((await ui(s, 'POST', `/api/tasks/${t.id}/stop`, {})).body.task.status).toBe('waiting');
  });
});
