/**
 * Rows of controls that come back into view under a finger take no tap for a moment, as a
 * browser's own prompts take no click for a moment after they show. On a phone on its side, a tap
 * on the terminal brings back Changes and files' header and tabs and the terminal's own row
 * (Workspace), and the click that follows a tap lands on whatever then lies under the finger: it
 * hung up the shell with End, which asks nothing at an idle prompt, or switched to Files.
 */

/** How long a row that came back takes no tap: a double tap's time, as Chrome's own prompts wait. */
export const SETTLE_MS = 500;

const onScreen = (el: Element) => el.getClientRects().length > 0;

export type Settling = {
  /** The rows come back now, at the end of the tap that shows them: until they have settled, they take no pointer. */
  reveal: () => void;
  stop: () => void;
};

/**
 * Watches the rows of `root` that fold away (`selector`). A row that comes back takes no click,
 * nor the mouse button of one, from a press begun while it was out of view or within `ms` of its
 * coming back: neither the tap that brought it back, on any browser, nor a second one made at
 * once. A click from the keyboard, or a script's, is never held back. While they settle, rows take
 * no pointer at all (`data-settling`, styles.css), so nothing under the finger lights up either.
 */
export function settleRows(root: HTMLElement, selector: string, ms = SETTLE_MS): Settling {
  /** When each row on screen came back; -Infinity for one on screen when first seen. */
  const shownAt = new Map<Element, number>();
  const known = new WeakSet<Element>();
  const timers = new Map<Element, ReturnType<typeof setTimeout>>();
  /** Until when the rows shown by reveal() settle. */
  let until = -Infinity;
  /** The latest press, and the rows out of view as it began. */
  let press: { at: number; hidden: Set<Element> } | undefined;

  const settling = (el: Element) => {
    clearTimeout(timers.get(el));
    el.setAttribute('data-settling', '');
    timers.set(el, setTimeout(() => {
      timers.delete(el);
      el.removeAttribute('data-settling');
    }, ms));
  };
  // A row is laid out again when it comes back from display: none, and looked at then.
  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver((entries) => {
    const now = performance.now();
    for (const { target } of entries) {
      if (!onScreen(target)) shownAt.delete(target);
      else if (!shownAt.has(target)) {
        shownAt.set(target, now);
        settling(target);
      }
    }
  });
  const rows = () => {
    const all = [...root.querySelectorAll(selector)];
    for (const row of all) {
      if (known.has(row)) continue;
      known.add(row);
      if (onScreen(row)) shownAt.set(row, -Infinity);
      observer?.observe(row);
    }
    return all;
  };
  const onPress = () => {
    press = { at: performance.now(), hidden: new Set(rows().filter((row) => !onScreen(row))) };
  };
  const hold = (e: MouseEvent) => {
    if (e.detail === 0 || !press) return;
    const row = e.target instanceof Element ? e.target.closest(selector) : null;
    if (!row || !root.contains(row) || !onScreen(row)) return;
    const settled = Math.max(until, (shownAt.get(row) ?? -Infinity) + ms);
    if (!press.hidden.has(row) && press.at >= settled) return;
    e.preventDefault();
    e.stopPropagation();
  };

  rows();
  root.addEventListener('pointerdown', onPress, true);
  for (const type of ['mousedown', 'mouseup', 'click'] as const) root.addEventListener(type, hold, true);
  return {
    reveal: () => {
      until = performance.now() + ms;
      settling(root);
    },
    stop: () => {
      root.removeEventListener('pointerdown', onPress, true);
      for (const type of ['mousedown', 'mouseup', 'click'] as const) root.removeEventListener(type, hold, true);
      observer?.disconnect();
      for (const [el, timer] of timers) {
        clearTimeout(timer);
        el.removeAttribute('data-settling');
      }
      timers.clear();
    },
  };
}
