import { Check, ExternalLink, SquareTerminal, Undo2 } from 'lucide-react';
import type { Task } from '../../../shared/schema.ts';
import { relativeTime } from '../lib.ts';
import { linkify } from './NeedsYou.tsx';
import { store } from '../store.ts';
import { openThread, resumeFor } from '../claude.ts';

/** Tasks an assistant marked done that you haven't looked at yet: what got done, who did it, and Got it or Reopen. */
export function FinishedList({ tasks, onOpen }: { tasks: Task[]; onOpen: (id: string) => void }) {
  if (!tasks.length) return null;
  return (
    <div className="finished">
      <ul className="finished-list">
        {tasks.map((t) => {
          const f = t.finishedBy!;
          return (
            <li key={t.id} className="finished-item">
              <div className="finished-head">
                <button type="button" className="finished-title" onClick={() => onOpen(t.id)}>
                  {t.title}
                </button>
                {t.isSample && <span className="sample-mark">Sample</span>}
              </div>
              <p className="finished-why">{f.why ? linkify(f.why) : 'Every subtask is done.'}</p>
              <div className="finished-foot">
                <span className="meta-line">
                  {f.by.trim() || 'Your assistant'} · {relativeTime(f.at)}
                </span>
                {f.link && (
                  <a className="link" href={f.link} target="_blank" rel="noreferrer noopener">
                    <ExternalLink size={13} aria-hidden /> Proof
                  </a>
                )}
                {resumeFor(f.sessionId) && (
                  <button type="button" className="link-btn" onClick={() => openThread(f.sessionId, resumeFor(f.sessionId))}>
                    <SquareTerminal size={13} aria-hidden /> Thread ready to archive · Open
                  </button>
                )}
                <span className="finished-actions">
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => store.reopen(t.id)}>
                    <Undo2 size={14} aria-hidden /> Reopen
                  </button>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => store.seenFinished(t.id)}>
                    <Check size={14} aria-hidden /> Got it
                  </button>
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
