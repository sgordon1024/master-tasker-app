// Entry point for the production service (LaunchAgent) and `npm start`.
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { initLog, log } from './log.ts';

const config = loadConfig();
initLog(config.logDir, { console: config.dev || process.stdout.isTTY });

let app: ReturnType<typeof createApp>;
try {
  app = createApp(config);
} catch (err) {
  log.error('startup failed', { err: err instanceof Error ? err.message : String(err) });
  // Exit non-zero so launchd restarts us (with throttling) and the error is in the log.
  process.exit(1);
}

app
  .listen()
  .then((port) => log.info('master tasker listening', { url: `http://${config.host}:${port}`, dataDir: config.dataDir, pid: process.pid }))
  .catch((err) => {
    log.error('could not listen', { err: String(err), port: config.port });
    process.exit(1);
  });

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info('shutting down', { signal });
  const force = setTimeout(() => process.exit(0), 5000);
  force.unref();
  await app.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  log.error('uncaught exception', { err: err.stack });
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  log.error('unhandled rejection', { err: String(err) });
});
