// Stands in for server/main.ts in tests of scripts/service.sh. Answers /api/health on MT_PORT like the
// real server and, when MT_DATA_DIR is set, keeps server.pid there the way server/app.ts does.
// When FAKE_SERVER_LOG is set, it writes each request's method and path there, one per line.
// It never listens on 4820, the installed app's port.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const port = Number(process.env.MT_PORT);
if (!Number.isInteger(port) || port <= 0 || port === 4820) {
  console.error(`fake-server: not listening on port ${process.env.MT_PORT}`);
  process.exit(2);
}
const pidFile = process.env.MT_DATA_DIR ? path.join(process.env.MT_DATA_DIR, 'server.pid') : '';
const log = process.env.FAKE_SERVER_LOG;

const server = http.createServer((req, res) => {
  if (log) fs.appendFileSync(log, `${req.method} ${req.url}\n`);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, db: 'ok' }));
});
server.listen(port, '127.0.0.1', () => {
  if (pidFile) {
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString() }));
  }
  console.log('listening');
});
// Like the real server: stop listening first, then remove the pid file.
process.on('SIGTERM', () => {
  server.close(() => {
    if (pidFile) fs.rmSync(pidFile, { force: true });
    process.exit(0);
  });
  server.closeAllConnections();
});
// Never outlive the test.
setTimeout(() => process.exit(0), 60_000).unref();
