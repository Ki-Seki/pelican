// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ChatMessage, RunSettings } from '../src/shared/protocol';

const SESSION = '33333333-2222-4333-8444-555555555555';
const SIDE = '55555555-2222-4333-8444-555555555555';
const CWD = '/code/app';

/** What the computer was asked, and what it answers. */
const server = vi.hoisted(() => ({
  side: [] as Array<{ id: string; question: string; settings: RunSettings; uuid: string }>,
  sent: [] as Array<{ id: string; text: string }>,
  /** The side chat's transcript: the copy of the session's conversation, then its own. */
  sideMessages: [] as ChatMessage[],
}));

vi.mock('../src/web/lib/api', async (original) => {
  const actual = await original<typeof import('../src/web/lib/api')>();
  const prompt: ChatMessage = { uuid: 'u1', role: 'user', blocks: [{ type: 'text', text: 'Clean up the build' }], timestamp: Date.now() - 60_000 };
  return {
    ...actual,
    api: {
      ...actual.api,
      models: async () => ({ models: [], signedIn: true }),
      usage: async () => [],
      defaults: async () => ({ permissionMode: null }),
      completions: async () => ({ commands: [], agents: [] }),
      git: async () => ({ repo: false }),
      tree: async () => [],
      session: async (id: string) => ({
        session: { id, title: 'Clean up the build', cwd: CWD, project: 'app', lastActivity: Date.now() - 60_000, status: 'idle' },
        run: null,
        tasks: [],
        settings: {},
      }),
      messages: async (id: string) => {
        const messages = id === SIDE ? [prompt, ...server.sideMessages] : [prompt];
        return { messages, total: messages.length, offset: 0 };
      },
      send: async (id: string, body: { text: string }) => {
        server.sent.push({ id, text: body.text });
        return { sessionId: id };
      },
      side: async (id: string, body: { question: string; settings: RunSettings; uuid: string }) => {
        server.side.push({ id, ...body });
        return { sessionId: SIDE };
      },
    },
  };
});

let media: Record<string, boolean> = {};
beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: Boolean(media[query]), media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    setTimeout(() => this.dispatchEvent(new Event('close')), 0);
  };
});

const { Chat } = await import('../src/web/components/Chat');
const { setPrefs } = await import('../src/web/lib/prefs');

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  media = {};
  setPrefs({ workspacePane: false });
  Object.assign(server, { side: [], sent: [], sideMessages: [] });
});

/** A computer wide enough for panes beside the conversation; Changes and files docks from 1440. */
const computer = (width: number) => {
  media = { '(min-width: 1280px)': width >= 1280, '(min-width: 1440px)': width >= 1440, '(hover: hover) and (pointer: fine)': true, '(pointer: fine)': true };
};
const wrap = (node: React.ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);
const session = () => wrap(<Chat sessionId={SESSION} home="/home/me" machine="studio" demo wide onBack={() => {}} onOpen={() => {}} onStartIn={() => {}} />);
const loaded = () => screen.findAllByText('Clean up the build');
const pane = () => screen.queryByRole('complementary', { name: 'Side chat' });

function type(label: string, text: string) {
  const box = screen.getByLabelText(label);
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: 'Enter', keyCode: 13 });
}

describe('the side chat', () => {
  it('opens with /btw and its question, beside the conversation, and the session gets nothing', async () => {
    computer(1280);
    session();
    await loaded();
    type('Message Claude', '/btw why is the cache key per user?');
    await waitFor(() => expect(server.side).toHaveLength(1));
    expect(server.side[0]).toMatchObject({ id: SESSION, question: 'why is the cache key per user?' });
    expect(server.sent).toEqual([]);
    expect(pane()).not.toBeNull();
    expect(within(pane()!).getByText('why is the cache key per user?')).toBeTruthy();
    // Only its own conversation: the copy of the session's is not shown again.
    expect(within(pane()!).queryByText('Clean up the build')).toBeNull();
  });

  it('opens with Cmd/Ctrl+;, and goes on with the same side chat once opened again in this visit', async () => {
    computer(1440);
    const first = session();
    await loaded();
    act(() => {
      fireEvent.keyDown(window, { key: ';', metaKey: true, ctrlKey: true });
    });
    // One modifier only, as the platform has it.
    expect(pane()).toBeNull();
    act(() => {
      fireEvent.keyDown(window, { key: ';', ctrlKey: true });
    });
    expect(pane()).not.toBeNull();
    type('Side question', 'What does the build cache hold?');
    await waitFor(() => expect(server.side).toHaveLength(1));
    first.unmount();

    session();
    await loaded();
    act(() => {
      fireEvent.keyDown(window, { key: ';', ctrlKey: true });
    });
    type('Side question', 'And how big does it get?');
    await waitFor(() => expect(server.sent).toEqual([{ id: SIDE, text: 'And how big does it get?' }]));
    expect(server.side).toHaveLength(1);
  });

  it('opens from the session menu, and New starts another from the session as it is now', async () => {
    computer(1280);
    session();
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Session menu' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Side chat/ }));
    await waitFor(() => expect(pane()).not.toBeNull());
    type('Side question', 'Which step is slowest?');
    await waitFor(() => expect(server.side).toHaveLength(1));
    fireEvent.click(within(pane()!).getByRole('button', { name: 'New side chat' }));
    type('Side question', 'Where are the logs?');
    await waitFor(() => expect(server.side).toHaveLength(2));
    expect(server.sent).toEqual([]);
  });

  it('takes the place of Changes and files beside the conversation, which comes back when it closes or is asked for', async () => {
    computer(1440);
    setPrefs({ workspacePane: true });
    session();
    await loaded();
    const changes = () => screen.queryByRole('complementary', { name: 'Changes and files' });
    await waitFor(() => expect(changes()).not.toBeNull());
    act(() => {
      fireEvent.keyDown(window, { key: ';', ctrlKey: true });
    });
    expect(pane()).not.toBeNull();
    expect(changes()).toBeNull();
    // Closed: Changes and files is back where it was.
    fireEvent.click(within(pane()!).getByRole('button', { name: 'Close' }));
    expect(pane()).toBeNull();
    expect(changes()).not.toBeNull();
    // Asked for while the side chat is there: it takes its place.
    act(() => {
      fireEvent.keyDown(window, { key: ';', ctrlKey: true });
    });
    expect(changes()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Changes and files' }));
    expect(pane()).toBeNull();
    expect(changes()).not.toBeNull();
  });

  it('is a sheet over the conversation on a phone', async () => {
    media = {};
    session();
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Session menu' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Side chat/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Side chat' });
    expect(within(sheet).getByText('Reads this session · changes nothing')).toBeTruthy();
    expect(pane()).toBeNull();
  });
});
