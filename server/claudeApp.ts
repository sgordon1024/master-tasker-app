// Reads, never writes, what the Claude desktop app keeps on this Mac: its Code threads (to open one
// directly in the app) and its scheduled routines (for the Sources page).
import fs from 'node:fs';
import path from 'node:path';

export interface ScheduledRoutine {
  id: string;
  name: string;
  description: string;
  /** Cron for repeating routines, or fireAt (ms) for one-off ones. */
  cron: string | null;
  fireAt: number | null;
  enabled: boolean;
  lastRunAt: string | null;
  cwd: string;
  file: string;
  /** The routine's instructions, for working out what it reads. */
  prompt: string;
  /** Tools it's been allowed to use, e.g. a connector's search tool. */
  tools: string[];
}

/** Every account folder the app keeps Code sessions in. */
function sessionDirs(base: string): string[] {
  const out: string[] = [];
  for (const a of safeList(base)) for (const b of safeList(path.join(base, a))) out.push(path.join(base, a, b));
  return out.filter((d) => fs.statSync(d, { throwIfNoEntry: false })?.isDirectory());
}
function safeList(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function createClaudeApp(base: string) {
  let map = new Map<string, string>();
  let lastRuns = new Map<string, { id: string; at: number }>();
  let builtAt = 0;

  function rebuild() {
    const next = new Map<string, string>();
    const runs = new Map<string, { id: string; at: number }>();
    for (const d of sessionDirs(base)) {
      for (const f of safeList(d)) {
        if (!/^local_[\w-]+\.json$/.test(f)) continue;
        const j = readJson(path.join(d, f));
        if (!j?.sessionId || j.isArchived) continue;
        if (j.cliSessionId) next.set(j.cliSessionId, j.sessionId);
        if (typeof j.scheduledTaskId === 'string') {
          const at = Number(j.createdAt) || 0;
          if (at >= (runs.get(j.scheduledTaskId)?.at ?? -1)) runs.set(j.scheduledTaskId, { id: j.sessionId, at });
        }
      }
    }
    map = next;
    lastRuns = runs;
    builtAt = Date.now();
  }

  /** Claude Code's session id (what thread files use) → the app's own id (what its links use). */
  function appSessionId(cliSessionId: string): string | null {
    if (!map.has(cliSessionId) && Date.now() - builtAt > 5000) rebuild();
    return map.get(cliSessionId) ?? null;
  }

  /** The app's id for a routine's most recent run. */
  function lastRun(routineId: string): string | null {
    if (Date.now() - builtAt > 5000) rebuild();
    return lastRuns.get(routineId)?.id ?? null;
  }

  function routines(): ScheduledRoutine[] {
    const out: ScheduledRoutine[] = [];
    for (const d of sessionDirs(base)) {
      const j = readJson(path.join(d, 'scheduled-tasks.json'));
      for (const t of j?.scheduledTasks ?? []) {
        if (typeof t?.id !== 'string') continue;
        // Paths are absolute in the app; relative ones (test fixtures) are next to the list.
        const file = typeof t.filePath === 'string' && t.filePath ? path.resolve(d, t.filePath) : '';
        let text = '';
        try {
          text = fs.readFileSync(file, 'utf8');
        } catch {}
        const front = /^---\n([\s\S]*?)\n---\n?/.exec(text);
        const description = front ? /description:\s*(.*)/.exec(front[1])?.[1]?.trim() ?? '' : '';
        out.push({
          id: t.id,
          name: t.displayName || t.id,
          description,
          cron: typeof t.cronExpression === 'string' ? t.cronExpression : null,
          fireAt: typeof t.fireAt === 'number' ? t.fireAt : null,
          enabled: t.enabled !== false,
          lastRunAt: t.lastRunAt ?? null,
          cwd: t.cwd ?? '',
          file,
          prompt: front ? text.slice(front[0].length) : text,
          tools: (t.approvedPermissions ?? []).map((p: { toolName?: string }) => p.toolName).filter(Boolean),
        });
      }
    }
    return out;
  }

  return { appSessionId, lastRun, routines };
}

/** The app's own "continue this session" link: opens that Code thread. */
export const appThreadLink = (appSessionId: string) => `claude://code/continue?session=${encodeURIComponent(appSessionId)}`;
