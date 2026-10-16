// Small shared pieces: a ⋯ menu (WAI-ARIA menu button) and the app's own confirm dialog.
import { ChevronDown } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../lib.ts';

export type MenuEntry =
  | { label: string; icon?: ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean; checked?: boolean; hint?: string }
  | { separator: true }
  | { heading: string }
  | { render: (close: () => void) => ReactNode; key: string };

/**
 * A button that opens a menu. Arrow keys move, Enter or Space picks, Esc closes and puts focus back.
 * The menu is portaled and fixed, so it is never clipped by a scrolling sidebar or card.
 */
export function Menu({ label, trigger, items, className, align = 'end', onOpenChange, triggerProps, buttonLabel, tooltip, plain = false }: {
  /** Names the menu, and the button unless buttonLabel says otherwise. */
  label: string;
  trigger: ReactNode;
  items: MenuEntry[] | (() => MenuEntry[]);
  className?: string;
  align?: 'start' | 'end';
  onOpenChange?: (open: boolean) => void;
  triggerProps?: React.ButtonHTMLAttributes<HTMLButtonElement> & { 'data-roving'?: string };
  /** The button's name, when it should say more than the menu's, like "Priority: High". */
  buttonLabel?: string;
  /** The hover text. Defaults to the label; false for none, when the button already shows its words. */
  tooltip?: string | false;
  /** Not an icon button: the class names in className are the whole look. */
  plain?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const set = (v: boolean) => {
    setOpen(v);
    onOpenChange?.(v);
  };
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={cx(!plain && 'icon-btn menu-trigger', className)}
        aria-label={buttonLabel ?? label}
        title={tooltip === false ? undefined : tooltip ?? label}
        aria-haspopup="menu"
        aria-expanded={open}
        {...triggerProps}
        onClick={(e) => {
          e.stopPropagation();
          set(!open);
        }}
        onKeyDown={(e) => {
          triggerProps?.onKeyDown?.(e);
          if (e.defaultPrevented) return;
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            e.stopPropagation();
            set(true);
          }
          // Esc closes the menu, not the panel or page it sits in.
          if (e.key === 'Escape' && open) {
            e.preventDefault();
            e.stopPropagation();
            set(false);
          }
        }}
      >
        {trigger}
      </button>
      {open && btn.current && (
        <MenuPopup
          anchor={btn.current}
          label={label}
          align={align}
          items={typeof items === 'function' ? items() : items}
          onClose={(refocus) => {
            set(false);
            if (refocus) btn.current?.focus();
          }}
        />
      )}
    </>
  );
}

function MenuPopup({ anchor, label, items, align, onClose }: { anchor: HTMLElement; label: string; items: MenuEntry[]; align: 'start' | 'end'; onClose: (refocus: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const el = ref.current!;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = align === 'end' ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = r.bottom + 4;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4);
    setPos({ top, left });
  }, [anchor, align]);
  // Focus the checked item, or the first, once the menu is placed and shown: a hidden element can't take focus.
  useEffect(() => {
    if (!pos) return;
    const el = ref.current;
    (el?.querySelector<HTMLElement>('[role^="menuitem"][aria-checked="true"]:not([disabled])') ?? el?.querySelector<HTMLElement>('[role^="menuitem"]:not([disabled])'))?.focus();
  }, [pos !== null]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose(false);
    };
    const away = () => onClose(false);
    document.addEventListener('pointerdown', down, true);
    window.addEventListener('resize', away);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      window.removeEventListener('resize', away);
    };
  }, [anchor, onClose]);
  const onKey = (e: React.KeyboardEvent) => {
    const all = [...(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled]), [data-menu-focus]') ?? [])];
    const i = all.indexOf(document.activeElement as HTMLElement);
    const go = (j: number) => all[(j + all.length) % all.length]?.focus();
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(all.length - 1);
    else if (e.key === 'Escape') onClose(true);
    else if (e.key === 'Tab') onClose(false);
    // Other keys stay in the menu: the app's own shortcuts (X, J, 1 to 5) must not act on the task behind it.
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape'].includes(e.key)) e.preventDefault();
    e.stopPropagation();
  };
  return createPortal(
    <div
      ref={ref}
      className="menu"
      role="menu"
      aria-label={label}
      style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden', top: 0, left: 0 }}
      onKeyDown={onKey}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((it, i) => {
        if ('separator' in it) return <div key={`s${i}`} className="menu-sep" role="separator" />;
        if ('heading' in it) return <div key={`h${i}`} className="menu-heading eyebrow">{it.heading}</div>;
        if ('render' in it) return <div key={it.key}>{it.render(() => onClose(true))}</div>;
        return (
          <button
            key={it.label}
            type="button"
            role={it.checked === undefined ? 'menuitem' : 'menuitemradio'}
            aria-checked={it.checked}
            className={cx('menu-item', it.danger && 'is-danger')}
            disabled={it.disabled}
            tabIndex={-1}
            onClick={() => {
              onClose(true);
              it.onSelect();
            }}
          >
            {it.icon}
            <span className="menu-label">{it.label}</span>
            {it.hint && <span className="menu-hint">{it.hint}</span>}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
}

/**
 * The app's own select: a button that shows the choice and opens a menu of the others, the checked one first in focus.
 * Used wherever a native select would look out of place (status, priority, filters).
 */
export function SelectMenu<T extends string>({ label, value, options, onChange, className, align = 'start', display }: {
  label: string;
  /** null: nothing chosen, as in "Move to…". */
  value: T | null;
  options: SelectOption<T>[];
  onChange: (v: T) => void;
  className?: string;
  align?: 'start' | 'end';
  /** What the button shows, when it differs from the option's label (e.g. "Move to…"). */
  display?: ReactNode;
}) {
  const current = options.find((o) => o.value === value);
  return (
    <Menu
      plain
      label={label}
      buttonLabel={current && display === undefined ? `${label}: ${current.label}` : label}
      tooltip={false}
      align={align}
      className={cx('select-btn', className)}
      trigger={
        <>
          {display === undefined && current?.icon}
          <span className="select-btn-value">{display ?? current?.label}</span>
          <ChevronDown size={14} aria-hidden className="select-btn-chev" />
        </>
      }
      items={options.map((o) => ({ label: o.label, icon: o.icon, checked: o.value === value, onSelect: () => o.value !== value && onChange(o.value) }))}
    />
  );
}

// ─── Confirm: the app's own dialog, never window.confirm ───

export interface ConfirmOptions {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  /** A choice to make before confirming, such as where an area's tasks go. */
  choice?: { label: string; options: { value: string; label: string }[]; value: string };
}
type ConfirmRequest = ConfirmOptions & { resolve: (r: { ok: boolean; value?: string }) => void };

let current: ConfirmRequest | null = null;
const listeners = new Set<() => void>();
const setCurrent = (r: ConfirmRequest | null) => {
  current = r;
  listeners.forEach((fn) => fn());
};

/** Ask before something that can't be undone. Resolves with ok, and the choice when there is one. */
export function confirmDialog(o: ConfirmOptions): Promise<{ ok: boolean; value?: string }> {
  current?.resolve({ ok: false });
  return new Promise((resolve) => setCurrent({ ...o, resolve }));
}

export function ConfirmHost() {
  const req = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => current,
  );
  const ref = useRef<HTMLDialogElement>(null);
  const back = useRef<HTMLElement | null>(null);
  const [value, setValue] = useState('');
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (req && !d.open) {
      back.current = document.activeElement as HTMLElement | null;
      setValue(req.choice?.value ?? '');
      d.showModal();
    }
    if (!req && d.open) d.close();
  }, [req]);
  const finish = (ok: boolean) => {
    const r = current;
    setCurrent(null);
    r?.resolve({ ok, value: r.choice ? value : undefined });
    requestAnimationFrame(() => back.current?.isConnected && back.current.focus());
  };
  return (
    <dialog ref={ref} className="dialog dialog-small" aria-labelledby="confirm-title" onCancel={(e) => { e.preventDefault(); finish(false); }}>
      {req && (
        <form onSubmit={(e) => { e.preventDefault(); finish(true); }}>
          <h2 id="confirm-title" className="dialog-title">{req.title}</h2>
          <div className="dialog-body">{req.body}</div>
          {req.choice && (
            <label className="field">
              <span className="field-label">{req.choice.label}</span>
              <select className="select" value={value} onChange={(e) => setValue(e.target.value)}>
                {req.choice.options.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </label>
          )}
          <div className="dialog-actions">
            <button type="button" className="btn btn-secondary" onClick={() => finish(false)} autoFocus>
              Cancel
            </button>
            <button type="submit" className={cx('btn', req.danger ? 'btn-danger' : 'btn-primary')}>
              {req.confirmLabel}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
