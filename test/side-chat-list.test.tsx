// @vitest-environment jsdom
// A side chat picked by name, from the session list (its options showing side chats, or a search)
// or ⌘K, opens as its session's side chat, on that one, not as a copy of the session.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ChatMessage, SessionSummary } from '../src/shared/protocol';

const SESSION = '55555555-2222-4333-8444-555555555555';
const LATEST = '56565656-2222-4333-8444-555555555555';
const EARLIER = '57575757-2222-4333-8444-555555555555';
const ORPHAN = '58585858-2222-4333-8444-555555555555';
const ago = (minutes: number) => Date.now() - minutes * 60_000;
const listed: SessionSummary[] = [
  { id: SESSION, title: 'Fix the flaky login test', cwd: '/code/app', project: 'app', lastActivity: ago(1), status: 'idle' },
  { id: LATEST, title: 'Why a timeout and not a wait?', cwd: '/code/app', project: 'app', lastActivity: ago(2), status: 'idle', sideChatOf: SESSION, sideQuestion: 'Why a timeout and not a wait?', sideStart: 'q2' },
  { id: EARLIER, title: 'Which test is flaky?', cwd: '/code/app', project: 'app', lastActivity: ago(30), status: 'idle', sideChatOf: SESSION, sideQuestion: 'Which test is flaky?', sideStart: 'q1' },
  // Its session is gone: it opens on its own.
  { id: ORPHAN, title: 'Where did it go?', cwd: '/code/app', project: 'app', lastActivity: ago(40), status: 'idle', sideChatOf: '59595959-2222-4333-8444-555555555555', sideQuestion: 'Where did it go?', sideStart: 'q3' },
];
const prompt: ChatMessage = { uuid: 'p1', role: 'user', blocks: [{ type: 'text', text: 'Fix the flaky login test' }], timestamp: ago(60) };
const own: Record<string, ChatMessage[]> = {
  [LATEST]: [{ uuid: 'q2', role: 'user', blocks: [{ type: 'text', text: 'Why a timeout and not a wait?' }], timestamp: ago(3) }, { uuid: 'a2', role: 'assistant', blocks: [{ type: 'text', text: 'A wait has nothing to wait for there.' }], timestamp: ago(2) }],
  [EARLIER]: [{ uuid: 'q1', role: 'user', blocks: [{ type: 'text', text: 'Which test is flaky?' }], timestamp: ago(31) }, { uuid: 'a1', role: 'assistant', blocks: [{ type: 'text', text: 'The sign-in test, on a slow machine.' }], timestamp: ago(30) }],
};

vi.mock('../src/web/lib/api', async (original) => {
  const actual = await original<typeof import('../src/web/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      auth: async () => ({ required: false, mode: 'none', signedIn: true }),
      info: async () => ({ machine: 'studio', home: '/home/me', version: '0.5.0', auth: false, demo: true }),
      sessions: async () => listed,
      models: async () => ({ models: [], signedIn: true }),
      usage: async () => [],
      planUsage: async () => null,
      defaults: async () => (await import('./start-defaults')).BUILT_IN,
      git: async () => ({ repo: false }),
      changes: async () => ({ turns: [], lines: {} }),
      completions: async () => ({ commands: [], agents: [] }),
      session: async (id: string) => ({ session: listed.find((s) => s.id === id) ?? listed[0], run: null, tasks: [], settings: {} }),
      messages: async (id: string) => {
        const messages = [prompt, ...(own[id] ?? [])];
        return { messages, total: messages.length, offset: 0 };
      },
    },
  };
});

let media: Record<string, boolean> = {};
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
  Element.prototype.scrollIntoView = vi.fn();
  Object.assign(globalThis, {
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
  });
});

const { App } = await import('../src/web/App');
const { setPrefs } = await import('../src/web/lib/prefs');
const { forgetSideChats } = await import('../src/web/components/SideChat');
const { showCommandMenu } = await import('../src/web/components/CommandMenu');

afterEach(() => {
  cleanup();
  showCommandMenu(false);
  forgetSideChats();
  setPrefs({ showSideChats: false });
  localStorage.clear();
  history.replaceState(null, '', '/');
});

const computer = () => {
  media = {
    '(min-width: 1024px)': true, '(min-width: 1280px)': true, '(min-width: 640px)': true,
    '(hover: hover) and (pointer: fine)': true, '(hover: hover)': true, '(pointer: fine)': true,
  };
};
async function page(route = '') {
  history.replaceState(null, '', `/${route}`);
  render(<QueryClientProvider client={new QueryClient()}><App /></QueryClientProvider>);
  await screen.findAllByText('Fix the flaky login test');
}
const row = (name: string) => within(document.querySelector<HTMLElement>('aside[data-list]') ?? document.body).getByRole('link', { name: new RegExp(`^${name.replace(/[?]/g, '\\?')}`) });
const sideChat = () => screen.queryByRole('complementary', { name: 'Side chat' });

describe('a side chat picked by name', () => {
  it('from its row in the list, opens its session with it as its side chat, named by its first question', async () => {
    computer();
    setPrefs({ showSideChats: true });
    await page();
    fireEvent.click(row('Which test is flaky?'));
    await waitFor(() => expect(location.search).toBe(`?s=${SESSION}`));
    const pane = await screen.findByRole('complementary', { name: 'Side chat' });
    expect(await within(pane).findByRole('heading', { name: 'Side chat · Which test is flaky?' })).toBeTruthy();
    expect(await within(pane).findByText('The sign-in test, on a slow machine.')).toBeTruthy();
    // Its session's own conversation, read only in the side chat's copy, is the session's here.
    expect(screen.getByLabelText('Message Claude')).toBeTruthy();
    // Another of its rows, with the session open: the side chat shows that one.
    fireEvent.click(row('Why a timeout and not a wait?'));
    expect(await within(sideChat()!).findByRole('heading', { name: 'Side chat · Why a timeout and not a wait?' })).toBeTruthy();
    expect(location.search).toBe(`?s=${SESSION}`);
  });

  it('from ⌘K, by its question, the same way; one whose session is gone opens on its own', async () => {
    computer();
    await page();
    act(() => {
      fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    });
    const menu = await screen.findByRole('dialog', { name: /command/i });
    fireEvent.change(within(menu).getByRole('combobox'), { target: { value: 'which test' } });
    fireEvent.click(await within(menu).findByText('Which test is flaky?'));
    await waitFor(() => expect(location.search).toBe(`?s=${SESSION}`));
    expect(await within(await screen.findByRole('complementary', { name: 'Side chat' })).findByRole('heading', { name: 'Side chat · Which test is flaky?' })).toBeTruthy();
    cleanup();
    forgetSideChats();
    setPrefs({ showSideChats: true });
    await page();
    fireEvent.click(row('Where did it go?'));
    await waitFor(() => expect(location.search).toBe(`?s=${ORPHAN}`));
  });
});
