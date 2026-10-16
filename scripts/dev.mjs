// Development: API on 4821 with a throwaway data dir in .data/, Vite with hot reload on 5180.
// Never touches the real database used by the installed service.
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const env = { ...process.env, MT_DEV: '1', MT_PORT: '4821', MT_DATA_DIR: path.join(root, '.data', 'dev'), MT_LOG_DIR: path.join(root, '.data', 'logs') };
const procs = [
  spawn(process.execPath, ['--watch', 'server/main.ts'], { cwd: root, env, stdio: 'inherit' }),
  spawn('npx', ['vite'], { cwd: root, env, stdio: 'inherit' }),
];
const stop = () => procs.forEach((p) => p.kill('SIGTERM'));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
