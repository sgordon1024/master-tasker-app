// What a scheduled routine runs first, to honor your switches on the Sources page in Master Tasker.
//
//   node automation/sources.ts check <routine-id>
//
// Prints whether the routine is paused and which sources it must not read. Reads a local file only.
// Env: MT_DATA_DIR, the same as the server. Master Tasker writes it into the check line when it isn't the default.
import path from 'node:path';
import { createSources } from '../server/sources.ts';
import { DATA_DIR } from './env.ts';

const [cmd, id] = process.argv.slice(2);
if (cmd !== 'check' || !id) {
  process.stderr.write('Usage: sources.ts check <routine-id>\n');
  process.exit(2);
}
const r = createSources({ stateFile: path.join(DATA_DIR, 'sources.json') }).check(id);
const say = r.paused
  ? 'This routine is paused in Master Tasker. Stop now and say so.'
  : r.off.length
    ? `Do not read these sources this run: ${r.off.join(', ')}. Everything else is fine.`
    : 'All sources are on.';
process.stdout.write(JSON.stringify({ ...r, instruction: say }, null, 1) + '\n');
