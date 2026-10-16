// Where the command-line tools find Master Tasker. Same variables and defaults as the server
// (server/config.ts), so a copy on another port or with another data folder just works.
//
//   MT_DATA_DIR          the data folder. Default ~/Library/Application Support/MasterTasker
//   MASTER_TASKER_URL    the app's address. Default http://127.0.0.1:<MT_PORT>, and MT_PORT defaults to 4820
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_PORT = 4820;
export const DEFAULT_DATA_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'MasterTasker');
export const DATA_DIR = path.resolve(process.env.MT_DATA_DIR || DEFAULT_DATA_DIR);
export const BASE = (process.env.MASTER_TASKER_URL || `http://127.0.0.1:${process.env.MT_PORT || DEFAULT_PORT}`).replace(/\/+$/, '');
/** The repo this code runs from. */
export const REPO = path.resolve(import.meta.dirname, '..');

/** Only ever talk to this Mac. */
export function checkLocal(base = BASE) {
  let host = '';
  try {
    host = new URL(base).hostname;
  } catch {}
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) throw new Error(`MASTER_TASKER_URL must be a local address (got ${base})`);
}

/** Reads a connection token from a file only you can read. `missing` says how to set it up. */
export function readTokenFile(file: string, missing: string): string {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    throw new Error(missing);
  }
  if ((st.mode & 0o077) !== 0) throw new Error(`${file} is readable by other users. Run: chmod 600 "${file}"`);
  const t = fs.readFileSync(file, 'utf8').trim();
  if (!/^mt_[A-Za-z0-9]{32}$/.test(t)) throw new Error(`${file} does not contain a Master Tasker token`);
  return t;
}

/** Saves a token so only you can read it: the folder is 700 and the file is 600. */
export function writeTokenFile(file: string, token: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(file), 0o700);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, token, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/** Quotes a value for a shell command line. */
export const shq = (s: string) => (/^[A-Za-z0-9_./:@%+=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/**
 * The env a routine or another tool needs to reach this copy, as a prefix for a command line.
 * Empty for the default port and data folder.
 */
export function envPrefix(): string {
  const parts: string[] = [];
  if (BASE !== `http://127.0.0.1:${DEFAULT_PORT}`) parts.push(`MASTER_TASKER_URL=${shq(BASE)}`);
  if (DATA_DIR !== path.resolve(DEFAULT_DATA_DIR)) parts.push(`MT_DATA_DIR=${shq(DATA_DIR)}`);
  return parts.length ? `${parts.join(' ')} ` : '';
}

/**
 * Creates a connection as you, the same way the app's Settings page does. Works only from this
 * Mac, because the server checks the origin and the custom header.
 */
export async function createConnection(name: string, scopes: { areas: '*' | string[]; unfiled: boolean; perms: string[] }, base = BASE): Promise<{ token: string; id: string }> {
  checkLocal(base);
  const res = await fetch(`${base}/api/clients`, {
    method: 'POST',
    headers: { 'x-master-tasker': 'web', 'x-session-id': 'setup-cli-tool', origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ name, kind: 'claude', scopes }),
  }).catch(() => {
    throw new Error(`Master Tasker isn't running at ${base}. Start it (./scripts/service.sh start), then try again.`);
  });
  const data = (await res.json().catch(() => null)) as { token?: string; client?: { id: string }; error?: { message: string } } | null;
  if (!res.ok || !data?.token) throw new Error(`Couldn't create the "${name}" connection: ${data?.error?.message ?? `HTTP ${res.status}`}`);
  return { token: data.token, id: data.client?.id ?? '' };
}

/** 'ok' when the token works, 'revoked' when the app says it's revoked or deleted, 'down' when the app isn't answering. */
export async function tokenStatus(token: string, base = BASE): Promise<'ok' | 'revoked' | 'down'> {
  try {
    const res = await fetch(`${base}/api/whoami`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
    return res.status === 401 ? 'revoked' : res.ok ? 'ok' : 'down';
  } catch {
    return 'down';
  }
}
