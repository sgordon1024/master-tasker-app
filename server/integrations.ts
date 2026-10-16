// Connecting Claude: finds what's installed on this Mac and sets it up when you press a Claude button in
// Settings > AI assistants. Everything here is local files only, and only these:
//   - the /master-tasker skill link in Claude Code's skills folder (config.claudeSkillsDir)
//   - the skill's .local.env (in the skill folder, config.skillDir) and its token file (in the data folder)
//   - one "master-tasker" entry in Claude Desktop's settings file (config.claudeDesktopConfig), after a backup
//   - token files for connections whose app settings name a file instead of holding the token (<data folder>/tokens)
//   - a note that Set up turned on thread linking (<data folder>/claude), so Remove can turn it off again
// It never removes or overwrites something another copy of Master Tasker, or anyone else, put there.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeFromShell, firstExisting, type Config } from './config.ts';
import { AppError, hashToken, type Ctx, type Service } from './service.ts';
import type { ClientScopes, Integrations } from '../shared/schema.ts';

/** This copy of Master Tasker. */
export const REPO = path.resolve(import.meta.dirname, '..');
const SKILL = 'master-tasker';
const TTL_MS = 5000;
/** Master Tasker backs up Claude Desktop's settings before every change, and keeps this many of its backups. */
export const DESKTOP_BACKUPS_KEPT = 3;

export const SKILL_CONNECTION = { name: 'Claude threads', kind: 'claude' as const, scopes: { areas: '*', unfiled: true, perms: ['read', 'update', 'complete', 'start'] } satisfies ClientScopes };
export const DESKTOP_CONNECTION = { name: 'Claude Desktop', kind: 'claude' as const, scopes: { areas: '*', unfiled: true, perms: ['read', 'propose'] } satisfies ClientScopes };

/** Single quotes for a shell file that gets sourced: 'it'\''s'. */
export const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const real = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const samePath = (a: string, b: string) => real(a) === real(b);

/**
 * The Node to write into Claude's settings: this same Node, by a path that survives updates.
 * Homebrew runs Node from a versioned folder that an upgrade deletes, so use its /opt/homebrew/bin
 * link when that link is this Node.
 */
export function stableNode(execPath = process.execPath, links = ['/opt/homebrew/bin/node', '/usr/local/bin/node']): string {
  return links.find((l) => fs.existsSync(l) && samePath(l, execPath)) ?? execPath;
}

/** Writes a file in one step, so nothing ever reads half of it. */
function writeAtomic(file: string, text: string, mode: number) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

/** Saves a token only you can read: the folder is 700 and the file is 600. */
function writeTokenFile(file: string, token: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(file), 0o700);
  writeAtomic(file, token, 0o600);
}

const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');

export interface IntegrationsDeps {
  config: Config;
  service: Service;
  /** The port the server actually listens on. */
  port: () => number;
  /** Something changed: tell open tabs. */
  onChange: () => void;
}

export function createIntegrations({ config, service, port, onChange }: IntegrationsDeps) {
  const skillSource = config.skillDir;
  const skillLink = path.join(config.claudeSkillsDir, SKILL);
  const envFile = path.join(skillSource, '.local.env');
  const tokenFile = path.join(config.dataDir, 'claude', 'token');
  // There when Set up Claude Code turned thread linking on. Gone once you change that switch yourself.
  const linkingBySetup = path.join(config.dataDir, 'claude', 'thread-linking-by-setup');
  const tokensDir = path.join(config.dataDir, 'tokens');
  const mcpServer = path.join(REPO, 'mcp', 'server.ts');
  const host = config.host === '::1' ? '[::1]' : '127.0.0.1';
  const url = () => `http://${host}:${port()}`;

  let claudeBin = config.claudeBin;
  let shellBin = '';
  let cache: { at: number; value: Integrations } | null = null;
  const changed = () => {
    cache = null;
    onChange();
  };

  // A login shell knows about installs the usual places miss. Asked once, in the background.
  if (config.claudeShellLookup) {
    void claudeFromShell().then((found) => {
      shellBin = found;
      if (found && !claudeBin) {
        claudeBin = found;
        changed();
      }
    });
  }

  function findClaudeBin(): string {
    if (!config.claudeShellLookup) return claudeBin && fs.existsSync(claudeBin) ? claudeBin : '';
    claudeBin = firstExisting(config.claudeBinCandidates) || (shellBin && fs.existsSync(shellBin) ? shellBin : '');
    return claudeBin;
  }

  // ─── What's there ───

  function skillState(): { state: Integrations['skill']['state']; target: string; dangling: boolean } {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(skillLink);
    } catch {
      return { state: 'missing', target: '', dangling: false };
    }
    if (!st.isSymbolicLink()) return { state: 'other', target: skillLink, dangling: false };
    const target = path.resolve(path.dirname(skillLink), fs.readlinkSync(skillLink));
    // A link to a folder that's gone (moved or deleted) is free to replace, as scripts/install-skill.sh does.
    if (!fs.existsSync(target)) return { state: 'missing', target, dangling: true };
    return { state: samePath(target, skillSource) ? 'linked' : 'other', target, dangling: false };
  }

  /** The connection a token belongs to, if it still works. */
  function liveClient(token: unknown): string | null {
    if (typeof token !== 'string' || !/^mt_[A-Za-z0-9]{32}$/.test(token)) return null;
    const r = service.db().prepare('SELECT id, revoked_at FROM clients WHERE token_hash = ?').get(hashToken(token)) as { id: string; revoked_at: string | null } | undefined;
    return r && !r.revoked_at ? r.id : null;
  }
  const readToken = () => {
    try {
      return fs.readFileSync(tokenFile, 'utf8').trim();
    } catch {
      return '';
    }
  };

  // ─── Token files: app settings name one of these (MASTER_TASKER_TOKEN_FILE) instead of holding the token ───

  const connectionFile = (id: string) => {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new AppError(422, 'validation', 'Unknown connection');
    return path.join(tokensDir, id);
  };
  /** Saves a connection's token to <data folder>/tokens/<id>, readable only by you. Returns the file. */
  function saveConnectionToken(id: string, token: string): string {
    const file = connectionFile(id);
    writeTokenFile(file, token);
    return file;
  }
  /** Revokes a connection and deletes the token file saved for it. */
  function revokeConnection(ctx: Ctx, id: string) {
    const client = service.revokeClient(ctx, id);
    fs.rmSync(connectionFile(id), { force: true });
    return client;
  }
  /** A connection's token file, when it has one. It holds the token, but this is only its path. */
  function tokenFileFor(id: string): string | undefined {
    try {
      const file = connectionFile(id);
      return fs.statSync(file).isFile() ? file : undefined;
    } catch {
      return undefined;
    }
  }
  /** A file in this copy's tokens folder. */
  const isOurTokenFile = (file: unknown): file is string => typeof file === 'string' && path.isAbsolute(file) && samePath(path.dirname(file), tokensDir);
  /** The token in a file an app's settings name. Only a small plain file is read. */
  const fileToken = (file: unknown): string => {
    if (typeof file !== 'string' || !path.isAbsolute(file)) return '';
    try {
      const st = fs.statSync(file);
      return st.isFile() && st.size < 256 ? fs.readFileSync(file, 'utf8').trim() : '';
    } catch {
      return '';
    }
  };
  // A connection revoked some other way (npm run cli -- token revoke) leaves its file behind. Tidy those up.
  try {
    const revoked = service.db().prepare('SELECT 1 FROM clients WHERE id = ? AND revoked_at IS NOT NULL');
    for (const name of fs.readdirSync(tokensDir)) {
      if (name.endsWith('.tmp') || revoked.get(name)) fs.rmSync(path.join(tokensDir, name), { force: true });
    }
  } catch {
    // no tokens folder yet
  }

  const node = stableNode();
  const envText = () =>
    [`MT_DATA_DIR=${shellQuote(config.dataDir)}`, `MASTER_TASKER_URL=${shellQuote(url())}`, `MT_NODE=${shellQuote(node)}`].join('\n') + '\n';
  /** The settings lines, without comments or blank lines, so a file written by scripts/install-skill.sh counts too. */
  const settingLines = (text: string) => text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).sort().join('\n');
  function envUpToDate(): boolean {
    try {
      return settingLines(fs.readFileSync(envFile, 'utf8')) === settingLines(envText());
    } catch {
      // Without the file the skill uses the defaults, which is only right for a default install.
      return port() === 4820 && config.dataDir === path.join(os.homedir(), 'Library', 'Application Support', 'MasterTasker');
    }
  }

  function readDesktop(): { exists: boolean; json: Record<string, any> | null } {
    let text: string;
    try {
      text = fs.readFileSync(config.claudeDesktopConfig, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, json: {} };
      return { exists: true, json: null };
    }
    if (!text.trim()) return { exists: true, json: {} };
    try {
      const json = JSON.parse(text);
      const servers = json?.mcpServers;
      const ok = json && typeof json === 'object' && !Array.isArray(json) && (servers === undefined || (servers && typeof servers === 'object' && !Array.isArray(servers)));
      return { exists: true, json: ok ? json : null };
    } catch {
      return { exists: true, json: null };
    }
  }
  const entryArgs = (entry: any): string[] => (Array.isArray(entry?.args) ? entry.args.filter((a: unknown) => typeof a === 'string') : []);
  const entryEnv = (entry: any): Record<string, unknown> => (entry?.env && typeof entry.env === 'object' ? entry.env : {});
  const runsThisCopy = (entry: any) => entryArgs(entry).some((a) => samePath(a, mcpServer));
  /** The token an entry uses, the way mcp/server.ts picks it: written into the settings, or else from the file they name. */
  const entryToken = (entry: any): string => {
    const env = entryEnv(entry);
    return typeof env.MASTER_TASKER_TOKEN === 'string' && env.MASTER_TASKER_TOKEN ? env.MASTER_TASKER_TOKEN.trim() : fileToken(env.MASTER_TASKER_TOKEN_FILE);
  };
  /**
   * A master-tasker entry this copy may change: it runs this copy's MCP server, its token (written in, or in this
   * copy's token file) is a live connection here, or the mcp/server.ts it runs is gone (this copy moved, and the
   * entry still points at the old folder).
   */
  const isOurs = (entry: any) => {
    const env = entryEnv(entry);
    if (runsThisCopy(entry) || liveClient(env.MASTER_TASKER_TOKEN)) return true;
    if (isOurTokenFile(env.MASTER_TASKER_TOKEN_FILE) && liveClient(fileToken(env.MASTER_TASKER_TOKEN_FILE))) return true;
    const server = entryArgs(entry).find((a) => path.isAbsolute(a) && a.endsWith(`${path.sep}mcp${path.sep}server.ts`));
    return !!server && !fs.existsSync(server);
  };
  /**
   * The command Claude runs for an entry is still there. A bare name like "node" is looked up on Claude's own PATH,
   * which Master Tasker can't see, so only a full path is checked.
   */
  const commandWorks = (entry: any) => {
    const command = entry?.command;
    if (typeof command !== 'string' || !command) return false;
    if (!path.isAbsolute(command)) return true;
    try {
      fs.accessSync(command, fs.constants.X_OK);
      return fs.statSync(command).isFile();
    } catch {
      return false;
    }
  };
  /** Where an entry's MCP server looks for the app, worked out the way mcp/server.ts does. */
  const entryUrl = (entry: any) => String(entryEnv(entry).MASTER_TASKER_URL || `http://127.0.0.1:${entryEnv(entry).MT_PORT || 4820}`).replace(/\/+$/, '');
  function desktopState(json: Record<string, any> | null): Integrations['desktop'] {
    if (!json) return { state: 'missing', tokenWorks: false, unreadable: true };
    const entry = json.mcpServers?.[SKILL];
    if (!entry) return { state: 'missing', tokenWorks: false, unreadable: false };
    if (!isOurs(entry)) return { state: 'other', tokenWorks: false, unreadable: false };
    const tokenWorks = !!liveClient(entryToken(entry));
    // Ours, but for an old folder or address (this copy moved, or its port changed), with the token written
    // into Claude's settings file, or with a Node that's gone (Homebrew upgraded it): Update rewrites it.
    const current = runsThisCopy(entry) && entryUrl(entry) === url() && !entryEnv(entry).MASTER_TASKER_TOKEN && commandWorks(entry);
    return { state: current ? 'connected' : 'outdated', tokenWorks, unreadable: false };
  }

  function detect(force = false): Integrations {
    if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.value;
    const skill = skillState();
    const claudeApp = { found: !!firstExisting(config.claudeAppCandidates) };
    const tokenWorks = !!liveClient(readToken());
    const upToDate = skill.state === 'linked' && envUpToDate();
    // The skill alone is enough to work a task with Claude Code in Terminal. The app adds Work on this with Claude.
    const skillReady = skill.state === 'linked' && tokenWorks && upToDate;
    const value: Integrations = {
      claudeApp,
      claudeCode: { found: !!findClaudeBin() },
      skill: { state: skill.state, tokenWorks, upToDate },
      desktop: desktopState(readDesktop().json),
      threadLinking: service.getSettings().threadLinking,
      skillReady,
      ready: claudeApp.found && skillReady,
      paths: { node, mcpServer, url: url() },
      checkedAt: new Date().toISOString(),
    };
    cache = { at: Date.now(), value };
    return value;
  }

  // ─── Claude Code: the skill ───

  /** Links the skill, gives it a working connection, tells it where this copy is, and turns on thread linking. */
  function setupClaudeCode(ctx: Ctx): { integrations: Integrations; message: string } {
    const skill = skillState();
    if (skill.state === 'other') {
      throw new AppError(409, 'conflict', 'Claude Code already has a master-tasker skill from another folder, so nothing was changed. Remove that one first if you want to use this copy.', { target: skill.target });
    }
    if (!fs.existsSync(path.join(skillSource, 'SKILL.md'))) throw new AppError(500, 'internal', 'The skill is missing from this copy of Master Tasker. Download it again.');
    // A token that still works stays. A revoked or deleted one is replaced by a new connection.
    let rotated = false;
    if (!liveClient(readToken())) {
      const { token } = service.createClient(ctx, SKILL_CONNECTION);
      writeTokenFile(tokenFile, token);
      rotated = true;
    } else {
      fs.chmodSync(path.dirname(tokenFile), 0o700);
      fs.chmodSync(tokenFile, 0o600);
    }
    writeAtomic(envFile, envText(), 0o644);
    if (skill.state === 'missing') {
      fs.mkdirSync(config.claudeSkillsDir, { recursive: true });
      if (skill.dangling) fs.unlinkSync(skillLink);
      fs.symlinkSync(skillSource, skillLink);
    }
    if (!service.getSettings().threadLinking) {
      service.updateSettings(ctx, { threadLinking: true });
      // Remember it was Set up, not you, so Remove can turn it off again.
      writeAtomic(linkingBySetup, `Set up Claude Code turned on thread linking, ${new Date().toISOString()}\n`, 0o600);
    }
    changed();
    return { integrations: detect(true), message: rotated || skill.state === 'missing' ? 'Claude Code is set up.' : 'Claude Code was already set up. Checked and refreshed it.' };
  }

  function removeClaudeCode(ctx: Ctx): { integrations: Integrations; message: string } {
    const skill = skillState();
    if (skill.state === 'other') {
      // The token file is shared by every copy that uses this data folder, and the other skill may use it.
      // Leave it and its connection to the copy that owns the skill, as scripts/install-skill.sh does.
      fs.rmSync(envFile, { force: true });
      changed();
      return { integrations: detect(true), message: 'The master-tasker skill in Claude Code belongs to another folder, so it and its connection were left alone. Remove it from that copy of Master Tasker.' };
    }
    if (skill.state === 'linked' || skill.dangling) fs.unlinkSync(skillLink);
    const id = liveClient(readToken());
    if (id) service.revokeClient(ctx, id);
    fs.rmSync(tokenFile, { force: true });
    fs.rmSync(envFile, { force: true });
    // Set up turned thread linking on, and you haven't touched it since: turn it off again. If you turned it on, it stays.
    let linkingOff = false;
    if (fs.existsSync(linkingBySetup)) {
      if (service.getSettings().threadLinking) {
        service.updateSettings(ctx, { threadLinking: false });
        linkingOff = true;
      }
      fs.rmSync(linkingBySetup, { force: true });
    }
    changed();
    const message = 'Removed the skill from Claude Code and removed its access.';
    return { integrations: detect(true), message: linkingOff ? `${message} Thread linking is off again, since Set up turned it on.` : message };
  }

  /** You changed the thread linking switch yourself, so Remove leaves it as you set it. */
  function forgetLinkingBySetup() {
    fs.rmSync(linkingBySetup, { force: true });
  }

  // ─── Claude Desktop chat: one MCP server entry ───

  function unreadable(): never {
    throw new AppError(422, 'validation', "Claude Desktop's settings file has a mistake in it, so Master Tasker left it alone. Fix it in Claude (Settings, Developer, Edit Config), then try again.");
  }
  /**
   * The settings file may be a link, say into a dotfiles folder. Writing would turn the link into a plain file,
   * and writing through it would change a file in that folder, so leave it alone.
   */
  function refuseLink(what: string) {
    let link = false;
    try {
      link = fs.lstatSync(config.claudeDesktopConfig).isSymbolicLink();
    } catch {
      // no file yet
    }
    if (link) throw new AppError(409, 'conflict', `Claude Desktop's settings file is a link to a file somewhere else, so Master Tasker left it alone. ${what}`);
  }
  /** Master Tasker's own backups in Claude's folder, newest first: claude_desktop_config.backup-<time>[-<n>].json. */
  function desktopBackups(dir: string, name: string): { file: string; stamp: string; n: number }[] {
    const ours = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.backup-(\\d{8}-\\d{6})(?:-(\\d+))?\\.json$`);
    return fs
      .readdirSync(dir)
      .flatMap((file) => {
        const m = ours.exec(file);
        return m ? [{ file, stamp: m[1], n: Number(m[2] ?? 1) }] : [];
      })
      .sort((a, b) => b.stamp.localeCompare(a.stamp) || b.n - a.n);
  }
  function backupDesktop(): string | null {
    if (!fs.existsSync(config.claudeDesktopConfig)) return null;
    const { dir, name } = path.parse(config.claudeDesktopConfig);
    const now = stamp();
    // Several in one second count up from the highest, so the newest always sorts first.
    const n = Math.max(0, ...desktopBackups(dir, name).filter((b) => b.stamp === now).map((b) => b.n)) + 1;
    const file = path.join(dir, `${name}.backup-${now}${n > 1 ? `-${n}` : ''}.json`);
    fs.copyFileSync(config.claudeDesktopConfig, file, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(file, 0o600);
    // Keep the newest few of its own. Every other file in Claude's folder stays.
    for (const old of desktopBackups(dir, name).filter((b) => b.file !== path.basename(file)).slice(DESKTOP_BACKUPS_KEPT - 1)) {
      fs.rmSync(path.join(dir, old.file), { force: true });
    }
    return file;
  }
  function writeDesktop(json: Record<string, any>) {
    fs.mkdirSync(path.dirname(config.claudeDesktopConfig), { recursive: true });
    // Other entries may hold secrets, so only you can read it.
    writeAtomic(config.claudeDesktopConfig, `${JSON.stringify(json, null, 2)}\n`, 0o600);
  }

  /** Adds the entry, or rewrites this copy's own (Update). The entry names a token file, never the token itself. */
  function addDesktop(ctx: Ctx): { integrations: Integrations; message: string; backup: string | null } {
    if (!firstExisting(config.claudeAppCandidates)) throw new AppError(409, 'conflict', 'Install the Claude app first, then try again.');
    refuseLink('To add it anyway, pick Other app in Settings > AI assistants, connect it, and paste its settings in yourself.');
    const { json } = readDesktop();
    if (!json) unreadable();
    const servers: Record<string, any> = json.mcpServers ?? {};
    const existing = servers[SKILL];
    if (existing && !isOurs(existing)) {
      throw new AppError(409, 'conflict', 'Claude Desktop already has a master-tasker entry for another copy of Master Tasker, so nothing was changed. Remove it in Claude first if you want to use this copy.');
    }
    const backup = backupDesktop();
    // Re-adding keeps a token that still works, so this stays one connection. A token written into the old entry moves to a file.
    let token = existing ? entryToken(existing) : '';
    let id = liveClient(token);
    if (!id) {
      const made = service.createClient(ctx, DESKTOP_CONNECTION);
      [id, token] = [made.client.id, made.token];
    }
    const file = saveConnectionToken(id, token);
    writeDesktop({ ...json, mcpServers: { ...servers, [SKILL]: { command: node, args: [mcpServer], env: { MASTER_TASKER_TOKEN_FILE: file, MASTER_TASKER_URL: url() } } } });
    changed();
    const message = existing ? 'Updated Master Tasker in Claude Desktop. Quit Claude fully and reopen it.' : 'Added to Claude Desktop. Quit Claude fully and reopen it.';
    return { integrations: detect(true), message, backup: backup && path.basename(backup) };
  }

  function removeDesktop(ctx: Ctx): { integrations: Integrations; message: string; backup: string | null } {
    const { json } = readDesktop();
    if (!json) unreadable();
    const entry = json.mcpServers?.[SKILL];
    if (!entry) return { integrations: detect(true), message: 'Claude Desktop has no Master Tasker entry. Nothing to remove.', backup: null };
    if (!isOurs(entry)) {
      return { integrations: detect(true), message: 'The master-tasker entry in Claude Desktop belongs to another copy of Master Tasker, so it was left alone.', backup: null };
    }
    refuseLink('Remove the master-tasker entry from that file yourself.');
    const backup = backupDesktop();
    const { [SKILL]: _removed, ...rest } = json.mcpServers as Record<string, any>;
    writeDesktop({ ...json, mcpServers: rest });
    const id = liveClient(entryToken(entry));
    if (id) revokeConnection(ctx, id);
    const file = entryEnv(entry).MASTER_TASKER_TOKEN_FILE;
    if (isOurTokenFile(file)) fs.rmSync(file, { force: true });
    changed();
    return { integrations: detect(true), message: 'Removed from Claude Desktop. Quit Claude fully and reopen it.', backup: backup && path.basename(backup) };
  }

  return {
    detect,
    /** Claude Code's command right now, for Ask. Empty when it isn't installed. */
    claudeBin: () => findClaudeBin(),
    setupClaudeCode,
    removeClaudeCode,
    addDesktop,
    removeDesktop,
    saveConnectionToken,
    revokeConnection,
    tokenFileFor,
    forgetLinkingBySetup,
    /** Forget the last check, e.g. after a setting changed. */
    invalidate: changed,
    files: { skillSource, skillLink, envFile, tokenFile, tokensDir, mcpServer },
  };
}

export type IntegrationsApi = ReturnType<typeof createIntegrations>;
