import type { Area, Priority, Project, Status, Task, TaskProgress } from '../../shared/schema.ts';

export function todayIso(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addDays(iso: string, days: number) {
  const [y, m, d] = iso.split('-').map(Number);
  return todayIso(new Date(y, m - 1, d + days));
}

export type DueState = 'overdue' | 'today' | 'soon' | 'later' | null;

export function dueState(t: Pick<Task, 'dueDate' | 'status'>, today = todayIso()): DueState {
  if (!t.dueDate || t.status === 'done') return null;
  if (t.dueDate < today) return 'overdue';
  if (t.dueDate === today) return 'today';
  if (t.dueDate <= addDays(today, 6)) return 'soon';
  return 'later';
}

const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const MONTH_DAY = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const FULL = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

export function formatDue(iso: string, today = todayIso()) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  if (iso === today) return 'Today';
  if (iso === addDays(today, 1)) return 'Tomorrow';
  if (iso === addDays(today, -1)) return 'Yesterday';
  if (iso > today && iso <= addDays(today, 6)) return WEEKDAY.format(date);
  if (y === new Date().getFullYear()) return MONTH_DAY.format(date);
  return FULL.format(date);
}

const LONG = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const LONG_YEAR = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
/** A due date in plain words, for titles and screen readers: "Friday, October 16". */
export function longDate(iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return (y === new Date().getFullYear() ? LONG : LONG_YEAR).format(date);
}

const TIME = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
export function formatTime(ms: number | string) {
  return TIME.format(new Date(ms));
}

/** "Today at 2:06 PM", "Yesterday at 8:00 AM", "Mon, Oct 12 at 8:00 AM". */
export function friendlyDateTime(ms: number | string, today = todayIso()) {
  const date = new Date(ms);
  const day = todayIso(date);
  const time = TIME.format(date);
  if (day === today) return `Today at ${time}`;
  if (day === addDays(today, -1)) return `Yesterday at ${time}`;
  const [y] = day.split('-').map(Number);
  const when = y === new Date().getFullYear() ? new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(date) : FULL.format(date);
  return `${when} at ${time}`;
}

/** Sentence case: the first letter up, the rest as written. */
export const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "1 task", "3 tasks". */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function relativeTime(ms: number | string, now = Date.now()) {
  const t = typeof ms === 'string' ? Date.parse(ms) : ms;
  const s = Math.round((now - t) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return MONTH_DAY.format(new Date(t));
}

/** Position between two neighbours, for drag-and-drop ordering. */
export function between(before: number | undefined, after: number | undefined) {
  if (before === undefined && after === undefined) return 0;
  if (before === undefined) return (after as number) - 1;
  if (after === undefined) return before + 1;
  return (before + after) / 2;
}

export const PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2, none: 3 };

export const byPosition = (a: Task, b: Task) => a.position - b.position || a.createdAt.localeCompare(b.createdAt);
export const byCompleted = (a: Task, b: Task) => (b.completedAt ?? '').localeCompare(a.completedAt ?? '');

export type ViewId = 'inbox' | 'doing' | 'today' | 'next' | 'waiting' | 'done' | 'board' | 'foryou' | 'activity' | 'routines' | 'trash' | 'settings' | 'wizard';

export interface Scope {
  view: ViewId;
  areaId: string | null;
  projectId: string | null;
}

export interface Filters {
  q: string;
  priority: Priority | 'any';
  due: 'any' | 'overdue' | 'today' | 'week' | 'none';
}

export const EMPTY_FILTERS: Filters = { q: '', priority: 'any', due: 'any' };

export function matches(t: Task, f: Filters, today = todayIso(), names?: { areas: Map<string, Area>; projects: Map<string, Project> }) {
  if (f.priority !== 'any' && t.priority !== f.priority) return false;
  if (f.due === 'none' && t.dueDate) return false;
  if (f.due === 'overdue' && dueState(t, today) !== 'overdue') return false;
  if (f.due === 'today' && dueState(t, today) !== 'today') return false;
  if (f.due === 'week' && !(t.dueDate && t.dueDate <= addDays(today, 6) && t.status !== 'done')) return false;
  if (f.q) {
    const needle = f.q.toLowerCase();
    const hay = [
      t.title,
      t.notes,
      t.nextAction,
      t.waitingOn,
      ...t.links.map((l) => `${l.label ?? ''} ${l.url}`),
      ...t.subtasks.map((s) => s.title),
      names && t.areaId ? names.areas.get(t.areaId)?.name : '',
      names && t.projectId ? names.projects.get(t.projectId)?.name : '',
    ]
      .join('\n')
      .toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

export function inScope(t: Task, scope: Pick<Scope, 'areaId' | 'projectId'>) {
  if (scope.projectId) return t.projectId === scope.projectId;
  if (scope.areaId) return t.areaId === scope.areaId;
  return true;
}

// In progress comes first: it is what you are working on right now.
export const STATUS_ORDER: Status[] = ['doing', 'inbox', 'today', 'next', 'waiting', 'done'];

export function isMac() {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
}

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(' ');
}

/** What a task needs from you, if anything: its own note first, then flagged subtasks. Done tasks need nothing. */
/** "Wait for Chris's notes" is someone else's move, not yours. */
export const isWaitStep = (title: string) => /^\s*(wait|waiting)\b/i.test(title);

/**
 * Claude counts as on a task only while one of its threads is actually running: it wrote something in the
 * last 5 minutes. A thread that finished its reply and is waiting for you is not on it.
 */
export const claudeIsOn = (p: TaskProgress | undefined, now = Date.now()) => {
  const at = p?.activeAt ?? p?.noteAt;
  return Boolean(at && now - Date.parse(at) < 5 * 60_000);
};

/**
 * In progress, but no Claude thread is working it. Returns the step Claude would do next (the first open
 * subtask that isn't a wait or flagged for you), so the app can show it and offer Work on this with Claude. It is
 * not yours: only steps flagged Needs you are.
 */
export function idleStep(t: Task, claudeOn: boolean): { id: string | null; title: string } | null {
  if (t.status !== 'doing' || t.deletedAt || claudeOn) return null;
  const open = t.subtasks.filter((s) => !s.done && !s.needsYou);
  const next = open.find((s) => !isWaitStep(s.title));
  if (next) return { id: next.id, title: next.title };
  if (!t.subtasks.some((s) => !s.done) && t.nextAction.trim()) return { id: null, title: t.nextAction };
  return null;
}

/**
 * What's waiting on you, in the order to do it: flagged subtasks in plan order (the plan is ordered by when
 * each step is needed), then anything flagged on the task itself.
 */
export function needsYouList(t: Task): { key: string; text: string; subtaskId: string | null }[] {
  if (t.status === 'done' || t.deletedAt) return [];
  return [
    ...t.subtasks.filter((s) => s.needsYou && !s.done).map((s) => ({ key: s.id, text: s.title, subtaskId: s.id })),
    ...(t.needsYou ? [{ key: 'task', text: t.needsYou, subtaskId: null }] : []),
  ];
}

export const needsYouItems = (t: Task): string[] => needsYouList(t).map((x) => x.text);

/** Tasks waiting on you, most important first: priority, then due date, then the order they're in. */
export const byYouFirst = (a: Task, b: Task) =>
  PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || a.position - b.position;

/** Copies text. Falls back to the older copy command where the clipboard API is blocked (some embedded browsers). */
export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    const back = document.activeElement as HTMLElement | null;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    back?.focus();
    return ok;
  }
}

/** A title short enough for a toast, cut at a word so it never ends mid-word. */
export function clip(s: string, max = 40) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max + 1);
  const at = cut.lastIndexOf(' ');
  return `${(at > max / 2 ? cut.slice(0, at) : s.slice(0, max)).replace(/[\s,.;:]+$/, '')}…`;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
// Short names people type: "fri", "thurs". Each maps to its index in WEEKDAYS.
const SHORT_DAYS: Record<string, number> = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH_WORD = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

/** Places you can file a task in from capture with #name. */
export interface CapturePlaces {
  areas: Pick<Area, 'id' | 'name' | 'archived'>[];
  projects: Pick<Project, 'id' | 'name' | 'areaId' | 'archived'>[];
}

export interface ParsedCapture {
  title: string;
  dueDate: string | null;
  priority: Priority | null;
  /** Filed with #name: the area, and the project when it named one. */
  areaId: string | null;
  projectId: string | null;
  /** The name it was filed under, for "In Home" or "In Side projects / Portfolio site". */
  place: string | null;
  /** The words that were read as a date, a priority or a place, to show what was understood. */
  found: string[];
}

const iso = (y: number, m: number, d: number) => {
  const date = new Date(y, m - 1, d);
  // Feb 30 rolls over in Date. A date that doesn't exist isn't read.
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d ? todayIso(date) : null;
};
const weekdayOf = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
};
/** A month and day with no year means the next one: "Jan 5" in October is next January. */
const nextOf = (m: number, d: number, today: string, year?: number) => {
  if (year !== undefined) return iso(year < 100 ? 2000 + year : year, m, d);
  const y = Number(today.slice(0, 4));
  const date = iso(y, m, d);
  if (date && date < today) return iso(y + 1, m, d);
  return date;
};
/** Does this browser write the day before the month (20/10 rather than 10/20)? */
const dayFirst = (() => {
  try {
    const parts = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'numeric' }).formatToParts(new Date(2020, 11, 31));
    return parts.findIndex((p) => p.type === 'day') < parts.findIndex((p) => p.type === 'month');
  } catch {
    return false;
  }
})();
const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** "#home", "#side-projects", "#portfolio" or "#side/portfolio": an area or a project, by name. */
function findPlace(word: string, places: CapturePlaces): { areaId: string; projectId: string | null; name: string } | null {
  const areas = places.areas.filter((a) => !a.archived);
  const projects = places.projects.filter((p) => !p.archived && areas.some((a) => a.id === p.areaId));
  const areaName = (id: string) => areas.find((a) => a.id === id)!.name;
  const pick = <T extends { name: string }>(list: T[], q: string) => {
    if (!q) return null;
    const exact = list.filter((x) => squash(x.name) === q);
    if (exact.length === 1) return exact[0];
    const start = list.filter((x) => squash(x.name).startsWith(q));
    return start.length === 1 ? start[0] : null;
  };
  const [first, second] = word.split('/').map(squash);
  if (second !== undefined) {
    const area = pick(areas, first);
    const project = area ? pick(projects.filter((p) => p.areaId === area.id), second) : null;
    return area && project ? { areaId: area.id, projectId: project.id, name: `${area.name} / ${project.name}` } : null;
  }
  // An exact name wins, an area before a project. Otherwise the start of a name, if only one fits.
  const exactArea = areas.filter((a) => squash(a.name) === first);
  if (exactArea.length === 1) return { areaId: exactArea[0].id, projectId: null, name: exactArea[0].name };
  const exactProject = projects.filter((p) => squash(p.name) === first);
  if (exactProject.length === 1) return { areaId: exactProject[0].areaId, projectId: exactProject[0].id, name: `${areaName(exactProject[0].areaId)} / ${exactProject[0].name}` };
  const both = [...areas.map((a) => ({ kind: 'area' as const, id: a.id, name: a.name })), ...projects.map((p) => ({ kind: 'project' as const, id: p.id, name: p.name, areaId: p.areaId }))];
  const hit = pick(both, first);
  if (!hit) return null;
  return hit.kind === 'area' ? { areaId: hit.id, projectId: null, name: hit.name } : { areaId: hit.areaId, projectId: hit.id, name: `${areaName(hit.areaId)} / ${hit.name}` };
}

/** The first date in the text, as [the words that said it, the day]. */
function findDate(title: string, today: string): [RegExpExecArray, string] | null {
  const lead = String.raw`(?:(?:on|by|due|for)\s+)?`;
  const tries: [RegExp, (m: RegExpExecArray) => string | null][] = [
    // 2026-10-20
    [new RegExp(String.raw`\s${lead}(\d{4})-(\d{2})-(\d{2})(?=\s)`, 'i'), (m) => iso(Number(m[1]), Number(m[2]), Number(m[3]))],
    // in 3 days, in a week, in two weeks
    [/\s(?:due\s+)?in\s+(\d{1,3}|an?|one|two|three|four|five|six|seven|eight|nine|ten)\s+(days?|weeks?)(?=\s)/i, (m) => {
      const n = NUMBER_WORDS[m[1].toLowerCase()] ?? Number(m[1]);
      return addDays(today, /^w/i.test(m[2]) ? n * 7 : n);
    }],
    // next week: the Monday after this one
    [new RegExp(String.raw`\s${lead}next\s+week(?=\s)`, 'i'), () => addDays(today, ((8 - weekdayOf(today)) % 7) || 7)],
    // Oct 20, October 20th, Oct 20 2027
    [new RegExp(String.raw`\s${lead}(${MONTH_WORD})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?(?=\s)`, 'i'), (m) => nextOf(MONTHS[m[1].toLowerCase()], Number(m[2]), today, m[3] ? Number(m[3]) : undefined)],
    // 20 Oct, 20th October
    [new RegExp(String.raw`\s${lead}(\d{1,2})(?:st|nd|rd|th)?\s+(${MONTH_WORD})(?:,?\s+(\d{4}))?(?=\s)`, 'i'), (m) => nextOf(MONTHS[m[2].toLowerCase()], Number(m[1]), today, m[3] ? Number(m[3]) : undefined)],
    // 10/20 or 10/20/2027, in the order this browser writes dates
    [new RegExp(String.raw`\s${lead}(\d{1,2})/(\d{1,2})(?:/(\d{2}|\d{4}))?(?=\s)`, 'i'), (m) => {
      const [a, b] = [Number(m[1]), Number(m[2])];
      const [month, day] = dayFirst ? [b, a] : [a, b];
      return nextOf(month, day, today, m[3] ? Number(m[3]) : undefined);
    }],
    [new RegExp(String.raw`\s${lead}(today|tonight|tomorrow)(?=\s)`, 'i'), (m) => (/^tom/i.test(m[1]) ? addDays(today, 1) : today)],
    // next friday: the Friday of next week
    [new RegExp(String.raw`\s${lead}next\s+(${WEEKDAYS.join('|')}|${Object.keys(SHORT_DAYS).join('|')})(?=\s)`, 'i'), (m) => {
      const want = WEEKDAYS.indexOf(m[1].toLowerCase()) >= 0 ? WEEKDAYS.indexOf(m[1].toLowerCase()) : SHORT_DAYS[m[1].toLowerCase()];
      const monday = addDays(today, ((8 - weekdayOf(today)) % 7) || 7);
      return addDays(monday, (want + 6) % 7);
    }],
    // friday, on friday
    [new RegExp(String.raw`\s${lead}(${WEEKDAYS.join('|')})(?=\s)`, 'i'), (m) => addDays(today, (WEEKDAYS.indexOf(m[1].toLowerCase()) - weekdayOf(today) + 7) % 7 || 7)],
    // fri: short names are common words ("sun cream", "sat down"), so only after on, by or due, or at the very end
    [new RegExp(String.raw`\s(?:(?:on|by|due)\s+(${Object.keys(SHORT_DAYS).join('|')})\.?(?=\s)|(${Object.keys(SHORT_DAYS).join('|')})\.?(?=\s+$))`, 'i'), (m) => {
      const want = SHORT_DAYS[(m[1] ?? m[2]).toLowerCase()];
      return addDays(today, (want - weekdayOf(today) + 7) % 7 || 7);
    }],
  ];
  for (const [re, read] of tries) {
    const m = re.exec(title);
    if (!m) continue;
    const day = read(m);
    if (day) return [m, day];
  }
  return null;
}

/**
 * Reads a due date, a priority and a place out of a quick capture.
 * Dates: "today", "tomorrow", "friday" or "fri", "next fri", "next week", "in 3 days", "Oct 20", "10/20", "2026-10-20".
 * A weekday means the next one after today. Priority: "!high", "!medium", "!low". Place: "#home", "#portfolio".
 * Only standalone words count, so "Read Today's paper" keeps its title.
 */
export function parseCapture(text: string, today = todayIso(), places?: CapturePlaces): ParsedCapture {
  let title = ` ${text.trim()} `;
  let dueDate: string | null = null;
  let priority: Priority | null = null;
  let place: ReturnType<typeof findPlace> = null;
  const found: string[] = [];
  const cut = (m: RegExpExecArray) => {
    found.push(m[0].trim());
    title = `${title.slice(0, m.index)} ${title.slice(m.index + m[0].length)}`;
  };
  const pr = /\s!(high|medium|med|low)(?=\s)/i.exec(title);
  if (pr) {
    const word = pr[1].toLowerCase();
    priority = word === 'med' ? 'medium' : (word as Priority);
    cut(pr);
  }
  if (places) {
    const re = /\s#([\p{L}\p{N}][\p{L}\p{N}_\-./]*)(?=\s)/gu;
    for (let m = re.exec(title); m; m = re.exec(title)) {
      place = findPlace(m[1].replace(/[.]+$/, ''), places);
      if (place) {
        cut(m);
        break;
      }
    }
  }
  const date = findDate(title, today);
  if (date) {
    dueDate = date[1];
    cut(date[0]);
  }
  title = title.replace(/\s+/g, ' ').trim();
  // Nothing left but the date: keep what was typed as the title.
  if (!title) return { title: text.trim(), dueDate: null, priority: null, areaId: null, projectId: null, place: null, found: [] };
  return { title, dueDate, priority, areaId: place?.areaId ?? null, projectId: place?.projectId ?? null, place: place?.name ?? null, found };
}

/** Claude's replies are Markdown. In one-line previews, show the words, not the ** and ` marks. */
export const plain = (s: string) => s.replace(/\*\*|__|`/g, '').replace(/^#+\s*/gm, '');
