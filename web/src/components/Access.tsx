// Settings > AI assistants > Assistants with access: every connection, what it can see and do, and Pause, Change
// access, Remove access and Show settings. Advanced has the form that adds access for a script. TokenReveal, the
// settings to paste for one connection, is shared with the app picker above it (Connect.tsx).
import { Check, Copy, Pause, Play, ShieldOff, SlidersHorizontal } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { PERMISSIONS, type Area, type ClientInfo, type ClientScopes, type Permission } from '../../../shared/schema.ts';
import { api, newKey } from '../api.ts';
import { agentForName, hasCheckedIn } from '../assistants.ts';
import { copyText, cx, relativeTime } from '../lib.ts';
import { AGENT_IDS, AGENT_LABEL, agentSnippets, type AssistantAppId } from '../snippets.ts';
import { store, useClients, useIntegrations, useStore } from '../store.ts';
import { onRadioKeys, radioTab } from './Bits.tsx';
import { confirmDialog } from './Menu.tsx';

export const PERM_LABEL: Record<Permission, string> = { read: 'Read', create: 'Create tasks', update: 'Edit and add notes', complete: 'Complete and reopen', propose: 'Propose changes', start: 'Move tasks into In progress' };

/** "a", "a and b", "a, b and c". */
const list = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** What a connection can see, in plain words. */
export function seesLine(s: ClientScopes, areas: Area[]): string {
  if (s.areas === '*') return s.unfiled ? 'Can see all areas' : 'Can see all areas, not unfiled Inbox items';
  const names = s.areas.map((id) => areas.find((a) => a.id === id)?.name ?? 'a deleted area');
  if (s.unfiled) names.push('unfiled Inbox items');
  return names.length ? `Can see ${list(names)}` : "Can't see any tasks";
}

/** What a connection can do, in plain words. Moving a task into In progress counts as editing it. */
export function canLine(perms: Permission[]): string {
  const has = (p: Permission) => perms.includes(p);
  const words: string[] = [];
  if (has('read')) words.push('read');
  if (has('propose')) words.push('suggest');
  if (has('create')) words.push('create tasks');
  if (has('update')) words.push('edit');
  if (has('complete')) words.push('complete');
  if (has('start') && !has('update')) words.push('start tasks');
  if (!words.length) return "Can't do anything yet";
  if (words[words.length - 1] === 'suggest') words[words.length - 1] = 'suggest changes';
  return `Can ${list(words)}`;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Assistants with access. `onBusy` says when a form or a new connection's settings are open here, so the picker
 * above keeps its button quiet and the page has one filled button.
 */
export function AccessList({ onBusy }: { onBusy: (busy: boolean) => void }) {
  const clients = useClients();
  const { areas } = useStore();
  const [editing, setEditing] = useState<string | null>(null);
  const [created, setCreated] = useState<{ client: ClientInfo; token: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const busy = editing !== null || created !== null || adding;
  useEffect(() => onBusy(busy), [busy, onBusy]);
  const patch = async (c: ClientInfo, body: unknown) => {
    try {
      await api('PATCH', `/api/clients/${c.id}`, body, { idempotencyKey: newKey() });
    } catch (e) {
      store.toast((e as Error).message, 'error');
    }
    void store.refreshClients();
  };
  const remove = async (c: ClientInfo) => {
    const ok = await confirmDialog({
      title: `Remove access for “${c.name}”?`,
      body: <p>It stops working right away. You can connect it again any time.</p>,
      confirmLabel: 'Remove access',
      danger: true,
    });
    if (!ok.ok) return;
    try {
      await api('POST', `/api/clients/${c.id}/revoke`, {}, { idempotencyKey: newKey() });
    } catch (e) {
      store.toast((e as Error).message, 'error');
    }
    void store.refreshClients();
    // It might be the one Claude Code or Claude Desktop uses.
    void store.refreshIntegrations(true);
  };
  const closeForm = () => {
    setAdding(false);
    setFormKey((k) => k + 1);
  };
  const live = (clients ?? []).filter((c) => !c.revokedAt);
  return (
    <section className="assistants-access" aria-labelledby="s-access" id="assistants-access">
      <h3 id="s-access" className="access-title" tabIndex={-1}>
        Assistants with access
      </h3>
      <p className="section-intro">Each one sees only the areas you pick and does only what you allow. What it changes shows its name.</p>
      {clients && live.length === 0 && <p className="meta-line">No assistant has access yet. Nothing outside this app can read or change your tasks.</p>}
      {live.length > 0 && (
        <ul className="cards access-list">
          {live.map((c) =>
            editing === c.id ? (
              <li key={c.id}>
                <ConnectionForm
                  existing={c}
                  primary={!created}
                  onCancel={() => setEditing(null)}
                  onSaved={() => {
                    setEditing(null);
                    void store.refreshClients();
                  }}
                />
              </li>
            ) : (
              <li key={c.id} className="card access-row">
                <div className="access-head">
                  <span className="access-name">{c.name}</span>
                  {c.paused && <span className="chip chip-warning">Paused</span>}
                </div>
                <p className="meta-line">
                  {seesLine(c.scopes, areas)} · {canLine(c.scopes.perms)}
                </p>
                {!c.paused && !hasCheckedIn(c) && (
                  <p className="meta-line">
                    {c.tokenFile
                      ? `${c.name} hasn't used it yet. Paste its settings into ${c.name} (Show settings), then quit and reopen ${c.name}.`
                      : `${c.name} hasn't used it yet.`}
                  </p>
                )}
                <details className="detail-more access-details">
                  <summary>Details</summary>
                  <p className="meta-line num" title="Each one has a daily limit, so a runaway assistant can't flood your tasks.">
                    Today: {count(c.usageToday.writes, 'change', 'changes')}, {count(c.usageToday.proposals, 'suggestion', 'suggestions')}. Daily limits:{' '}
                    {count(c.limits.writesPerDay, 'change', 'changes')}, {count(c.limits.proposalsPerDay, 'suggestion', 'suggestions')}.
                  </p>
                  <p className="meta-line">{c.lastUsedAt ? `Last used ${relativeTime(c.lastUsedAt)}.` : 'Not used yet.'}</p>
                </details>
                <div className="card-foot">
                  <button type="button" className="btn btn-secondary btn-sm" aria-label={`${c.paused ? 'Resume' : 'Pause'} ${c.name}`} onClick={() => void patch(c, { paused: !c.paused })}>
                    {c.paused ? <Play size={14} aria-hidden /> : <Pause size={14} aria-hidden />} {c.paused ? 'Resume' : 'Pause'}
                  </button>
                  <button type="button" className="btn btn-secondary btn-sm" aria-label={`Change access for ${c.name}`} onClick={() => setEditing(c.id)}>
                    <SlidersHorizontal size={14} aria-hidden /> Change access
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm btn-danger-text" aria-label={`Remove access for ${c.name}`} onClick={() => void remove(c)}>
                    <ShieldOff size={14} aria-hidden /> Remove access
                  </button>
                  <ConnectionSettings client={c} />
                </div>
              </li>
            ),
          )}
        </ul>
      )}
      {created && <TokenReveal token={created.token} client={created.client} agent="other" onDone={() => setCreated(null)} />}
      <details className="detail-more access-advanced" open={adding} onToggle={(e) => setAdding(e.currentTarget.open)}>
        <summary>Advanced</summary>
        <div className="access-script">
          <h4 className="claude-step-title">Add access for a script</h4>
          <p className="meta-line">For a script, or an app that isn't in the list above. Pick what it can see and do, then copy the settings it shows.</p>
          <ConnectionForm
            key={formKey}
            primary={!created && editing === null}
            onCancel={closeForm}
            onSaved={(r) => {
              closeForm();
              if (r.token) setCreated({ client: r.client, token: r.token });
              void store.refreshClients();
            }}
          />
        </div>
      </details>
    </section>
  );
}

/** The tab a connection's settings open on: from its name, else what the caller suggests, else from its kind. */
export const settingsTabFor = (client: Pick<ClientInfo, 'name' | 'kind'>, suggested?: AssistantAppId): AssistantAppId =>
  agentForName(client.name) ?? suggested ?? (client.kind === 'claude' ? 'claude-code' : 'other');

/**
 * Show settings: a connection's settings again, ready to paste, for any connection with a token file. They name the
 * file, never the token, so they're safe to show any time.
 */
export function ConnectionSettings({ client }: { client: ClientInfo }) {
  const [open, setOpen] = useState(false);
  if (!client.tokenFile || client.revokedAt) return null;
  return (
    <>
      <button type="button" className="btn btn-secondary btn-sm" aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} settings for ${client.name}`} onClick={() => setOpen((o) => !o)}>
        <Copy size={14} aria-hidden /> {open ? 'Hide settings' : 'Show settings'}
      </button>
      {open && (
        <div className="connect-settings-again">
          <TokenReveal client={client} onDone={() => setOpen(false)} />
        </div>
      )}
    </>
  );
}

/**
 * Settings for each app, ready to paste. They name the connection's token file. With `token` (only right after the
 * connection is made), the token itself can be shown once, on request. The tab starts at the app the connection's
 * name says, then `agent`, then its kind. `primary` fills its button, unless something else on the page has the
 * filled one.
 */
export function TokenReveal({ token, client, agent: suggested, primary = true, onDone }: { token?: string; client: ClientInfo; agent?: AssistantAppId; primary?: boolean; onDone: () => void }) {
  const i = useIntegrations();
  const [agent, setAgent] = useState<AssistantAppId>(() => settingsTabFor(client, suggested));
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (what: string, text: string) => {
    if (await copyText(text)) setCopied(what);
    else store.toast('Could not copy. Your browser blocked the clipboard.', 'error');
  };
  const snippets = i && client.tokenFile ? agentSnippets(client.tokenFile, i.paths) : [];
  const shown = snippets.find((s) => s.id === agent);
  return (
    <div className="card token-card" role="region" aria-label={`Settings for ${client.name}`}>
      <p className="card-title">{token ? `“${client.name}” is ready` : `Settings for “${client.name}”`}</p>
      <p className="meta-line">
        {token ? 'Copy its settings into the app. ' : ''}They name a private file on this Mac, readable only by you, that lets the app in. Nothing secret goes in the app's settings or your Terminal history.
        {token && client.tokenFile ? ' You can show these settings again any time.' : ''}
      </p>
      {shown && (
        <>
          <div className="segmented agent-tabs" role="radiogroup" aria-label="Settings for" onKeyDown={(e) => onRadioKeys(e, AGENT_IDS, agent, setAgent)}>
            {AGENT_IDS.map((a, n) => (
              <button key={a} type="button" role="radio" aria-checked={agent === a} tabIndex={radioTab(agent === a, n === 0, true)} className={cx('seg', agent === a && 'is-on')} onClick={() => setAgent(a)}>
                {AGENT_LABEL[a]}
              </button>
            ))}
          </div>
          <p className="meta-line">{shown.where}</p>
          <div className="token-row">
            <pre className="token mono snippet" aria-label={`${shown.label} settings`}>{shown.text}</pre>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void copy(shown.id, shown.text)}>
              {copied === shown.id ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />} {copied === shown.id ? 'Copied' : 'Copy'}
            </button>
          </div>
        </>
      )}
      {token && (
        <details className="detail-more" open={!shown || undefined}>
          <summary>Show token</summary>
          <p className="meta-line">Only for an app that needs the token itself. This is the only time it's shown. If you lose it, remove this access and connect again.</p>
          <div className="token-row">
            <code className="token mono">{token}</code>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void copy('token', token)}>
              {copied === 'token' ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />} {copied === 'token' ? 'Copied' : 'Copy'}
            </button>
          </div>
        </details>
      )}
      <button type="button" className={cx('btn btn-sm', token && primary ? 'btn-primary' : 'btn-secondary')} onClick={onDone}>
        {token ? 'I saved it' : 'Done'}
      </button>
    </div>
  );
}

/**
 * Access for a script, or changing what a connection can see and do. A new one starts with every area, including
 * ones you add later, and can read and suggest changes.
 */
export function ConnectionForm({ existing, primary = true, onCancel, onSaved }: { existing?: ClientInfo; primary?: boolean; onCancel: () => void; onSaved: (r: { client: ClientInfo; token?: string }) => void }) {
  const { areas } = useStore();
  const [name, setName] = useState(existing?.name ?? '');
  const [all, setAll] = useState(existing ? existing.scopes.areas === '*' : true);
  const [areaIds, setAreaIds] = useState<string[]>(existing && existing.scopes.areas !== '*' ? existing.scopes.areas : []);
  const [unfiled, setUnfiled] = useState(existing?.scopes.unfiled ?? true);
  const [perms, setPerms] = useState<Permission[]>(existing?.scopes.perms ?? ['read', 'propose']);
  const [error, setError] = useState<string | null>(null);
  const whyId = useId();
  const why = !name.trim()
    ? 'Give it a name first.'
    : perms.length === 0
      ? 'Pick at least one thing it can do.'
      : !all && areaIds.length === 0 && !unfiled
        ? 'Pick at least one area, or unfiled Inbox items.'
        : null;
  const submit = async () => {
    if (why) return;
    const scopes = { areas: all ? ('*' as const) : areaIds, unfiled, perms };
    try {
      if (existing) {
        const r = await api<{ client: ClientInfo }>('PATCH', `/api/clients/${existing.id}`, { name, scopes }, { idempotencyKey: newKey() });
        onSaved(r);
      } else {
        const r = await api<{ client: ClientInfo; token: string }>('POST', '/api/clients', { name, kind: 'other', scopes, tokenFile: true }, { idempotencyKey: newKey() });
        onSaved(r);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <form className="card form" aria-label={existing ? `Change ${existing.name}` : 'Add access for a script'} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="field-grid">
        <label className="field">
          <span className="field-label eyebrow">Name</span>
          <input className="input" value={name} required maxLength={60} placeholder={existing ? undefined : 'e.g. Backup script'} onChange={(e) => setName(e.target.value)} />
        </label>
      </div>
      <fieldset className="fieldset">
        <legend className="field-label eyebrow">Areas it can see</legend>
        <div className="checks">
          <label className="check-label">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> All areas
          </label>
          {!all &&
            areas.filter((a) => !a.archived).map((a) => (
              <label key={a.id} className="check-label">
                <input type="checkbox" checked={areaIds.includes(a.id)} onChange={(e) => setAreaIds((x) => (e.target.checked ? [...x, a.id] : x.filter((y) => y !== a.id)))} /> {a.name}
              </label>
            ))}
          <label className="check-label">
            <input type="checkbox" checked={unfiled} onChange={(e) => setUnfiled(e.target.checked)} /> Unfiled Inbox items
          </label>
        </div>
        {all && <p className="meta-line">New areas are included.</p>}
      </fieldset>
      <fieldset className="fieldset">
        <legend className="field-label eyebrow">What it can do</legend>
        <div className="checks">
          {PERMISSIONS.map((p) => (
            <label key={p} className="check-label">
              <input type="checkbox" checked={perms.includes(p)} onChange={(e) => setPerms((x) => (e.target.checked ? [...x, p] : x.filter((y) => y !== p)))} /> {PERM_LABEL[p]}
            </label>
          ))}
        </div>
      </fieldset>
      {error && <p className="field-warning" role="alert">{error}</p>}
      <div className="card-foot">
        {why && (
          <span className="meta-line" id={whyId}>
            {why}
          </span>
        )}
        <div className="detail-head-spacer" />
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className={cx('btn', primary ? 'btn-primary' : 'btn-secondary')} disabled={!!why} aria-describedby={why ? whyId : undefined}>
          {existing ? 'Save changes' : 'Add access'}
        </button>
      </div>
    </form>
  );
}
