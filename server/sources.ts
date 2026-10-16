// The Sources page: every scheduled routine, what it reads, which tickets it's tied to, and your
// on/off switches. Switches live in sources.json in the data folder. A routine honors them because
// one check line is added to its instructions the first time you switch something off.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_DATA_DIR, shq } from '../automation/env.ts';
import type { RoutineInfo } from '../shared/schema.ts';
import type { ScheduledRoutine } from './claudeApp.ts';

/** The check a routine runs, wherever this copy of Master Tasker lives. */
const CHECK_TOOL = path.resolve(import.meta.dirname, '..', 'automation', 'sources.ts');

interface State {
  routines: Record<string, { paused?: boolean; off?: string[]; labels?: Record<string, string> }>;
}

export const CHECK_MARK = '<!-- master-tasker:sources -->';

const RULES: { key: string; label: string; test: RegExp; tool?: RegExp }[] = [
  { key: 'gmail', label: 'Gmail', test: /\bgmail\b/i, tool: /(search_threads|get_thread)$/ },
  { key: 'slack', label: 'Slack', test: /\bslack\b/i, tool: /slack_/ },
  { key: 'calendar', label: 'Google Calendar', test: /\bcalendar\b/i, tool: /(list_events|search_events)$/ },
  { key: 'drive', label: 'Google Drive', test: /google drive/i, tool: /(read_file_content|search_files)$/ },
  { key: 'jira', label: 'Jira and Confluence', test: /\b(jira|confluence)\b/i },
  { key: 'granola', label: 'Granola meetings', test: /\bgranola\b/i, tool: /(get_meeting_transcript|list_meetings|get_meetings|query_granola)$/ },
  { key: 'dev', label: 'Code folders (git, PRs, plan files)', test: /dev folders|development folders|code folders|devscan/i },
  { key: 'claude-sessions', label: 'Claude Code sessions', test: /claude code sessions|session transcripts/i },
  { key: 'github', label: 'GitHub', test: /\bgh (pr|api|issue|run)\b|github api/i },
  { key: 'browser', label: 'Browser', test: /preview_start|browser pane|claude in chrome/i },
];

/** What a routine reads, from its instructions and the tools it's been allowed. */
export function detectSources(r: Pick<ScheduledRoutine, 'prompt' | 'description' | 'tools'>): { key: string; label: string }[] {
  const text = `${r.description}\n${r.prompt}`;
  const out = RULES.filter((x) => x.test.test(text) || (x.tool && r.tools.some((t) => x.tool!.test(t)))).map(({ key, label }) => ({ key, label }));
  // Local files it reads or updates, named by the folder they're in, one level below a folder in your home folder.
  const folders = new Set<string>();
  for (const m of text.matchAll(/(?:\/Users\/[^/\s]+|~|\$HOME)\/[^/"'\s]+\/([^/"'\n]+)\/[^"'\n]*\.(?:md|json|csv|txt)/g)) folders.add(m[1]);
  for (const f of folders) out.push({ key: `files:${f}`, label: `Files in ${f}` });
  return out;
}

const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const time = (h: number, m: number) => `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;

/** "0 8,14 * * *" → "Every day at 8am and 2pm". Falls back to the raw cron for anything unusual. */
export function describeSchedule(cron: string | null, fireAt: number | null): string {
  if (fireAt) {
    const d = new Date(fireAt);
    return `Once, ${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} at ${time(d.getHours(), d.getMinutes())}`;
  }
  if (!cron) return 'No schedule';
  const p = cron.trim().split(/\s+/);
  if (p.length !== 5 || p[2] !== '*' || p[3] !== '*' || !/^\d+$/.test(p[0]) || !/^[\d,]+$/.test(p[1])) return cron;
  const hours = p[1].split(',').map(Number);
  const at = hours.map((h) => time(h, Number(p[0])));
  const when = at.length > 1 ? `${at.slice(0, -1).join(', ')} and ${at[at.length - 1]}` : at[0];
  const dow = p[4];
  const days =
    dow === '*' ? 'Every day' : dow === '1-5' ? 'Weekdays' : dow === '0,6' || dow === '6,0' ? 'Weekends' : /^[\d,]+$/.test(dow) ? dow.split(',').map((d) => DAY[Number(d) % 7]).join(', ') : `Days ${dow}`;
  return `${days} at ${when}`;
}

export function createSources(opts: { stateFile: string }) {
  const read = (): State => {
    try {
      const s = JSON.parse(fs.readFileSync(opts.stateFile, 'utf8'));
      return { routines: s.routines ?? {} };
    } catch {
      return { routines: {} };
    }
  };
  const save = (s: State) => {
    fs.mkdirSync(path.dirname(opts.stateFile), { recursive: true });
    const tmp = `${opts.stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 1));
    fs.renameSync(tmp, opts.stateFile);
  };

  function describe(r: ScheduledRoutine, findTickets: (r: ScheduledRoutine) => string[]): RoutineInfo {
    const st = read().routines[r.id] ?? {};
    const off = new Set(st.off ?? []);
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      schedule: describeSchedule(r.cron, r.fireAt),
      enabled: r.enabled,
      lastRunAt: r.lastRunAt,
      paused: Boolean(st.paused),
      enforced: r.prompt.includes(CHECK_MARK),
      sources: detectSources(r).map((x) => ({ ...x, on: !off.has(x.key) })),
      ticketIds: findTickets(r),
      allTasks: /master-tasker-review|review\.ts start/.test(r.prompt),
    };
  }

  /**
   * Adds the one check line to a routine's instructions, right after its header, so it reads your
   * switches before it reads anything. Done once, and only when you first switch something off.
   */
  function enforce(r: ScheduledRoutine) {
    if (!r.file || !fs.existsSync(r.file)) throw new Error("Can't find this routine's instructions file");
    const text = fs.readFileSync(r.file, 'utf8');
    if (text.includes(CHECK_MARK)) return;
    const dataDir = path.dirname(opts.stateFile);
    const env = dataDir === path.resolve(DEFAULT_DATA_DIR) ? '' : `MT_DATA_DIR=${shq(dataDir)} `;
    const cmd = `${env}node ${shq(CHECK_TOOL)} check ${shq(r.id)}`;
    const line = `${CHECK_MARK}\nFirst, before reading anything: run \`${cmd}\`. If it says this routine is paused, stop and say so. Never read a source it lists as off, and name any skipped source in your summary.\n`;
    const front = /^---\n[\s\S]*?\n---\n/.exec(text);
    const next = front ? `${front[0]}\n${line}${text.slice(front[0].length)}` : `${line}\n${text}`;
    fs.writeFileSync(r.file, next);
  }

  function set(r: ScheduledRoutine, change: { paused?: boolean; source?: string; on?: boolean }) {
    const s = read();
    const st = (s.routines[r.id] ??= {});
    if (change.paused !== undefined) st.paused = change.paused;
    if (change.source) {
      const known = detectSources(r).find((x) => x.key === change.source);
      if (!known) throw new Error('That routine does not read that source');
      const off = new Set(st.off ?? []);
      if (change.on) off.delete(change.source);
      else off.add(change.source);
      st.off = [...off];
      st.labels = { ...st.labels, [known.key]: known.label };
    }
    if (st.paused || st.off?.length) enforce(r);
    save(s);
  }

  /** What the routine itself sees when it runs the check. */
  function check(id: string) {
    const st = read().routines[id] ?? {};
    return { routine: id, paused: Boolean(st.paused), off: (st.off ?? []).map((k) => st.labels?.[k] ?? k) };
  }

  return { describe, set, check };
}
