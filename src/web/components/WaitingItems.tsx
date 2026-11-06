import { CornerUpLeft, FileText, Folder, MessageSquare, PencilLine, TextQuote, X } from 'lucide-react';
import { type KeyboardEvent, type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { baseName } from '../lib/format';
import { composing } from '../lib/keyboard';
import { paint, rangeOf } from '../lib/passages';
import { enterSends } from '../lib/prefs';
import { isReply, itemName, itemTitle, passageStart, shortLines, type WaitingItem } from '../lib/quote';
import { Sheet } from './Sheet';

/**
 * What waits above the message box for the next message, four kinds told apart at a glance: a
 * quote, its passage in quotation marks, muted; a quote with a note, a short muted lead and then the
 * note; a line comment, where it is and the note; a file, its name. A click or a tap opens one, to
 * read it whole, change its note, see where it came from, or remove it. A computer's chip has a ×
 * too; a phone's is a finger tall and has none: Remove is in what it opens.
 */

/** What waits, counted by kind, as a sentence's start: "1 comment, 1 quote". */
export function waitingCount(items: readonly WaitingItem[]): { said: string; one: boolean } {
  const quotes = items.filter((item) => item.kind === 'quote').length;
  const comments = items.filter((item) => item.kind === 'comment').length;
  const files = items.filter((item) => item.kind === 'file').length;
  const parts = [
    comments > 0 ? `${comments} ${comments === 1 ? 'comment' : 'comments'}` : '',
    quotes > 0 ? `${quotes} ${quotes === 1 ? 'quote' : 'quotes'}` : '',
    files > 0 ? `${files} ${files === 1 ? 'file' : 'files'}` : '',
  ].filter(Boolean);
  return { said: parts.join(', '), one: items.length === 1 };
}

/** What a chip shows of its item, after its icon. */
function ChipText({ item }: { item: WaitingItem }) {
  if (item.kind === 'file') return <span className="min-w-0 truncate font-mono text-[12px] text-fg">{baseName(item.path ?? item.text)}{item.folder ? '/' : ''}</span>;
  const where = item.kind === 'comment' || item.path ? shortLines(item.path ?? '', item.lines) : undefined;
  if (item.kind === 'comment' || isReply(item)) {
    return (
      <>
        {where ? (
          <span className="shrink-0 font-mono text-[11.5px] text-faint">{where}</span>
        ) : (
          <span className="max-w-[3.5rem] shrink-0 truncate text-faint">“{passageStart(item)}”</span>
        )}
        <span className="min-w-0 truncate text-fg">{item.note}</span>
      </>
    );
  }
  if (where) return <span className="min-w-0 truncate font-mono text-[11.5px] text-muted">{where}</span>;
  return <span className="min-w-0 truncate text-muted">“{passageStart(item)}”</span>;
}

const ChipIcon = ({ item }: { item: WaitingItem }) => {
  const Icon = item.kind === 'file' ? (item.folder ? Folder : FileText) : item.kind === 'comment' ? MessageSquare : TextQuote;
  return <Icon aria-hidden className="size-3 shrink-0 text-faint" />;
};

export function WaitingChips({ items, touch, open, onOpen, onRemove, list }: {
  items: readonly WaitingItem[];
  /** A phone's: a finger tall, with no ×. */
  touch: boolean;
  /** The item whose editor is open. */
  open?: string;
  onOpen: (item: WaitingItem, chip: HTMLElement) => void;
  onRemove: (item: WaitingItem, byKeys: boolean) => void;
  list?: RefObject<HTMLUListElement | null>;
}) {
  if (items.length === 0) return null;
  return (
    // Scrolls sideways when they do not fit, fading at the edge as the model row does.
    <ul ref={list} aria-label="With your next message" className="no-scrollbar flex gap-1.5 overflow-x-auto px-3 pt-3 [mask-image:linear-gradient(to_right,black_calc(100%-14px),transparent)]">
      {items.map((item) => {
        const name = itemName(item);
        const active = open === item.id;
        if (touch) {
          return (
            <li key={item.id} className="flex shrink-0">
              <button
                type="button"
                aria-label={name}
                aria-haspopup="dialog"
                onClick={(e) => onOpen(item, e.currentTarget)}
                className={`flex h-11 max-w-[17rem] items-center gap-1.5 rounded-full border bg-bg px-3.5 text-[12.5px] ${active ? 'border-fg' : 'border-line'}`}
              >
                <ChipIcon item={item} />
                <ChipText item={item} />
              </button>
            </li>
          );
        }
        return (
          <li key={item.id} title={name} className={`flex h-8 max-w-[12.5rem] shrink-0 items-center rounded-full border bg-bg text-[12.5px] ${active ? 'border-fg' : 'border-line'}`}>
            <button
              type="button"
              aria-label={name}
              aria-haspopup="dialog"
              aria-expanded={active}
              onClick={(e) => onOpen(item, e.currentTarget.parentElement!)}
              className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-l-full pl-2.5 outline-none focus-visible:bg-hover"
            >
              <ChipIcon item={item} />
              <ChipText item={item} />
            </button>
            <button
              type="button"
              aria-label={item.kind === 'file' ? `Remove the file ${baseName(item.path ?? item.text)}` : item.kind === 'comment' ? `Remove the comment on ${shortLines(item.path ?? '', item.lines)}` : `Remove the quote ${item.path ? shortLines(item.path, item.lines) : passageStart(item)}`}
              onClick={(e) => onRemove(item, e.detail === 0)}
              className="relative mr-0.5 grid size-7 shrink-0 place-items-center rounded-full text-faint after:absolute after:-inset-1 hover:bg-hover hover:text-fg"
            >
              <X className="size-3.5" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** A note's field grows with what is written in it, up to a few lines. */
function useGrow(field: RefObject<HTMLTextAreaElement | null>, value: string, max = 160) {
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  }, [field, value, max]);
}

/**
 * On a phone, the quote just taken waits in the box as a card: the passage, a 44 px × that lets it
 * go, and "Add a note", which brings the keyboard up only when tapped. Its note is the quote's,
 * written as it is typed; the card becomes a chip when the next quote comes.
 */
export function QuoteCard({ item, onNote, onRemove }: { item: WaitingItem; onNote: (note: string) => void; onRemove: () => void }) {
  const [writing, setWriting] = useState(Boolean(item.note));
  const field = useRef<HTMLTextAreaElement>(null);
  useGrow(field, item.note ?? '');
  // The passage stays marked where it was said while its card waits.
  useEffect(() => paint('quote-source', rangeOf(item.from)), [item.from]);
  return (
    <>
      <div className="mx-3 mt-2.5 rounded-2xl bg-bg pt-1 pr-0.5 pl-3">
        <div className="flex items-start gap-1">
          <blockquote className="mt-2 line-clamp-2 min-w-0 flex-1 border-l-2 border-faint/40 pl-2.5 text-[13.5px] leading-snug break-words whitespace-pre-wrap text-muted">{item.text}</blockquote>
          <button type="button" aria-label={`Remove the quote ${passageStart(item)}`} onClick={onRemove} className="grid size-11 shrink-0 place-items-center rounded-full text-faint active:bg-hover">
            <X className="size-4" />
          </button>
        </div>
        {writing ? (
          <textarea
            ref={field}
            rows={1}
            value={item.note ?? ''}
            aria-label="Your note"
            placeholder="Add a note"
            onChange={(e) => onNote(e.target.value)}
            onBlur={() => !item.note && setWriting(false)}
            className="block min-h-11 w-full resize-none bg-transparent py-2.5 pr-3 text-[16px] leading-6 outline-none placeholder:text-faint"
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              setWriting(true);
              requestAnimationFrame(() => field.current?.focus());
            }}
            className="flex h-11 w-full items-center gap-2 pr-3 text-[15px] text-faint"
          >
            <PencilLine className="size-4" />
            Add a note
          </button>
        )}
      </div>
      <div className="mx-4 mt-1 h-px bg-line" />
    </>
  );
}

/** How "Show" is put for an item: back where a quote was said, or in Changes or Files. */
function showLabel(item: WaitingItem): string | undefined {
  if (item.kind === 'file' || (item.kind === 'quote' && item.path)) return 'Show in Files';
  if (item.kind === 'comment') return item.from.what === 'diff' ? 'Show in Changes' : 'Show in Files';
  return item.from.key ? 'Show in conversation' : undefined;
}

/** As long as a sheet takes to go (Modal's way out). */
const SHEET_OUT_MS = 220;

/**
 * A waiting item opened: the whole passage (or the code, or the path), its note to change, Show,
 * Remove and Done. On a computer a panel over the message box, beside its chip; on a phone a sheet,
 * which plays its way out before Show or Remove does what it says. The note is the item's as it is
 * typed; a comment's never ends up empty.
 */
export function ChipEditor({ item, touch, anchor, frame, canShow, onNote, onShow, onRemove, onClose }: {
  item: WaitingItem;
  touch: boolean;
  /** The chip it opened from, to sit above it on a computer. */
  anchor?: HTMLElement | null;
  /** What the panel is placed in on a computer: the message box's own frame. */
  frame?: HTMLElement | null;
  /** Whether Show has anywhere to go: the conversation holds the passage, or Changes and Files are there. */
  canShow: boolean;
  onNote: (note: string) => void;
  onShow: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const [note, setNote] = useState(item.note ?? '');
  const before = useRef(item.note ?? '');
  const panel = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const [left, setLeft] = useState<number>();
  const [open, setOpen] = useState(true);
  const show = canShow ? showLabel(item) : undefined;
  const notable = item.kind !== 'file';
  /** Closes it, then does `then`: at once on a computer, once a phone's sheet has gone. */
  const leave = (then?: () => void) => {
    // A comment is what it says: emptied, it keeps what it said before.
    if (item.kind === 'comment' && !note.trim()) onNote(before.current);
    if (!touch) {
      onClose();
      then?.();
      return;
    }
    setOpen(false);
    setTimeout(() => {
      onClose();
      then?.();
    }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : SHEET_OUT_MS);
  };
  const finish = () => leave();
  const latest = useRef(finish);
  latest.current = finish;

  // Where it is from stays marked in the conversation while it is open.
  useEffect(() => {
    if (item.kind !== 'quote' || item.path) return undefined;
    return paint('quote-source', rangeOf(item.from));
  }, [item.kind, item.path, item.from]);

  useLayoutEffect(() => {
    if (touch || !panel.current || !frame) return;
    const box = frame.getBoundingClientRect();
    const chip = anchor?.getBoundingClientRect();
    const width = panel.current.offsetWidth;
    setLeft(Math.max(12, Math.min((chip ? chip.left - box.left : 12), box.width - width - 12)));
  }, [touch, anchor, frame]);

  useEffect(() => {
    if (touch) return undefined;
    field.current?.focus({ preventScroll: true });
    const end = field.current?.value.length ?? 0;
    field.current?.setSelectionRange(end, end);
    const onDown = (e: PointerEvent) => {
      const at = e.target as Node;
      if (panel.current?.contains(at) || anchor?.contains(at)) return;
      latest.current();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [touch]);
  useGrow(field, note, touch ? 200 : 140);

  const change = (value: string) => {
    setNote(value);
    if (item.kind !== 'comment' || value.trim()) onNote(value);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (composing(e.nativeEvent)) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finish();
    } else if (e.key === 'Enter' && !e.shiftKey && !e.altKey && e.target === field.current && (e.metaKey || e.ctrlKey || enterSends())) {
      e.preventDefault();
      finish();
    }
  };

  const mono = item.kind !== 'quote' || Boolean(item.path);
  const body = item.kind === 'file' ? (item.path ?? item.text) : item.text;
  const title = itemTitle(item);
  const Icon = item.kind === 'comment' ? MessageSquare : item.kind === 'file' ? FileText : TextQuote;

  if (touch) {
    return (
      <Sheet open={open} onClose={finish} title={title}>
        <div className="px-3 pb-1">
          <div className={`max-h-[38vh] overflow-y-auto border-l-2 border-faint/40 pl-3 break-words whitespace-pre-wrap text-muted ${mono ? 'font-mono text-[13px] leading-relaxed' : 'text-[14.5px] leading-relaxed'}`}>{body}</div>
          {notable && (
            <>
              <label htmlFor={`note-${item.id}`} className="mt-4 block text-[12px] text-faint">Your note</label>
              <textarea
                id={`note-${item.id}`}
                ref={field}
                rows={2}
                value={note}
                placeholder="Add a note"
                onChange={(e) => change(e.target.value)}
                className="mt-1.5 block min-h-[76px] w-full resize-none rounded-xl border border-line bg-bg px-3 py-2.5 text-[16px] leading-6 outline-none placeholder:text-faint focus:border-fg"
              />
            </>
          )}
          <div className="mt-3 flex items-center gap-1">
            {show && (
              <button type="button" onClick={() => leave(onShow)} className="-ml-1 flex h-11 items-center gap-1.5 rounded-full px-2 text-[14px] text-muted active:bg-hover">
                <CornerUpLeft className="size-4" />
                {show}
              </button>
            )}
            <button type="button" onClick={() => leave(onRemove)} className="ml-auto flex h-11 items-center rounded-full px-3.5 text-[14px] text-danger active:bg-hover">Remove</button>
            <button type="button" onClick={finish} className="flex h-11 items-center rounded-full bg-fg px-5 text-[14px] font-medium text-bg">Done</button>
          </div>
        </div>
      </Sheet>
    );
  }
  return (
    <div
      ref={panel}
      role="dialog"
      aria-label={title}
      onKeyDown={onKeyDown}
      // Placed once it is drawn; never hidden, so its note field can take the keys at once.
      style={left === undefined ? { opacity: 0 } : { left }}
      className="animate-fade absolute bottom-full z-30 mb-2 w-[420px] max-w-[calc(100%-24px)] rounded-2xl border border-line bg-panel p-3 shadow-xl"
    >
      <div className="flex items-center gap-1.5 text-[12px] text-faint">
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">{title}</span>
      </div>
      <div className={`mt-2 max-h-40 overflow-y-auto border-l-2 border-faint/40 pl-2.5 break-words whitespace-pre-wrap text-muted ${mono ? 'font-mono text-[12.5px] leading-[1.55]' : 'text-[13px] leading-snug'}`}>{body}</div>
      {notable && (
        <textarea
          ref={field}
          rows={1}
          value={note}
          aria-label="Your note"
          placeholder="Add a note"
          onChange={(e) => change(e.target.value)}
          className="mt-2.5 block w-full resize-none rounded-lg border border-line bg-bg px-2.5 py-2 text-[14px] leading-snug outline-none placeholder:text-faint focus:border-fg"
        />
      )}
      <div className="mt-2 flex items-center gap-1">
        {show && (
          <button type="button" onClick={() => leave(onShow)} className="flex h-8 items-center gap-1 rounded-full px-1.5 text-[12.5px] text-muted hover:text-fg">
            <CornerUpLeft className="size-3.5" />
            {show}
          </button>
        )}
        <button type="button" onClick={() => leave(onRemove)} className="ml-auto flex h-8 items-center rounded-full px-3 text-[13px] text-muted hover:bg-hover hover:text-fg">Remove</button>
        <button type="button" onClick={finish} className="flex h-8 items-center rounded-full bg-fg px-3.5 text-[13px] font-medium text-bg">Done</button>
      </div>
    </div>
  );
}
