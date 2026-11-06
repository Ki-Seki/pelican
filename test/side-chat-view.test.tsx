// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ChatMessage, GitStatus, RunSettings, SessionChanges } from '../src/shared/protocol';

const SESSION = '33333333-2222-4333-8444-555555555555';
const SIDE = '55555555-2222-4333-8444-555555555555';
const CWD = '/code/app';

/** What the computer was asked, and what it answers. */
const server = vi.hoisted(() => ({
  side: [] as Array<{ id: string; question: string; settings: RunSettings; uuid: string }>,
  sent: [] as Array<{ id: string; text: string }>,
  /** The session's conversation after its first prompt. */
  after: [] as ChatMessage[],
  /** The side chat's transcript: the copy of the session's conversation, then its own. */
  sideMessages: [] as ChatMessage[],
  git: { repo: false } as GitStatus,
  /** The turns Claude Code's record says changed files. */
  turns: [{ uuid: 'u1', n: 1, text: 'Clean up the build', files: [{ path: 'src/cache.ts', added: 2, removed: 1 }], checkpoint: true }] as SessionChanges['turns'],
  /** A side question does not reach the computer. */
  drop: false,
  /** Holds the next side question's answer until it settles. */
  hold: undefined as Promise<void> | undefined,
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
      git: async () => server.git,
      tree: async () => [],
      exists: async (_cwd: string, paths: string[]) => paths,
      file: async (_cwd: string, path: string) => ({ path, size: 24, text: 'const key = user.id;\nexport { key };\n' }),
      changes: async () => ({ turns: server.turns, lines: {} }),
      turnDiff: async () => '',
      session: async (id: string) => ({
        session: { id, title: 'Clean up the build', cwd: CWD, project: 'app', lastActivity: Date.now() - 60_000, status: 'idle', ...(id === SIDE ? { title: 'Side chat', sideChatOf: SESSION } : {}) },
        run: null,
        tasks: [],
        settings: {},
      }),
      messages: async (id: string) => {
        const messages = id === SIDE ? [prompt, ...server.after, ...server.sideMessages] : [prompt, ...server.after];
        return { messages, total: messages.length, offset: 0 };
      },
      send: async (id: string, body: { text: string }) => {
        server.sent.push({ id, text: body.text });
        return { sessionId: id };
      },
      side: async (id: string, body: { question: string; settings: RunSettings; uuid: string }) => {
        server.side.push({ id, ...body });
        const held = server.hold;
        server.hold = undefined;
        await held;
        if (server.drop) throw new actual.ApiError('Can’t reach studio', 0);
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
  Element.prototype.scrollIntoView = vi.fn();
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    setTimeout(() => this.dispatchEvent(new Event('close')), 0);
  };
  // As in a browser: behind an open modal dialog, or in an inert one, nothing takes focus.
  const focus = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function focusUnlessInert(this: HTMLElement, options?: FocusOptions) {
    const top = [...document.querySelectorAll('dialog[open]')].at(-1);
    if (this.closest('[inert]') || (top && !top.contains(this))) return;
    focus.call(this, options);
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
  Object.assign(server, { side: [], sent: [], after: [], sideMessages: [], git: { repo: false }, turns: [{ uuid: 'u1', n: 1, text: 'Clean up the build', files: [{ path: 'src/cache.ts', added: 2, removed: 1 }], checkpoint: true }], drop: false, hold: undefined });
  history.replaceState(null, '', '/');
});

/** A computer: panes sit beside the conversation from 1024px, and the session list fits beside them from 1280px. */
const computer = (width: number) => {
  media = { '(min-width: 1024px)': width >= 1024, '(min-width: 1280px)': width >= 1280, '(min-width: 1440px)': width >= 1440, '(hover: hover) and (pointer: fine)': true, '(pointer: fine)': true };
};
const wrap = (node: React.ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);
const session = () => wrap(<Chat sessionId={SESSION} home="/home/me" machine="studio" demo wide onBack={() => {}} onOpen={() => {}} onStartIn={() => {}} />);
const loaded = () => screen.findAllByText('Clean up the build');
const pane = () => screen.queryByRole('complementary', { name: 'Side chat' });
/** The tabs of Changes and files load when first shown, which takes longer on a busy machine. */
const LAZY = { timeout: 5000 };

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

  it('opened from the session menu on a computer, has the keys once the menu has gone; closed, they go to the message box', async () => {
    computer(1280);
    session();
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Session menu' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Side chat/ }));
    await waitFor(() => expect(document.querySelector('dialog[open]')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Side question')));
    fireEvent.keyDown(screen.getByLabelText('Side question'), { key: 'Escape' });
    expect(pane()).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText('Message Claude'));
  });

  it('beside the conversation, closes with Cmd/Ctrl+\\ pressed in it, as Changes and files does; pressed in the conversation, it stays', async () => {
    computer(1280);
    session();
    await loaded();
    act(() => {
      fireEvent.keyDown(window, { key: ';', ctrlKey: true });
    });
    fireEvent.keyDown(screen.getByLabelText('Message Claude'), { key: '\\', ctrlKey: true });
    expect(pane()).not.toBeNull();
    fireEvent.keyDown(screen.getByLabelText('Side question'), { key: '\\', metaKey: true });
    expect(pane()).toBeNull();
    act(() => {
      fireEvent.keyDown(window, { key: ';', ctrlKey: true });
    });
    fireEvent.keyDown(screen.getByLabelText('Side question'), { key: '\\' });
    expect(pane()).not.toBeNull();
    fireEvent.keyDown(screen.getByLabelText('Side question'), { key: '\\', ctrlKey: true });
    expect(pane()).toBeNull();
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

  it('in a folder git does not track, where no turn changed files, gives the place back to the Changes tab tapped there', async () => {
    computer(1280);
    setPrefs({ workspacePane: true });
    server.turns = [];
    history.replaceState(null, '', `/?s=${SESSION}&w=changes`);
    session();
    await loaded();
    const changes = () => screen.queryByRole('complementary', { name: 'Changes and files' });
    const tab = () => within(changes()!).getByRole('button', { name: 'Changes' });
    // Nothing to compare: it starts in Files, and Changes, tapped, says why it is empty.
    await waitFor(() => expect(location.search).toContain('w=files'));
    fireEvent.click(tab());
    expect(await within(changes()!).findByText('This folder is not a git repository', {}, LAZY)).toBeTruthy();
    const stays = async () => {
      expect(changes()).not.toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(location.search).toContain('w=changes');
      expect(tab().getAttribute('aria-pressed')).toBe('true');
      expect(within(changes()!).getByText('This folder is not a git repository')).toBeTruthy();
    };
    // The side chat takes its place for a while: closed, it gives the place back as it was.
    act(() => {
      fireEvent.keyDown(window, { key: ';', ctrlKey: true });
    });
    expect(changes()).toBeNull();
    fireEvent.click(within(pane()!).getByRole('button', { name: 'Close' }));
    await stays();
    // And when Changes and files is asked for from its button.
    act(() => {
      fireEvent.keyDown(window, { key: ';', ctrlKey: true });
    });
    expect(changes()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Changes and files' }));
    expect(pane()).toBeNull();
    await stays();
    // Closed for good and opened again, it starts in Files again.
    fireEvent.click(within(changes()!).getByRole('button', { name: 'Close' }));
    expect(changes()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Changes and files' }));
    await waitFor(() => expect(location.search).toContain('w=files'));
  });

  describe('asked for a file or a turn’s changes', () => {
    const answer = (uuid: string, text: string): ChatMessage => ({ uuid, role: 'assistant', blocks: [{ type: 'text', text }], timestamp: Date.now() - 30_000 });
    const changes = () => screen.queryByRole('complementary', { name: 'Changes and files' });
    const file = () => screen.queryByRole('group', { name: 'The text of src/cache.ts' });
    /** Side chat open with its first question answered, as it is remembered in this tab. */
    const answered = () => {
      server.sideMessages = [
        { uuid: 'q1', role: 'user', blocks: [{ type: 'text', text: 'Where is the key made?' }], timestamp: Date.now() - 20_000 },
        answer('a2', 'In `src/cache.ts:1`, from the user.'),
      ];
      sessionStorage.setItem('pelican:side-chats', JSON.stringify({ [SESSION]: { id: SIDE, first: 'q1' } }));
    };

    it('in the conversation, while the side chat sits in the pane’s place: the side chat makes way', async () => {
      computer(1440);
      setPrefs({ workspacePane: true });
      server.after = [answer('a1', 'The key is made in `src/cache.ts:1`.')];
      session();
      await loaded();
      await waitFor(() => expect(changes()).not.toBeNull());
      act(() => {
        fireEvent.keyDown(window, { key: ';', ctrlKey: true });
      });
      expect(changes()).toBeNull();
      fireEvent.click(await screen.findByRole('link', { name: 'src/cache.ts:1' }));
      expect(pane()).toBeNull();
      expect(changes()).not.toBeNull();
      await waitFor(() => expect(file()).not.toBeNull(), LAZY);
      expect(location.search).toContain('p=src%2Fcache.ts');
    });

    it('under a turn, “files changed”: the side chat makes way for that turn’s changes', async () => {
      computer(1280);
      setPrefs({ workspacePane: true });
      server.after = [answer('a1', 'Done: the cache is cleaned up.')];
      session();
      await loaded();
      act(() => {
        fireEvent.keyDown(window, { key: ';', ctrlKey: true });
      });
      fireEvent.click(await screen.findByRole('button', { name: /1 file changed/ }));
      expect(pane()).toBeNull();
      expect(changes()).not.toBeNull();
      expect(location.search).toContain('t=u1');
    });

    it('in the side chat’s answer, beside the conversation: it shows the file in its place', async () => {
      computer(1440);
      setPrefs({ workspacePane: true });
      answered();
      session();
      await loaded();
      act(() => {
        fireEvent.keyDown(window, { key: ';', ctrlKey: true });
      });
      fireEvent.click(await within(pane()!).findByRole('link', { name: 'src/cache.ts:1' }));
      expect(pane()).toBeNull();
      await waitFor(() => expect(file()).not.toBeNull(), LAZY);
    });

    it('in the side chat’s answer, on a phone: the sheet goes first, then the file opens over the conversation', async () => {
      media = {};
      answered();
      session();
      await loaded();
      fireEvent.click(screen.getByRole('button', { name: 'Session menu' }));
      fireEvent.click(await screen.findByRole('button', { name: /^Side chat/ }));
      const sheet = await screen.findByRole('dialog', { name: 'Side chat' });
      fireEvent.click(await within(sheet).findByRole('link', { name: 'src/cache.ts:1' }));
      // While the sheet plays its way out it holds the page: the view waits for it.
      expect(screen.queryByRole('region', { name: 'Changes and files' })).toBeNull();
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Side chat' })).toBeNull());
      const view = await screen.findByRole('region', { name: 'Changes and files' });
      await waitFor(() => expect(within(view).getByRole('group', { name: 'The text of src/cache.ts' })).toBeTruthy(), LAZY);
      expect(location.search).toContain('w=files');
    });
  });

  it('sits beside the conversation from 1024px, as Changes and files does, the session list folding away below 1280px', async () => {
    computer(1024);
    session();
    await loaded();
    expect(screen.queryByRole('button', { name: 'Back to sessions' })).toBeNull();
    act(() => {
      fireEvent.keyDown(window, { key: ';', ctrlKey: true });
    });
    expect(pane()).not.toBeNull();
    expect(screen.queryByRole('dialog', { name: 'Side chat' })).toBeNull();
    expect(document.documentElement.dataset.pane).toBe('docked');
    // The list is folded away: the way back to it is in the header, and Cmd/Ctrl+K brings it back.
    expect(screen.getByRole('button', { name: 'Back to sessions' })).toBeTruthy();
    act(() => {
      fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    });
    expect(pane()).toBeNull();
    expect(document.documentElement.dataset.pane).toBeUndefined();
    expect(screen.queryByRole('button', { name: 'Back to sessions' })).toBeNull();
  });

  it('beside the conversation on a tablet, keeps its box clear of the home indicator, as the conversation’s box beside it is; a phone’s sheet keeps clear itself', async () => {
    /** How deep the box's foot is padded: as deep as the home indicator where there is one, 8px at least, or 8px. */
    const foot = (box: HTMLElement) => (box.closest('.pb-safe, .pb-2')!.classList.contains('pb-safe') ? 'clear of the edge' : '8px');
    media = { '(min-width: 1024px)': true, '(pointer: coarse)': true };
    session();
    await loaded();
    act(() => {
      fireEvent.keyDown(window, { key: ';', ctrlKey: true });
    });
    expect(pane()).not.toBeNull();
    expect(foot(within(pane()!).getByLabelText('Side question'))).toBe('clear of the edge');
    expect(foot(screen.getByLabelText('Message Claude'))).toBe('clear of the edge');
    cleanup();
    media = { '(pointer: coarse)': true };
    session();
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Session menu' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Side chat/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Side chat' });
    const box = within(sheet).getByLabelText('Side question');
    expect(foot(box)).toBe('8px');
    expect(box.closest('.pb-safe')).not.toBeNull();
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

describe('a side question that did not go', () => {
  const question = 'why is the cache key per user?';
  const sideBox = () => screen.getByLabelText('Side question') as HTMLTextAreaElement;
  const toggle = () => act(() => {
    fireEvent.keyDown(window, { key: ';', ctrlKey: true });
  });
  /** Whatever the box was going to do once shown has been done. */
  const settled = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  /** Holds the next side question's answer: what it returns lets it go. */
  function holdNext(): () => Promise<void> {
    let release = () => {};
    server.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => act(async () => release());
  }
  const ask = (text: string) => {
    fireEvent.change(sideBox(), { target: { value: text } });
    fireEvent.keyDown(sideBox(), { key: 'Enter', keyCode: 13, ctrlKey: true });
  };

  it('comes back to its box once, also once the side chat beside the conversation is closed and opened again', async () => {
    computer(1280);
    server.drop = true;
    session();
    await loaded();
    toggle();
    ask(question);
    await within(pane()!).findByText('Can’t reach studio');
    await waitFor(() => expect(sideBox().value).toBe(question));
    fireEvent.click(within(pane()!).getByRole('button', { name: 'Close' }));
    expect(pane()).toBeNull();
    toggle();
    await settled();
    expect(sideBox().value).toBe(question);
  });

  it('keeps what was typed after it came back, the side chat closed and opened again', async () => {
    computer(1280);
    server.drop = true;
    session();
    await loaded();
    toggle();
    ask(question);
    await waitFor(() => expect(sideBox().value).toBe(question));
    fireEvent.change(sideBox(), { target: { value: 'what does the build cache hold?' } });
    fireEvent.click(within(pane()!).getByRole('button', { name: 'Close' }));
    toggle();
    await settled();
    expect(sideBox().value).toBe('what does the build cache hold?');
  });

  it('on a phone, comes back once to the sheet’s box, closed with Done and opened again', async () => {
    media = {};
    server.drop = true;
    session();
    await loaded();
    const open = async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Session menu' }));
      fireEvent.click(await screen.findByRole('button', { name: /^Side chat/ }));
      return screen.findByRole('dialog', { name: 'Side chat' });
    };
    const sheet = await open();
    ask(question);
    await waitFor(() => expect(sideBox().value).toBe(question));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Side chat' })).toBeNull());
    await open();
    await settled();
    expect(sideBox().value).toBe(question);
  });

  it('asked, and the side chat put away before the question went: opened again, the box holds it once', async () => {
    computer(1280);
    server.drop = true;
    session();
    await loaded();
    toggle();
    const release = holdNext();
    ask(question);
    await waitFor(() => expect(server.side).toHaveLength(1));
    fireEvent.click(within(pane()!).getByRole('button', { name: 'Close' }));
    await release();
    toggle();
    await settled();
    expect(sideBox().value).toBe(question);
    expect(within(pane()!).getByText('Can’t reach studio')).toBeTruthy();
  });

  it('starting with / or !, comes back as words above what was typed since: a side chat takes no commands', async () => {
    computer(1280);
    server.drop = true;
    session();
    await loaded();
    toggle();
    const release = holdNext();
    ask('/etc/hosts: who reads it?');
    await waitFor(() => expect(server.side).toHaveLength(1));
    fireEvent.change(sideBox(), { target: { value: 'and when?' } });
    await release();
    await waitFor(() => expect(sideBox().value).toBe('/etc/hosts: who reads it?\n\nand when?'));
    expect(within(pane()!).queryByText(/^Not sent:/)).toBeNull();
  });
});

describe('a side chat opened as a session of its own (from the list, a search, the usage page)', () => {
  const tasks: ChatMessage = {
    uuid: 'a0',
    role: 'assistant',
    blocks: [{ type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [{ content: 'Clean the cache', status: 'in_progress', activeForm: 'Cleaning the cache' }, { content: 'Run the tests', status: 'pending', activeForm: 'Running the tests' }] } }],
    timestamp: Date.now() - 50_000,
  };
  const open = (id: string) => wrap(<Chat sessionId={id} home="/home/me" machine="studio" demo wide onBack={() => {}} onOpen={() => {}} onStartIn={() => {}} />);
  /** The task list pinned above the message box, as live work. */
  const pinned = () => screen.queryByRole('button', { name: /^0\/2/ });

  it('is read only here too: questions, and nothing that runs commands or changes files', async () => {
    computer(1440);
    setPrefs({ workspacePane: true });
    server.git = { repo: true, branch: 'feat/x', base: 'main', remote: true, files: [{ path: 'src/cache.ts', status: 'modified', added: 2, removed: 1 }] };
    server.after = [tasks];
    // The session itself, for comparison: its own box, its tasks, Commit and Create PR, Rewind and Edit.
    history.replaceState(null, '', `/?s=${SESSION}&w=changes`);
    open(SESSION);
    await loaded();
    await screen.findByRole('button', { name: 'Create PR' }, LAZY);
    expect(screen.getByLabelText('Message Claude')).toBeTruthy();
    expect(pinned()).not.toBeNull();
    expect(screen.getByTitle(/^Rewind code/)).toBeTruthy();
    cleanup();

    history.replaceState(null, '', `/?s=${SIDE}&w=changes&t=u1`);
    open(SIDE);
    await screen.findAllByText('Clean up the build');
    const box = screen.getByLabelText('Side question') as HTMLTextAreaElement;
    expect(box.placeholder).toBe('Ask a side question');
    for (const name of ['Attach files', 'Model, effort and speed', 'Permission mode']) expect(screen.queryByRole('button', { name })).toBeNull();
    // The task list it copied is the session's work, not its own.
    expect(pinned()).toBeNull();
    // The prompt it copied offers no Rewind, nor Edit.
    expect(screen.queryByTitle(/^Rewind code/)).toBeNull();
    expect(screen.queryByTitle(/^Edit and send again/)).toBeNull();
    // Its turn's changes, without Rewind code; the folder's, without Commit, Push or Create PR.
    const changes = await screen.findByRole('complementary', { name: 'Changes and files' });
    await within(changes).findByText('cache.ts', {}, LAZY);
    expect(within(changes).queryByText('Rewind code')).toBeNull();
    fireEvent.click(within(changes).getByRole('button', { name: /^Show:/ }));
    fireEvent.click(within(screen.getAllByRole('dialog').at(-1)!).getByText('Uncommitted'));
    await waitFor(() => expect(location.search).not.toContain('t=u1'));
    await within(changes).findByText('cache.ts', {}, LAZY);
    for (const name of ['Commit', 'Push', 'Create PR']) expect(within(changes).queryByRole('button', { name })).toBeNull();
    // A ! is a question's, as in the side chat beside a session: nothing runs.
    fireEvent.change(box, { target: { value: '!npm test' } });
    expect(screen.queryByText('Shell command')).toBeNull();
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 13 });
    await waitFor(() => expect(server.sent).toEqual([{ id: SIDE, text: '!npm test' }]));
  });
});
