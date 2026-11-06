/**
 * Where a quoted passage is in the conversation, found again: each thing that can be quoted carries
 * `data-quote-from` (its key in the conversation), and a passage is where it starts and ends in it,
 * counted in characters other than spaces, so it is found again whatever the page made of its line
 * breaks and paragraphs, and nothing of the passage itself (a secret, masked in the quote) needs to
 * be kept to find it. It is marked as Claude Desktop marks the passage its note box is about: a
 * highlight the browser paints over the text (the CSS Custom Highlight API), which changes no
 * element, so a reply drawn again keeps it. Browsers without one show no mark.
 */

import type { QuoteFrom } from './quote';

const SPACE = /\s/;

/** How many characters other than spaces come before (`node`, `offset`) in `root`. */
function countTo(root: Element, node: Node, offset: number): number {
  const at = document.createRange();
  at.setStart(root, 0);
  try {
    at.setEnd(node, offset);
  } catch {
    return 0;
  }
  let count = 0;
  for (const char of at.toString()) if (!SPACE.test(char)) count += 1;
  return count;
}

/** The thing a range lies in, with its key; none when it spans more than one. */
export function sourceOf(range: Range): HTMLElement | null {
  const common = range.commonAncestorContainer;
  const element = common instanceof Element ? common : common.parentElement;
  return element?.closest<HTMLElement>('[data-quote-from]') ?? null;
}

/** Where a range is in what it was taken from: its key, what it is, when it was said, and where in it. */
export function fromRange(range: Range, source = sourceOf(range)): QuoteFrom | undefined {
  if (!source) return undefined;
  const what = (source.dataset.quoteWhat ?? 'reply') as QuoteFrom['what'];
  const at = Number(source.dataset.quoteAt);
  return {
    what,
    key: source.dataset.quoteFrom!,
    ...(at > 0 ? { at } : {}),
    span: [countTo(source, range.startContainer, range.startOffset), countTo(source, range.endContainer, range.endOffset)],
  };
}

/** Where an element is in the thing it is in: a paragraph swiped, a step's output. */
export function fromElement(element: Element): QuoteFrom | undefined {
  const range = document.createRange();
  range.selectNodeContents(element);
  return fromRange(range, element.closest<HTMLElement>('[data-quote-from]'));
}

/** The element of the thing with this key, in the page now. */
export function sourceElement(key: string | undefined): HTMLElement | null {
  if (!key) return null;
  return document.querySelector<HTMLElement>(`[data-quote-from="${key.replace(/["\\]/g, '\\$&')}"]`);
}

/** The range a passage is at in its thing, found again; none when the thing is not in the page. */
export function rangeOf(from: QuoteFrom | undefined): Range | null {
  const root = sourceElement(from?.key);
  if (!root) return null;
  const range = document.createRange();
  if (!from?.span) {
    range.selectNodeContents(root);
    return range;
  }
  const [start, end] = from.span;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let count = 0;
  let started = false;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const text = node.data;
    for (let i = 0; i < text.length; i += 1) {
      if (SPACE.test(text[i]!)) continue;
      if (!started && count === start) {
        range.setStart(node, i);
        started = true;
      }
      count += 1;
      if (started && count === end) {
        range.setEnd(node, i + 1);
        return range;
      }
    }
  }
  if (!started) return null;
  range.setEndAfter(root.lastChild ?? root);
  return range;
}

type Highlights = { set(name: string, highlight: unknown): void; delete(name: string): void };
const highlights = (): Highlights | undefined => (globalThis.CSS as unknown as { highlights?: Highlights } | undefined)?.highlights;
const Painter = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;

/** The ranges each highlight paints now: several things can mark at once (a card, an editor, Show). */
const painting = new Map<string, Set<Range>>();

/**
 * Paints a range with one of Pelican's highlights (styles.css): `quote-source` marks where a quote
 * is from, `quote-noting` keeps a selection showing while its note is written. Returns how to stop.
 */
export function paint(name: 'quote-source' | 'quote-noting', range: Range | null): () => void {
  const all = highlights();
  if (!all || !Painter || !range) return () => {};
  const id = `pelican-${name}`;
  const ranges = painting.get(id) ?? new Set();
  painting.set(id, ranges);
  const redraw = () => (ranges.size > 0 ? all.set(id, new Painter(...ranges)) : all.delete(id));
  ranges.add(range);
  redraw();
  return () => {
    if (ranges.delete(range)) redraw();
  };
}

/** Brings a passage into view, in the middle of what scrolls, and marks it for a moment. */
export function showPassage(from: QuoteFrom | undefined, ms = 2500): boolean {
  const range = rangeOf(from);
  if (!range) return false;
  const box = range.getBoundingClientRect();
  const target = box.height > 0 ? range.startContainer.parentElement : sourceElement(from?.key);
  target?.scrollIntoView?.({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  const stop = paint('quote-source', range);
  setTimeout(stop, ms);
  return true;
}
