// @vitest-environment jsdom
// What can be seen (src/web/lib/viewport.ts): the app as tall as the visual viewport, and the page
// marked short when a phone's keyboard is up or the phone lies on its side, where the terminal's
// line takes the room (styles.css).
import { afterEach, describe, expect, it } from 'vitest';

import { fitToVisibleViewport, typingIn, visibleArea } from '../src/web/lib/viewport';

/** A visual viewport of the given height, which says when it changes, unless it is quiet. */
function viewport(height: number) {
  const vv = Object.assign(new EventTarget(), { height, width: 412, scale: 1, offsetTop: 0, offsetLeft: 0 });
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv });
  return {
    resize: (to: number) => {
      vv.height = to;
      vv.dispatchEvent(new Event('resize'));
    },
    /** Moved down (or back up), to show the field typed in. */
    pan: (to: number) => {
      vv.offsetTop = to;
      vv.dispatchEvent(new Event('scroll'));
    },
    /** Changed without a word, as Edge on Android may leave it. */
    quietly: (to: number) => {
      vv.height = to;
    },
  };
}

/** The layout viewport's height, as window.innerHeight says it. */
const layoutHeight = (height: number) => Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
const frames = async (count: number) => {
  for (let i = 0; i < count; i += 1) await new Promise((resolve) => requestAnimationFrame(resolve));
};

const root = document.documentElement;

afterEach(() => {
  Reflect.deleteProperty(window, 'visualViewport');
  Reflect.deleteProperty(window, 'innerHeight');
  document.body.replaceChildren();
});

describe('what can be seen', () => {
  it('sizes the app to it, and marks the page short while a phone’s keyboard is up, or tiny with the phone on its side', () => {
    const vv = viewport(783);
    const stop = fitToVisibleViewport();
    expect(root.style.getPropertyValue('--app-h')).toBe('783px');
    expect(root.hasAttribute('data-short')).toBe(false);
    // Gboard up on a Pixel 7, in Chrome.
    vv.resize(423);
    expect(root.style.getPropertyValue('--app-h')).toBe('423px');
    expect(root.getAttribute('data-short')).toBe('');
    // The phone on its side, Gboard up: room for the line alone.
    vv.resize(66);
    expect(root.getAttribute('data-short')).toBe('tiny');
    vv.resize(783);
    expect(root.hasAttribute('data-short')).toBe(false);
    vv.resize(304);
    stop();
    expect(root.hasAttribute('data-short')).toBe(false);
    expect(root.style.getPropertyValue('--app-h')).toBe('');
  });

  it('marks a touch screen’s keyboard up, also on a phone on its side, where what can be seen is short either way', () => {
    const media = { coarse: true, landscape: false };
    const before = { matchMedia: window.matchMedia, width: screen.width, height: screen.height };
    window.matchMedia = ((query: string) => ({ matches: query.includes('coarse') ? media.coarse : query.includes('landscape') ? media.landscape : false })) as unknown as typeof window.matchMedia;
    const sized = (width: number, height: number) => {
      Object.defineProperty(screen, 'width', { configurable: true, value: width });
      Object.defineProperty(screen, 'height', { configurable: true, value: height });
    };
    try {
      // A Pixel 7 in Chrome, upright, then Gboard up.
      sized(412, 915);
      const vv = viewport(783);
      const stop = fitToVisibleViewport();
      expect(root.hasAttribute('data-keyboard')).toBe(false);
      vv.resize(423);
      expect(root.hasAttribute('data-keyboard')).toBe(true);
      // On its side: short, its keyboard down; then up, 66 px left.
      sized(915, 412);
      media.landscape = true;
      vv.resize(304);
      expect(root.getAttribute('data-short')).toBe('');
      expect(root.hasAttribute('data-keyboard')).toBe(false);
      vv.resize(66);
      expect(root.hasAttribute('data-keyboard')).toBe(true);
      // An iPhone 15 on its side, whose screen.width and screen.height stay upright: Safari's bars, then its keyboard.
      sized(393, 852);
      vv.resize(330);
      expect(root.hasAttribute('data-keyboard')).toBe(false);
      vv.resize(134);
      expect(root.hasAttribute('data-keyboard')).toBe(true);
      // A computer's window, however short, has no such keyboard.
      media.coarse = false;
      vv.resize(134);
      expect(root.hasAttribute('data-keyboard')).toBe(false);
      stop();
      expect(root.hasAttribute('data-keyboard')).toBe(false);
    } finally {
      window.matchMedia = before.matchMedia;
      sized(before.width, before.height);
    }
  });

  it('starts where the browser moved down to show the field typed in, and reaches no lower than the page (Edge on Android)', async () => {
    // Edge, its toolbar at the bottom: 679 px seen above its toolbar, 763 px of page. Its keyboard
    // up, it moves what can be seen 274 px down to the field and goes on saying 679 px tall.
    layoutHeight(763);
    const vv = viewport(679);
    const stop = fitToVisibleViewport();
    const field = document.body.appendChild(document.createElement('textarea'));
    field.focus();
    vv.pan(274);
    expect(root.style.getPropertyValue('--app-top')).toBe('274px');
    expect(root.style.getPropertyValue('--app-h')).toBe('489px');
    expect(root.getAttribute('data-short')).toBe('');
    // Its keyboard down, the field left: nothing has moved, whatever it still says.
    field.blur();
    vv.quietly(679);
    await frames(2);
    expect(root.style.getPropertyValue('--app-top')).toBe('');
    expect(root.style.getPropertyValue('--app-h')).toBe('679px');
    expect(root.hasAttribute('data-short')).toBe(false);
    stop();
    expect(root.style.getPropertyValue('--app-top')).toBe('');
  });

  it('looks again for a while after a field is entered, for a browser that says nothing of its keyboard', async () => {
    layoutHeight(783);
    const vv = viewport(783);
    const stop = fitToVisibleViewport();
    const field = document.body.appendChild(document.createElement('input'));
    field.focus();
    vv.quietly(471);
    await frames(3);
    expect(root.style.getPropertyValue('--app-h')).toBe('471px');
    expect(root.getAttribute('data-short')).toBe('');
    stop();
  });

  it('takes what it is told where the browser resizes the page, as Chrome does, and the whole page pinch-zoomed in', () => {
    expect(visibleArea({ height: 471, offsetTop: 0, scale: 1 }, 471, true)).toEqual({ top: 0, height: 471 });
    // Laid over the page and moved down, as the browser says it.
    expect(visibleArea({ height: 471, offsetTop: 312, scale: 1 }, 783, true)).toEqual({ top: 312, height: 471 });
    // Moved, with no field typed in: no keyboard, so nothing has moved (iOS may leave offsetTop behind).
    expect(visibleArea({ height: 783, offsetTop: 312, scale: 1 }, 783, false)).toEqual({ top: 0, height: 783 });
    expect(visibleArea({ height: 300, offsetTop: 120, scale: 2.5 }, 783, true)).toEqual({ top: 0, height: 783 });
  });

  it('knows the fields a touch screen’s keyboard comes up for', () => {
    const made = (html: string) => {
      document.body.innerHTML = html;
      return document.body.firstElementChild;
    };
    expect(typingIn(made('<textarea></textarea>'))).toBe(true);
    expect(typingIn(made('<input>'))).toBe(true);
    expect(typingIn(made('<input type="search">'))).toBe(true);
    expect(typingIn(made('<div contenteditable="true"></div>'))).toBe(true);
    // A terminal's screen on a touch screen takes no keyboard; nor does a button, a box or a read-only field.
    expect(typingIn(made('<textarea inputmode="none"></textarea>'))).toBe(false);
    expect(typingIn(made('<input type="checkbox">'))).toBe(false);
    expect(typingIn(made('<button></button>'))).toBe(false);
    expect(typingIn(made('<input readonly>'))).toBe(false);
    expect(typingIn(null)).toBe(false);
  });
});
