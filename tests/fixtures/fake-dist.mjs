// Stands in for nodejs.org/dist in tests of scripts/service.sh get-node, so no test downloads a real Node.
//   node fake-dist.mjs <folder> <request log>
// Serves the files in <folder> on 127.0.0.1, on a free port it prints as "listening <port>", and writes
// each path it's asked for to <request log>, one per line.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const [root, log] = process.argv.slice(2).map((p) => path.resolve(p));

const server = http.createServer((req, res) => {
  const asked = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  fs.appendFileSync(log, `${asked}\n`);
  const file = path.join(root, asked);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404);
    return res.end('Not found');
  }
  res.writeHead(200, { 'content-length': fs.statSync(file).size });
  fs.createReadStream(file).pipe(res);
});
server.listen(0, '127.0.0.1', () => console.log(`listening ${server.address().port}`));
// Never outlive the test.
setTimeout(() => process.exit(0), 60_000).unref();
