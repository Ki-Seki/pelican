// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

/** A window whose width can change: each query matches from its min-width on. */
let width = 1280;
const listeners = new Map<string, Set<() => void>>();
beforeAll(() => {
  window.matchMedia = ((query: string) => {
    const min = Number(/min-width: (\d+)px/.exec(query)?.[1] ?? 0);
    return {
      get matches() {
        return width >= min;
      },
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: () => void) => {
        if (!listeners.has(query)) listeners.set(query, new Set());
        listeners.get(query)!.add(listener);
      },
      removeEventListener: (_type: string, listener: () => void) => listeners.get(query)?.delete(listener),
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    };
  }) as unknown as typeof window.matchMedia;
});

function resize(to: number) {
  width = to;
  act(() => {
    for (const set of listeners.values()) for (const listener of set) listener();
  });
}

const { useMedia } = await import('../src/web/lib/media');

function Beside() {
  return <p>{useMedia('(min-width: 1024px)') ? 'beside' : 'over'}</p>;
}

afterEach(() => {
  cleanup();
  width = 1280;
  listeners.clear();
});

describe('a media query, as the window has it', () => {
  it('matches from the first render, follows the window as it changes, and stops listening once gone', () => {
    const view = render(<Beside />);
    expect(screen.getByText('beside')).toBeTruthy();
    resize(800);
    expect(screen.getByText('over')).toBeTruthy();
    resize(1024);
    expect(screen.getByText('beside')).toBeTruthy();
    view.unmount();
    expect([...listeners.values()].every((set) => set.size === 0)).toBe(true);
  });
});
