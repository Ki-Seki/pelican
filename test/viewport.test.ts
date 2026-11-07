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
});
