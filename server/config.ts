import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  logDir: string;
  dbPath: string;
  backupDir: string;
  distDir: string;
  seedSamples: boolean;
  /** Opens on the first-run setup screen until it's finished or skipped. Off marks setup done at startup (tests, the demo). */
  firstRun: boolean;
  dev: boolean;
  backupIntervalHours: number;
  backupKeep: number;
  /** Where Claude Code keeps its threads. Read only, to link threads to tasks, and only once you turn that on. */
  claudeProjectsDir: string;
  /** The Claude Code command, for answering your questions about a task. Empty if it isn't installed. */
  claudeBin: string;
  /** Places to look for Claude Code again when you press Check again. Empty when MT_CLAUDE_BIN chose it. */
  claudeBinCandidates: string[];
  /** Also ask a login shell where claude is, once at startup. Off when MT_CLAUDE_BIN chose it. */
  claudeShellLookup: boolean;
  /** The Claude desktop app's Code data. Read only: its threads and scheduled routines. */
  claudeAppDir: string;
  /** The Claude desktop app itself. Only checked for, never opened or changed. */
  claudeAppPath: string;
  /** Where to look for the app when checking again: MT_CLAUDE_APP_PATH, or the two usual places. */
  claudeAppCandidates: string[];
  /** Claude Code's personal skills folder. Set up Claude Code links the /master-tasker skill here. */
  claudeSkillsDir: string;
  /** The skill folder that gets linked: this repo's claude/skills/master-tasker. Tests point it at a copy. */
  skillDir: string;
  /** Claude Desktop's settings file. Add to Claude Desktop adds one entry to it. */
  claudeDesktopConfig: string;
  /** Your on/off switches for what each routine reads. */
  sourcesFile: string;
  /** Shows a Mac notification when Claude finishes a ticket. Empty turns it off (tests, dev). */
  notifyBin: string;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** Newest first, so "v24.10.0" comes before "v24.9.1". */
const byVersionDesc = (a: string, b: string) => b.localeCompare(a, undefined, { numeric: true });

const readText = (file: string) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

/** The usual places Claude Code ends up, in the order to try them. */
export function claudeBinCandidates(home: string, env: NodeJS.ProcessEnv): string[] {
  const out = ['/opt/homebrew/bin/claude', '/usr/local/bin/claude', path.join(home, '.local', 'bin', 'claude'), path.join(home, '.claude', 'local', 'claude')];
  // npm's global bin: next to the node running this server, or wherever npm's prefix points.
  out.push(path.join(path.dirname(process.execPath), 'claude'));
  const prefix = env.NPM_CONFIG_PREFIX || env.npm_config_prefix || /^\s*prefix\s*=\s*(.+?)\s*$/m.exec(readText(path.join(home, '.npmrc')))?.[1];
  if (prefix) out.push(path.join(prefix.replace(/^~(?=\/|$)/, home), 'bin', 'claude'));
  out.push(path.join(home, '.npm-global', 'bin', 'claude'));
  // nvm: the shell's current node, then its default, then any installed version.
  if (env.NVM_BIN) out.push(path.join(env.NVM_BIN, 'claude'));
  const nvm = env.NVM_DIR || path.join(home, '.nvm');
  let versions: string[] = [];
  try {
    versions = fs.readdirSync(path.join(nvm, 'versions', 'node')).sort(byVersionDesc);
  } catch {}
  const alias = readText(path.join(nvm, 'alias', 'default')).trim().replace(/^v?/, 'v');
  const preferred = alias.length > 1 ? versions.find((v) => v === alias || v.startsWith(`${alias}.`)) : undefined;
  for (const v of preferred ? [preferred, ...versions.filter((x) => x !== preferred)] : versions) out.push(path.join(nvm, 'versions', 'node', v, 'bin', 'claude'));
  return [...new Set(out)];
}

let shellLookup: Promise<string> | null = null;
/**
 * Asks a login shell where `claude` is, once per process, with a short timeout. Catches installs the
 * fixed places miss (asdf, volta, a custom PATH): a Mac service doesn't get your shell's PATH otherwise.
 * The server starts it once at startup, in the background.
 */
export function claudeFromShell(): Promise<string> {
  shellLookup ??= new Promise((resolve) => {
    execFile('/bin/zsh', ['-lc', 'command -v claude'], { timeout: 1500, encoding: 'utf8' }, (err, stdout) => {
      const out = String(stdout ?? '').trim().split('\n').pop() ?? '';
      // No answer in time, or no claude on the shell's PATH: the fixed places still count.
      resolve(!err && out.startsWith('/') && fs.existsSync(out) ? out : '');
    });
  });
  return shellLookup;
}

export const firstExisting = (paths: string[]) => paths.find((p) => fs.existsSync(p)) ?? '';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = os.homedir();
  const dataDir = path.resolve(env.MT_DATA_DIR ?? path.join(home, 'Library', 'Application Support', 'MasterTasker'));
  const logDir = path.resolve(env.MT_LOG_DIR ?? path.join(home, 'Library', 'Logs', 'MasterTasker'));
  const host = env.MT_HOST ?? '127.0.0.1';
  if (!LOOPBACK.has(host) && env.MT_ALLOW_NETWORK !== '1') {
    // Network exposure is a deliberate, documented opt-in. See docs/OPERATIONS.md.
    throw new Error(`Refusing to bind to ${host}. Master Tasker only listens on localhost unless MT_ALLOW_NETWORK=1.`);
  }
  // MT_CLAUDE_BIN picks Claude Code exactly (empty means "not installed"). Otherwise look in the usual places
  // now, and the server asks a login shell once at startup (claudeFromShell).
  const binCandidates = env.MT_CLAUDE_BIN !== undefined ? [] : claudeBinCandidates(home, env);
  const claudeBin = env.MT_CLAUDE_BIN !== undefined ? env.MT_CLAUDE_BIN && path.resolve(env.MT_CLAUDE_BIN) : firstExisting(binCandidates);
  const appCandidates = env.MT_CLAUDE_APP_PATH !== undefined ? [path.resolve(env.MT_CLAUDE_APP_PATH)] : ['/Applications/Claude.app', path.join(home, 'Applications', 'Claude.app')];
  return {
    host,
    port: Number(env.MT_PORT ?? 4820),
    dataDir,
    logDir,
    dbPath: path.join(dataDir, 'master-tasker.db'),
    backupDir: path.join(dataDir, 'backups'),
    distDir: path.resolve(import.meta.dirname, '..', 'dist'),
    seedSamples: env.MT_SEED !== '0',
    firstRun: env.MT_FIRST_RUN !== '0',
    dev: env.MT_DEV === '1',
    backupIntervalHours: Number(env.MT_BACKUP_INTERVAL_HOURS ?? 24),
    backupKeep: Number(env.MT_BACKUP_KEEP ?? 14),
    claudeProjectsDir: path.resolve(env.MT_CLAUDE_PROJECTS_DIR ?? path.join(home, '.claude', 'projects')),
    claudeAppDir: path.resolve(env.MT_CLAUDE_APP_DIR ?? path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions')),
    claudeAppPath: firstExisting(appCandidates) || appCandidates[0],
    claudeAppCandidates: appCandidates,
    claudeSkillsDir: path.resolve(env.MT_CLAUDE_SKILLS_DIR ?? path.join(home, '.claude', 'skills')),
    skillDir: path.resolve(env.MT_SKILL_DIR ?? path.join(import.meta.dirname, '..', 'claude', 'skills', 'master-tasker')),
    claudeDesktopConfig: path.resolve(env.MT_CLAUDE_DESKTOP_CONFIG ?? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')),
    sourcesFile: path.join(dataDir, 'sources.json'),
    notifyBin: env.MT_NOTIFY_BIN !== undefined ? env.MT_NOTIFY_BIN && path.resolve(env.MT_NOTIFY_BIN) : env.MT_DEV === '1' ? '' : '/usr/bin/osascript',
    claudeBin,
    claudeBinCandidates: binCandidates,
    claudeShellLookup: env.MT_CLAUDE_BIN === undefined,
  };
}
