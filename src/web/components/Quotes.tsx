import { FileText, MessageSquare, MessagesSquare, TextQuote } from 'lucide-react';
import { createContext, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { announce } from '../lib/announce';
import { addWaiting } from '../lib/drafts';
import { baseName } from '../lib/format';
import { ariaKeys, composing, isKey, keyText } from '../lib/keyboard';
import { fromElement, fromRange, paint, rangeOf, sourceOf } from '../lib/passages';
import { enterSends } from '../lib/prefs';
import { useSwipeLeft } from '../lib/press';
import { type PromptPart, type QuoteFrom, quoteItem, readPrompt, shortLines, TOO_MANY_REPLIES, type WaitingItem } from '../lib/quote';

/**
 * Where quotes taken in a conversation go: the message box of its chat (`chat`, the box's draft
 * key), at once with a note (`sendNow`, the note box's Send now), or to the session's side chat.
 */
export type QuoteTarget = {
  chat: string;
  /** The conversation is a side chat's: what is quoted from its answers is from the side chat. */
  side?: boolean;
  sendNow?: (item: WaitingItem) => void;
  /** Gives the message box the keys, once a quote has gone there or was sent. */
  focusBox?: () => void;
  /** The session's side chat, opened (or, when `open`, sent to) with a passage attached. */
  sideChat?: { open: boolean; start: (item: WaitingItem) => void };
};
export const QuoteTargetContext = createContext<QuoteTarget | undefined>(undefined);

/** Desktop's least: a selection of fewer characters offers nothing. */
const MIN_CHARS = 2;
/** How long a selection rests, after the mouse button is let go or the handles stop moving, before its actions show. */
export const SETTLE_MS = 250;
/** Between the selection and the pill or the note box. */
const GAP = 8;
/** Kept clear of the conversation's edges. */
const EDGE = 12;
/** A pill whose selection scrolled this far has gone with it. */
const SCROLLED_AWAY = 100;

type Picked = {
  range: Range;
  text: string;
  /** Where it is from, when it lies in one thing: what Quote needs. */
  from?: QuoteFrom;
  /** A mouse's selection gets the pill above it; a finger's, the bar docked above the box. */
  mode: 'pill' | 'dock';
};

/** A note being written on a quote, by chat: switching to another session and back keeps it. */
type Noting = { item: WaitingItem; note: string };
const notes = new Map<string, Noting>();

const elementOf = (node: Node | null) => (node instanceof Element ? node : node?.parentElement ?? null);

/** The first and last line a range is drawn on. */
function linesOf(range: Range): { first: DOMRect; last: DOMRect } | undefined {
  const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
  const box = range.getBoundingClientRect();
  const first = rects[0] ?? (box.width > 0 || box.height > 0 ? box : undefined);
  return first ? { first, last: rects.at(-1) ?? first } : undefined;
}

/** A panel `width` wide centred on the range, clamped inside `bounds`. */
const centred = (rect: DOMRect, width: number, bounds: DOMRect) => {
  const half = width / 2;
  const centre = Math.min(Math.max(rect.left + rect.width / 2, bounds.left + half + EDGE), bounds.right - half - EDGE);
  return Math.round(centre - half);
};

/**
 * Exactly two actions on text selected in the conversation, Claude Desktop's, in its order and
 * words: Start a side chat (Send to side chat once one is open) and Quote. With a mouse, a pill
 * above the selection, 250 ms after the button is let go, where ↵ quotes; Quote opens a note box at
 * the selection. Under a finger, the system keeps its own menu at the selection, and the pair docks
 * as a bar above the message box once the handles rest; Quote puts the passage in the box, where a
 * note can be added, and the keyboard stays down. ⇧⌘L quotes a selection without a note.
 */
export function SelectionActions({ within, dockTo, onDock }: {
  /** The conversation's content: selections in it, in its parts marked data-quotable. */
  within: RefObject<HTMLElement | null>;
  /** What the dock sits at the foot of: the conversation's visible frame. */
  dockTo?: RefObject<HTMLElement | null>;
  /** Told when the dock shows and goes, to keep the end of the conversation clear of it. */
  onDock?: (docked: boolean) => void;
}) {
  const target = useContext(QuoteTargetContext);
  const [picked, setPicked] = useState<Picked>();
  const [noting, setNoting] = useState<Noting | undefined>(() => (target ? notes.get(target.chat) : undefined));
  const pointer = useRef('mouse');
  const pressing = useRef(false);
  const chat = target?.chat;

  // Another chat's conversation in this place: its own note, if one was being written there.
  useEffect(() => setNoting(chat ? notes.get(chat) : undefined), [chat]);

  /** The selection in this conversation now, if it is one that offers something. */
  const read = useCallback((): Picked | undefined => {
    const root = within.current;
    const selection = getSelection();
    if (!root || !target || !selection || selection.isCollapsed || selection.rangeCount === 0) return undefined;
    const range = selection.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return undefined;
    const quotable = (node: Node | null) => Boolean(elementOf(node)?.closest('[data-quotable]'));
    if (!quotable(selection.anchorNode) && !quotable(selection.focusNode)) return undefined;
    const text = selection.toString();
    if (text.trim().length < MIN_CHARS) return undefined;
    const source = sourceOf(range);
    const from = source && root.contains(source) ? fromRange(range, source) : undefined;
    if (!from && !target.sideChat) return undefined;
    if (from && target.side && from.what === 'reply') from.what = 'side';
    return { range: range.cloneRange(), text, ...(from ? { from } : {}), mode: pointer.current === 'mouse' ? 'pill' : 'dock' };
  }, [within, target]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setPicked(read()), SETTLE_MS);
    };
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest('[data-selection-actions], [data-note-box]')) return;
      pointer.current = e.pointerType || 'mouse';
      if (e.pointerType !== 'mouse') return;
      // While a mouse drags out a selection, the pill would chase it: it waits for the button.
      pressing.current = true;
      setPicked(undefined);
    };
    const onUp = () => {
      if (!pressing.current) return;
      pressing.current = false;
      settle();
    };
    const onChange = () => {
      if (pressing.current) return;
      // A handle being dragged: the bar goes until the selection rests again. A selection that
      // went (a tap on the bar may take it) leaves the bar there a moment, for that tap's click.
      const selection = getSelection();
      if (selection && !selection.isCollapsed) setPicked((was) => (was?.mode === 'dock' ? undefined : was));
      settle();
    };
    document.addEventListener('selectionchange', onChange);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('pointerup', onUp, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('selectionchange', onChange);
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('pointerup', onUp, true);
    };
  }, [read]);

  const done = () => {
    getSelection()?.removeAllRanges();
    setPicked(undefined);
  };

  /** Quote: the note box at the selection with a pointer; the message box, with "Add a note", under a finger. */
  const quote = (from: Picked) => {
    if (!target || !from.from) return;
    const item = quoteItem(from.text, from.from);
    if (!item) return;
    if (from.mode === 'dock') {
      if (!addWaiting(target.chat, item)) announce(TOO_MANY_REPLIES);
      else announce('Quoted in your message');
      done();
      return;
    }
    const next = { item, note: '' };
    notes.set(target.chat, next);
    setNoting(next);
    done();
  };

  const sideChat = (from: Picked) => {
    const item = quoteItem(from.text, from.from ?? { what: target?.side ? 'side' : 'reply' });
    if (!item || !target?.sideChat) return;
    target.sideChat.start(item);
    done();
  };

  // ↵ quotes while the pill shows; Esc puts the pill away. ⇧⌘L quotes what is selected, without a note.
  useEffect(() => {
    if (!target) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || composing(e)) return;
      if (isKey(e, 'quoteSelection')) {
        const now = read();
        if (!now?.from) return;
        e.preventDefault();
        const item = quoteItem(now.text, now.from);
        if (item && addWaiting(target.chat, item)) announce('Quoted in your message');
        done();
        return;
      }
      if (!picked || picked.mode !== 'pill' || noting) return;
      const typing = e.target instanceof HTMLElement && e.target.matches('input, textarea, select, [contenteditable="true"]');
      if (typing) return;
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && picked.from) {
        e.preventDefault();
        quote(picked);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setPicked(undefined);
      }
    };
    // Before the chat's own keys (Esc stops Claude), whenever each was added.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, picked, noting, read]);

  const docked = picked?.mode === 'dock' && !noting;
  useEffect(() => {
    onDock?.(docked);
  }, [docked, onDock]);
  useEffect(() => () => onDock?.(false), [onDock]);

  if (!target) return null;
  const sideLabel = target.sideChat?.open ? 'Send to side chat' : 'Start a side chat';
  return (
    <>
      {picked && !noting && picked.mode === 'pill' && (
        <Pill picked={picked} bounds={dockTo ?? within} sideLabel={target.sideChat ? sideLabel : undefined} onSideChat={() => sideChat(picked)} onQuote={picked.from ? () => quote(picked) : undefined} onGone={() => setPicked(undefined)} />
      )}
      {docked && dockTo?.current && createPortal(
        <Dock picked={picked} frame={dockTo.current} sideLabel={target.sideChat ? sideLabel : undefined} onSideChat={() => sideChat(picked)} onQuote={picked.from ? () => quote(picked) : undefined} />,
        dockTo.current,
      )}
      {noting && (
        <NoteBox
          key={noting.item.id}
          noting={noting}
          bounds={dockTo ?? within}
          canSend={Boolean(target.sendNow)}
          onNote={(note) => {
            const next = { ...noting, note };
            notes.set(target.chat, next);
          }}
          onClose={(how) => {
            notes.delete(target.chat);
            setNoting(undefined);
            if (how === 'add' || how === 'send') target.focusBox?.();
          }}
          onAdd={(note) => {
            const item = { ...noting.item, ...(note.trim() ? { note: note.trim() } : {}) };
            if (!addWaiting(target.chat, item)) return false;
            announce(item.note ? 'Quoted with your note' : 'Quoted in your message');
            return true;
          }}
          onSend={(note) => target.sendNow?.({ ...noting.item, note: note.trim() })}
        />
      )}
    </>
  );
}

const PART = 'flex h-full items-center whitespace-nowrap outline-none focus-visible:bg-hover hover:bg-hover';

/** Desktop's pill above a mouse's selection: Start a side chat · Quote ↵. */
function Pill({ picked, bounds, sideLabel, onSideChat, onQuote, onGone }: {
  picked: Picked;
  bounds: RefObject<HTMLElement | null>;
  sideLabel?: string;
  onSideChat: () => void;
  onQuote?: () => void;
  onGone: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number }>();
  const gone = useRef(onGone);
  gone.current = onGone;
  useLayoutEffect(() => {
    const el = panel.current;
    const frame = bounds.current;
    if (!el || !frame) return undefined;
    const startTop = linesOf(picked.range)?.first.top;
    let frameRequest = 0;
    const update = () => {
      frameRequest = 0;
      const lines = linesOf(picked.range);
      if (!lines || startTop === undefined || Math.abs(lines.first.top - startTop) > SCROLLED_AWAY) {
        gone.current();
        return;
      }
      const area = frame.getBoundingClientRect();
      const above = lines.first.top - GAP - el.offsetHeight;
      setPlace({
        left: centred(lines.first, el.offsetWidth, area),
        top: Math.round(above >= area.top + EDGE ? above : lines.last.bottom + GAP),
      });
    };
    update();
    const soon = () => {
      if (!frameRequest) frameRequest = requestAnimationFrame(update);
    };
    window.addEventListener('scroll', soon, { capture: true, passive: true });
    window.addEventListener('resize', soon);
    return () => {
      cancelAnimationFrame(frameRequest);
      window.removeEventListener('scroll', soon, { capture: true });
      window.removeEventListener('resize', soon);
    };
  }, [picked, bounds]);
  const quoteKey = keyText('quote');
  return createPortal(
    <div
      ref={panel}
      role="toolbar"
      aria-label="Selected text"
      data-selection-actions
      // The selection stays while the pill is pressed.
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      style={place ? { left: place.left, top: place.top } : { left: 0, top: 0, visibility: 'hidden' }}
      className="animate-fade fixed z-30 flex h-8 items-center overflow-hidden rounded-full border border-line bg-panel text-[13px] font-medium text-fg shadow-lg select-none"
    >
      {sideLabel && (
        <button type="button" onClick={onSideChat} className={`${PART} gap-1.5 pr-2.5 pl-3 ${onQuote ? '' : 'pr-3'}`}>
          <MessagesSquare className="size-3.5 text-muted" />
          {sideLabel}
        </button>
      )}
      {sideLabel && onQuote && <span aria-hidden className="h-4 w-px shrink-0 bg-line" />}
      {onQuote && (
        <button type="button" onClick={onQuote} aria-keyshortcuts={ariaKeys('quote')} className={`${PART} gap-1.5 pr-3 ${sideLabel ? 'pl-2.5' : 'pl-3'}`}>
          <TextQuote className="size-3.5 text-muted" />
          Quote
          {quoteKey && <span aria-hidden className="ml-0.5 text-[11.5px] font-normal text-faint">{quoteKey}</span>}
        </button>
      )}
    </div>,
    document.body,
  );
}

/**
 * Under a finger: the pair as a 44 px bar at the foot of the conversation, just above the message
 * box, clear of the selection's handles and of the menu the system shows at the selection. The
 * conversation's end makes room for it, and the selection is moved up out from under it.
 */
function Dock({ picked, frame, sideLabel, onSideChat, onQuote }: { picked: Picked; frame: HTMLElement; sideLabel?: string; onSideChat: () => void; onQuote?: () => void }) {
  const bar = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const lines = linesOf(picked.range);
    const el = bar.current;
    const scroller = frame.querySelector<HTMLElement>('[data-conversation]');
    if (!lines || !el || !scroller) return;
    const clear = el.getBoundingClientRect().top - GAP;
    if (lines.last.bottom > clear) scroller.scrollTop += lines.last.bottom - clear;
  }, [picked, frame]);
  const item = 'flex h-full items-center gap-2 outline-none active:bg-hover focus-visible:bg-hover';
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-2 z-20 flex justify-center px-3">
      <div
        ref={bar}
        role="toolbar"
        aria-label="Selected text"
        data-selection-actions
        onPointerDown={(e) => e.preventDefault()}
        onMouseDown={(e) => e.preventDefault()}
        className="animate-fade pointer-events-auto flex h-11 items-center overflow-hidden rounded-full border border-line bg-panel text-[14px] font-medium whitespace-nowrap text-fg shadow-lg select-none"
      >
        {sideLabel && (
          <button type="button" onClick={onSideChat} className={`${item} pl-4 ${onQuote ? 'pr-3.5' : 'pr-4'}`}>
            <MessagesSquare className="size-4 text-muted" />
            {sideLabel}
          </button>
        )}
        {sideLabel && onQuote && <span aria-hidden className="h-5 w-px shrink-0 bg-line" />}
        {onQuote && (
          <button type="button" onClick={onQuote} className={`${item} pr-4 ${sideLabel ? 'pl-3.5' : 'pl-4'}`}>
            <TextQuote className="size-4 text-muted" />
            Quote
          </button>
        )}
      </div>
    </div>
  );
}

const NOTE_WIDTH = 400;

/**
 * Claude Desktop's note box, at the selection it quotes, which stays marked while it is open: the
 * quote, and a note about it. ↵ adds the quote to the message (with the note, or as it is without
 * one); ⌘↵ sends it now with its note, a steer while Claude works; Esc lets it go. A click outside
 * closes it only while the note is empty: words written are not thrown away by a stray click.
 */
function NoteBox({ noting, bounds, canSend, onNote, onAdd, onSend, onClose }: {
  noting: Noting;
  bounds: RefObject<HTMLElement | null>;
  canSend: boolean;
  onNote: (note: string) => void;
  /** False when the message holds as many quotes with a note as it can. */
  onAdd: (note: string) => boolean;
  onSend: (note: string) => void;
  onClose: (how: 'add' | 'send' | 'escape' | 'outside') => void;
}) {
  const [note, setNote] = useState(noting.note);
  const [full, setFull] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number }>();
  const opener = useRef<Element | null>(null);
  const latest = useRef({ note, onClose });
  latest.current = { note, onClose };

  // The passage it is about stays marked, and the box follows it as the conversation moves.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    let frameRequest = 0;
    let unpaint = () => {};
    let painted: Range | null = null;
    const update = () => {
      frameRequest = 0;
      const range = painted?.startContainer.isConnected ? painted : rangeOf(noting.item.from);
      if (range !== painted) {
        unpaint();
        unpaint = paint('quote-noting', range);
        painted = range;
      }
      const area = (bounds.current ?? document.body).getBoundingClientRect();
      const lines = range ? linesOf(range) : undefined;
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      if (!lines) {
        setPlace({ left: Math.round(area.left + (area.width - width) / 2), top: Math.round(area.bottom - height - EDGE) });
        return;
      }
      const below = lines.last.bottom + GAP;
      const top = below + height <= area.bottom - EDGE ? below : Math.max(area.top + EDGE, lines.first.top - GAP - height);
      setPlace({ left: centred(lines.last, width, area), top: Math.round(top) });
    };
    update();
    const soon = () => {
      if (!frameRequest) frameRequest = requestAnimationFrame(update);
    };
    window.addEventListener('scroll', soon, { capture: true, passive: true });
    window.addEventListener('resize', soon);
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(soon);
    if (bounds.current) observer?.observe(bounds.current);
    return () => {
      cancelAnimationFrame(frameRequest);
      unpaint();
      observer?.disconnect();
      window.removeEventListener('scroll', soon, { capture: true });
      window.removeEventListener('resize', soon);
    };
  }, [noting.item.from, bounds]);

  useEffect(() => {
    opener.current = document.activeElement;
    field.current?.focus({ preventScroll: true });
    const end = field.current?.value.length ?? 0;
    field.current?.setSelectionRange(end, end);
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || !box.current || box.current.contains(e.target as Node)) return;
      if (latest.current.note.trim() === '') latest.current.onClose('outside');
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, []);

  const close = (how: 'add' | 'send' | 'escape' | 'outside') => {
    onClose(how);
    const back = opener.current;
    if (how === 'escape' && back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true });
  };
  const add = () => {
    if (onAdd(note)) close('add');
    else setFull(true);
  };
  const ready = note.trim().length > 0;
  const send = () => {
    if (!ready || !canSend) return;
    onSend(note);
    close('send');
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (composing(e.nativeEvent)) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close('escape');
    } else if (e.key === 'Tab' && box.current) {
      // The keys stay in the box while it is open.
      const all = [...box.current.querySelectorAll<HTMLElement>('textarea, button:not([disabled])')];
      if (all.length === 0) return;
      e.preventDefault();
      const at = all.indexOf(document.activeElement as HTMLElement);
      all[e.shiftKey ? (at <= 0 ? all.length - 1 : at - 1) : (at + 1) % all.length]!.focus();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && e.target === field.current) {
      e.preventDefault();
      send();
    } else if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && e.target === field.current && enterSends()) {
      e.preventDefault();
      add();
    }
  };

  const sendKey = keyText('noteSend');
  const addKey = keyText('noteAdd');
  return createPortal(
    <div
      ref={box}
      role="dialog"
      aria-label="Quote with a note"
      data-note-box
      onKeyDown={onKeyDown}
      // Placed once it is drawn; never hidden, so its note field can take the keys at once.
      style={place ? { left: place.left, top: place.top } : { left: 0, top: 0, opacity: 0 }}
      className="animate-fade fixed z-30 rounded-2xl border border-line bg-panel p-3 shadow-xl"
    >
      <div style={{ width: `min(${NOTE_WIDTH - 26}px, calc(100vw - ${2 * EDGE + 26}px))` }}>
        <blockquote className="line-clamp-2 border-l-2 border-faint/40 pl-2.5 text-[13px] leading-snug break-words whitespace-pre-wrap text-muted">{noting.item.text}</blockquote>
        <textarea
          ref={field}
          rows={2}
          value={note}
          aria-label="Your note"
          placeholder="Add a note"
          onChange={(e) => {
            setNote(e.target.value);
            setFull(false);
            onNote(e.target.value);
          }}
          className="mt-2.5 block min-h-[60px] w-full resize-none rounded-lg border border-line bg-bg px-2.5 py-2 text-[14px] leading-snug outline-none placeholder:text-faint focus:border-fg"
        />
        {full && <p role="alert" className="mt-2 text-[12.5px] leading-snug text-danger">{TOO_MANY_REPLIES}</p>}
        <div className="mt-2 flex items-center justify-end gap-1.5">
          {canSend && (
            <button type="button" onClick={send} disabled={!ready} aria-keyshortcuts={ariaKeys('noteSend')} className="flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] text-muted hover:bg-hover hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent">
              Send now{sendKey && <span aria-hidden className="text-[11.5px] text-faint">{sendKey}</span>}
            </button>
          )}
          <button type="button" onClick={add} aria-keyshortcuts={ariaKeys('noteAdd')} className="flex h-8 items-center gap-1.5 rounded-full bg-fg px-3.5 text-[13px] font-medium text-bg">
            Add{addKey && <span aria-hidden className="text-[11.5px] font-normal opacity-60">{addKey}</span>}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ---------- a left swipe ---------- */

/** What a swipe on a reply quotes: the paragraph, item or heading under the finger. */
const PARAGRAPH = 'p, li, h1, h2, h3, h4, h5, h6, blockquote';

/**
 * A left swipe under a finger quotes, as Telegram's swipe to reply: the paragraph of a reply it is
 * on, or the whole of a prompt or a step's output (`whole`). The thing follows the finger, with
 * Quote showing beside it; let go past the mark, it is quoted into the message box, where a note
 * can be added. Code, tables and diffs scroll sideways instead, and so does a selection's text.
 */
export function SwipeQuote({ children, whole, className = '' }: {
  children: ReactNode;
  /** A swipe quotes all of it, from here, whatever part of it the finger is on: this text, or what it reads. */
  whole?: { text?: () => string; from: () => QuoteFrom | undefined };
  className?: string;
}) {
  const target = useContext(QuoteTargetContext);
  const box = useRef<HTMLDivElement>(null);
  const moving = useRef<HTMLElement | null>(null);
  const { dx, armed, bind } = useSwipeLeft(() => {
    const el = moving.current;
    if (!target || !el) return;
    const text = whole?.text ? whole.text() : (el.innerText || el.textContent || '');
    const from = (whole ? whole.from() : fromElement(el)) ?? { what: target.side ? 'side' as const : 'reply' as const };
    if (from.what === 'reply' && target.side) from.what = 'side';
    const item = quoteItem(text, from);
    if (!item) return;
    if (addWaiting(target.chat, item)) announce('Quoted in your message');
    else announce(TOO_MANY_REPLIES);
  }, { enabled: Boolean(target) });

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const root = box.current;
    const under = e.target instanceof Element ? e.target : null;
    moving.current = !root ? null : whole ? root.firstElementChild as HTMLElement | null : (under?.closest<HTMLElement>(PARAGRAPH) ?? null);
    if (moving.current && !root?.contains(moving.current)) moving.current = null;
    if (moving.current) bind.onPointerDown(e);
  };
  useLayoutEffect(() => {
    const el = moving.current;
    if (!el) return;
    el.style.transform = dx ? `translateX(${dx}px)` : '';
    el.style.transition = dx ? 'none' : 'transform 200ms cubic-bezier(0.32,0.72,0,1)';
  }, [dx]);

  const el = moving.current;
  const centre = el && box.current ? el.offsetTop + el.offsetHeight / 2 : 0;
  return (
    <div ref={box} {...bind} onPointerDown={onPointerDown} className={`relative ${className}`}>
      {children}
      {dx < 0 && el && (
        <div aria-hidden style={{ top: centre, opacity: Math.min(1, -dx / 40) }} className="pointer-events-none absolute right-0 flex -translate-y-1/2 flex-col items-center gap-1 text-[11px] text-muted">
          <span className={`grid size-10 place-items-center rounded-full transition-colors ${armed ? 'bg-fg text-bg' : 'bg-chip text-fg'}`}>
            <TextQuote className="size-4" />
          </span>
          Quote
        </div>
      )}
    </div>
  );
}

/* ---------- a prompt, as it reads ---------- */

/**
 * A prompt's words with what it quotes set apart, quietly, as Claude Desktop shows its replies: a
 * quote smaller and grey behind a rule, its note after it in the prompt's own words; a comment
 * under the file and lines it is on; files attached as their names. A prompt with none reads as
 * it was typed.
 */
export function PromptBody({ text }: { text: string }) {
  const parts = useMemo(() => readPrompt(text), [text]);
  if (!parts.some((part) => part.kind !== 'text')) return <>{text}</>;
  const files = parts.filter((part): part is Extract<PromptPart, { kind: 'file' }> => part.kind === 'file');
  return (
    <div className="space-y-1.5">
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {files.map((file) => (
            <span key={file.path} title={file.path} className="flex max-w-full items-center gap-1 rounded-md bg-hover px-1.5 font-mono text-[12px] text-muted">
              <FileText className="size-3 shrink-0" />
              <span className="truncate">{baseName(file.path)}{file.folder ? '/' : ''}</span>
            </span>
          ))}
        </div>
      )}
      {parts.map((part, i) => {
        if (part.kind === 'file') return null;
        if (part.kind === 'text') return <div key={i}>{part.text}</div>;
        if (part.kind === 'comment') {
          return (
            <div key={i}>
              <blockquote className="border-l-2 border-faint/40 pl-2.5 text-muted">
                <div className="flex min-w-0 items-center gap-1 font-mono text-[11.5px] text-faint">
                  <MessageSquare className="size-3 shrink-0" />
                  <span className="truncate">{shortLines(part.path, part.lines)}{part.removed ? ' · before changes' : ''}</span>
                </div>
                {part.code !== undefined && <div className="font-mono text-[12.5px] leading-[1.55]">{part.code}</div>}
              </blockquote>
              {part.note && <div className="mt-1">{part.note}</div>}
            </div>
          );
        }
        const lines = Boolean(part.label);
        return (
          <div key={i}>
            <blockquote className="border-l-2 border-faint/40 pl-2.5 text-muted">
              {part.label && <div className="truncate font-mono text-[11.5px] text-faint">{part.label}</div>}
              <div className={lines ? 'font-mono text-[12.5px] leading-[1.55]' : 'text-[13.5px] leading-snug'}>{part.text}</div>
            </blockquote>
            {part.note && <div className="mt-1">{part.note}</div>}
          </div>
        );
      })}
    </div>
  );
}
