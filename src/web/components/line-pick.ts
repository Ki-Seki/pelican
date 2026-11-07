import { useEffect, useRef, useState } from 'react';

/**
 * A tap or a click on a line, to comment on it, told from the start of reading it closely: with a
 * mouse, the first click of a double click (to select a word) waits for the second, and a line
 * whose text is being selected is not picked. Keys pick at once (`now`).
 */
export function useLinePick<T>(onPick: (line: T) => void): (line: T, now?: boolean) => void {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pick = useRef(onPick);
  pick.current = onPick;
  useEffect(() => () => clearTimeout(timer.current), []);
  return (line, now = false) => {
    clearTimeout(timer.current);
    if (window.getSelection()?.toString()) return;
    const fine = typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches;
    if (now || !fine) {
      pick.current(line);
      return;
    }
    timer.current = setTimeout(() => {
      if (!window.getSelection()?.toString()) pick.current(line);
    }, 250);
  };
}

/**
 * Lines picked in a row under a finger, as Claude Desktop's diff takes a range: a long press on a
 * line (500 ms, a finger drifting up to 10 px) picks it, and the finger then goes over the lines to
 * pick up to, the page holding still meanwhile; letting go ends it (`done`). A finger that moves
 * first scrolls, as ever. Each line carries its place in `attribute` (data-line, data-row). The tap
 * that ends a press is the press's, not a tap on a line.
 */
export function useLineDrag(el: HTMLElement | null, attribute: string, onRange: (anchor: number, end: number, done: boolean) => void): void {
  const handler = useRef(onRange);
  handler.current = onRange;
  useEffect(() => {
    if (!el) return undefined;
    const placeOf = (target: Element | null) => {
      const value = Number(target?.closest(`[${attribute}]`)?.getAttribute(attribute));
      return Number.isFinite(value) && target && el.contains(target) ? value : undefined;
    };
    let held: { id: number; x: number; y: number; anchor: number; end: number; active: boolean; timer: ReturnType<typeof setTimeout> } | undefined;
    let pressedAt = -Infinity;
    const letGo = () => {
      if (held) clearTimeout(held.timer);
      held = undefined;
    };
    const down = (e: PointerEvent) => {
      letGo();
      if (e.pointerType !== 'touch' || !e.isPrimary) return;
      const anchor = placeOf(e.target as Element);
      if (anchor === undefined) return;
      const h = { id: e.pointerId, x: e.clientX, y: e.clientY, anchor, end: anchor, active: false, timer: setTimeout(() => {
        h.active = true;
        pressedAt = Date.now();
        handler.current(anchor, anchor, false);
      }, 500) };
      held = h;
    };
    const move = (e: PointerEvent) => {
      const h = held;
      if (!h || e.pointerId !== h.id) return;
      if (!h.active) {
        if (Math.hypot(e.clientX - h.x, e.clientY - h.y) > 10) letGo();
        return;
      }
      const end = placeOf(document.elementFromPoint(e.clientX, e.clientY));
      if (end === undefined || end === h.end) return;
      h.end = end;
      handler.current(h.anchor, end, false);
    };
    const up = (e: PointerEvent) => {
      const h = held;
      if (!h || e.pointerId !== h.id) return;
      if (h.active) {
        pressedAt = Date.now();
        handler.current(h.anchor, h.end, true);
      }
      letGo();
    };
    // While a press picks, the finger's moves are its own: the page does not scroll under it.
    const own = (e: TouchEvent) => {
      if (held?.active && e.cancelable) e.preventDefault();
    };
    // The click a lifting finger makes, and Android's menu after a long press, are the press's.
    const swallow = (e: Event) => {
      if (Date.now() - pressedAt < 600 || held?.active) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', letGo);
    el.addEventListener('touchmove', own, { passive: false });
    el.addEventListener('click', swallow, true);
    el.addEventListener('contextmenu', swallow, true);
    return () => {
      letGo();
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', letGo);
      el.removeEventListener('touchmove', own);
      el.removeEventListener('click', swallow, true);
      el.removeEventListener('contextmenu', swallow, true);
    };
  }, [el, attribute]);
}

/** The lines (by `attribute`: data-line, data-row) the selection covers inside `box`, and its text, while there is one. */
export function useLineSelection(box: React.RefObject<HTMLElement | null>, attribute: string): { from: number; to: number; text: string } | undefined {
  const [range, setRange] = useState<{ from: number; to: number; text: string }>();
  useEffect(() => {
    const lineOf = (node: Node | null) => {
      const element = node instanceof Element ? node : node?.parentElement;
      const value = Number(element?.closest(`[${attribute}]`)?.getAttribute(attribute));
      return Number.isFinite(value) && element?.closest(`[${attribute}]`) ? value : undefined;
    };
    const onChange = () => {
      const selection = window.getSelection();
      const el = box.current;
      const text = selection?.toString() ?? '';
      if (!selection || selection.isCollapsed || !text.trim() || !el || !el.contains(selection.anchorNode) || !el.contains(selection.focusNode)) {
        setRange(undefined);
        return;
      }
      const a = lineOf(selection.anchorNode);
      const b = lineOf(selection.focusNode);
      if (a === undefined || b === undefined) return setRange(undefined);
      setRange({ from: Math.min(a, b), to: Math.max(a, b), text });
    };
    document.addEventListener('selectionchange', onChange);
    return () => document.removeEventListener('selectionchange', onChange);
  }, [box, attribute]);
  return range;
}

