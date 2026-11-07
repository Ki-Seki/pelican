// @vitest-environment jsdom
// Rows that come back under a finger (src/web/lib/settle.ts): on a phone on its side, the tap on
// the terminal that brings back the header, the tabs and the terminal's row landed, as its click,
// on End or Files, now under the finger. Laid out here by hand: a row is on screen while `shown`
// has it, and the browser's ResizeObserver says so when `layout` is called.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SETTLE_MS, settleRows } from '../src/web/lib/settle';

const shown = new Set<Element>();
let observed: Element[] = [];
let report: ((entries: Array<{ target: Element }>) => void) | undefined;
let now = 1000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
    return (shown.has(this) ? [{}] : []) as unknown as DOMRectList;
  });
  Object.assign(globalThis, {
    ResizeObserver: class {
      constructor(callback: (entries: Array<{ target: Element }>) => void) {
        report = callback;
      }
      observe(el: Element) {
        observed.push(el);
      }
      unobserve() {}
      disconnect() {
        observed = [];
      }
    },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  shown.clear();
  observed = [];
  report = undefined;
  document.body.replaceChildren();
});

/** The browser lays the page out: the rows observed say what came and went. */
const layout = () => report?.(observed.map((target) => ({ target })));

function page() {
  const root = document.createElement('div');
  const screen = document.createElement('div');
  const row = document.createElement('div');
  row.setAttribute('data-makes-room', 'short');
  const end = document.createElement('button');
  end.textContent = 'End';
  const ended = vi.fn();
  end.addEventListener('click', ended);
  row.append(end);
  root.append(row, screen);
  document.body.append(root);
  return { root, screen, row, end, ended };
}

/** A finger's tap: down on `at`, then the click the browser sends to what lies under it by then. */
const press = (at: Element) => at.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
const click = (at: Element, detail = 1) => at.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail }));

describe('a row that comes back under a finger', () => {
  it('takes no click from the tap that brought it back, nor from one made at once, and takes one after a moment', () => {
    const { root, screen, row, end, ended } = page();
    const rows = settleRows(root, '[data-makes-room]');
    // The tap on the screen brings the row back before its click comes, which lands on End.
    press(screen);
    rows.reveal();
    shown.add(row);
    expect(click(end)).toBe(false);
    expect(ended).not.toHaveBeenCalled();
    // The browser lays it out; a second tap at once is not End's either.
    now += 16;
    layout();
    now += 150;
    press(end);
    expect(click(end)).toBe(false);
    expect(ended).not.toHaveBeenCalled();
    // A press begun while it settled, let go once it has, is not End's.
    now += 200;
    press(end);
    now += 400;
    click(end);
    expect(ended).not.toHaveBeenCalled();
    // On screen for the moment, it takes a tap.
    press(end);
    expect(click(end)).toBe(true);
    expect(ended).toHaveBeenCalledTimes(1);
    rows.stop();
  });

  it('takes no pointer while it settles, from a reveal or from the browser’s own layout', () => {
    const { root, screen, row } = page();
    const rows = settleRows(root, '[data-makes-room]');
    press(screen);
    rows.reveal();
    expect(root.hasAttribute('data-settling')).toBe(true);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(root.hasAttribute('data-settling')).toBe(false);
    // Folded again, and back by other means (the keyboard went down, the line was left).
    shown.delete(row);
    layout();
    shown.add(row);
    layout();
    expect(row.hasAttribute('data-settling')).toBe(true);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(row.hasAttribute('data-settling')).toBe(false);
    rows.stop();
  });

  it('holds back nothing on screen all along, nor a click from the keyboard', () => {
    const { root, screen, row, end, ended } = page();
    shown.add(row);
    const rows = settleRows(root, '[data-makes-room]');
    press(end);
    expect(click(end)).toBe(true);
    // Back under the finger, a key still presses it.
    shown.delete(row);
    layout();
    press(screen);
    shown.add(row);
    layout();
    expect(click(end, 0)).toBe(true);
    expect(ended).toHaveBeenCalledTimes(2);
    // Once stopped, nothing is held back.
    rows.stop();
    press(screen);
    expect(click(end)).toBe(true);
    expect(ended).toHaveBeenCalledTimes(3);
  });
});
