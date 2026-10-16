// Small JSON-lines logger with size-based rotation. No dependencies.
import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 2 * 1024 * 1024;
const KEEP = 5;

let logFile: string | null = null;
let alsoConsole = true;

export function initLog(dir: string, opts: { console?: boolean } = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  logFile = path.join(dir, 'server.log');
  alsoConsole = opts.console ?? true;
  // launchd writes stdout/stderr to these files and never rotates them. Trim them at startup.
  for (const name of ['launchd.out.log', 'launchd.err.log']) rotateIfLarge(path.join(dir, name));
}

export function rotateIfLarge(file: string, max = MAX_BYTES, keep = KEEP) {
  try {
    if (fs.statSync(file).size < max) return;
  } catch {
    return;
  }
  for (let i = keep - 1; i >= 1; i--) {
    const from = `${file}.${i}`;
    if (fs.existsSync(from)) fs.renameSync(from, `${file}.${i + 1}`);
  }
  fs.renameSync(file, `${file}.1`);
  const overflow = `${file}.${keep + 1}`;
  if (fs.existsSync(overflow)) fs.rmSync(overflow);
}

function write(level: string, msg: string, extra?: Record<string, unknown>) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra });
  if (logFile) {
    try {
      rotateIfLarge(logFile);
      fs.appendFileSync(logFile, line + '\n', { mode: 0o600 });
    } catch {
      // Logging must never take the server down.
    }
  }
  if (alsoConsole) (level === 'error' ? console.error : console.log)(line);
}

export const log = {
  info: (msg: string, extra?: Record<string, unknown>) => write('info', msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => write('warn', msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => write('error', msg, extra),
};
