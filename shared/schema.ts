// The single contract shared by the UI, the HTTP API and the MCP server.
// Every write path validates with these schemas, so the rules cannot drift.
import { z } from 'zod';

export const STATUSES = ['inbox', 'doing', 'today', 'next', 'waiting', 'done'] as const;
export const PRIORITIES = ['none', 'low', 'medium', 'high'] as const;
// "start" only lets a connection move a task into In progress. Moving it out stays with you.
export const PERMISSIONS = ['read', 'create', 'update', 'complete', 'propose', 'start'] as const;
export const CLIENT_KINDS = ['claude', 'other'] as const;

export type Status = (typeof STATUSES)[number];
export type Priority = (typeof PRIORITIES)[number];
export type Permission = (typeof PERMISSIONS)[number];
export type ClientKind = (typeof CLIENT_KINDS)[number];

export const STATUS_LABELS: Record<Status, string> = {
  inbox: 'Inbox',
  doing: 'In progress',
  today: 'Today',
  next: 'Next',
  waiting: 'Waiting',
  done: 'Done',
};

export const PRIORITY_LABELS: Record<Priority, string> = {
  none: 'No priority',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

export const LIMITS = {
  title: 500,
  notes: 20_000,
  shortText: 500,
  links: 20,
  subtasks: 100,
  searchMax: 50,
  searchDefault: 20,
  noteAppend: 4_000,
} as const;

const ALLOWED_LINK_SCHEMES = ['http:', 'https:', 'mailto:', 'message:', 'slack:', 'obsidian:', 'notion:', 'things:'];

export const zStatus = z.enum(STATUSES);
export const zPriority = z.enum(PRIORITIES);
export const zId = z.string().min(1).max(64).regex(/^[a-z]+_[A-Za-z0-9]+$/, 'Invalid id');

export const zIsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'Not a real date');

/** A link the app shows as a link: http(s), mailto or one of a few app links. Never javascript:, file: or data:. */
export const zLinkUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((u) => {
    try {
      return ALLOWED_LINK_SCHEMES.includes(new URL(u).protocol);
    } catch {
      return false;
    }
  }, 'Link must be a valid http(s), mailto or app link');

export const zLink = z
  .object({
    url: zLinkUrl,
    label: z.string().trim().max(200).optional(),
  })
  .strict();

/** A Claude Code thread id. It goes into a command you can paste into Terminal, so only letters, digits and dashes. */
export const SESSION_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

const shortText = z.string().max(LIMITS.shortText);

/** Fields a caller may set on a task. Shared by create, patch and proposals. */
export const taskFieldShape = {
  title: z.string().trim().min(1, 'Title is required').max(LIMITS.title),
  notes: z.string().max(LIMITS.notes),
  areaId: zId.nullable(),
  projectId: zId.nullable(),
  status: zStatus,
  priority: zPriority,
  dueDate: zIsoDate.nullable(),
  nextAction: shortText,
  waitingOn: shortText,
  links: z.array(zLink).max(LIMITS.links),
  position: z.number().finite(),
};

export const TASK_ID_RE = /^t_[A-Za-z0-9]{14}$/;

export const zTaskCreate = z
  .object({
    ...taskFieldShape,
    // Optional id chosen by the caller, so an optimistic UI row and the saved row are the same row.
    id: z.string().regex(TASK_ID_RE, 'Invalid task id').optional(),
    title: taskFieldShape.title,
    notes: taskFieldShape.notes.optional(),
    areaId: taskFieldShape.areaId.optional(),
    projectId: taskFieldShape.projectId.optional(),
    status: taskFieldShape.status.optional(),
    priority: taskFieldShape.priority.optional(),
    dueDate: taskFieldShape.dueDate.optional(),
    nextAction: taskFieldShape.nextAction.optional(),
    waitingOn: taskFieldShape.waitingOn.optional(),
    links: taskFieldShape.links.optional(),
    position: taskFieldShape.position.optional(),
    subtasks: z.array(z.string().trim().min(1).max(LIMITS.shortText)).max(LIMITS.subtasks).optional(),
  })
  .strict();
export type TaskCreate = z.infer<typeof zTaskCreate>;

export const zTaskPatchFields = z
  .object({
    title: taskFieldShape.title,
    notes: taskFieldShape.notes,
    areaId: taskFieldShape.areaId,
    projectId: taskFieldShape.projectId,
    status: taskFieldShape.status,
    priority: taskFieldShape.priority,
    dueDate: taskFieldShape.dueDate,
    nextAction: taskFieldShape.nextAction,
    waitingOn: taskFieldShape.waitingOn,
    links: taskFieldShape.links,
    position: taskFieldShape.position,
    /** What you need to decide or do. Empty means nothing. Assistants can set it; only you can clear it. */
    needsYou: z.string().trim().max(LIMITS.shortText),
  })
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, 'Patch is empty');
export type TaskPatchFields = z.infer<typeof zTaskPatchFields>;
export type TaskField = keyof TaskPatchFields;

export const zTaskUpdate = z
  .object({
    /** The revision the caller last saw. Required so nobody overwrites changes silently. */
    baseRev: z.number().int().min(1),
    patch: zTaskPatchFields,
  })
  .strict();
export type TaskUpdate = z.infer<typeof zTaskUpdate>;

export const zNoteAppend = z.object({ text: z.string().trim().min(1).max(LIMITS.noteAppend) }).strict();

export const zSubtaskCreate = z.object({ title: z.string().trim().min(1).max(LIMITS.shortText) }).strict();
/** Optional proof when an assistant completes a task. The daily review must say why. */
export const zComplete = z
  .object({
    why: z.string().trim().max(500).optional(),
    link: zLinkUrl.optional(),
    sessionId: z.string().trim().regex(SESSION_ID_RE, 'Not a thread id').optional(),
  })
  .strict();

export const zSubtaskOrder = z
  .object({ ids: z.array(zId).min(1).max(LIMITS.subtasks).optional(), ordered: z.boolean().optional() })
  .strict()
  .refine((o) => o.ids || o.ordered !== undefined, 'Give the order, or whether it is locked');
export const zSubtaskPatch = z
  .object({ title: z.string().trim().min(1).max(LIMITS.shortText), done: z.boolean(), needsYou: z.boolean() })
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, 'Patch is empty');

export const AREA_MODES = ['work', 'personal'] as const;
export type AreaMode = (typeof AREA_MODES)[number];
export const zAreaMode = z.enum(AREA_MODES);

export const zAreaCreate = z
  .object({
    name: z.string().trim().min(1).max(80),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    mode: zAreaMode.optional(),
  })
  .strict();
export const zAreaPatch = z
  .object({
    name: z.string().trim().min(1).max(80),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    position: z.number().finite(),
    archived: z.boolean(),
    mode: zAreaMode,
  })
  .partial()
  .strict();
/** Deleting an area. An area with tasks needs somewhere for them to go: another area, or null for Unfiled. */
export const zAreaDelete = z.object({ moveTo: zId.nullable().optional() }).strict();

export const zProjectCreate = z
  .object({ areaId: zId, name: z.string().trim().min(1).max(120) })
  .strict();
export const zProjectPatch = z
  .object({
    name: z.string().trim().min(1).max(120),
    areaId: zId,
    position: z.number().finite(),
    archived: z.boolean(),
  })
  .partial()
  .strict();

export const zTaskQuery = z
  .object({
    q: z.string().trim().max(200).optional(),
    status: z.union([zStatus, z.array(zStatus)]).optional(),
    areaId: zId.optional(),
    projectId: zId.optional(),
    includeDone: z.boolean().optional(),
    limit: z.number().int().min(1).max(LIMITS.searchMax).optional(),
  })
  .strict();
export type TaskQuery = z.infer<typeof zTaskQuery>;

/** Proposals: suggested changes from assistants or automation. A human accepts or rejects them. */
export const zProposalCreate = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create'), task: zTaskCreate }).strict(),
  z.object({ kind: z.literal('update'), taskId: zId, patch: zTaskPatchFields }).strict(),
  z.object({ kind: z.literal('complete'), taskId: zId }).strict(),
  z.object({ kind: z.literal('reopen'), taskId: zId }).strict(),
  z.object({ kind: z.literal('note'), taskId: zId, text: zNoteAppend.shape.text }).strict(),
  // "Needs info": ask instead of guessing. The answer comes back to the asking connection.
  z
    .object({
      kind: z.literal('question'),
      taskId: zId.optional(),
      areaId: zId.nullable().optional(),
      question: z.string().trim().min(1).max(500),
      choices: z.array(z.string().trim().min(1).max(120)).max(4).optional(),
    })
    .strict(),
]);
export const zProposalAnswer = z.object({ answer: z.string().trim().min(1).max(1000) }).strict();
export const zProposalEnvelope = z
  .object({
    proposal: zProposalCreate,
    reason: z.string().trim().max(1000).optional(),
    /** 0..1. Informational only. Nothing is auto-applied based on confidence. */
    confidence: z.number().min(0).max(1).optional(),
    /** Stable key from the source (e.g. "gmail:thread/123"). Used to deduplicate. */
    dedupeKey: z.string().trim().min(1).max(300).optional(),
    sourceUrl: zLinkUrl.optional(),
  })
  .strict();
export type ProposalEnvelope = z.infer<typeof zProposalEnvelope>;
export type ProposalBody = z.infer<typeof zProposalCreate>;

export const zClientScopes = z
  .object({
    /** Area ids this client can see and touch. "*" means every area. */
    areas: z.union([z.literal('*'), z.array(zId).max(50)]),
    /** Whether the client can see tasks that have no area yet (raw Inbox captures). */
    unfiled: z.boolean(),
    perms: z.array(z.enum(PERMISSIONS)).min(1),
  })
  .strict();
export type ClientScopes = z.infer<typeof zClientScopes>;

export const zClientLimits = z
  .object({
    writesPerDay: z.number().int().min(0).max(10_000),
    proposalsPerDay: z.number().int().min(0).max(10_000),
  })
  .strict();
export type ClientLimits = z.infer<typeof zClientLimits>;

export const zClientCreate = z
  .object({
    name: z.string().trim().min(1).max(60),
    kind: z.enum(CLIENT_KINDS),
    scopes: zClientScopes,
    limits: zClientLimits.optional(),
    /** Also save the token in a file only you can read, so an app's settings can name the file (MASTER_TASKER_TOKEN_FILE) instead of holding the token. */
    tokenFile: z.boolean().optional(),
  })
  .strict();
export const zClientPatch = z
  .object({
    name: z.string().trim().min(1).max(60),
    scopes: zClientScopes,
    limits: zClientLimits,
    paused: z.boolean(),
  })
  .partial()
  .strict();

/** What the app and your AI assistants call you. One line. Empty means they say "you". */
export const zOwnerName = z
  .string()
  .trim()
  .max(60, 'Keep your name under 60 characters')
  .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), 'Use one line, with no special characters');

export const zSettingsPatch = z
  .object({ automationPaused: z.boolean(), macNotify: z.boolean(), threadLinking: z.boolean(), ownerName: zOwnerName })
  .partial()
  .strict();

/** The starter areas first-run setup offers: Work and Personal, the six sample areas, or none. */
export const STARTER_AREAS = ['work-personal', 'sample', 'none'] as const;
export type StarterAreas = (typeof STARTER_AREAS)[number];

/**
 * First-run setup. `areas` and `samples` go together. Leave both out, as Skip does, to keep the sample areas
 * and tasks a new install starts with.
 */
export const zSetup = z
  .object({ name: zOwnerName, areas: z.enum(STARTER_AREAS), samples: z.boolean() })
  .partial()
  .strict()
  .refine((s) => (s.areas === undefined) === (s.samples === undefined), 'Choose the starter areas and the sample tasks together');
export type SetupInput = z.infer<typeof zSetup>;

/** Accept every pending suggestion from one connection. `ids` limits it to the ones you can see. */
export const zAcceptAll = z
  .object({ clientId: zId, ids: z.array(zId).min(1).max(200).optional() })
  .strict();

// ─── Entity shapes returned by the API ───

export interface Subtask {
  id: string;
  title: string;
  done: boolean;
  position: number;
  /** Only you can do this one. Claude won't tick it off. */
  needsYou: boolean;
}

export interface Task {
  id: string;
  title: string;
  notes: string;
  areaId: string | null;
  projectId: string | null;
  status: Status;
  priority: Priority;
  dueDate: string | null;
  nextAction: string;
  waitingOn: string;
  /** What you need to decide or do. Empty means nothing. */
  needsYou: string;
  /** The why behind each thing that needs you, keyed by 'task' or a subtask id. */
  youContext: Record<string, YouContext>;
  links: { url: string; label?: string }[];
  subtasks: Subtask[];
  /** Claude planned the subtasks as a sequence that has to happen in that order, so the app doesn't offer reordering. */
  subtasksOrdered: boolean;
  /** Claude marked it done and you haven't looked yet. Cleared when you press Got it or reopen it. */
  finishedBy: FinishedBy | null;
  /** Where it was before Done, so Reopen puts it back there. */
  prevStatus: Status | null;
  /** Where it was before In progress, so Stop puts it back there. */
  startedFrom: Status | null;
  position: number;
  rev: number;
  seq: number;
  isSample: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  deletedAt: string | null;
  createdBy: string;
}

/** Who finished a task for you, and how they knew it was done. */
export interface FinishedBy {
  /** The connection's name, e.g. "Claude threads" or "Daily review". */
  by: string;
  why: string;
  link: string;
  sessionId: string;
  at: string;
}

/** Context for one "Needs you" item: what's behind it and which Claude thread raised it. */
export interface YouContext {
  detail: string;
  at: string;
  sessionId: string;
  threadTitle: string;
  /** Command that reopens the thread that raised it. Empty if it didn't come from a thread. */
  resumeCommand: string;
}

/** Your question about a "Needs you" item, answered by a read-only Claude run. */
export interface Ask {
  id: string;
  taskId: string;
  item: string;
  question: string;
  answer: string;
  status: 'running' | 'done' | 'error';
  createdAt: string;
  answeredAt: string | null;
}

export const zYouFlag = z
  .object({
    /** A subtask (id or title) to flag. Without it, the text goes on the task. */
    subtask: z.string().trim().min(1).max(LIMITS.shortText).optional(),
    text: z.string().trim().min(1).max(LIMITS.shortText).optional(),
    detail: z.string().trim().max(2000).optional(),
    sessionId: z.string().regex(SESSION_ID_RE).optional(),
  })
  .strict()
  .refine((f) => f.subtask || f.text, 'Name a subtask or give the text');
export type YouFlag = z.infer<typeof zYouFlag>;

/** One thing a scheduled routine reads, and whether you've switched it off. */
export interface SourceInfo {
  key: string;
  label: string;
  on: boolean;
}

/** A routine scheduled in the Claude app, as the Sources page shows it. */
export interface RoutineInfo {
  id: string;
  name: string;
  description: string;
  schedule: string;
  /** On in the Claude app's Scheduled list. */
  enabled: boolean;
  lastRunAt: string | null;
  /** Paused here: it stops before reading anything. */
  paused: boolean;
  /** Its instructions check your switches. Added the first time you switch something off. */
  enforced: boolean;
  sources: SourceInfo[];
  ticketIds: string[];
  tickets?: { id: string; title: string; status: Status }[];
  /** It reads every open task (the daily review). */
  allTasks: boolean;
  /** Opens its latest run in the Claude app. */
  lastRunLink?: string | null;
}

export const zRoutinePatch = z
  .object({ paused: z.boolean().optional(), source: z.string().min(1).max(80).optional(), on: z.boolean().optional() })
  .strict()
  .refine((p) => p.paused !== undefined || (p.source && p.on !== undefined), 'Say what to change');
export const zSourceRequest = z.object({ text: z.string().trim().min(3).max(2000) }).strict();

export const zAskCreate = z
  .object({ item: z.string().regex(/^(task|s_[A-Za-z0-9]+)$/), question: z.string().trim().min(1).max(1000) })
  .strict();

export interface Area {
  id: string;
  name: string;
  color: string;
  position: number;
  archived: boolean;
  isSample: boolean;
  /** Which side of the Work / Personal switch this area is on. */
  mode: AreaMode;
}

export interface Project {
  id: string;
  areaId: string;
  name: string;
  position: number;
  archived: boolean;
  isSample: boolean;
}

export type ActorKind = 'user' | 'client' | 'system';

export interface Actor {
  kind: ActorKind;
  /** client id for clients, "local-ui" for the user, a job name for system */
  id: string;
  /** Display label derived from the verified identity, never from caller input. */
  label: string;
  clientKind?: ClientKind;
  /** Optional name the caller claimed. Shown as unverified. */
  claimedName?: string | null;
}

export interface ActivityEntry {
  id: number;
  at: string;
  actor: Actor;
  entityType: 'task' | 'area' | 'project' | 'proposal' | 'client' | 'settings' | 'system';
  entityId: string;
  action: string;
  changes: Record<string, [unknown, unknown]> | null;
  rev: number | null;
  summary: string;
}

export type ProposalStatus = 'pending' | 'accepted' | 'rejected' | 'duplicate';

export interface Proposal {
  id: string;
  clientId: string;
  clientLabel: string;
  body: ProposalBody;
  reason: string;
  confidence: number | null;
  dedupeKey: string | null;
  sourceUrl: string | null;
  status: ProposalStatus;
  seenCount: number;
  createdAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  resolvedTaskId: string | null;
  areaId: string | null;
  /** Your answer, for questions. */
  answer: string | null;
}

export interface ClientInfo {
  id: string;
  name: string;
  kind: ClientKind;
  scopes: ClientScopes;
  limits: ClientLimits;
  paused: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  usageToday: { writes: number; proposals: number };
  /**
   * The file that holds its token, for app settings (MASTER_TASKER_TOKEN_FILE). In the answer that creates it, when
   * asked for, and in the list of connections while the file is there. It's only a path, so the settings can be shown again.
   */
  tokenFile?: string;
}

export interface Settings {
  automationPaused: boolean;
  /** A Mac notification when Claude finishes a ticket. */
  macNotify: boolean;
  /** Read Claude Code threads on this Mac to link them to tasks. Off until you turn it on. */
  threadLinking: boolean;
  /** First-run setup is finished or skipped. Until then the app opens on the setup screen. */
  setupDone: boolean;
  /** What the app and your AI assistants call you. Empty: they say "you". */
  ownerName: string;
  /** False when setup left out the sample tasks, so Getting started doesn't offer to clear tasks that never existed. */
  startedWithSamples: boolean;
}

// ─── Connecting Claude ───

/** What's set up for Claude on this Mac, as Settings > AI assistants shows it. */
export interface Integrations {
  /** The Claude desktop app. Its Code tab runs the /master-tasker skill too. */
  claudeApp: { found: boolean };
  /** The Claude Code command. Ask needs it. */
  claudeCode: { found: boolean };
  /**
   * The /master-tasker skill. `linked`: linked to this copy of Master Tasker. `other`: something else
   * already uses the name (a link to another folder, or a real folder). `missing`: not set up.
   */
  skill: { state: 'linked' | 'other' | 'missing'; tokenWorks: boolean; upToDate: boolean };
  /**
   * Claude Desktop chat. `connected`: its settings point at this copy. `outdated`: this copy's entry, but for an old
   * folder or address, or with the token written into Claude's settings file, so Update rewrites it.
   * `other`: a master-tasker entry points somewhere else.
   */
  desktop: { state: 'connected' | 'outdated' | 'other' | 'missing'; tokenWorks: boolean; unreadable: boolean };
  threadLinking: boolean;
  /**
   * The skill is linked to this copy, its connection works and its settings are current, so Claude can work a task:
   * in the Claude app, or in Claude Code in Terminal.
   */
  skillReady: boolean;
  /** skillReady, and the Claude app is installed, so "Work on this with Claude" can open a thread that runs it. */
  ready: boolean;
  /** Real paths, only for the copy-ready setup snippets. */
  paths: { node: string; mcpServer: string; url: string };
  checkedAt: string;
}

export interface SyncPayload {
  seq: number;
  full: boolean;
  tasks: Task[];
  areas: Area[];
  projects: Project[];
  pendingProposals: number;
  settings: Settings;
  serverTime: string;
}

export type LiveEvent =
  | { type: 'task'; seq: number; task: Task }
  | { type: 'area'; seq: number; area: Area }
  | { type: 'area-deleted'; seq: number; id: string }
  | { type: 'project'; seq: number; project: Project }
  | { type: 'proposals'; seq: number; pending: number }
  | { type: 'clients'; seq: number }
  | { type: 'settings'; seq: number; settings: Settings }
  | { type: 'activity'; seq: number }
  | { type: 'integrations'; seq: number }
  | { type: 'reset'; seq: number };

export interface ApiErrorBody {
  error: {
    code:
      | 'bad_request'
      | 'validation'
      | 'unauthorized'
      | 'forbidden'
      | 'not_found'
      | 'conflict'
      | 'idempotency_mismatch'
      | 'paused'
      | 'rate_limited'
      | 'internal';
    message: string;
    issues?: { path: string; message: string }[];
    /** On conflict: the current server copy and which fields collided. */
    current?: Task;
    fields?: string[];
    /** What's missing on this Mac for this to work, e.g. 'claude-code' for Ask. */
    needs?: string;
    /** Why setup changed nothing: it's already done, or you already have tasks or areas of your own. */
    setup?: 'done' | 'has-data';
  };
}

export function formatZodIssues(err: z.ZodError): { path: string; message: string }[] {
  return err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

// ─── Claude threads ───

/** A Claude Code thread on this Mac that mentions a task. Found by reading thread files locally. */
export interface ClaudeThread {
  sessionId: string;
  title: string;
  cwd: string;
  startedAt: string | null;
  lastActiveAt: string | null;
  firstSeenAt: string;
  mentions: number;
  /** Other tasks the same thread mentions. */
  otherTasks: { id: string; title: string; status: Status }[];
  resumeCommand: string;
}

/** What Claude is doing on an In progress task, read from its most recently active linked thread. */
export interface TaskProgress {
  taskId: string;
  /** The open subtask Claude last said it was on ("Now on: ..."), if it named one. */
  subtaskId: string | null;
  note: string;
  noteKind: 'decision' | 'reply';
  noteAt: string | null;
  /** When the thread last wrote anything, tool calls included. A running thread writes every few seconds. */
  activeAt: string | null;
  sessionId: string;
  threadTitle: string;
}
