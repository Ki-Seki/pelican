// @vitest-environment jsdom
// On a computer the session list hides and shows (its button, ⌘B, as in Claude Desktop), remembered
// in this browser; hidden, it floats in at the window's left edge. ⌘K opens the command menu.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { SessionSummary } from '../src/shared/protocol';

const SESSION = '55555555-2222-4333-8444-555555555555';
const listed: SessionSummary[] = [
  { id: SESSION, title: 'Fix the flaky login test', cwd: '/code/app', project: 'app', lastActivity: Date.now() - 60_000, status: 'idle' },
  { id: '66666666-2222-4333-8444-555555555555', title: 'Release notes for v2.4', cwd: '/code/docs', project: 'docs', lastActivity: Date.now() - 120_000, status: 'idle' },
];

vi.mock('../src/web/lib/api', async (original) => {
  const actual = await original<typeof import('../src/web/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      auth: async () => ({ required: false, mode: 'none', signedIn: true }),
      info: async () => ({ machine: 'studio', home: '/home/me', version: '0.5.0', auth: false, demo: false }),
      sessions: async () => listed,
      models: async () => ({ models: [], signedIn: true }),
      usage: async () => [],
      planUsage: async () => null,
      defaults: async () => (await import('./start-defaults')).BUILT_IN,
      git: async () => ({ repo: false }),
      changes: async () => ({ turns: [], lines: {} }),
      completions: async () => ({ commands: [], agents: [] }),
      session: async (id: string) => ({ session: listed.find((s) => s.id === id) ?? listed[0], run: null, tasks: [], settings: {} }),
      messages: async () => ({ messages: [], total: 0, offset: 0 }),
    },
  };
});

let media: Record<string, boolean> = {};
const computer = (width: number) => {
  media = {
    '(min-width: 1024px)': width >= 1024, '(min-width: 1280px)': width >= 1280, '(min-width: 640px)': true,
    '(hover: hover) and (pointer: fine)': true, '(hover: hover)': true, '(pointer: fine)': true,
  };
};
beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: Boolean(media[query]), media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
  Object.assign(globalThis, {
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
  });
});

const { App } = await import('../src/web/App');
const { getPrefs, setPrefs } = await import('../src/web/lib/prefs');
const { showCommandMenu } = await import('../src/web/components/CommandMenu');

afterEach(() => {
  cleanup();
  showCommandMenu(false);
  setPrefs({ sidebar: 'shown' });
  delete document.documentElement.dataset.pane;
  history.replaceState(null, '', '/');
});

async function page(route = `?s=${SESSION}`) {
  history.replaceState(null, '', `/${route}`);
  render(<QueryClientProvider client={new QueryClient()}><App /></QueryClientProvider>);
  await screen.findAllByText('Release notes for v2.4');
  // The conversation loads when first needed.
  if (route) await waitFor(() => expect(document.querySelector('main header')).not.toBeNull(), { timeout: 5000 });
}
const list = () => document.querySelector<HTMLElement>('aside[data-list]')!;
/** The list as a reader has it: there, or hidden from the page (out of sight, and out of the keys' way). */
const listShown = () => !list().hasAttribute('inert');
const key = (init: KeyboardEventInit) => act(() => {
  fireEvent.keyDown(window, init);
});

describe('the session list on a computer', () => {
  it('hides with its button and comes back with the one in the conversation’s header, remembered in this browser', async () => {
    computer(1440);
    await page();
    expect(listShown()).toBe(true);
    fireEvent.click(within(list()).getByRole('button', { name: 'Hide sidebar' }));
    expect(listShown()).toBe(false);
    expect(getPrefs().sidebar).toBe('hidden');
    // The conversation takes the whole width; the way back is first in its header.
    const show = within(document.querySelector('main header')!).getByRole('button', { name: 'Show sidebar' });
    expect(show.getAttribute('title')).toBe('Show sidebar (Ctrl+B)');
    fireEvent.click(show);
    expect(listShown()).toBe(true);
    expect(getPrefs().sidebar).toBe('shown');
  });

  it('hides and shows with ⌘B, as in Claude Desktop', async () => {
    computer(1440);
    await page();
    key({ key: 'b', code: 'KeyB', ctrlKey: true });
    expect(listShown()).toBe(false);
    key({ key: 'b', code: 'KeyB', ctrlKey: true });
    expect(listShown()).toBe(true);
  });

  it('hidden, floats in at the window’s left edge or its button, and goes when the pointer leaves, with Esc, or once a session is picked', async () => {
    computer(1440);
    setPrefs({ sidebar: 'hidden' });
    await page();
    expect(listShown()).toBe(false);
    fireEvent.pointerEnter(document.querySelector('[data-sidebar-edge]')!, { pointerType: 'mouse' });
    expect(listShown()).toBe(true);
    // Hidden still, as chosen: it floats over the conversation.
    expect(document.querySelector('[data-layout]')!.getAttribute('data-sidebar')).toBe('hidden');
    fireEvent.pointerLeave(list(), { pointerType: 'mouse' });
    await waitFor(() => expect(listShown()).toBe(false));
    fireEvent.pointerEnter(within(document.querySelector('main header')!).getByRole('button', { name: 'Show sidebar' }), { pointerType: 'mouse' });
    expect(listShown()).toBe(true);
    key({ key: 'Escape' });
    expect(listShown()).toBe(false);
    fireEvent.pointerEnter(document.querySelector('[data-sidebar-edge]')!, { pointerType: 'mouse' });
    fireEvent.click(within(list()).getByRole('link', { name: /^Release notes for v2\.4/ }));
    expect(listShown()).toBe(false);
    expect(location.search).toBe('?s=66666666-2222-4333-8444-555555555555');
  });

  it('floating in, goes as the pointer moves anywhere off it, though it never was on it', async () => {
    computer(1440);
    setPrefs({ sidebar: 'hidden' });
    await page();
    fireEvent.pointerEnter(document.querySelector('[data-sidebar-edge]')!, { pointerType: 'mouse' });
    // A pointer moving on it keeps it.
    fireEvent.pointerMove(list(), { pointerType: 'mouse' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(listShown()).toBe(true);
    // It floated in under a pointer that moved straight on over the conversation.
    fireEvent.pointerMove(document.querySelector('main')!, { pointerType: 'mouse' });
    await waitFor(() => expect(listShown()).toBe(false));
  });

  it('hidden, floats in for ⇧⌘K, its search taking the keys', async () => {
    computer(1440);
    setPrefs({ sidebar: 'hidden' });
    await page();
    key({ key: 'K', code: 'KeyK', ctrlKey: true, shiftKey: true });
    expect(listShown()).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Search sessions' })));
  });

  it('between 1024 and 1279px, is hidden the same way while a pane sits beside the conversation, and ⌘B brings it back', async () => {
    computer(1100);
    await page();
    expect(listShown()).toBe(true);
    act(() => {
      document.documentElement.dataset.pane = 'docked';
    });
    await waitFor(() => expect(listShown()).toBe(false));
    // Not a choice to remember: the pane made the room.
    expect(getPrefs().sidebar).toBe('shown');
    expect(within(document.querySelector('main header')!).getByRole('button', { name: 'Show sidebar' })).toBeTruthy();
    key({ key: 'b', code: 'KeyB', ctrlKey: true });
    expect(listShown()).toBe(true);
    act(() => {
      delete document.documentElement.dataset.pane;
    });
    await waitFor(() => expect(listShown()).toBe(true));
  });
});

describe('the command menu', () => {
  it('opens with ⌘K, finds a session by name, and opens it', async () => {
    computer(1440);
    await page();
    key({ key: 'k', code: 'KeyK', ctrlKey: true });
    const menu = await screen.findByRole('dialog', { name: 'Command menu' });
    fireEvent.change(within(menu).getByRole('combobox'), { target: { value: 'release' } });
    fireEvent.click(within(menu).getByRole('option', { name: /Release notes for v2\.4/ }));
    await waitFor(() => expect(location.search).toBe('?s=66666666-2222-4333-8444-555555555555'));
  });

  it('lists the page’s own: New session, Settings with /config, Keyboard shortcuts, the sidebar', async () => {
    computer(1440);
    await page('');
    key({ key: 'k', code: 'KeyK', ctrlKey: true });
    const menu = await screen.findByRole('dialog', { name: 'Command menu' });
    expect(within(menu).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'New sessionCtrl+Shift+O', 'Settings/configCtrl+Shift+,', 'Keyboard shortcutsCtrl+/', 'Hide sidebarCtrl+B',
    ]);
  });
});
