import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp, type App } from '../server/app.ts';
import { loadConfig, type Config } from '../server/config.ts';
import { initLog } from '../server/log.ts';

export function tempDir(prefix = 'mt-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export interface TestServer {
  app: App;
  base: string;
  port: number;
  dir: string;
  config: Config;
  stop(): Promise<void>;
}

export async function startServer(opts: { dir?: string; seed?: boolean; port?: number; env?: Record<string, string> } = {}): Promise<TestServer> {
  const dir = opts.dir ?? tempDir();
  initLog(path.join(dir, 'logs'), { console: false });
  // Never the real Claude in tests: an empty path means "not installed" unless a test passes a stand-in.
  // Never the real Claude setup either: the skills folder, Claude Desktop's settings and the app all live in the temp folder.
  const config = loadConfig({
    MT_DATA_DIR: path.join(dir, 'data'),
    MT_LOG_DIR: path.join(dir, 'logs'),
    MT_PORT: String(opts.port ?? 0),
    MT_SEED: opts.seed === false ? '0' : '1',
    MT_CLAUDE_PROJECTS_DIR: path.join(dir, 'claude-projects'),
    MT_CLAUDE_BIN: '',
    MT_CLAUDE_APP_DIR: path.join(dir, 'claude-app'),
    MT_CLAUDE_APP_PATH: path.join(dir, 'Applications', 'Claude.app'),
    MT_CLAUDE_SKILLS_DIR: path.join(dir, 'claude-skills'),
    MT_CLAUDE_DESKTOP_CONFIG: path.join(dir, 'claude-desktop', 'claude_desktop_config.json'),
    MT_SKILL_DIR: path.join(dir, 'skill', 'master-tasker'),
    MT_NOTIFY_BIN: '',
    ...opts.env,
  });
  const app = createApp(config);
  const port = await app.listen();
  return { app, base: `http://127.0.0.1:${port}`, port, dir, config, stop: () => app.close() };
}

export interface Res<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

/** Call the API as the browser UI ("you"). */
export async function ui<T = any>(s: TestServer, method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res<T>> {
  const res = await fetch(s.base + p, {
    method,
    headers: { 'x-master-tasker': 'web', 'x-session-id': 'session-ui-test-1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

/** Call the API as a connection (assistant) using its token. */
export async function asClient<T = any>(s: TestServer, token: string, method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res<T>> {
  const res = await fetch(s.base + p, {
    method,
    headers: { authorization: `Bearer ${token}`, 'x-session-id': 'session-client-1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

export async function makeClient(s: TestServer, opts: { name?: string; kind?: string; areas?: string[] | '*'; unfiled?: boolean; perms?: string[]; limits?: { writesPerDay: number; proposalsPerDay: number } } = {}) {
  const r = await ui(s, 'POST', '/api/clients', {
    name: opts.name ?? 'test client',
    kind: opts.kind ?? 'claude',
    scopes: { areas: opts.areas ?? '*', unfiled: opts.unfiled ?? true, perms: opts.perms ?? ['read', 'create', 'update', 'complete', 'propose'] },
    ...(opts.limits ? { limits: opts.limits } : {}),
  });
  if (r.status !== 200) throw new Error(`makeClient failed: ${JSON.stringify(r.body)}`);
  return { token: r.body.token as string, id: r.body.client.id as string };
}

/** Thread linking reads Claude Code's thread files, so it starts off. Tests about threads turn it on. */
export async function linkThreads(s: TestServer) {
  const r = await ui(s, 'PATCH', '/api/settings', { threadLinking: true });
  if (r.status !== 200) throw new Error(`could not turn on thread linking: ${JSON.stringify(r.body)}`);
}

export async function areaId(s: TestServer, name: string): Promise<string> {
  const r = await ui(s, 'GET', '/api/areas');
  const a = r.body.areas.find((x: { name: string }) => x.name === name);
  if (!a) throw new Error(`no area ${name}`);
  return a.id;
}

/** Minimal SSE reader for tests. */
export function listenEvents(s: TestServer) {
  const events: any[] = [];
  let resolveOpen: () => void;
  const opened = new Promise<void>((r) => (resolveOpen = r));
  const req = http.get(`${s.base}/api/events`, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (ev === 'hello') resolveOpen();
        if (ev === 'change' && data) events.push(JSON.parse(data));
      }
    });
  });
  return {
    events,
    opened,
    waitFor: async (pred: (e: any) => boolean, ms = 3000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const hit = events.find(pred);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error('event not received');
    },
    close: () => req.destroy(),
  };
}
