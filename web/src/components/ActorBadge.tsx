import { Bot, Cog, ShieldCheck, User } from 'lucide-react';
import type { Actor } from '../../../shared/schema.ts';
import { cx } from '../lib.ts';

/**
 * Who made a change. The label comes from the verified identity (your browser, or a connection token).
 * A name the caller typed about itself is shown separately and marked unverified.
 */
export function ActorBadge({ actor }: { actor: Actor }) {
  const icon = actor.kind === 'user' ? <User size={12} aria-hidden /> : actor.kind === 'system' ? <Cog size={12} aria-hidden /> : <Bot size={12} aria-hidden />;
  const verified = actor.kind === 'client';
  return (
    <span className={cx('actor', `actor-${actor.kind}`, actor.clientKind && `actor-${actor.clientKind}`)}>
      {icon}
      <span>{actor.label}</span>
      {verified && (
        <span className="actor-verified" title="Verified: it used its own access">
          <ShieldCheck size={12} aria-label="verified" />
        </span>
      )}
      {actor.claimedName && actor.claimedName !== actor.label && (
        <span className="actor-claim" title="Name supplied by the caller. Not verified.">
          says “{actor.claimedName}”
        </span>
      )}
    </span>
  );
}
