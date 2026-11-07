// @vitest-environment jsdom
// Changes and files beside the conversation, driven from the keyboard as in Claude Desktop.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const SESSION = '33333333-2222-4333-8444-555555555555';
const CWD = '/code/app';
/** The terminals asked for, by what the page sent. */
const opened: Array<Record<string, unknown>> = [];

// The terminal's screen (xterm.js) is stood in for: the tab around it is what is tried here.
vi.mock('../src/web/components/TerminalScreen', async () => {
  const { forwardRef, useImperativeHandle } = await import('react');
  return {
    TerminalScreen: forwardRef(function Stand(props: { id?: string }, ref) {
      useImperativeHandle(ref, () => ({ size: () => ({ cols: 80, rows: 24 }), colors: () => undefined, focus: () => undefined, input: () => undefined, paste: () => undefined, text: () => ({ before: '', screen: '', after: '' }) }));
      return <div data-terminal tabIndex={-1} data-shows={props.id ?? ''} />;
    }),
  };
});

vi.mock('../src/web/lib/api', async (original) => {
  const actual = await original<typeof import('../src/web/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      models: async () => ({ models: [], signedIn: true }),
      usage: async () => [],
      defaults: async () => ({ permissionMode: null }),
      completions: async () => ({ commands: [], agents: [] }),
      git: async () => ({ repo: true, branch: 'main', files: [{ path: 'src/a.ts', status: 'modified', added: 1, removed: 0 }] }),
      changes: async () => ({ turns: [], lines: {} }),
      tree: async () => [],
      terminals: async () => ({ available: true, terminals: [{ id: 't1', cwd: CWD, program: 'zsh', viewers: 0, createdAt: 1 }, ...opened.map((body, i) => ({ id: `t${i + 2}`, cwd: body.cwd as string, program: 'zsh', viewers: 0, createdAt: i + 2 }))] }),
      openTerminal: async (body: Record<string, unknown>) => {
        opened.push(body);
        return { id: `t${opened.length + 1}`, cwd: body.cwd, program: 'zsh', viewers: 0, createdAt: opened.length + 1 };
      },
      session: async (id: string) => ({
        session: { id, title: 'Clean up the build', cwd: CWD, project: 'app', lastActivity: Date.now() - 60_000, status: 'idle' },
        run: null,
        tasks: [],
        settings: {},
      }),
      messages: async () => ({ messages: [{ uuid: 'u1', role: 'user', blocks: [{ type: 'text', text: 'Clean up the build' }], timestamp: Date.now() - 60_000 }], total: 1, offset: 0 }),
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
    this.removeAttribute('open');
  };
});

const { Chat } = await import('../src/web/components/Chat');
const { setPrefs } = await import('../src/web/lib/prefs');
const { takeTerminalAsks } = await import('../src/web/lib/terminals');
const { forgetLastTab } = await import('../src/web/components/Workspace');

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  media = {};
  setPrefs({ workspacePane: false });
  history.replaceState(null, '', '/');
  // Each test starts as a page just loaded, with the one terminal and none asked for: in any order.
  opened.length = 0;
  takeTerminalAsks('/');
  forgetLastTab();
});

/** A computer wide enough for the pane beside the conversation, with a mouse and a keyboard. */
const computer = () => {
  media = { '(min-width: 1024px)': true, '(min-width: 1280px)': true, '(min-width: 1440px)': true, '(hover: hover) and (pointer: fine)': true, '(pointer: fine)': true };
};
const session = async () => {
  render(<QueryClientProvider client={new QueryClient()}><Chat sessionId={SESSION} home="/home/me" machine="studio" demo wide onBack={() => {}} onOpen={() => {}} onStartIn={() => {}} /></QueryClientProvider>);
  await screen.findAllByText('Clean up the build');
};
const pane = () => screen.queryByRole('complementary', { name: 'Changes and files' });
/** The tabs of Changes and files load when first shown, which takes longer on a busy machine. */
const LAZY = { timeout: 5000 };
const toggle = () => screen.getByRole('button', { name: 'Changes and files' });
// Off Apple keyboards, as here, the modifier is Ctrl.
const key = (target: Element | Window, init: KeyboardEventInit) => act(() => {
  fireEvent.keyDown(target, init);
});

describe('Changes and files beside the conversation', () => {
  it('shows and hides with Cmd/Ctrl+Shift+D, from the conversation and from inside it', async () => {
    computer();
    await session();
    expect(pane()).toBeNull();
    key(window, { key: 'D', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(pane()).not.toBeNull());
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    // Pressed inside it, it goes, and the keys go to the button that brings it back.
    const close = within(pane()!).getByRole('button', { name: 'Close' });
    close.focus();
    key(close, { key: 'D', ctrlKey: true, shiftKey: true });
    expect(pane()).toBeNull();
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(document.activeElement).toBe(toggle());
  });

  it('closes with Cmd/Ctrl+\\ pressed in it, as the side chat does, and gives the keys to its button', async () => {
    computer();
    setPrefs({ workspacePane: true });
    await session();
    await waitFor(() => expect(pane()).not.toBeNull());
    const row = await within(pane()!).findByText('a.ts', {}, LAZY);
    const button = row.closest('button')!;
    button.focus();
    key(button, { key: '\\', ctrlKey: true });
    expect(pane()).toBeNull();
    expect(document.activeElement).toBe(toggle());
    // Pressed in the conversation, the key is the conversation's: nothing closes.
    key(toggle(), { key: 'D', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(pane()).not.toBeNull());
    const message = screen.getByLabelText('Message Claude');
    message.focus();
    key(message, { key: '\\', ctrlKey: true });
    expect(pane()).not.toBeNull();
    expect(document.activeElement).toBe(message);
  });

  it('shows the terminal with Ctrl+`, as in Claude Desktop, and hides it pressed there, the message box having the keys again', async () => {
    computer();
    await session();
    key(window, { key: '`', code: 'Backquote', ctrlKey: true });
    await waitFor(() => expect(pane()).not.toBeNull());
    expect(within(pane()!).getByRole('button', { name: 'Terminal' }).getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(document.querySelector('[data-terminal]')?.getAttribute('data-shows')).toBe('t1'), LAZY);
    // On another tab, it comes back to the terminal.
    fireEvent.click(within(pane()!).getByRole('button', { name: 'Files' }));
    key(window, { key: '`', code: 'Backquote', ctrlKey: true });
    expect(within(pane()!).getByRole('button', { name: 'Terminal' }).getAttribute('aria-pressed')).toBe('true');
    const terminal = document.querySelector<HTMLElement>('[data-terminal]')!;
    terminal.focus();
    key(terminal, { key: '`', code: 'Backquote', ctrlKey: true });
    expect(pane()).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText('Message Claude'));
  });

  it('opens a new terminal in the session’s folder with Ctrl+Shift+`, as Claude Desktop’s New terminal does, from the terminal too', async () => {
    computer();
    await session();
    key(window, { key: '~', code: 'Backquote', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(pane()).not.toBeNull());
    expect(within(pane()!).getByRole('button', { name: 'Terminal' }).getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(opened).toEqual([expect.objectContaining({ cwd: CWD })]), LAZY);
    // Pressed in the terminal, another, and the terminal stays.
    const terminal = await waitFor(() => document.querySelector<HTMLElement>('[data-terminal]')!, LAZY);
    terminal.focus();
    key(terminal, { key: '~', code: 'Backquote', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(opened).toHaveLength(2), LAZY);
    expect(pane()).not.toBeNull();
  });

  it('closed with its X, gives the keys to the button that shows it', async () => {
    computer();
    setPrefs({ workspacePane: true });
    await session();
    await waitFor(() => expect(pane()).not.toBeNull());
    const close = within(pane()!).getByRole('button', { name: 'Close' });
    close.focus();
    fireEvent.click(close);
    expect(pane()).toBeNull();
    expect(document.activeElement).toBe(toggle());
  });
});
