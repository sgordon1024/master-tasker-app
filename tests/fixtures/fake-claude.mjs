#!/usr/bin/env node
// Stands in for Claude Code in tests. Echoes what it was asked and how it was run, so tests can check both.
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  const q = /The user's question: (.*)/.exec(input)?.[1] ?? '';
  if (q.includes('fail')) {
    process.stdout.write(JSON.stringify({ is_error: true, result: 'Not logged in' }));
    return;
  }
  const resume = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : 'none';
  const safe = args.includes('--no-session-persistence') && args.slice(args.indexOf('--tools') + 1).join(',') === 'Read,Grep,Glob';
  // Says who it was asked for, when the prompt names them.
  const who = /^The user, (.+?), is looking/m.exec(input)?.[1];
  process.stdout.write(JSON.stringify({ is_error: false, result: `Answer to "${q}" (thread ${resume}, read-only ${safe})${who ? ` for ${who}` : ''}` }));
});
