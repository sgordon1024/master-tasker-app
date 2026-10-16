// Starting Claude on a task: a new thread in the Claude desktop app, or, with only Claude Code, a prompt to paste
// into it in Terminal. Only once the /master-tasker skill is set up. Until then the task shows no Claude buttons,
// and Claude's own links open Settings > AI assistants with Claude picked.
import { SESSION_ID_RE, type Integrations, type Task } from '../../shared/schema.ts';
import { api } from './api.ts';
import { ASSISTANT_PICK } from './assistants.ts';
import { copyText } from './lib.ts';
import { setPref } from './prefs.ts';
import { claudeReference } from './progress.ts';
import { store } from './store.ts';

/** Settings > AI assistants with Claude picked. The old link to Claude's own section, kept so it still works. */
export const CLAUDE_SETUP_HASH = '#/settings?section=claude';

const snapshot = () => store.getSnapshot().integrations;

/** The /master-tasker skill is set up and working, so Claude can work a task: in the Claude app, or in Terminal. */
export const claudeReady = (i: Integrations | null = snapshot()) => i?.skillReady === true;

/** Ready, and the Claude app is installed, so Work on this with Claude opens a new thread there. */
export const claudeAppReady = (i: Integrations | null = snapshot()) => claudeReady(i) && i?.claudeApp.found === true;

/** Ready, but there's no Claude app: the Claude buttons copy a prompt to paste into Claude Code in Terminal. */
export const claudeInTerminal = (i: Integrations | null = snapshot()) => claudeReady(i) && !claudeAppReady(i);

/** The main Claude button on a task, which workWithClaude carries out. */
export const workWithClaudeLabel = (i: Integrations | null = snapshot()) => (claudeInTerminal(i) ? 'Copy prompt for Claude Code' : 'Work on this with Claude');

/** Where a prompt copied for Terminal goes, for someone who may never have used Terminal. */
export const TERMINAL_HOW = 'Open Terminal, type claude and press Return, then paste it and press Return.';

/** Hands a claude:// link to the Mac. Tests swap this out so the page stays put. */
export const openUrl = (url: string) => {
  // A new-thread link needs the Claude app. Without it the link goes nowhere, so copy its message for Terminal instead.
  if (url.startsWith('claude://code/new') && claudeInTerminal()) {
    void copyForTerminal(new URL(url).searchParams.get('q') ?? '');
    return;
  }
  const stub = (window as unknown as { __mtOpen?: (u: string) => void }).__mtOpen;
  if (stub) stub(url);
  else window.location.href = url;
};

type ThreadLink = { url: string; prompt?: string };
const promptOf = (l: ThreadLink) => l.prompt ?? new URL(l.url).searchParams.get('q') ?? '';

/**
 * Copies text that is still on its way from the server. Safari only lets a page copy right after a click, so the copy
 * starts now and fills in when the text arrives.
 */
async function copyWhenReady(text: Promise<string>): Promise<boolean> {
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': text.then((t) => new Blob([t], { type: 'text/plain' })) })]);
      return true;
    } catch {
      // Fall back to a plain copy below. If the text itself failed, that throws the same error.
    }
  }
  const t = await text;
  return !!t && copyText(t);
}

async function copyForTerminal(prompt: string | Promise<string>, lead = '') {
  if (!(await copyWhenReady(Promise.resolve(prompt)))) return store.toast('Could not copy. Your browser blocked the clipboard.', 'error');
  store.toast(`${lead}Copied a prompt for Claude Code. ${TERMINAL_HOW}`, 'success');
}

/**
 * Starts a new Claude thread from a claude://code/new link: opens it in the Claude app, or with only Claude Code,
 * copies its message to paste in Terminal. `lead` goes first in the message it shows, e.g. "Saved as a task. ".
 * Pass the request itself, not its answer, so the copy can start while the click still counts.
 * The app can't tell whether Claude opened, so this never claims it did.
 */
export async function startThread(link: ThreadLink | Promise<ThreadLink>, lead = '') {
  if (claudeInTerminal()) return copyForTerminal(Promise.resolve(link).then(promptOf), lead);
  openUrl((await link).url);
  store.toast(`${lead}Opening Claude… Your browser may ask to open Claude. Then press Enter there.`, 'info');
}

/** Opens Settings at AI assistants with Claude picked, from anywhere. */
export function openClaudeSetup() {
  setPref(ASSISTANT_PICK, 'claude-code');
  if (location.hash !== CLAUDE_SETUP_HASH) location.hash = CLAUDE_SETUP_HASH;
  // Already there: scroll back to it.
  requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('mt:section', { detail: 'claude' })));
}

/**
 * Work on this with Claude: opens a new Claude Code thread in the desktop app with /master-tasker filled in,
 * on the task or one subtask. `pickUp` says the last thread stopped, so the new one carries on from there.
 * Without the Claude app (Claude Code only), it copies the same message to paste into Claude Code in Terminal.
 */
export async function workWithClaude(taskId: string, opts: { subtaskId?: string; pickUp?: boolean } = {}) {
  if (!claudeReady()) return openClaudeSetup();
  try {
    const q = new URLSearchParams();
    if (opts.subtaskId) q.set('subtask', opts.subtaskId);
    else if (opts.pickUp) q.set('continue', '1');
    const qs = q.toString();
    await startThread(api<ThreadLink>('GET', `/api/tasks/${taskId}/claude-link${qs ? `?${qs}` : ''}`));
  } catch (e) {
    store.toast((e as Error).message, 'error');
  }
}

/** Where a copied prompt works. A normal Claude chat doesn't know /master-tasker. */
export const PASTE_WHERE = 'Paste it into Claude Code, or the Code tab in the Claude app, where /master-tasker works.';

/** Copy prompt: the /master-tasker command for this task, to paste yourself. */
export async function copyPrompt(task: Task) {
  if (!(await copyText(claudeReference(task)))) return store.toast('Could not copy. Your browser blocked the clipboard.', 'error');
  const linked = store.getSnapshot().integrations?.skill.state === 'linked';
  store.toast(linked ? `Copied. ${PASTE_WHERE}` : `Copied. ${PASTE_WHERE} Set up Claude Code first so it knows the command.`, 'success', linked ? undefined : { label: 'Set up', run: openClaudeSetup });
}

/** The Terminal command for a thread an assistant named, or '' when the id isn't a plain thread id. */
export const resumeFor = (sessionId: string) => (SESSION_ID_RE.test(sessionId) ? `claude --resume ${sessionId}` : '');

/** Opens a thread in the Claude app. If the app doesn't know it, copies the terminal command instead. */
export async function openThread(sessionId: string, resumeCommand: string) {
  try {
    const { url } = await api<{ url: string | null }>('GET', `/api/claude/open?session=${encodeURIComponent(sessionId)}`);
    if (url) {
      openUrl(url);
      return;
    }
  } catch {}
  const ok = await copyText(resumeCommand);
  store.toast(ok ? "That thread isn't in the Claude app. Copied a command to reopen it in Terminal." : 'Could not copy.', ok ? 'success' : 'error');
}
