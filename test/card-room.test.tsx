// @vitest-environment jsdom
// A card with less room than it needs (src/web/components/PermissionCard.tsx): what it asks about
// shows above its buttons, as on an upright phone (on a Pixel 7 on its side `npm test` sat under
// Allow and Deny), and what is scrolled under its head or its foot is cut at a quiet line, a little
// way off, as Claude Desktop cuts it (a question's title sat on half an option). jsdom lays nothing
// out: each part's place on the screen is set here.
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PermissionRequest } from '../src/shared/protocol';

Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
Object.assign(window, { matchMedia: (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }) });

const { keepAskedInView, PermissionCard } = await import('../src/web/components/PermissionCard');

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
    asks: root.querySelector('[data-asks]')!,
    foot: root.querySelector('[data-card-foot]')!,
  };
}

describe('what an approval asks about, where the card has little room', () => {
  it('is scrolled into view above Allow and Deny when it lies under them, the words above it going under the head', () => {
    const { root, head, asks, foot } = card();
    const scroller = document.createElement('div');
    // As on a Pixel 7 on its side: the command's box 34 px, 9 px of it above the foot.
    place(head, 0, 36);
    place(asks, 87, 121);
    place(foot, 96, 208);
    keepAskedInView(scroller, root);
    expect(scroller.scrollTop).toBe(33);
  });

  it('is left as it is when it shows above them', () => {
    const { root, head, asks, foot } = card();
    const scroller = document.createElement('div');
    place(head, 0, 36);
    place(asks, 87, 121);
    place(foot, 136, 200);
    keepAskedInView(scroller, root);
    expect(scroller.scrollTop).toBe(0);
  });

  it('shows the start of a long command, a few lines of it, at most as far as the head allows', () => {
    const { root, head, asks, foot } = card(ask({ command: Array.from({ length: 8 }, (_, i) => `echo ${i}`).join('\n') }));
    const scroller = document.createElement('div');
    place(head, 0, 36);
    place(asks, 120, 300);
    place(foot, 130, 250);
    keepAskedInView(scroller, root);
    // Three lines' worth above the foot's room: 64 - (130 - 8 - 120).
    expect(scroller.scrollTop).toBe(62);
    // Where the head is near, only so far as to keep it clear of the head's room.
    scroller.scrollTop = 0;
    place(asks, 50, 300);
    place(foot, 80, 200);
    keepAskedInView(scroller, root);
    expect(scroller.scrollTop).toBe(6);
  });

  it('keeps what "always" saves beside Allow and Deny where the foot must leave room (a short screen), on a line of its own elsewhere', () => {
    card();
    const allow = screen.getByRole('button', { name: 'Allow' });
    const always = screen.getByRole('button', { name: 'Always allow npm test * in this project' });
    expect(always.parentElement!.parentElement).toBe(allow.parentElement);
    expect(always.parentElement!.className).toContain('basis-full');
    expect(always.parentElement!.className).toContain('[@media(max-height:600px)]:basis-auto');
  });
});

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
