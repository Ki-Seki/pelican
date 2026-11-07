// @vitest-environment jsdom
// What is scrolled under a card's head or its foot, where they stick (src/web/components/
// PermissionCard.tsx), is cut at a quiet line, a little way off, as Claude Desktop cuts it: a
// question's title sat on half an option. jsdom lays nothing out: each part's place is set here.
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PermissionRequest } from '../src/shared/protocol';

Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
Object.assign(window, { matchMedia: (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }) });

const { PermissionCard } = await import('../src/web/components/PermissionCard');

const SESSION = 'cccccccc-0000-4000-8000-0000000000b2';
const ask = (input: Record<string, unknown>, extra: Partial<PermissionRequest> = {}): PermissionRequest => ({ id: 'p1', sessionId: SESSION, toolName: 'Bash', input, createdAt: Date.now(), ...extra });

/** Where each part is: [top, bottom] in the page. */
const placed = new Map<Element, [number, number]>();
const place = (el: Element | null | undefined, top: number, bottom: number) => {
  if (el) placed.set(el, [top, bottom]);
};
beforeEach(() => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const [top, bottom] = placed.get(this) ?? [0, 0];
    return { top, bottom, height: bottom - top, left: 0, right: 600, width: 600, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  });
});
afterEach(() => {
  cleanup();
  placed.clear();
  vi.restoreAllMocks();
});

function card(request = ask({ command: 'npm test', description: 'Run the tests' }, { always: 'Always allow npm test * in this project' })) {
  render(<PermissionCard sessionId={SESSION} request={request} />);
  const root = document.querySelector('[data-card]')!;
  return {
    root,
    head: root.querySelector('[data-card-head]')!,
    foot: root.querySelector('[data-card-foot]')!,
  };
}

describe('what is scrolled under a card’s head or its foot', () => {
  it('is marked, for the quiet line and the room there, and not while nothing is under them', async () => {
    const { root, head, foot } = card();
    const middle = head.nextElementSibling!;
    expect(foot.previousElementSibling).toBe(middle);
    // At rest: the head, what it asks about a little below it, the foot after it.
    place(head, 0, 36);
    place(middle, 40, 120);
    place(foot, 120, 200);
    await act(async () => {
      document.dispatchEvent(new Event('scroll'));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(root.hasAttribute('data-cut-top')).toBe(false);
    expect(root.hasAttribute('data-cut-bottom')).toBe(false);
    // Scrolled: under the head at its top, under the foot at its end.
    place(middle, 20, 150);
    await act(async () => {
      document.dispatchEvent(new Event('scroll'));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(root.hasAttribute('data-cut-top')).toBe(true);
    expect(root.hasAttribute('data-cut-bottom')).toBe(true);
  });
});
