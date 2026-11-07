// @vitest-environment jsdom
// A finger on the terminal's screen (touchGestures in src/web/components/TerminalScreen.tsx): a
// swipe scrolls back, and the move stays the screen's, so the browser starts no fling of its own.
import type { Terminal } from '@xterm/xterm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

const { touchGestures } = await import('../src/web/components/TerminalScreen');

/** As much of a terminal as the gestures use: 24 rows, scrolled by whole lines. */
function standIn() {
  const scrolled: number[] = [];
  const t = {
    rows: 24,
    options: { fontSize: 13 },
    modes: { applicationCursorKeysMode: false },
    buffer: { active: { type: 'normal' } },
    scrollLines: (lines: number) => scrolled.push(lines),
    input: vi.fn(),
  };
  return { t: t as unknown as Terminal, scrolled };
}

const screenEl = () => {
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientHeight', { value: 480 });
  document.body.appendChild(el);
  return el;
};
const finger = (el: HTMLElement, type: string, y: number) => el.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: y, bubbles: true }));

afterEach(() => {
  document.body.replaceChildren();
});

describe('a finger on the terminal’s screen', () => {
  it('scrolls back with a swipe down, a row for each row’s height it moves', () => {
    const el = screenEl();
    const { t, scrolled } = standIn();
    const gestures = touchGestures(el, t, () => undefined, () => undefined);
    finger(el, 'pointerdown', 100);
    finger(el, 'pointermove', 160);
    finger(el, 'pointerup', 160);
    // 60 px at 20 px a row: three rows back.
    expect(scrolled).toEqual([-3]);
    gestures.detach();
  });

  it('keeps its moves from the browser, which would take a flick for a fling of its own and the next tap for stopping it', () => {
    const el = screenEl();
    const { t } = standIn();
    const gestures = touchGestures(el, t, () => undefined, () => undefined);
    const move = new TouchEvent('touchmove', { cancelable: true, bubbles: true });
    el.dispatchEvent(move);
    expect(move.defaultPrevented).toBe(true);
    // Taken away with the screen, it holds nothing back.
    gestures.detach();
    const after = new TouchEvent('touchmove', { cancelable: true, bubbles: true });
    el.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });
});
