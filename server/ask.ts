// Answers your question about something that needs you, with a one-off Claude run you start.
// It resumes the thread that raised the item, so it knows the story, but it is read-only:
// it can read files and nothing else, and --no-session-persistence means nothing is saved,
// so your real thread is never touched and the run never shows up as a thread of its own.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import type { Task } from '../shared/schema.ts';

const TIMEOUT_MS = 180_000;

export interface AskInput {
  claudeBin: string;
  task: Task;
  item: string;
  question: string;
  thread: { sessionId: string; cwd: string } | null;
  /** What the person wants to be called, from Settings. Empty: the prompt says "the user". */
  name?: string;
}

function itemText(task: Task, item: string) {
  if (item === 'task') return task.needsYou;
  return task.subtasks.find((s) => s.id === item)?.title ?? '';
}

export function askPrompt(task: Task, item: string, question: string, name = ''): string {
  const what = itemText(task, item);
  const detail = task.youContext[item]?.detail;
  const open = task.subtasks.filter((s) => !s.done).map((s) => `- ${s.title}${s.needsYou ? ' (needs you)' : ''}`);
  return [
    `The user${name ? `, ${name},` : ''} is looking at their Master Tasker task ${task.id}: "${task.title}".`,
    `This is waiting on the user: "${what}"${detail ? `\nWhy: ${detail}` : ''}`,
    ...(open.length ? ['Open subtasks:', ...open] : []),
    '',
    `The user's question: ${question}`,
    '',
    'Answer the user directly, speaking to them as "you", in a few short, plain sentences. No em dashes. If it helps, name the exact file, link or step.',
    'This is a read-only side question: do not change anything, and do not write "Now on:", "Done:" or "Needs you:" lines.',
  ].join('\n');
}

/** Runs Claude and resolves with its answer. Rejects with a plain message if it can't. */
export function runAsk({ claudeBin, task, item, question, thread, name = '' }: AskInput): Promise<string> {
  if (!claudeBin) return Promise.reject(new Error('Ask needs Claude Code on this Mac. Set it up in Settings, under AI assistants.'));
  const cwd = thread?.cwd && fs.existsSync(thread.cwd) ? thread.cwd : os.homedir();
  const args = ['-p', '--output-format', 'json', '--no-session-persistence', '--model', 'sonnet', '--strict-mcp-config'];
  if (thread) args.push('--resume', thread.sessionId, '--fork-session');
  // Last, because it takes a list. The prompt goes in on stdin.
  args.push('--tools', 'Read', 'Grep', 'Glob');
  return new Promise((resolve, reject) => {
    const child = spawn(claudeBin, args, {
      cwd,
      env: { ...process.env, PATH: `${process.env.PATH ?? ''}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Claude took too long to answer. Try a shorter question.'));
    }, TIMEOUT_MS);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`Could not start Claude: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const r = JSON.parse(out);
        if (r.is_error || typeof r.result !== 'string') return reject(new Error(String(r.result || 'Claude could not answer.')));
        resolve(r.result.trim());
      } catch {
        reject(new Error((err.trim().split('\n').pop() || `Claude stopped (code ${code}).`).slice(0, 300)));
      }
    });
    child.stdin.end(askPrompt(task, item, question, name));
  });
}
