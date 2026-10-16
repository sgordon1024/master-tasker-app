import { Check, Copy, Loader2, MessageCircleQuestion, MessageSquareReply, SquareTerminal, Undo2 } from 'lucide-react';
import { Fragment, useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Ask, Task, YouContext } from '../../../shared/schema.ts';
import { api, ApiError, newKey } from '../api.ts';
import { copyText, cx, needsYouList, relativeTime } from '../lib.ts';
import { store, useIntegrations } from '../store.ts';
import { openThread } from '../claude.ts';

interface Item {
  key: string;
  text: string;
  subtaskId: string | null;
}

type Open = { key: string; mode: 'reply' | 'ask' } | null;

/** Everything on a task waiting for you, with the why, where it came from, and a way to finish, answer or ask about it. */
export function NeedsYouActions({ task }: { task: Task }) {
  const [open, setOpen] = useState<Open>(null);
  // Ask runs Claude Code on this Mac. Without it, there's no Ask at all.
  const canAsk = useIntegrations()?.claudeCode.found === true;
  const asks = useAsks(task.id);
  const items: Item[] = needsYouList(task);
  const clear = (it: Item) =>
    it.subtaskId ? store.updateSubtask(task.id, it.subtaskId, { needsYou: false }) : store.updateTask(task.id, { needsYou: '' }, { baseRev: task.rev });
  const toggle = (key: string, mode: 'reply' | 'ask') => setOpen(open?.key === key && open.mode === mode ? null : { key, mode });
  return (
    <ol className="you-actions">
      {items.map((it, i) => {
        const ctx = task.youContext?.[it.key];
        const mine = asks.list.filter((a) => a.item === it.key);
        return (
          <li key={it.key} className={cx('you-action', i === 0 && 'is-first')}>
            {items.length > 1 && <span className="you-num num" aria-hidden>{i + 1}</span>}
            <span className="you-action-text">
              {i === 0 && items.length > 1 && <span className="you-start">Start here</span>}
              {it.text}
            </span>
            <span className="you-action-btns" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className="btn btn-sm you-btn-done"
                aria-label={`Handled: ${it.text}`}
                title={it.subtaskId ? 'Check off this subtask' : "You've handled it. Clears the flag."}
                onClick={() => (it.subtaskId ? store.updateSubtask(task.id, it.subtaskId, { done: true }) : clear(it))}
              >
                <Check size={14} aria-hidden /> Handled
              </button>
              {canAsk && (
                <button
                  type="button"
                  className="btn btn-sm you-btn-ghost"
                  aria-label={`Ask about: ${it.text}`}
                  aria-expanded={open?.key === it.key && open.mode === 'ask'}
                  title="Ask Claude for more on this. It reads the thread that raised it and answers here. It can't change anything."
                  onClick={() => toggle(it.key, 'ask')}
                >
                  <MessageCircleQuestion size={14} aria-hidden /> Ask
                </button>
              )}
              <button
                type="button"
                className="btn btn-sm you-btn-ghost"
                aria-label={`Reply: ${it.text}`}
                aria-expanded={open?.key === it.key && open.mode === 'reply'}
                title="Answer your assistant, or say what's changed. It's saved on the task, where your assistant reads it, and this stops waiting on you."
                onClick={() => toggle(it.key, 'reply')}
              >
                <MessageSquareReply size={14} aria-hidden /> Reply
              </button>
              {it.subtaskId && (
                <button
                  type="button"
                  className="btn btn-sm you-btn-ghost"
                  aria-label={`Not mine: ${it.text}`}
                  title="Not something only you can do. Unflags it and leaves it open."
                  onClick={() => clear(it)}
                >
                  <Undo2 size={14} aria-hidden /> Not mine
                </button>
              )}
            </span>
            {ctx?.detail && <span className="you-detail">{linkify(ctx.detail)}</span>}
            {ctx && <Source ctx={ctx} />}
            {mine.length > 0 && (
              <ul className="you-asks" aria-label="Your questions">
                {mine.map((a) => (
                  <AskRow key={a.id} ask={a} />
                ))}
              </ul>
            )}
            {canAsk && open?.key === it.key && open.mode === 'ask' && (
              <AskBox
                about={it.text}
                hasThread={Boolean(ctx?.sessionId)}
                onCancel={() => setOpen(null)}
                onSend={async (question) => {
                  if (await asks.ask(it.key, question)) setOpen(null);
                }}
              />
            )}
            {open?.key === it.key && open.mode === 'reply' && (
              <ReplyBox
                task={task}
                about={it.text}
                onCancel={() => setOpen(null)}
                onSent={() => {
                  setOpen(null);
                  clear(it);
                }}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** Which thread raised it, when, and a way back into that thread. */
function Source({ ctx }: { ctx: YouContext }) {
  return (
    <span className="you-source" onClick={(e) => e.stopPropagation()}>
      {ctx.threadTitle ? `From “${ctx.threadTitle}”` : 'Flagged'} · {relativeTime(ctx.at)}
      {ctx.resumeCommand && (
        <button
          type="button"
          className="you-link"
          title="Open that thread in the Claude app"
          onClick={() => openThread(ctx.sessionId, ctx.resumeCommand)}
        >
          <SquareTerminal size={12} aria-hidden /> Open thread
        </button>
      )}
    </span>
  );
}

/** Links and file paths in the why, made easy to use. */
export function linkify(text: string): ReactNode {
  // Markdown links, [the thread](https://...), show as their label.
  const md = text.split(/(\[[^\]\n]{1,80}\]\(https?:\/\/[^\s)]+\))/g);
  if (md.length > 1)
    return md.map((m, i) => {
      const hit = i % 2 === 1 ? /^\[([^\]]+)\]\((.+)\)$/.exec(m) : null;
      return hit ? (
        <a key={i} href={hit[2]} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
          {hit[1]}
        </a>
      ) : (
        <Fragment key={i}>{linkify(m)}</Fragment>
      );
    });
  // Folders in the middle of a path may have spaces ("Master Tasker"); the last part may not, and a trailing period isn't part of it.
  const parts = text.split(/(https?:\/\/[^\s)]+[^\s).,]|~?\/(?:[\w.@~-]+(?: [\w.@~-]+)*\/)+[\w.@~-]*[\w@~-])/g);
  return parts.map((p, i) => {
    if (/^https?:\/\//.test(p))
      return (
        <a key={i} href={p} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
          {p.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60)}
        </a>
      );
    if (i % 2 === 1)
      return (
        <code key={i} className="you-path">
          {p}
        </code>
      );
    return <Fragment key={i}>{p}</Fragment>;
  });
}

function useAsks(taskId: string) {
  const [list, setList] = useState<Ask[]>([]);
  const load = () =>
    api<{ asks: Ask[] }>('GET', `/api/tasks/${taskId}/asks`)
      .then((r) => setList(r.asks))
      .catch(() => {});
  useEffect(() => {
    load();
  }, [taskId]);
  // Poll only while Claude is answering.
  const running = list.some((a) => a.status === 'running');
  useEffect(() => {
    if (!running) return;
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [running, taskId]);
  return {
    list,
    ask: async (item: string, question: string) => {
      try {
        const { ask } = await api<{ ask: Ask }>('POST', `/api/tasks/${taskId}/asks`, { item, question }, { idempotencyKey: newKey() });
        setList((l) => [...l, ask]);
        return true;
      } catch (e) {
        // Claude Code went missing since the last check: look again, which hides Ask.
        if (e instanceof ApiError && e.body?.needs === 'claude-code') void store.refreshIntegrations(true);
        store.toast((e as Error).message, 'error');
        return false;
      }
    },
  };
}

/** Just enough Markdown for Claude's answers: paragraphs, lists, **bold** and `code`. */
function inline(text: string): ReactNode {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) return <strong key={i}>{linkify(p.slice(2, -2))}</strong>;
    if (p.startsWith('`') && p.endsWith('`')) return <code key={i} className="you-path">{p.slice(1, -1)}</code>;
    return <Fragment key={i}>{linkify(p)}</Fragment>;
  });
}
function Answer({ text }: { text: string }) {
  const blocks = text.trim().split(/\n{2,}/);
  return (
    <>
      {blocks.map((b, i) => {
        const lines = b.split('\n');
        const list = lines.every((l) => /^\s*(?:[-*]|\d+\.)\s+/.test(l));
        if (!list) return <p key={i}>{inline(b)}</p>;
        const Tag = /^\s*\d+\./.test(lines[0]) ? 'ol' : 'ul';
        return (
          <Tag key={i}>
            {lines.map((l, j) => (
              <li key={j}>{inline(l.replace(/^\s*(?:[-*]|\d+\.)\s+/, ''))}</li>
            ))}
          </Tag>
        );
      })}
    </>
  );
}

function AskRow({ ask }: { ask: Ask }) {
  const long = ask.answer.length > 320;
  const [more, setMore] = useState(false);
  return (
    <li className={`you-ask is-${ask.status}`}>
      <span className="you-ask-q">You asked: {ask.question}</span>
      {ask.status === 'running' ? (
        <span className="you-ask-a is-thinking">
          <Loader2 size={13} className="spin" aria-hidden /> Claude is reading the thread. This takes about a minute.
        </span>
      ) : ask.status === 'error' ? (
        <span className="you-ask-a">Couldn't answer: {ask.answer}</span>
      ) : (
        <>
          <div className={`you-ask-a${long && !more ? ' is-clipped' : ''}`}>
            <Answer text={ask.answer} />
          </div>
          {long && (
            <button type="button" className="you-link" aria-expanded={more} onClick={(e) => (e.stopPropagation(), setMore(!more))}>
              {more ? 'Show less' : 'Show more'}
            </button>
          )}
        </>
      )}
    </li>
  );
}

function AskBox({ about, hasThread, onCancel, onSend }: { about: string; hasThread: boolean; onCancel: () => void; onSend: (q: string) => Promise<void> }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    const q = text.trim();
    if (!q || busy) return;
    setBusy(true);
    await onSend(q);
    setBusy(false);
  };
  return (
    <div className="you-reply" onClick={(e) => e.stopPropagation()}>
      <textarea
        className="you-reply-input"
        aria-label={`Ask about ${about}`}
        placeholder="e.g. Where is the comparison, and what would you do?"
        value={text}
        rows={2}
        autoFocus
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e: KeyboardEvent) => {
          e.stopPropagation();
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send();
          if (e.key === 'Escape') onCancel();
        }}
      />
      <span className="you-reply-hint">
        {hasThread ? 'Claude reads the thread that raised this and answers here.' : 'Claude reads this task and answers here.'} Read-only: it can't change anything.
      </span>
      <span className="you-action-btns">
        <button type="button" className="btn btn-sm you-btn-done" disabled={!text.trim() || busy} onClick={() => void send()}>
          Ask <kbd>⌘↵</kbd>
        </button>
        <button type="button" className="btn btn-sm you-btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </span>
    </div>
  );
}

/**
 * Save reply: your answer is saved as a note on the task, where your assistant reads it, and the item stops waiting
 * on you. It flags it again if it still needs you. Copy reply copies it, only when you press it, to paste into its chat.
 */
function ReplyBox({ task, about, onCancel, onSent }: { task: Task; about: string; onCancel: () => void; onSent: () => void }) {
  const [text, setText] = useState('');
  const save = () => {
    const reply = text.trim();
    if (!reply) return;
    store.appendNote(task.id, `You replied to "${about}": ${reply}`);
    store.toast('Reply saved on the task. Your assistant reads it the next time it reads the task.', 'success');
    onSent();
  };
  const copy = async () => {
    const reply = text.trim();
    if (!reply) return;
    const copied = await copyText(`Master Tasker task ${task.id}, re "${about}":\n${reply}`);
    store.toast(copied ? "Reply copied. Paste it into your assistant's chat to tell it now." : 'Could not copy. Your browser blocked the clipboard.', copied ? 'success' : 'error');
  };
  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
    if (e.key === 'Escape') onCancel();
  };
  return (
    <div className="you-reply" onClick={(e) => e.stopPropagation()}>
      <textarea
        className="you-reply-input"
        aria-label={`Reply about ${about}`}
        placeholder="e.g. The wider one. Use it for the hero."
        value={text}
        rows={2}
        autoFocus
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
      />
      <span className="you-action-btns">
        <button type="button" className="btn btn-sm you-btn-done" disabled={!text.trim()} onClick={save}>
          Save reply <kbd>⌘↵</kbd>
        </button>
        <button type="button" className="btn btn-sm you-btn-ghost" disabled={!text.trim()} title="Copies your reply, to paste into your assistant's chat while it's working" onClick={() => void copy()}>
          <Copy size={14} aria-hidden /> Copy reply
        </button>
        <button type="button" className="btn btn-sm you-btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </span>
    </div>
  );
}
