// @vitest-environment jsdom
// What can be seen (src/web/lib/viewport.ts): the app as tall as the visual viewport, and the page
// marked short when a phone's keyboard is up or the phone lies on its side, where the terminal's
// line takes the room (styles.css).
import { afterEach, describe, expect, it } from 'vitest';

import { fitToVisibleViewport } from '../src/web/lib/viewport';

/** A visual viewport of the given height, which says when it changes. */
function viewport(height: number) {
  const vv = Object.assign(new EventTarget(), { height, width: 412, scale: 1, offsetTop: 0, offsetLeft: 0 });
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv });
  return {
    resize: (to: number) => {
      vv.height = to;
      vv.dispatchEvent(new Event('resize'));
    },
  };
}

const root = document.documentElement;

afterEach(() => {
  Reflect.deleteProperty(window, 'visualViewport');
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
});
