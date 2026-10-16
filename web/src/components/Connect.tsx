// Settings > AI assistants: pick the app you use, then connect it. Claude has its own panel, with the extras only
// Claude has. Every other app makes a connection and shows its settings to paste. Below the picker, Assistants with
// access lists every connection (Access.tsx).
import { Check, RefreshCw, Sparkles } from 'lucide-react';
import { createContext, useCallback, useContext, useId, useState, type ReactNode } from 'react';
import type { ClientInfo, Integrations, Permission } from '../../../shared/schema.ts';
import { api, newKey } from '../api.ts';
import { agentForName, appForClient, assistantPrompt, hasCheckedIn, isInternal, isLive, setAssistantPick, useAssistantPick } from '../assistants.ts';
import { claudeInTerminal, claudeReady, workWithClaudeLabel } from '../claude.ts';
import { cx, relativeTime } from '../lib.ts';
import { AGENT_IDS, AGENT_LABEL, type AssistantAppId } from '../snippets.ts';
import { store, useClients, useIntegrations, useStore } from '../store.ts';
import { AccessList, TokenReveal } from './Access.tsx';
import { onRadioKeys, radioTab } from './Bits.tsx';
import '../styles/connect.css';

// Claude's own pages, not redirects (claude.ai/download moved to claude.com, the Claude Code docs to code.claude.com).
const GET_APP = 'https://claude.com/download';
const GET_CODE = 'https://code.claude.com/docs/en/setup';

/** The picker's name for each app. Claude Code stands for all of Claude there. */
const pickLabel = (a: AssistantAppId) => (a === 'claude-code' ? 'Claude' : AGENT_LABEL[a]);

/** The name a new connection gets, which is also how it shows in Activity and on what it finishes. */
const CONNECTION_NAME: Record<AssistantAppId, string> = {
  'claude-code': 'Claude Code in Terminal',
  codex: 'Codex',
  vscode: 'GitHub Copilot',
  cursor: 'Cursor',
  gemini: 'Gemini CLI',
  windsurf: 'Windsurf',
  other: 'Other assistant',
};

/** How the app is named in a sentence. */
const APP_WORDS: Record<AssistantAppId, string> = { ...CONNECTION_NAME, other: 'your app' };

/** One line about the app, before you connect it. */
const APP_NOTE: Partial<Record<AssistantAppId, string>> = {
  codex: 'The ChatGPT desktop app, Codex CLI and the Codex extension in your editor share one setup.',
  vscode: 'GitHub Copilot uses the tools set up in VS Code.',
  windsurf: 'Windsurf is now called Devin Desktop.',
  other: 'For any other app that can run tools on your Mac.',
};

/** A shorter way to start, in apps that offer Master Tasker's own prompt. */
const START_SHORTCUT: Partial<Record<AssistantAppId, string>> = {
  vscode: 'In the chat, /master-tasker.work_task and the task id works too.',
  gemini: 'In Gemini CLI, /work_task and the task id works too.',
  other: "If the app lists Master Tasker's prompts, you can pick work_task and give it the task id instead.",
};

/** What a connection from the picker can do. "Let it work on tasks" adds what working a task needs. */
export const OTHER_APP_PERMS: Record<'suggest' | 'work', Permission[]> = { suggest: ['read', 'propose'], work: ['read', 'propose', 'update', 'complete', 'start'] };

/** False while a form or new settings are open under Assistants with access, which then has the page's filled button. */
const PrimaryOk = createContext(true);

/** Whether an app in the picker is connected, has access it hasn't used yet, is only paused, or has none. */
function pickState(app: AssistantAppId, clients: ClientInfo[]): 'live' | 'waiting' | 'paused' | null {
  const mine = clients.filter((c) => !c.revokedAt && !isInternal(c) && appForClient(c) === app);
  const live = mine.filter(isLive);
  return live.some(hasCheckedIn) ? 'live' : live.length ? 'waiting' : mine.length ? 'paused' : null;
}

/** Settings > AI assistants. */
export function AssistantsSection() {
  const clients = useClients() ?? [];
  const pick = useAssistantPick();
  const [busyBelow, setBusyBelow] = useState(false);
  const onBusy = useCallback((b: boolean) => setBusyBelow(b), []);
  return (
    <section className="settings-section assistants" aria-labelledby="s-assistants" id="assistants">
      <h2 id="s-assistants" className="section-title" tabIndex={-1}>
        AI assistants
      </h2>
      <p className="section-intro">Let an AI assistant read your tasks and work on them. Pick the app you use. Each one gets its own access, and you can change or remove it any time.</p>
      <div className="assistant-pick">
        <p className="pref-label" id="assistant-pick-label">
          Which app do you use?
        </p>
        <div className="assistant-tiles" role="radiogroup" aria-labelledby="assistant-pick-label" onKeyDown={(e) => onRadioKeys(e, AGENT_IDS, pick, (a) => a && setAssistantPick(a))}>
          {AGENT_IDS.map((a, n) => {
            const state = pickState(a, clients);
            return (
              <button key={a} type="button" role="radio" aria-checked={pick === a} tabIndex={radioTab(pick === a, n === 0, pick !== null)} className={cx('assistant-tile', pick === a && 'is-on')} onClick={() => setAssistantPick(a)}>
                <span className="assistant-tile-name">{pickLabel(a)}</span>
                {state && (
                  <span className={cx('assistant-tile-state', state !== 'live' && 'is-paused')}>
                    {state === 'live' && <Check size={12} strokeWidth={2.5} aria-hidden />}
                    {{ live: 'Connected', waiting: 'Not used yet', paused: 'Paused' }[state]}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
      <PrimaryOk.Provider value={!busyBelow}>{pick === 'claude-code' ? <ClaudePanel /> : pick ? <AppPanel key={pick} app={pick} clients={clients} /> : null}</PrimaryOk.Provider>
      <p className="meta-line assistants-web">Assistants on the web, such as chatgpt.com and claude.ai, and phone apps can't connect. They run on the internet and can't reach apps on your Mac.</p>
      <AccessList onBusy={onBusy} />
    </section>
  );
}

/** Any app but Claude: make a connection, then paste its settings into the app. */
function AppPanel({ app, clients }: { app: AssistantAppId; clients: ClientInfo[] }) {
  const has = app === 'other' ? undefined : clients.find((c) => !c.revokedAt && c.kind !== 'claude' && agentForName(c.name) === app);
  return (
    <div className="assistant-panel" role="group" aria-label={pickLabel(app)}>
      <ConnectApp app={app} has={has} intro={`${APP_NOTE[app] ? `${APP_NOTE[app]} ` : ''}Connecting gives it its own access to your tasks, then shows what to paste into ${APP_WORDS[app]}.`} />
    </div>
  );
}

/**
 * Let it work on tasks, then Connect: makes the connection, shows its settings ready to paste, then how to start work
 * in that app. With `has`, the app is connected already, so it says so instead. `quiet` keeps every button unfilled.
 */
function ConnectApp({ app, has, intro, quiet = false }: { app: AssistantAppId; has?: ClientInfo; intro: string; quiet?: boolean }) {
  const primaryOk = useContext(PrimaryOk) && !quiet;
  const [work, setWork] = useState(false);
  const [made, setMade] = useState<{ client: ClientInfo; token: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const workId = useId();
  const make = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ client: ClientInfo; token: string }>(
        'POST',
        '/api/clients',
        { name: CONNECTION_NAME[app], kind: app === 'claude-code' ? 'claude' : 'other', scopes: { areas: '*', unfiled: true, perms: OTHER_APP_PERMS[work ? 'work' : 'suggest'] }, tokenFile: true },
        { idempotencyKey: newKey() },
      );
      setMade(r);
      void store.refreshClients();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (made) {
    return (
      <>
        <TokenReveal token={made.token} client={made.client} agent={app} primary={primaryOk} onDone={() => setMade(null)} />
        <StartWork app={app} />
      </>
    );
  }
  if (has) {
    return (
      <>
        <p className="claude-result" role="status">
          <Check size={14} aria-hidden />
          <span>
            {has.name} is {has.paused ? 'connected, and paused' : 'connected'}. To paste its settings again, press Show settings on its row under Assistants with access.
          </span>
        </p>
        <StartWork app={app} />
      </>
    );
  }
  return (
    <>
      <p className="section-intro">{intro}</p>
      <div className="connect-work">
        <label className="check-label">
          <input type="checkbox" className="checkbox" checked={work} aria-describedby={workId} onChange={(e) => setWork(e.target.checked)} /> Let it work on tasks (plan, start, tick off steps)
        </label>
        <p className="meta-line" id={workId}>
          {work
            ? "It can fill out and plan a task, move it into In progress, tick off its steps, and finish the task once every step is done. It still can't clear Needs you or tick off a step that needs you."
            : 'Off: it can read your tasks and suggest changes, which wait in For you until you accept them. Turn this on for it to work a task from start to finish.'}
        </p>
      </div>
      <button type="button" className={cx('btn btn-sm', primaryOk ? 'btn-primary' : 'btn-secondary')} disabled={busy} onClick={() => void make()}>
        Connect {APP_WORDS[app]}
      </button>
      {error && (
        <p className="field-warning" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

/** How to start work on a task in the app: the prompt from a task's ⋯ menu, and any shorter way it has. */
function StartWork({ app }: { app: AssistantAppId }) {
  const claude = claudeReady(useIntegrations());
  if (app === 'claude-code') {
    return <p className="meta-line">Then, in any Claude Code thread, /mcp__master-tasker__work_task and a task id starts work on that task.</p>;
  }
  const words = APP_WORDS[app];
  return (
    <div className="assistant-start">
      <h3 className="claude-step-title">Start work on a task</h3>
      <p className="meta-line">
        {claude
          ? `Paste a prompt like this into ${words}'s chat, with your task's id and title in it. A task's id is in the address bar while it's open, after task=.`
          : `Open a task and choose Copy prompt for your assistant in its ⋯ menu. Paste it into ${words}'s chat. It reads like this:`}
      </p>
      <p className="assistant-prompt">{assistantPrompt({ id: 't_abc123', title: 'Write the case study intro' })}</p>
      {START_SHORTCUT[app] && <p className="meta-line">{START_SHORTCUT[app]}</p>}
    </div>
  );
}

// ─── Claude ───

type Tone = 'ok' | 'warn' | 'off';
const TONE_CLASS: Record<Tone, string> = { ok: 'chip-ok', warn: 'chip-warning', off: 'chip-muted' };

function StatusRow({ name, help, state, tone }: { name: string; help: string; state: string; tone: Tone }) {
  return (
    <li className="claude-status-row">
      <span className="claude-status-name">
        {name}
        <span className="meta-line">{help}</span>
      </span>
      <span className={cx('chip', TONE_CLASS[tone])}>{state}</span>
    </li>
  );
}

function skillStatus(i: Integrations): [string, Tone] {
  if (i.skill.state === 'other') return ['Another copy', 'warn'];
  if (i.skill.state === 'missing') return ['Not connected', 'off'];
  return i.skillReady ? ['Connected', 'ok'] : ['Needs setting up again', 'warn'];
}

function desktopStatus(i: Integrations): [string, Tone] {
  if (i.desktop.unreadable) return ["Can't read its settings", 'warn'];
  if (i.desktop.state === 'other') return ['Another copy', 'warn'];
  if (i.desktop.state === 'missing') return ['Not added', 'off'];
  if (i.desktop.state === 'outdated') return ['Needs update', 'warn'];
  return i.desktop.tokenWorks ? ['Added', 'ok'] : ['Add again', 'warn'];
}

/** This copy's entry in Claude Desktop's settings, there and readable, so it can be updated or removed. */
const desktopAdded = (i: Integrations) => (i.desktop.state === 'connected' || i.desktop.state === 'outdated') && !i.desktop.unreadable;

/** What's on this Mac and what's connected, in one plain sentence. Only when some Claude was found. */
export function claudeSummary(i: Integrations): string {
  const found = i.claudeApp.found && i.claudeCode.found ? 'Claude app and Claude Code found.' : i.claudeApp.found ? 'Claude app found.' : 'Claude Code found.';
  const chats = i.desktop.state === 'connected' && i.desktop.tokenWorks;
  const state =
    i.skill.state === 'other'
      ? "Another copy of Master Tasker has the /master-tasker command, so this one isn't connected."
      : i.skillReady
        ? `Master Tasker is connected${chats ? ', in Claude chats too' : ''}.${claudeInTerminal(i) ? ' Claude works on your tasks in Terminal.' : ''}`
        : i.skill.state === 'linked'
          ? "Master Tasker's connection stopped working. Set up again fixes it."
          : chats
            ? 'Claude chats can read your tasks. Set up Claude Code so Claude can work on them too.'
            : "Master Tasker isn't connected yet.";
  return `${found} ${state}`;
}

type What = 'claude-code' | 'claude-desktop';
type Result = { what: What; message: string; backup?: string | null; error?: boolean };

/** One button, and when it can't be pressed, the reason right under it. */
function ActionButton({ label, primary, busy, why, onClick }: { label: string; primary?: boolean; busy?: boolean; why?: string; onClick: () => void }) {
  const id = useId();
  const filled = useContext(PrimaryOk) && primary;
  return (
    <span className="claude-action">
      <button type="button" className={cx('btn btn-sm', filled ? 'btn-primary' : 'btn-secondary')} disabled={!!why || busy} aria-describedby={why ? id : undefined} onClick={onClick}>
        {label}
      </button>
      {why && (
        <span id={id} className="meta-line">
          {why}
        </span>
      )}
    </span>
  );
}

function ResultLine({ r }: { r: Result | null }) {
  if (!r) return null;
  return (
    <p className={r.error ? 'field-warning' : 'claude-result'} role={r.error ? 'alert' : 'status'}>
      {!r.error && <Check size={14} aria-hidden />}
      <span>
        {r.message}
        {r.backup && <span className="meta-line"> Claude's old settings were saved next to it as {r.backup}.</span>}
      </span>
    </p>
  );
}

const ExternalLink = ({ href, children, className = 'link-btn' }: { href: string; children: ReactNode; className?: string }) => (
  <a className={className} href={href} target="_blank" rel="noreferrer noopener">
    {children}
  </a>
);

/**
 * Claude, in the picker. With no Claude on this Mac, one card says how to get it. Otherwise one sentence says what's
 * there, with the details behind a disclosure, then one step per thing it changes. Every button says first what it
 * changes on this Mac, and each one can be undone.
 */
function ClaudePanel() {
  const i = useIntegrations();
  const { settings } = useStore();
  const primaryOk = useContext(PrimaryOk);
  const [busy, setBusy] = useState<What | 'check' | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const run = async (what: What, on: boolean) => {
    setBusy(what);
    try {
      const r = await store.connectClaude(what, on);
      setResult({ what, message: r.message, backup: r.backup });
    } catch (e) {
      setResult({ what, message: (e as Error).message, error: true });
      void store.refreshIntegrations(true);
    } finally {
      setBusy(null);
    }
  };
  const check = async () => {
    setBusy('check');
    await store.refreshIntegrations(true);
    setBusy(null);
  };
  const resultFor = (what: What) => (result?.what === what ? result : null);
  const checkAgain = (className: string) => (
    <button type="button" className={cx('btn btn-sm', className)} disabled={busy === 'check'} onClick={() => void check()}>
      <RefreshCw size={14} aria-hidden className={cx(busy === 'check' && 'spin')} /> Check again
    </button>
  );

  const anyClaude = !!i && (i.claudeApp.found || i.claudeCode.found);
  // Set up before, and still there, so it can be removed even after Claude itself is gone.
  const leftover = !!i && (i.skill.state === 'linked' || desktopAdded(i));

  return (
    <div className="assistant-panel connect-claude" role="group" aria-label="Claude" id="connect-claude">
      <p className="section-intro">Claude has a few extras, such as Work on this with Claude. Each step below says what it changes on this Mac, and you can undo it.</p>
      {i === null ? (
        <p className="meta-line">Checking this Mac…</p>
      ) : (
        <>
          {!anyClaude ? (
            <div className="card connect-none" role="group" aria-labelledby="connect-none-title">
              <h3 id="connect-none-title" className="connect-none-title">
                Claude isn't on this Mac
              </h3>
              <p className="connect-none-body">Claude needs a paid plan. Get the Claude app and sign in, then come back here and press Check again.</p>
              <div className="button-row">
                <ExternalLink href={GET_APP} className={cx('btn btn-sm', primaryOk ? 'btn-primary' : 'btn-secondary')}>
                  Get the Claude app
                </ExternalLink>
                {checkAgain('btn-secondary')}
              </div>
              <p className="meta-line" aria-live="polite">
                Checked {relativeTime(i.checkedAt)}. Use Claude Code in Terminal instead? <ExternalLink href={GET_CODE}>Install Claude Code</ExternalLink>, then press Check again.
              </p>
            </div>
          ) : (
            <div className="card claude-status">
              <div className="connect-summary">
                {i.skillReady && <Check size={16} aria-hidden className="connect-summary-ok" />}
                <p className="connect-sentence" aria-live="polite">
                  {claudeSummary(i)}
                </p>
                {checkAgain('btn-ghost')}
              </div>
              <details className="detail-more connect-details">
                <summary>Details</summary>
                <ul className="claude-status-list" aria-label="What's set up">
                  <StatusRow name="Claude app" help="Work on this with Claude opens it." state={i.claudeApp.found ? 'Found' : 'Not found'} tone={i.claudeApp.found ? 'ok' : 'off'} />
                  <StatusRow name="Claude Code in Terminal (optional, for Ask)" help="Answers your questions on Needs you items." state={i.claudeCode.found ? 'Found' : 'Not found'} tone={i.claudeCode.found ? 'ok' : 'off'} />
                  <StatusRow name="/master-tasker in Claude Code" help="Lets a Claude thread read and update your tasks." state={skillStatus(i)[0]} tone={skillStatus(i)[1]} />
                  <StatusRow name="Claude Desktop chat" help="Lets any Claude chat read your tasks and suggest changes." state={desktopStatus(i)[0]} tone={desktopStatus(i)[1]} />
                </ul>
                <p className="meta-line">Checked {relativeTime(i.checkedAt)}</p>
              </details>
            </div>
          )}
          {i.skillReady && (
            <p className="claude-try">
              <Sparkles size={14} aria-hidden />
              <span>
                {claudeInTerminal(i)
                  ? `Try it: open any task and press ${workWithClaudeLabel(i)}, then paste it into Claude Code in Terminal.`
                  : `Try it: open any task and press ${workWithClaudeLabel(i)}.`}
              </span>
            </p>
          )}

          {(anyClaude || leftover) && <ClaudeCodeStep i={i} busy={busy === 'claude-code'} result={resultFor('claude-code')} run={(on) => void run('claude-code', on)} />}
          {(i.claudeApp.found || desktopAdded(i) || i.desktop.unreadable) && (
            <DesktopStep i={i} busy={busy === 'claude-desktop'} result={resultFor('claude-desktop')} run={(on) => void run('claude-desktop', on)} />
          )}

          {(anyClaude || settings.threadLinking) && (
            <div className="claude-step">
              <div className="pref-row">
                <span className="pref-label" id="thread-linking-label">
                  Link Claude threads to tasks
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={settings.threadLinking}
                  aria-labelledby="thread-linking-label"
                  aria-describedby="thread-linking-help"
                  className="switch"
                  onClick={() => store.setThreadLinking(!settings.threadLinking).catch((e) => store.toast(e.message, 'error'))}
                >
                  <span className="switch-thumb" />
                </button>
              </div>
              <p className="meta-line" id="thread-linking-help">
                Reads the Claude Code thread history on this Mac to find threads that mention a task, and lists them on that task with Claude's progress. It only reads, and nothing leaves this Mac. Off means Master Tasker doesn't look at it. Set up Claude Code turns this on, and Remove turns it off again, unless you changed it here.
              </p>
            </div>
          )}

          {anyClaude && !i.claudeApp.found && (
            <p className="meta-line">
              Want the Claude app too? Work on this with Claude opens tasks there, and Claude chats can read them. <ExternalLink href={GET_APP}>Get the Claude app</ExternalLink>, then press Check again.
            </p>
          )}
          {i.claudeApp.found && !i.claudeCode.found && (
            <p className="meta-line">
              Ask, on Needs you items, also needs Claude Code in Terminal. It's optional. <ExternalLink href={GET_CODE}>Install Claude Code</ExternalLink>, then press Check again.
            </p>
          )}

          {i.claudeCode.found && <TerminalStep />}
        </>
      )}
    </div>
  );
}

function Step({ title, intro, children }: { title: string; intro: ReactNode; children: ReactNode }) {
  return (
    <div className="claude-step">
      <h3 className="claude-step-title">{title}</h3>
      <p className="section-intro">{intro}</p>
      {children}
    </div>
  );
}

function ClaudeCodeStep({ i, busy, result, run }: { i: Integrations; busy: boolean; result: Result | null; run: (on: boolean) => void }) {
  const working = i.skillReady;
  // Set up needs somewhere to run the command. Remove never does.
  const needClaude = !i.claudeApp.found && !i.claudeCode.found ? 'Get the Claude app or Claude Code first, then press Check again.' : undefined;
  return (
    <Step
      title="Work on tasks with Claude Code"
      intro={
        i.claudeApp.found
          ? 'Adds the /master-tasker command to Claude Code, with its own connection to your tasks. Then Work on this with Claude, on any task, opens a thread in the Code tab of the Claude app that plans and works it. It also turns on linking Claude threads to tasks.'
          : 'Adds the /master-tasker command to Claude Code, with its own connection to your tasks. Then Copy prompt for Claude Code, on any task, copies a prompt to paste into Claude Code in Terminal. Claude plans and works the task from there. It also turns on linking Claude threads to tasks.'
      }
    >
      <div className="button-row">
        {i.skill.state === 'other' ? (
          <ActionButton label="Set up Claude Code" why="Claude Code already has a /master-tasker command from another folder. Master Tasker leaves it alone. Remove that one in Claude Code first to use this copy." onClick={() => {}} />
        ) : working ? (
          <ActionButton label="Remove from Claude Code" busy={busy} onClick={() => run(false)} />
        ) : (
          <>
            <ActionButton label={i.skill.state === 'linked' ? 'Set up again' : 'Set up Claude Code'} primary busy={busy} why={needClaude} onClick={() => run(true)} />
            {i.skill.state === 'linked' && <ActionButton label="Remove" busy={busy} onClick={() => run(false)} />}
          </>
        )}
      </div>
      {!working && i.skill.state === 'linked' && !result && <p className="meta-line">Its connection stopped working or moved. Set up again fixes it.</p>}
      <ResultLine r={result} />
    </Step>
  );
}

function DesktopStep({ i, busy, result, run }: { i: Integrations; busy: boolean; result: Result | null; run: (on: boolean) => void }) {
  const why = !i.claudeApp.found
    ? 'Get the Claude app first, then press Check again.'
    : i.desktop.unreadable
      ? "Claude's settings file has a mistake in it, so Master Tasker won't touch it. Fix it in Claude: Settings, Developer, Edit Config."
      : i.desktop.state === 'other'
        ? 'Claude already has a Master Tasker entry for another copy. Master Tasker leaves it alone.'
        : undefined;
  const added = desktopAdded(i);
  const outdated = i.desktop.state === 'outdated';
  // One filled button in the panel: this one only once Claude Code is done, or when it's all there is to do.
  const primary = i.skillReady || i.skill.state === 'other' || (!i.claudeApp.found && !i.claudeCode.found);
  return (
    <Step
      title="Use your tasks in Claude chats"
      intro="Adds Master Tasker to chats in the Claude app, so you can ask about your tasks in any chat. Claude can read them and suggest changes. Suggestions wait in For you until you accept them. Claude's settings file is backed up first, and its other entries stay as they are."
    >
      <div className="button-row">
        {added ? (
          <>
            {outdated ? (
              <ActionButton label="Update" primary busy={busy} why={!i.claudeApp.found ? why : undefined} onClick={() => run(true)} />
            ) : (
              !i.desktop.tokenWorks && <ActionButton label="Add again" primary busy={busy} why={!i.claudeApp.found ? why : undefined} onClick={() => run(true)} />
            )}
            <ActionButton label="Remove from Claude Desktop" busy={busy} onClick={() => run(false)} />
          </>
        ) : (
          <ActionButton label="Add to Claude Desktop" primary={primary} busy={busy} why={why} onClick={() => run(true)} />
        )}
      </div>
      {outdated && !result && <p className="meta-line">Its entry points at an old folder, address or copy of Node, or keeps the token in Claude's settings file. Update rewrites it, after a backup.</p>}
      {added && !outdated && !i.desktop.tokenWorks && !result && <p className="meta-line">Its access was removed. Add again gives it new access.</p>}
      <ResultLine r={result} />
    </Step>
  );
}

/** Claude Code in Terminal, for people who want Master Tasker's tools in every Claude Code thread. Out of the way. */
function TerminalStep() {
  const clients = useClients() ?? [];
  const has = clients.find((c) => !c.revokedAt && c.kind === 'claude' && /terminal/i.test(c.name));
  return (
    <details className="detail-more claude-terminal">
      <summary>Claude Code in Terminal</summary>
      <div className="claude-terminal-body">
        <ConnectApp
          app="claude-code"
          has={has}
          quiet
          intro="The /master-tasker command is all most people need. To give every Claude Code thread the Master Tasker tools too, connect it here. It shows a command to paste into Terminal."
        />
      </div>
    </details>
  );
}
