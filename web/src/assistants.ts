// Which AI assistants are connected, for the screens that change with it: the sidebar line, Getting started and
// a task's ⋯ menu. Any app counts. Claude's own connections (Claude threads, Claude Desktop, Claude Code in
// Terminal) all count as Claude.
import type { ClientInfo, Task } from '../../shared/schema.ts';
import { copyText } from './lib.ts';
import { setPref, usePref } from './prefs.ts';
import { AGENT_IDS, type AssistantAppId } from './snippets.ts';
import { store, useClients } from './store.ts';

/** Settings > AI assistants. Other screens link here. */
export const ASSISTANTS_HASH = '#/settings?section=assistants';

/** The app picked under "Which app do you use?" in Settings, saved in this browser. */
export const ASSISTANT_PICK = 'mt.assistant';

/** Connections that aren't an assistant someone connected: the daily review routine works on its own schedule. */
const INTERNAL = new Set(['Daily review']);
export const isInternal = (c: Pick<ClientInfo, 'name'>) => INTERNAL.has(c.name);

/** Every Claude connection is Claude, whatever it's called. Other apps go by their connection's name. */
export const assistantName = (c: Pick<ClientInfo, 'name' | 'kind'>) => (c.kind === 'claude' ? 'Claude' : c.name);

/** Can work right now: not removed, not paused, and not one of the app's own routines. */
export const isLive = (c: ClientInfo) => !c.revokedAt && !c.paused && !isInternal(c);

/**
 * Has really used its access, so it's connected and not just given a key. Claude's connections count once made,
 * because Master Tasker sets them up and checks them itself. Any other app counts once it has started Master
 * Tasker's tools (they check in when they start), or done anything with them.
 */
export const hasCheckedIn = (c: Pick<ClientInfo, 'kind' | 'lastUsedAt'>) => c.kind === 'claude' || !!c.lastUsedAt;

/** The assistants connected right now, one name each, in the order they were connected. */
export function connectedAssistants(clients: ClientInfo[] | null): string[] {
  return [...new Set((clients ?? []).filter((c) => isLive(c) && hasCheckedIn(c)).map(assistantName))];
}

/** Given access, but the app hasn't used it yet: its settings may not be pasted, or it needs a restart. */
export function waitingAssistants(clients: ClientInfo[] | null): string[] {
  const connected = new Set(connectedAssistants(clients));
  return [...new Set((clients ?? []).filter((c) => isLive(c) && !hasCheckedIn(c)).map(assistantName))].filter((n) => !connected.has(n));
}

/** Any assistant is connected. */
export const assistantReady = (clients: ClientInfo[] | null) => connectedAssistants(clients).length > 0;

/** The sidebar line under "Saved on this Mac". `claudeWorking` is how many tasks a Claude thread is on right now. */
export function assistantStatusLine(names: string[], claudeWorking = 0, waiting: string[] = []): string {
  if (claudeWorking > 0) return `Claude: working on ${claudeWorking}`;
  if (names.length === 0 && waiting.length === 1) return `Waiting for ${waiting[0]}`;
  if (names.length === 0 && waiting.length > 1) return `Waiting for ${waiting.length} assistants`;
  if (names.length === 0) return 'No assistant connected';
  if (names.length === 1) return `${names[0]} connected`;
  return `${names.length} assistants connected`;
}

/** The connected assistants' names, for any screen that changes with them. Null until the first check comes back. */
export function useConnectedAssistants(): string[] | null {
  const clients = useClients();
  return clients === null ? null : connectedAssistants(clients);
}

/** The apps given access that haven't used it yet. */
export function useWaitingAssistants(): string[] {
  return waitingAssistants(useClients());
}

/** The settings tab a connection's name points to: its app's own, the generic one, or none. */
export function agentForName(name: string): AssistantAppId | undefined {
  const n = name.toLowerCase();
  if (/claude/.test(n)) return 'claude-code';
  if (/cursor/.test(n)) return 'cursor';
  if (/vs ?code|visual studio|copilot/.test(n)) return 'vscode';
  if (/codex|chatgpt/.test(n)) return 'codex';
  if (/gemini/.test(n)) return 'gemini';
  if (/windsurf|devin/.test(n)) return 'windsurf';
  if (/terminal/.test(n)) return 'claude-code';
  if (/zed|cline|goose|other/.test(n)) return 'other';
  return undefined;
}

/** Which app in the picker a connection belongs to. Every Claude connection is under Claude. */
export const appForClient = (c: Pick<ClientInfo, 'name' | 'kind'>): AssistantAppId | undefined => (c.kind === 'claude' ? 'claude-code' : agentForName(c.name));

/** The app picked in Settings. Until you pick one, the app of the first assistant you connected, if any. */
export function useAssistantPick(): AssistantAppId | null {
  const saved = usePref(ASSISTANT_PICK);
  const clients = useClients();
  if (saved && (AGENT_IDS as string[]).includes(saved)) return saved as AssistantAppId;
  for (const c of clients ?? []) {
    const app = isLive(c) ? appForClient(c) : undefined;
    if (app) return app;
  }
  return null;
}
export const setAssistantPick = (app: AssistantAppId) => setPref(ASSISTANT_PICK, app);

/** Opens Settings at AI assistants, from anywhere. */
export function openAssistants() {
  if (location.hash !== ASSISTANTS_HASH) location.hash = ASSISTANTS_HASH;
  // Already there: scroll back to it.
  requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('mt:section', { detail: 'assistants' })));
}

/** The prompt any assistant can start a task from. Its task id is how the assistant finds the task. */
export const assistantPrompt = (task: Pick<Task, 'id' | 'title'>) =>
  `Use the Master Tasker tools to work on task ${task.id} ("${task.title}"): read it, plan it into steps, start it, tick steps off as you finish them, and flag anything only I can decide or do as Needs you.`;

/** Copy prompt for your assistant, in a task's ⋯ menu when an assistant other than Claude is connected. */
export async function copyAssistantPrompt(task: Task) {
  if (!(await copyText(assistantPrompt(task)))) return store.toast('Could not copy. Your browser blocked the clipboard.', 'error');
  store.toast("Copied. Paste it into your assistant's chat.", 'success');
}
