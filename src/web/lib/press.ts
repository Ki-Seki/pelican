import { type CSSProperties, type MouseEvent, type PointerEvent, useEffect, useRef, useState } from 'react';

/**
 * The gestures that open a thing's list of actions (lib/actions) or do its one action: a long press
 * under a finger, which is a right-click with a pointer, and a swipe to the left. They keep to the
 * rules a phone's own gestures need: a long press only where there is no text to select (the
 * system's own long press selects text), never a swipe to the right (Safari's Back) or one from an
 * edge of the screen, and no swipe on what scrolls sideways or while text is selected.
 */

/** How long a finger holds before a long press acts, as in Claude Desktop. */
export const LONG_PRESS_MS = 500;
/** How far a held finger may drift and still be holding still. */
export const LONG_PRESS_SLOP = 10;
/** How far a drag goes sideways before it is a swipe; it must also go twice as far sideways as up or down. */
export const SWIPE_START = 12;
/** A swipe starting this close to either edge of the screen is the system's (Back, Forward). */
export const SWIPE_EDGE = 24;
/** How far to the left a swipe must go for letting go to act. */
export const SWIPE_ACTS = 64;

/** Where a list was asked for, and how: what was under the finger or the pointer, and what the gesture is on. */
export type Press = {
  x: number;
  y: number;
  pointerType: 'mouse' | 'touch' | 'pen' | 'keyboard';
  target: Element;
  element: HTMLElement;
};

type LongPressOptions = {
  enabled?: boolean;
  /** Where the browser's own menu shows instead: a link, an image. */
  nativeMenu?: (target: Element) => boolean;
  /** Its text can be selected under a finger too (a prompt once Select text is picked). */
  selectable?: boolean;
};

const HELD_TYPES = new Set(['touch', 'pen']);

/**
 * A long press (500 ms, a finger drifting up to 10 px) and a right-click, the same list on either:
 * spread the returned handlers on the thing. Scrolling or a second finger lets go of a press, and
 * the tap that ends one is not a tap on the thing. iOS's callout on links is turned off on it, and
 * under a finger its text is not selected by the press (`className`), unless it is `selectable`.
 * The keyboard's menu key opens it too, under the thing.
 */
export function useLongPress<T extends HTMLElement = HTMLElement>(onPress: (press: Press) => void, options: LongPressOptions = {}) {
  const { enabled = true, nativeMenu, selectable = false } = options;
  const handler = useRef(onPress);
  handler.current = onPress;
  const held = useRef<{ id: number; x: number; y: number; type: 'touch' | 'pen'; target: Element; element: T; timer: number; stop: () => void }>(undefined);
  // When a press last acted, and when a pointer last went down here: what follows them is theirs.
  const pressedAt = useRef(-Infinity);
  const downAt = useRef(-Infinity);

  const letGo = () => {
    const h = held.current;
    if (!h) return;
    clearTimeout(h.timer);
    h.stop();
    held.current = undefined;
  };
  useEffect(() => letGo, []);

  const act = (press: Press) => {
    letGo();
    pressedAt.current = Date.now();
    handler.current(press);
  };

  return {
    onPointerDown(e: PointerEvent<T>) {
      downAt.current = Date.now();
      letGo();
      // A mouse has its right button; a second finger is a pinch, not a press.
      if (!enabled || !HELD_TYPES.has(e.pointerType) || !e.isPrimary) return;
      const h = { id: e.pointerId, x: e.clientX, y: e.clientY, type: e.pointerType as 'touch' | 'pen', target: e.target as Element, element: e.currentTarget, timer: 0, stop: () => {} };
      const onScroll = () => letGo();
      window.addEventListener('scroll', onScroll, { capture: true, passive: true });
      h.stop = () => window.removeEventListener('scroll', onScroll, { capture: true });
      h.timer = window.setTimeout(() => act({ x: h.x, y: h.y, pointerType: h.type, target: h.target, element: h.element }), LONG_PRESS_MS);
      held.current = h;
    },
    onPointerMove(e: PointerEvent<T>) {
      const h = held.current;
      if (!h) return;
      if (e.pointerId !== h.id || Math.hypot(e.clientX - h.x, e.clientY - h.y) > LONG_PRESS_SLOP) letGo();
    },
    onPointerUp: letGo,
    onPointerCancel: letGo,
    onContextMenu(e: MouseEvent<T>) {
      if (!enabled) return;
      const target = e.target as Element;
      // A long press that already acted (Android follows one with this), or one the browser saw first.
      if (Date.now() - pressedAt.current < 1000) {
        e.preventDefault();
        return;
      }
      const h = held.current;
      if (nativeMenu?.(target)) {
        letGo();
        return;
      }
      e.preventDefault();
      if (h) {
        act({ x: h.x, y: h.y, pointerType: h.type, target: h.target, element: h.element });
        return;
      }
      const element = e.currentTarget;
      // No pointer went down: the keyboard's menu key, which opens it under the thing.
      if (Date.now() - downAt.current > 1000) {
        const r = element.getBoundingClientRect();
        act({ x: r.left, y: r.bottom, pointerType: 'keyboard', target, element });
        return;
      }
      act({ x: e.clientX, y: e.clientY, pointerType: 'mouse', target, element });
    },
    onClickCapture(e: MouseEvent<T>) {
      // The finger that held lifts with a click: it is the press's, not a tap.
      if (Date.now() - pressedAt.current < 600) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    style: { WebkitTouchCallout: 'none' } as CSSProperties,
    className: selectable ? '' : '[@media(hover:none)]:select-none',
  };
}

/**
 * Whether a drag that starts here belongs to something else: code, a table or a diff, which
 * scroll sideways, or anything else that does. Looked at from what was touched up to the thing.
 */
function scrollsSideways(target: EventTarget | null, root: Element): boolean {
  for (let el = target instanceof Element ? target : null; el && el !== root.parentElement; el = el.parentElement) {
    if (el.matches('pre, table, [data-diff], [data-no-swipe]')) return true;
    if (el.scrollWidth > el.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(el).overflowX)) return true;
  }
  return false;
}

const selecting = () => {
  const selection = typeof getSelection === 'function' ? getSelection() : null;
  return Boolean(selection && !selection.isCollapsed && selection.toString().trim());
};

/** Past how far a swipe acts, it follows the finger more slowly. */
const resisted = (dx: number, acts: number) => (-dx <= acts ? dx : -(acts + (-dx - acts) * 0.35));

/**
 * A swipe to the left under a finger, as Telegram's swipe to reply: the thing follows the finger
 * (`dx`, at most 0, for its transform), and letting go past `acts` px does `onSwipe`. It is a swipe
 * only once it goes more than 12 px sideways and twice as far as up or down; until then the page
 * scrolls as ever. A swipe to the right is left to the browser (Back), and so is one that starts
 * within 24 px of an edge, on code, a table or a diff, or while text is selected.
 */
export function useSwipeLeft<T extends HTMLElement = HTMLElement>(
  onSwipe: (swipe: { target: Element; element: T }) => void,
  { enabled = true, acts = SWIPE_ACTS }: { enabled?: boolean; acts?: number } = {},
) {
  const [dx, setDx] = useState(0);
  const handler = useRef(onSwipe);
  handler.current = onSwipe;
  const drag = useRef<{ id: number; x: number; y: number; target: Element; element: T; sideways: boolean }>(undefined);
  const swallowUntil = useRef(0);

  const end = () => {
    drag.current = undefined;
    setDx(0);
  };

  const bind = {
    onPointerDown(e: PointerEvent<T>) {
      drag.current = undefined;
      if (!enabled || e.pointerType !== 'touch' || !e.isPrimary) return;
      if (e.clientX < SWIPE_EDGE || e.clientX > innerWidth - SWIPE_EDGE) return;
      if (scrollsSideways(e.target, e.currentTarget) || selecting()) return;
      drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, target: e.target as Element, element: e.currentTarget, sideways: false };
    },
    onPointerMove(e: PointerEvent<T>) {
      const d = drag.current;
      if (!d || e.pointerId !== d.id) return;
      const mx = e.clientX - d.x;
      const my = e.clientY - d.y;
      if (!d.sideways) {
        if (Math.abs(mx) <= SWIPE_START && Math.abs(my) <= SWIPE_START) return;
        // Up or down is the page scrolling, and to the right is Back's: neither is a swipe here.
        if (mx >= -SWIPE_START || -mx < 2 * Math.abs(my) || selecting()) {
          drag.current = undefined;
          return;
        }
        d.sideways = true;
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }
      setDx(resisted(Math.min(0, mx), acts));
    },
    onPointerUp(e: PointerEvent<T>) {
      const d = drag.current;
      if (!d || e.pointerId !== d.id) return;
      const acted = d.sideways && d.x - e.clientX >= acts;
      if (d.sideways) swallowUntil.current = Date.now() + 400;
      end();
      if (acted) handler.current({ target: d.target, element: d.element });
    },
    onPointerCancel() {
      if (drag.current) end();
    },
    onClickCapture(e: MouseEvent<T>) {
      // Some browsers follow a swipe with a click on the thing: it was not a tap.
      if (Date.now() < swallowUntil.current) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    // The page keeps scrolling up and down, and zooming; a sideways drag is this one's.
    style: { touchAction: 'pan-y pinch-zoom' } as CSSProperties,
  };
  return { dx, swiping: dx < 0, armed: -dx >= acts, bind };
}
