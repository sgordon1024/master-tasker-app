import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeRemote, redact, REVIEW_MARKER } from '../automation/devscan.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
let tmp: string;
let dev: string;
let claude: string;

const env = () => ({ PATH: process.env.PATH!, HOME: tmp, MT_DEV_ROOTS: dev, MT_DATA_DIR: path.join(tmp, 'data'), MT_CLAUDE_PROJECTS_DIR: claude, MT_DEVSCAN_GH: '0' });
function cli(...args: string[]) {
  const r = spawnSync(process.execPath, ['automation/devscan.ts', ...args], { cwd: ROOT, env: env(), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}
const g = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=me@example.com', '-c', 'user.name=Me', ...args], { cwd, stdio: 'ignore' });
function repo(name: string) {
  const p = path.join(dev, name);
  fs.mkdirSync(p, { recursive: true });
  g(p, 'init', '-q', '-b', 'main');
  g(p, 'config', 'user.email', 'me@example.com');
  fs.writeFileSync(path.join(p, 'README.md'), name);
  g(p, 'add', '.');
  g(p, 'commit', '-q', '-m', `start ${name}`);
  return p;
}
function session(cwd: string, lines: { role: 'user' | 'assistant'; text: string }[], title?: string) {
  const dir = path.join(claude, cwd.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const at = new Date().toISOString();
  const rows = lines.map((l, i) => JSON.stringify({ type: l.role, sessionId: 's1', cwd, timestamp: at, uuid: `u${i}`, message: { role: l.role, content: l.text } }));
  if (title) rows.push(JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: 's1' }));
  fs.writeFileSync(path.join(dir, `${Math.random().toString(36).slice(2)}.jsonl`), rows.join('\n'));
}
const find = (d: any, name: string) => d.active.find((p: any) => p.name === name);

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-devscan-'));
  dev = path.join(tmp, 'development');
  claude = path.join(tmp, 'claude-projects');
  fs.mkdirSync(dev);
  fs.mkdirSync(claude);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('which code folders it watches', () => {
  it('watches none until you name some, and reads the saved list', () => {
    repo('app');
    const noRoots = () => {
      const e: Record<string, string> = env();
      delete e.MT_DEV_ROOTS;
      return e;
    };
    const scanWith = (e: Record<string, string>) => JSON.parse(spawnSync(process.execPath, ['automation/devscan.ts', 'scan'], { cwd: ROOT, env: e, encoding: 'utf8' }).stdout);
    let d = scanWith(noRoots());
    expect(d.roots).toEqual([]);
    expect(d.counts.tracked).toBe(0);
    // ~ means your home folder, and lines starting with # are notes.
    const list = path.join(tmp, 'data', 'devscan', 'folders.txt');
    fs.mkdirSync(path.dirname(list), { recursive: true });
    fs.writeFileSync(list, `# my code\n~/${path.relative(tmp, dev)}\n\n`);
    d = scanWith(noRoots());
    expect(d.roots).toEqual([dev]);
    expect(d.active.map((p: any) => p.name)).toEqual(['app']);
  });
});

describe('development folder scanner', () => {
  it('reports recent work, then only what changed after each acknowledged review', () => {
    const a = repo('alpha');
    repo('beta');
    const first = cli('scan');
    expect(first.firstRun).toBe(true);
    expect(first.counts.tracked).toBe(2);
    expect(find(first, 'alpha').commits[0].subject).toBe('start alpha');

    // Without an ack the cursor stays put, so a failed review loses nothing.
    expect(find(cli('scan'), 'alpha').commits).toHaveLength(1);
    const second = cli('scan');
    cli('ack', second.scanId);

    const quiet = cli('scan');
    expect(quiet.active).toHaveLength(0);
    expect(quiet.counts.quiet).toBe(2);

    fs.writeFileSync(path.join(a, 'b.txt'), 'x');
    g(a, 'add', '.');
    g(a, 'commit', '-q', '-m', 'add b');
    const third = cli('scan');
    expect(third.active.map((p: any) => p.name)).toEqual(['alpha']);
    expect(find(third, 'alpha').commits.map((c: any) => c.subject)).toEqual(['add b']);
    expect(find(third, 'alpha').commits[0].mine).toBe(true);
  });

  it('follows a renamed folder instead of treating it as new, and notices new and deleted folders', () => {
    repo('old-name');
    repo('doomed');
    const s1 = cli('scan');
    const id = find(s1, 'old-name').id;
    cli('ack', s1.scanId);

    fs.renameSync(path.join(dev, 'old-name'), path.join(dev, 'New Name'));
    fs.rmSync(path.join(dev, 'doomed'), { recursive: true });
    repo('brand-new');
    const s2 = cli('scan');
    const renamed = find(s2, 'New Name');
    expect(renamed.id).toBe(id);
    expect(renamed.renamedFrom).toBe(path.join(dev, 'old-name'));
    expect(renamed.isNew).toBeUndefined();
    expect(find(s2, 'brand-new').isNew).toBe(true);
    expect(s2.gone.map((x: any) => x.name)).toEqual(['doomed']);
    cli('ack', s2.scanId);

    const s3 = cli('scan');
    expect(s3.active.map((p: any) => [p.name, p.isNew, p.renamedFrom, p.commits?.length])).toEqual([]);
    expect(s3.gone).toHaveLength(0);
    const all = cli('projects');
    expect(all.find((p: any) => p.id === id).previousPaths).toEqual([path.join(dev, 'old-name')]);
  });

  it('tracks repos nested in plain folders, and plain folders by file changes', () => {
    const group = path.join(dev, 'group');
    fs.mkdirSync(group);
    repo('group/inner');
    fs.mkdirSync(path.join(dev, 'notes-folder'));
    fs.writeFileSync(path.join(dev, 'notes-folder', 'TODO.md'), '- [ ] call the vendor\n- [x] done thing\n');
    fs.mkdirSync(path.join(dev, 'notes-folder', 'node_modules'));
    fs.writeFileSync(path.join(dev, 'notes-folder', 'node_modules', 'ignored.js'), '');
    const d = cli('scan');
    const inner = find(d, 'group / inner');
    expect(inner.insideFolder).toBe('group');
    const notes = find(d, 'notes-folder');
    expect(notes.changedFiles.newest).toEqual(['TODO.md']);
    expect(notes.planFiles[0]).toEqual({ file: 'TODO.md', open: ['call the vendor'], done: 1 });
  });

  it('attaches Claude Code sessions to their folder, through renames, and skips the review run itself', () => {
    const p = repo('proj');
    session(path.join(p, '.claude', 'worktrees', 'wt1'), [
      { role: 'user', text: 'Please finish the Android modifiers. password: hunter2' },
      { role: 'assistant', text: 'Done. Opened PR #56.' },
    ], 'Android work');
    session(p, [{ role: 'user', text: `${REVIEW_MARKER} daily review` }, { role: 'assistant', text: 'Reviewed.' }]);
    session(path.join(tmp, 'elsewhere'), [{ role: 'user', text: 'Plan the offsite' }]);
    const d = cli('scan');
    const ss = find(d, 'proj').claudeSessions;
    expect(ss).toHaveLength(1);
    expect(ss[0]).toMatchObject({ title: 'Android work', lastReply: 'Done. Opened PR #56.' });
    expect(ss[0].asks[0]).toBe('Please finish the Android modifiers. password: [redacted]');
    expect(d.claudeSessionsOutsideDevFolders.map((s: any) => s.asks[0])).toEqual(['Plan the offsite']);
    cli('ack', d.scanId);

    // A session recorded under the old path still lands on the renamed folder.
    fs.renameSync(p, path.join(dev, 'proj-renamed'));
    session(p, [{ role: 'user', text: 'old path session' }]);
    const d2 = cli('scan');
    expect(find(d2, 'proj-renamed').claudeSessions[0].asks).toEqual(['old path session']);
  });
});

describe('scanner helpers', () => {
  it('redacts secrets', () => {
    expect(redact(`token mt_${'a'.repeat(32)} and ghp_${'b'.repeat(30)}`)).toBe('token [redacted] and [redacted]');
    expect(redact('API_KEY=abc123 secret: "x y"')).toBe('API_KEY=[redacted] secret: [redacted]');
  });
  it('normalizes GitHub remotes', () => {
    expect(normalizeRemote('git@github.com:AcmeCo/Widget-Kit.git')).toBe('acmeco/widget-kit');
    expect(normalizeRemote('https://github.com/someone/notes.git')).toBe('someone/notes');
  });
});
