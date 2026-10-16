// Run before every push: node scripts/check-public.mjs
// Fails if anything personal, private or not yet cleared for a public repo would be published.
// It checks the files git would publish (tracked, plus untracked files that aren't ignored).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const files = [...new Set([...git('ls-files').split('\n'), ...git('ls-files', '--others', '--exclude-standard').split('\n')])].filter(Boolean);
const self = 'scripts/check-public.mjs';

// Words that only make sense in the original personal copy.
const PERSONAL = /\b(steve|stephen|gordon|sgordon1024|stephengordon|willowtree|willowtreeapps|telus|boost mobile|dish\.com|nyxie|starnet|kalshi)\b/i;
// The public repo's own address names its owner's account. It's the one place that name may appear, outside LICENSE.
const REPO_URL = /(?:git\+)?https:\/\/github\.com\/sgordon1024\/master-tasker-app\b/g;
// Home folder paths, except the placeholders the docs and tests use.
const HOME_PATH = /\/Users\/(?!me\/|x\/|YOU\/|you\/)[A-Za-z0-9._-]+/;
// The original owner's folder layout (the repo at ~/development/Master Tasker). A stranger's copy can live anywhere,
// so code builds paths from its own folder (import.meta.dirname) and docs say "the Master Tasker folder".
const OWNER_PATH = /development\/Master Tasker|(?:~|\$HOME|\$\{HOME\})\/development\b|homedir\(\),\s*['"]development['"]/i;
// Apps only the original owner uses.
const OWNER_TOOL = /\bgetsequence\b|\bSequence \(money\)|(?<=[a-z,] )Sequence\b/;
// The design review quotes the owner paths it found, as evidence. Every other check still applies to it.
const QUOTES_OWNER_PATHS = new Set(['docs/DESIGN-REVIEW.md']);
// Things that look like secrets.
const SECRET = /(mt_[A-Za-z0-9]{24,}|sk-ant-[A-Za-z0-9-]{20,}|ghp_[A-Za-z0-9]{30,}|xox[bp]-[A-Za-z0-9-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
// Files that must never be published.
const NEVER = /(\.db|\.db-wal|\.db-shm|\.sqlite3?|\.env|token)$/;
// Decisions that have to be made before going public. Delete a line once it's settled.
const PENDING = [];

const problems = [];
for (const f of files) {
  if (f === self) continue;
  if (NEVER.test(f)) problems.push(`${f}: data or secret file, never publish it`);
  const full = path.join(root, f);
  if (!fs.existsSync(full) || fs.statSync(full).size > 2_000_000) continue;
  const text = fs.readFileSync(full, 'utf8');
  if (text.includes('\u0000')) continue; // binary
  text.split('\n').forEach((line, i) => {
    for (const [name, re] of [['personal', PERSONAL], ['home path', HOME_PATH], ['secret', SECRET], ['owner path', OWNER_PATH], ['owner tool', OWNER_TOOL]]) {
      // The owner's name belongs on the copyright line, and nowhere else.
      if (name === 'personal' && f === 'LICENSE' && line.startsWith('Copyright (c)')) continue;
      if (name.startsWith('owner ') && QUOTES_OWNER_PATHS.has(f)) continue;
      const m = re.exec(name === 'personal' ? line.replace(REPO_URL, '') : line);
      if (m) problems.push(`${f}:${i + 1}: ${name} "${m[0]}"`);
    }
  });
}
for (const p of PENDING) if (files.some((f) => f.startsWith(p.file))) problems.push(`${p.file}: ${p.why}`);
if (!files.includes('LICENSE')) problems.push('LICENSE: missing. Pick a license before publishing.');

if (problems.length) {
  console.error(`Not ready to publish. ${problems.length} thing${problems.length === 1 ? '' : 's'} to fix:\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`Ready to publish: ${files.length} files checked, nothing personal or secret found.`);
