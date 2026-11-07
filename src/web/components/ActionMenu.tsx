import { Check, ChevronRight } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

import type { Choice, MenuEntry } from '../lib/actions';
import { hasKeyboard, keyText } from '../lib/keyboard';
import { Modal } from './Modal';
import { Sheet } from './Sheet';

/** Where a menu opens on a computer: at a point (a right-click), or under an element (⋯, a title's ▾). */
export type MenuAnchor = { x: number; y: number } | Element;

/** Kept clear of the window's edges. */
const EDGE = 8;

type Place = { left: number; top: number };

/** A panel `width` × `height` placed at a point, or under an element, turned back from an edge it would cross. */
export function place(at: MenuAnchor | null | undefined, width: number, height: number): Place {
  const maxLeft = Math.max(EDGE, innerWidth - width - EDGE);
  const maxTop = Math.max(EDGE, innerHeight - height - EDGE);
  if (!at || (at instanceof Element && !at.isConnected)) return { left: Math.min(maxLeft, Math.max(EDGE, (innerWidth - width) / 2)), top: Math.min(maxTop, 96) };
  if (at instanceof Element) {
    const r = at.getBoundingClientRect();
    const left = r.left + width > innerWidth - EDGE ? r.right - width : r.left;
    const below = r.bottom + 4;
    const top = below + height > innerHeight - EDGE && r.top - 4 - height >= EDGE ? r.top - 4 - height : below;
    return { left: Math.min(maxLeft, Math.max(EDGE, left)), top: Math.min(maxTop, Math.max(EDGE, top)) };
  }
  const left = at.x + width > innerWidth - EDGE ? at.x - width : at.x;
  const top = at.y + height > innerHeight - EDGE ? at.y - height : at.y;
  return { left: Math.min(maxLeft, Math.max(EDGE, left)), top: Math.min(maxTop, Math.max(EDGE, top)) };
}

/**
 * Places a panel by its size: at once, and again at the next frame where it had none yet (the
 * dialog it is in is shown after its children are laid out). Gives back what cancels the wait.
 */
function measured(el: HTMLElement | null, then: (el: HTMLElement) => void): (() => void) | undefined {
  if (!el) return undefined;
  then(el);
  if (el.offsetHeight > 0) return undefined;
  const frame = requestAnimationFrame(() => then(el));
  return () => cancelAnimationFrame(frame);
}

/** A submenu beside the row it opens from, on the side with room. */
function besideRow(row: Element, width: number, height: number): Place {
  const r = row.getBoundingClientRect();
  const left = r.right + 4 + width > innerWidth - EDGE ? r.left - 4 - width : r.right + 4;
  return { left: Math.max(EDGE, left), top: Math.min(Math.max(EDGE, innerHeight - height - EDGE), Math.max(EDGE, r.top - 4)) };
}

/**
 * A panel of its own at an element on a computer (the context ring's), as a menu opens: Esc, a
 * click or a scroll outside it closes it, and focus goes back where it was.
 */
export function Popover({ open, onClose, at, label, children, className = '' }: { open: boolean; onClose: () => void; at: Element | null; label: string; children: ReactNode; className?: string }) {
  const panel = useRef<HTMLDivElement>(null);
  const outside = useRef(false);
  const [where, setWhere] = useState<Place>();
  useLayoutEffect(() => {
    if (!open) return undefined;
    return measured(panel.current, (el) => setWhere(place(at, el.offsetWidth, el.offsetHeight)));
  }, [open, at]);
  return (
    <Modal open={open} onClose={onClose} label={label}>
      <div
        className="absolute inset-0"
        onPointerDown={() => {
          outside.current = true;
        }}
        onClick={() => outside.current && onClose()}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
        onWheel={onClose}
      />
      <div
        ref={panel}
        role="dialog"
        aria-label={label}
        tabIndex={-1}
        data-autofocus
        style={where ?? { visibility: 'hidden', left: 0, top: 0 }}
        className={`animate-fade fixed max-h-[calc(100%-16px)] overflow-y-auto overscroll-contain rounded-2xl border border-line bg-panel shadow-xl outline-none transition-opacity duration-100 group-data-closing/modal:opacity-0 ${className}`}
      >
        {children}
      </div>
    </Modal>
  );
}

const items = (menu: HTMLElement | null) => [...(menu?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];

/**
 * Up and down through a menu's items, wrapping; Home and End; a letter goes to the next item that
 * starts with it. Whether the key was a menu's.
 */
function moveFocus(e: KeyboardEvent, menu: HTMLElement | null): boolean {
  const all = items(menu);
  if (all.length === 0) return false;
  const at = all.indexOf(document.activeElement as HTMLElement);
  let next: HTMLElement | undefined;
  if (e.key === 'ArrowDown') next = all[(at + 1) % all.length];
  else if (e.key === 'ArrowUp') next = all[at <= 0 ? all.length - 1 : at - 1];
  else if (e.key === 'Home') next = all[0];
  else if (e.key === 'End') next = all.at(-1);
  else if (e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
    const letter = e.key.toLowerCase();
    const after = [...all.slice(at + 1), ...all.slice(0, at + 1)];
    next = after.find((item) => item.textContent?.trim().toLowerCase().startsWith(letter));
  }
  if (!next) return false;
  e.preventDefault();
  next.focus({ preventScroll: true });
  return true;
}

/** A choice of a few, as a light track with the one chosen raised: the transcript view. */
function Choices({ choice, label, tall }: { choice: Choice; label: string; tall: boolean }) {
  return (
    <div role="group" aria-label={label} className="grid auto-cols-fr grid-flow-col gap-0.5 rounded-full bg-chip p-0.5">
      {choice.options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="menuitemradio"
          aria-checked={option.value === choice.value}
          onClick={() => choice.choose(option.value)}
          className={`grid min-w-0 place-items-center rounded-full px-1 outline-none focus-visible:ring-1 focus-visible:ring-faint ${tall ? 'h-10 text-[14px]' : 'h-7 text-[12.5px]'} ${option.value === choice.value ? 'bg-panel font-medium text-fg shadow-[0_1px_3px_rgba(0,0,0,0.10)]' : 'text-muted hover:text-fg'}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * What a long press opened the sheet for, raised over the dimmed page where it was: a copy of it,
 * on the panel's color, which takes no taps. The thing itself stays where it is, under the dim.
 */
function Lifted({ element }: { element: Element }) {
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !element.isConnected) return;
    const copy = element.cloneNode(true) as HTMLElement;
    for (const node of [copy, ...copy.querySelectorAll('[id]')]) node.removeAttribute('id');
    const r = element.getBoundingClientRect();
    // Its own size, whatever sized it where it was (a bubble is 85% of its column there).
    Object.assign(copy.style, { margin: '0', backgroundColor: 'transparent', width: `${r.width}px`, height: `${r.height}px`, maxWidth: 'none', minWidth: '0' });
    // Something with no color of its own (a row, a step) gets a little room round it on its card.
    const bare = /^(transparent|rgba\(0, 0, 0, 0\))$/.test(getComputedStyle(element).backgroundColor);
    const [x, y] = bare ? [8, 4] : [0, 0];
    const height = r.height + 2 * y;
    Object.assign(el.style, { left: `${r.left - x}px`, top: `${r.top - y}px`, width: `${r.width + 2 * x}px`, height: `${height}px`, padding: `${y}px ${x}px` });
    el.replaceChildren(copy);
    // Where the sheet rising over it would cover it, it rises above the sheet's top with it, as iOS
    // lifts what a long press is on (measured once the sheet is laid out).
    const frame = requestAnimationFrame(() => {
      const sheet = el.nextElementSibling instanceof HTMLElement ? el.nextElementSibling.offsetTop : 0;
      if (sheet > 0 && r.top - y + height > sheet - 12) el.style.top = `${Math.max(8, sheet - 12 - height)}px`;
    });
    return () => cancelAnimationFrame(frame);
  }, [element]);
  return <div ref={box} aria-hidden inert className="pointer-events-none fixed overflow-hidden rounded-2xl bg-panel shadow-xl ring-1 ring-line transition-[top,opacity] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] group-data-closing/modal:opacity-0 motion-reduce:transition-none" />;
}

/**
 * A thing's list of actions (lib/actions): on a computer a menu at the pointer or under its button,
 * a rule between its parts and keys faintly beside them; on a phone a sheet at thumb height, rows a
 * finger can hit. Esc, a click or a tap outside it closes it; picking an action closes it at once
 * and gives focus back to where it was, then does the action.
 */
export function ActionMenu({
  open,
  onClose,
  label,
  title,
  entries,
  at,
  as,
  keys = true,
  focusFirst = false,
  header,
  footer,
  lift,
}: {
  open: boolean;
  onClose: () => void;
  /** What the list is for, as a screen reader says it: "Session", "Claude’s reply". */
  label: string;
  /** A phone's sheet's title, where it says more than the label ("Claude’s reply · 10:42 AM"). */
  title?: ReactNode;
  entries: readonly MenuEntry[];
  /** Where it opens on a computer; centered near the top without one. */
  at?: MenuAnchor | null;
  /** A menu or a sheet; by default a menu where the pointer can hover, a sheet under a finger. */
  as?: 'menu' | 'sheet';
  /** Keys faintly beside the actions, in a menu; a list row's menu shows none (they act on the open session). */
  keys?: boolean;
  /** Opened from the keyboard: the first action has focus, ready for the arrows. */
  focusFirst?: boolean;
  /**
   * Above the actions: the panes' tiles at the top of a phone's session menu. As a function, it is
   * given what an action is picked with, so a tile closes the menu as an action does.
   */
  header?: ReactNode | ((pick: (run: () => void) => void) => ReactNode);
  /** Under the actions, quietly: a turn's figures, a session's start and ID. */
  footer?: ReactNode;
  /** On a phone, the thing a long press opened it for, raised over the dim while it is open. */
  lift?: Element | null;
}) {
  const [shown, setShown] = useState(false);
  // An action picked: the menu goes at once, whatever its way out, so the action finds the page
  // as it was (focus back on the menu's button, nothing held inert behind a dialog).
  const [gone, setGone] = useState(false);
  const opener = useRef<Element | null>(null);
  if (open !== shown) {
    setShown(open);
    if (open) opener.current = document.activeElement;
    else setGone(false);
  }
  const [kind] = useState(() => as ?? (hasKeyboard() ? 'menu' : 'sheet'));
  const menu = (as ?? kind) === 'menu';
  // On its way out it shows what it showed while open, as a sheet does: a caller may give an empty list once closed.
  const kept = useRef({ entries, at, lift });
  if (open) kept.current = { entries, at, lift };
  const shownList = open ? entries : kept.current.entries;
  const shownAt = open ? at : kept.current.at;
  const shownLift = open ? lift : kept.current.lift;

  const pick = (run: () => void) => {
    const back = opener.current;
    flushSync(() => setGone(true));
    if (back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true });
    onClose();
    run();
  };

  if (gone || (shownList.length === 0 && !header && !footer)) return null;
  const top = typeof header === 'function' ? header(pick) : header;
  if (menu) {
    return (
      <Modal open={open} onClose={onClose} label={label}>
        <PointerMenu label={label} entries={shownList} at={shownAt} keys={keys} focusFirst={focusFirst} header={top} footer={footer} onClose={onClose} pick={pick} />
      </Modal>
    );
  }
  return (
    <Sheet open={open} onClose={onClose} title={title ?? label} behind={shownLift ? <Lifted element={shownLift} /> : undefined}>
      {top}
      <div role="menu" aria-label={label}>
        {shownList.map((entry) => <SheetEntry key={entry.id} entry={entry} pick={pick} />)}
      </div>
      {footer && <div className="mx-3 mt-1 border-t border-line pt-2.5 pb-1 text-[12.5px] leading-snug text-faint">{footer}</div>}
    </Sheet>
  );
}

const ICON = (danger?: boolean) => `grid size-4 shrink-0 place-items-center ${danger ? '' : 'text-faint'}`;
const ROW = 'flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13.5px] outline-none focus:bg-hover';

/** A row's key, faint, once it works; or its hint, where it has one. */
function KeyHint({ entry, keys }: { entry: MenuEntry; keys: boolean }) {
  const text = (keys && entry.key ? keyText(entry.key) : undefined) ?? entry.hint;
  return text ? <span className="shrink-0 pl-3 font-sans text-[12px] tracking-wide text-faint tabular-nums">{text}</span> : null;
}

/** A row's icon, or, for one of a few to pick from, its check. */
function EntryIcon({ entry, className }: { entry: MenuEntry; className: string }) {
  if (entry.checked !== undefined && !entry.icon) return entry.checked ? <Check className={className} /> : null;
  return entry.icon ? <entry.icon className={className} /> : null;
}

/** The menu on a computer, and the one submenu it may have open. */
function PointerMenu({ label, entries, at, keys, focusFirst, header, footer, onClose, pick }: {
  label: string;
  entries: readonly MenuEntry[];
  at?: MenuAnchor | null;
  keys: boolean;
  focusFirst: boolean;
  header?: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  pick: (run: () => void) => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  // A click outside closes it; the button let go of from the press that opened it is no click.
  const outside = useRef(false);
  const [where, setWhere] = useState<Place>();
  const [sub, setSub] = useState<{ id: string; row: HTMLElement; focus: boolean }>();
  const subPanel = useRef<HTMLDivElement>(null);
  const [subWhere, setSubWhere] = useState<Place>();

  useLayoutEffect(() => measured(panel.current, (el) => setWhere(place(at, el.offsetWidth, el.offsetHeight))), [at, entries.length]);
  useLayoutEffect(() => {
    const el = subPanel.current;
    if (!sub || !el) {
      setSubWhere(undefined);
      return;
    }
    setSubWhere(besideRow(sub.row, el.offsetWidth, el.offsetHeight));
    if (sub.focus) items(el)[0]?.focus({ preventScroll: true });
  }, [sub]);

  const subEntry = sub && entries.find((entry) => entry.id === sub.id);
  const openSub = (entry: MenuEntry, row: HTMLElement, focus: boolean) => setSub({ id: entry.id, row, focus });
  const closeSub = (focusRow: boolean) => {
    if (focusRow) sub?.row.focus({ preventScroll: true });
    setSub(undefined);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (moveFocus(e, panel.current)) return;
    const row = document.activeElement as HTMLElement | null;
    const entry = row?.dataset.entry ? entries.find((x) => x.id === row.dataset.entry) : undefined;
    if (e.key === 'ArrowRight' && entry && 'items' in entry && row) {
      e.preventDefault();
      openSub(entry, row, true);
    }
  };
  const onSubKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (moveFocus(e, subPanel.current)) return;
    if (e.key === 'ArrowLeft' || e.key === 'Escape') {
      // Only the submenu closes: the menu stays, at the row it opened from.
      e.preventDefault();
      e.stopPropagation();
      closeSub(true);
    }
  };

  return (
    <>
      {/* Anywhere outside the menu closes it, as a click, a right-click or a scroll does a menu's. */}
      <div
        className="absolute inset-0"
        onPointerDown={() => {
          outside.current = true;
        }}
        onClick={() => outside.current && onClose()}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
        onWheel={onClose}
      />
      <div
        ref={panel}
        role="menu"
        aria-label={label}
        tabIndex={-1}
        {...(focusFirst ? {} : { 'data-autofocus': true })}
        onKeyDown={onKeyDown}
        onPointerLeave={() => !sub && panel.current?.focus({ preventScroll: true })}
        style={where ?? { visibility: 'hidden', left: 0, top: 0 }}
        className="animate-fade fixed max-h-[calc(100%-16px)] w-max max-w-80 min-w-60 overflow-y-auto overscroll-contain rounded-2xl border border-line bg-panel p-1 shadow-xl outline-none transition-opacity duration-100 group-data-closing/modal:opacity-0"
      >
        {header}
        {entries.map((entry, i) => (
          <div key={entry.id}>
            {entry.rule && <div className="mx-2.5 my-1 h-px bg-line" />}
            {entry.heading && <div className="px-2.5 pt-1.5 pb-1 text-[12px] text-faint">{entry.heading}</div>}
            {'choice' in entry ? (
              <div>
                <div className="flex h-8 items-center gap-2.5 px-2.5 text-[13.5px]">
                  <span className={ICON()}>{entry.icon && <entry.icon className="size-3.5" />}</span>
                  <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                  <KeyHint entry={entry} keys={keys} />
                </div>
                <div className="px-1.5 pt-0.5 pb-1.5"><Choices choice={entry.choice} label={entry.label} tall={false} /></div>
              </div>
            ) : (
              <button
                type="button"
                role={entry.checked === undefined ? 'menuitem' : 'menuitemradio'}
                {...(entry.checked === undefined ? {} : { 'aria-checked': entry.checked })}
                data-entry={entry.id}
                {...(focusFirst && i === 0 ? { 'data-autofocus': true } : {})}
                {...('items' in entry ? { 'aria-haspopup': 'menu' as const, 'aria-expanded': sub?.id === entry.id } : {})}
                onPointerMove={(e) => {
                  if (e.pointerType !== 'mouse') return;
                  e.currentTarget.focus({ preventScroll: true });
                  if ('items' in entry) {
                    if (sub?.id !== entry.id) openSub(entry, e.currentTarget, false);
                  } else if (sub) setSub(undefined);
                }}
                onClick={(e) => {
                  if ('items' in entry) openSub(entry, e.currentTarget, e.detail === 0);
                  else if ('run' in entry) pick(entry.run);
                }}
                className={`${ROW} ${entry.danger ? 'text-danger' : ''} ${sub?.id === entry.id ? 'bg-hover' : ''}`}
              >
                <span className={entry.checked === undefined ? ICON(entry.danger) : 'grid size-4 shrink-0 place-items-center'}><EntryIcon entry={entry} className="size-3.5" /></span>
                <span className="min-w-0 flex-1 truncate">{entry.label}{entry.detail && <span className="ml-2 text-faint">{entry.detail}</span>}</span>
                <KeyHint entry={entry} keys={keys} />
                {('items' in entry || entry.opens) && <ChevronRight className="size-3.5 shrink-0 text-faint" />}
              </button>
            )}
          </div>
        ))}
        {footer && (
          <>
            <div className="mx-2.5 my-1 h-px bg-line" />
            <div className="px-2.5 pt-0.5 pb-1.5 text-[11.5px] leading-snug text-faint">{footer}</div>
          </>
        )}
      </div>
      {subEntry && 'items' in subEntry && (
        <div
          ref={subPanel}
          role="menu"
          aria-label={subEntry.label}
          onKeyDown={onSubKeyDown}
          style={subWhere ?? { visibility: 'hidden', left: 0, top: 0 }}
          className="fixed w-max max-w-72 min-w-44 rounded-2xl border border-line bg-panel p-1 shadow-xl outline-none"
        >
          {subEntry.items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              onPointerMove={(e) => e.pointerType === 'mouse' && e.currentTarget.focus({ preventScroll: true })}
              onClick={() => 'run' in item && pick(item.run)}
              className={`${ROW} ${item.danger ? 'text-danger' : ''}`}
            >
              <span className={ICON(item.danger)}>{item.icon && <item.icon className="size-3.5" />}</span>
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              <KeyHint entry={item} keys={keys} />
            </button>
          ))}
        </div>
      )}
    </>
  );
}

const SHEET_ROW = 'flex min-h-12 w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-[15px] outline-none hover:bg-hover focus-visible:bg-hover active:bg-hover';

/** One row of a phone's sheet: an action, a choice, or a list that opens in place under its row. */
function SheetEntry({ entry, pick }: { entry: MenuEntry; pick: (run: () => void) => void }) {
  const [opened, setOpened] = useState(false);
  if ('choice' in entry) {
    return (
      <div className="px-3 pt-3 pb-2">
        <div className="pb-1.5 text-[12.5px] text-faint">{entry.label}</div>
        <Choices choice={entry.choice} label={entry.label} tall />
      </div>
    );
  }
  const icon = (entry.icon || entry.checked !== undefined) && (
    <span className={`grid size-5 shrink-0 place-items-center ${entry.danger || entry.checked !== undefined ? '' : 'text-muted'}`}><EntryIcon entry={entry} className="size-4" /></span>
  );
  const heading = entry.heading && <div className="px-3 pt-3 pb-1 text-[12.5px] text-faint">{entry.heading}</div>;
  if ('items' in entry) {
    return (
      <div>
        <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={opened} onClick={() => setOpened((v) => !v)} className={SHEET_ROW}>
          {icon}
          <span className="min-w-0 flex-1">{entry.label}</span>
          <ChevronRight className={`size-4 shrink-0 text-faint transition-transform ${opened ? 'rotate-90' : ''}`} />
        </button>
        {opened && (
          <div role="menu" aria-label={entry.label}>
            {entry.items.map((item) => (
              <button key={item.id} type="button" role="menuitem" onClick={() => 'run' in item && pick(item.run)} className={`${SHEET_ROW} min-h-11 pl-11 text-[14.5px] ${item.danger ? 'text-danger' : ''}`}>
                <span className="min-w-0 flex-1">{item.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }
  return (
    <>
      {heading}
      <button
        type="button"
        role={entry.checked === undefined ? 'menuitem' : 'menuitemradio'}
        {...(entry.checked === undefined ? {} : { 'aria-checked': entry.checked })}
        onClick={() => 'run' in entry && pick(entry.run)}
        className={`${SHEET_ROW} ${entry.danger ? 'text-danger' : ''}`}
      >
        {icon}
        <span className="min-w-0 flex-1">{entry.label}{entry.detail && <span className="ml-2 text-[14px] text-faint">{entry.detail}</span>}</span>
        {entry.hint && <span className="shrink-0 pl-2 text-[13.5px] text-faint">{entry.hint}</span>}
        {entry.opens && <ChevronRight className="size-4 shrink-0 text-faint" />}
      </button>
    </>
  );
}
