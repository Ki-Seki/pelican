import { TextQuote } from 'lucide-react';
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';

import { announce } from '../lib/announce';
import { addQuote, promptParts, quoteText } from '../lib/quote';

/** Where a selection ends on screen: its last line that has any width, else the whole of it. */
function endOf(range: Range): DOMRect {
  const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
  return rects.at(-1) ?? range.getBoundingClientRect();
}

const elementOf = (node: Node | null) => (node instanceof Element ? node : node?.parentElement ?? null);

/**
 * Quote, by text selected in a reply or a tool's output (the parts marked data-quotable inside
 * `within`): a small action under the selection's end puts the text above the message box as a
 * quote (lib/quote). On a touch screen it shows once the system's own selection has settled, below
 * its handle, clear of the menu the system shows above; with a mouse, once the button is let go.
 */
export function QuoteAction({ within, quoteKey }: { within: RefObject<HTMLElement | null>; quoteKey: string }) {
  const [shown, setShown] = useState<{ text: string; top: number; left: number }>();
  const pressing = useRef(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      const root = within.current;
      const selection = getSelection();
      const range = selection && !selection.isCollapsed && selection.rangeCount > 0 ? selection.getRangeAt(0) : undefined;
      const quotable = (node: Node | null) => Boolean(elementOf(node)?.closest('[data-quotable]'));
      if (!root || !range || !root.contains(range.commonAncestorContainer) || !(quotable(selection!.anchorNode) || quotable(selection!.focusNode))) {
        setShown(undefined);
        return;
      }
      const text = selection!.toString();
      if (!text.trim()) {
        setShown(undefined);
        return;
      }
      const end = endOf(range);
      const box = root.getBoundingClientRect();
      // A finger's selection has a handle hanging under its end; the action goes below it.
      const below = matchMedia('(pointer: coarse)').matches ? 34 : 8;
      setShown({ text, top: end.bottom - box.top + below, left: Math.min(Math.max(end.right - box.left, 48), box.width - 48) });
    };
    const soon = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(check, ms);
    };
    // While a mouse drags out a selection, the action would chase it: it waits for the button.
    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || (e.target instanceof Element && e.target.closest('[data-quote-action]'))) return;
      pressing.current = true;
      setShown(undefined);
    };
    const onUp = () => {
      if (!pressing.current) return;
      pressing.current = false;
      soon(10);
    };
    const onChange = () => {
      if (!pressing.current) soon(180);
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
  }, [within]);

  if (!shown) return null;
  return (
    <button
      type="button"
      data-quote-action
      // The selection stays while the action is pressed, on a phone too.
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        addQuote(quoteKey, quoteText({ text: shown.text }));
        getSelection()?.removeAllRanges();
        setShown(undefined);
        announce('Quoted in your message');
      }}
      style={{ top: shown.top, left: shown.left }}
      className="animate-fade absolute z-20 flex h-9 -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-panel px-3.5 text-[13px] font-medium shadow-lg select-none after:absolute after:-inset-1 hover:bg-hover pointer-fine:h-8 pointer-fine:px-3"
    >
      <TextQuote className="size-3.5 text-muted" />
      Quote
    </button>
  );
}

/**
 * A prompt's words with the quotes in it set apart, quietly: the quoted text smaller and grey,
 * under where it is from when it is from a file. A prompt with no quote reads as it was typed.
 */
export function PromptBody({ text }: { text: string }) {
  const parts = useMemo(() => promptParts(text), [text]);
  if (!parts.some((part) => part.kind === 'quote')) return <>{text}</>;
  return (
    <div className="space-y-1.5">
      {parts.map((part, i) => (part.kind === 'text' ? (
        <div key={i}>{part.text}</div>
      ) : (
        <blockquote key={i} className="border-l-2 border-faint/40 pl-2.5 text-muted">
          {part.from && <div className="truncate font-mono text-[11.5px] text-faint">{part.from}</div>}
          <div className={part.from ? 'font-mono text-[12.5px] leading-[1.55]' : 'text-[13.5px] leading-snug'}>{part.text}</div>
        </blockquote>
      )))}
    </div>
  );
}
