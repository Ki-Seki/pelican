// @vitest-environment jsdom
// The Terminal tab of Changes and files (src/web/components/WorkspaceTerminal.tsx): which terminals
// it shows, how one starts, ends and starts again, the trust sheet, Run and Open in terminal, and a
// phone's key row and line field. The screen itself (xterm.js) is stood in for: it reports what
// a real one would, and records what is typed into it.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { forwardRef, type Ref, useImperativeHandle } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TerminalInfo, TerminalList } from '../src/shared/terminal';
import type { ScreenHandle, ScreenMode } from '../src/web/components/TerminalScreen';

const CWD = '/code/app';
const typed: string[] = [];
const pasted: string[] = [];
let screenProps: Record<string, any> = {};

vi.mock('../src/web/components/TerminalScreen', () => ({
  TerminalScreen: forwardRef(function Stand(props: Record<string, any>, ref: Ref<ScreenHandle>) {
    screenProps = props;
    useImperativeHandle(ref, () => ({
      size: () => ({ cols: 90, rows: 30 }),
      focus: () => undefined,
      input: (text: string) => typed.push(text),
      paste: (text: string) => pasted.push(text),
      text: () => ({ before: 'line one', screen: 'line two', after: '' }),
      colors: () => undefined,
    }));
    return <div data-terminal data-shows={props.id ?? ''} />;
  }),
}));

let list: TerminalList;
const opened: Array<Record<string, unknown>> = [];
const closed: string[] = [];
let refuse: ((body: Record<string, unknown>) => Error | undefined) | undefined;

vi.mock('../src/web/lib/api', async (original) => {
  const actual = await original<typeof import('../src/web/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      terminals: async () => structuredClone(list),
      openTerminal: async (body: Record<string, unknown>) => {
        opened.push(body);
        const error = refuse?.(body);
        if (error) throw error;
        const terminal: TerminalInfo = { id: `t${opened.length + 10}`, cwd: body.cwd as string, program: 'zsh', viewers: 0, createdAt: Date.now() };
        list.terminals.push(terminal);
        return terminal;
      },
      closeTerminal: async (id: string) => {
        closed.push(id);
        list.terminals = list.terminals.filter((t) => t.id !== id);
        return { ok: true };
      },
    },
  };
});

let coarse = false;
beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('coarse') ? coarse : false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});

const { ApiError } = await import('../src/web/lib/api');
const { askForTerminal } = await import('../src/web/lib/terminals');
const { WorkspaceTerminal } = await import('../src/web/components/WorkspaceTerminal');

const terminal = (id: string, extra: Partial<TerminalInfo> = {}): TerminalInfo => ({ id, cwd: CWD, program: 'zsh', viewers: 1, createdAt: Number(id.replace(/\D/g, '')), ...extra });

beforeEach(() => {
  list = { available: true, terminals: [] };
  opened.length = 0;
  closed.length = 0;
  typed.length = 0;
  pasted.length = 0;
  refuse = undefined;
  coarse = false;
  sessionStorage.clear();
});
afterEach(cleanup);

function tab(props: Partial<Parameters<typeof WorkspaceTerminal>[0]> = {}) {
  const onQuote = vi.fn();
  const askTrust = vi.fn(async () => undefined as 'trusted' | 'user-only' | undefined);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <WorkspaceTerminal cwd={CWD} hidden={false} askTrust={askTrust} onQuote={onQuote} {...props} />
    </QueryClientProvider>,
  );
  return { onQuote, askTrust };
}
const tabs = () => screen.queryAllByRole('tab').map((t) => t.textContent);
const shows = () => document.querySelector('[data-terminal]')?.getAttribute('data-shows');

describe('the Terminal tab', () => {
  it('says why there is no terminal here, and starts none', async () => {
    list = { available: false, reason: 'This is the demo, so nothing runs here. Start Pelican without --demo for a terminal.', terminals: [] };
    tab();
    expect(await screen.findByText(/nothing runs here/)).toBeTruthy();
    expect(opened).toEqual([]);
    expect(document.querySelector('[data-terminal]')).toBeNull();
  });

  it('starts the folder’s first terminal by itself, at the size of the screen it shows on', async () => {
    tab();
    await waitFor(() => expect(tabs()).toEqual(['zsh']));
    expect(opened).toEqual([{ cwd: CWD, cols: 90, rows: 30 }]);
    expect(shows()).toBe('t11');
  });

  it('shows the folder’s terminals and those in folders inside it, named after the program in front', async () => {
    list.terminals = [terminal('t1'), terminal('t2', { cwd: `${CWD}/web`, program: 'npm' }), terminal('t3', { cwd: '/code/other' }), terminal('t4', { cwd: `${CWD}-two` })];
    tab();
    await waitFor(() => expect(tabs()).toEqual(['zsh', 'npm · web']));
    expect(opened).toEqual([]);
    // The newest shows first; a tab shows its own.
    expect(shows()).toBe('t2');
    fireEvent.click(screen.getByRole('tab', { name: 'zsh' }));
    expect(shows()).toBe('t1');
    // The program in front changes the name.
    act(() => screenProps.onProgram('t1', 'vim'));
    await waitFor(() => expect(tabs()).toEqual(['vim', 'npm · web']));
  });

  it('ends a shell at its prompt at once, and asks first when a program runs in it', async () => {
    list.terminals = [terminal('t1'), terminal('t2', { program: 'vim' })];
    tab();
    await waitFor(() => expect(shows()).toBe('t2'));
    fireEvent.click(screen.getByRole('button', { name: 'End' }));
    expect(screen.getByText(/It is still running/)).toBeTruthy();
    expect(closed).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'End' }));
    fireEvent.click(screen.getByRole('button', { name: 'End' }));
    await waitFor(() => expect(closed).toEqual(['t2']));
    expect(tabs()).toEqual(['zsh']);
    expect(shows()).toBe('t1');
    fireEvent.click(screen.getByRole('button', { name: 'End' }));
    await waitFor(() => expect(closed).toEqual(['t2', 't1']));
    // The last one ended here: no new one starts by itself, but one is a tap away.
    expect(tabs()).toEqual([]);
    expect(opened).toEqual([]);
    fireEvent.click(screen.getAllByRole('button', { name: 'New terminal' }).at(-1)!);
    await waitFor(() => expect(tabs()).toEqual(['zsh']));
  });

  it('says how a shell ended, and that one Pelican ended with, with Start again', async () => {
    list.terminals = [terminal('t1')];
    tab();
    await waitFor(() => expect(shows()).toBe('t1'));
    act(() => screenProps.onExit('t1', { code: 3, signal: null }));
    expect(await screen.findByText('The shell ended with exit code 3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start again' }));
    await waitFor(() => expect(closed).toEqual(['t1']));
    await waitFor(() => expect(opened).toEqual([{ cwd: CWD, cols: 90, rows: 30 }]));
    await waitFor(() => expect(shows()).toBe('t11'));
    // Pelican stopped since: the tab stays, to start again.
    act(() => screenProps.onConnection('t11', { kind: 'gone' }));
    expect(await screen.findByText('This terminal is no longer running')).toBeTruthy();
    expect(tabs()).toEqual(['zsh']);
    fireEvent.click(screen.getByRole('button', { name: 'Start again' }));
    await waitFor(() => expect(opened).toHaveLength(2));
    // A terminal gone with Pelican has nothing to hang up.
    expect(closed).toEqual(['t1']);
  });

  it('asks about a folder nobody trusted, and starts nothing by itself when the answer is no', async () => {
    refuse = (body) => (body.trust ? undefined : new ApiError('Trust this folder first', 409, false, { brings: ['.mcp.json: server "db"'] }));
    const { askTrust } = tab();
    await waitFor(() => expect(askTrust).toHaveBeenCalledWith(['.mcp.json: server "db"']));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'New terminal' })).toHaveLength(2));
    expect(opened).toHaveLength(1);
    askTrust.mockResolvedValueOnce('user-only');
    fireEvent.click(screen.getAllByRole('button', { name: 'New terminal' }).at(-1)!);
    await waitFor(() => expect(tabs()).toEqual(['zsh']));
    expect(opened.at(-1)).toEqual({ cwd: CWD, cols: 90, rows: 30, trust: 'user-only' });
  });

  it('says what stopped a terminal from starting', async () => {
    refuse = () => new ApiError('At most 10 terminals run at once. Close one to open another.', 429);
    tab();
    expect(await screen.findByText(/At most 10 terminals/)).toBeTruthy();
    expect(opened).toHaveLength(1);
  });

  it('opens a terminal asked for elsewhere: in a folder (Open in terminal), running a command (Run in terminal)', async () => {
    list.terminals = [terminal('t1')];
    askForTerminal(`${CWD}/web`);
    askForTerminal(CWD, 'npm test');
    // Another folder's ask waits for its own tab.
    askForTerminal('/code/other', 'ls');
    tab();
    await waitFor(() => expect(opened).toEqual([{ cwd: `${CWD}/web`, cols: 90, rows: 30 }, { cwd: CWD, cols: 90, rows: 30, command: 'npm test' }]));
    await waitFor(() => expect(tabs()).toEqual(['zsh', 'zsh · web', 'zsh']));
  });

  it('quotes what was selected, as the terminal’s', async () => {
    list.terminals = [terminal('t1')];
    const { onQuote } = tab();
    await waitFor(() => expect(shows()).toBe('t1'));
    act(() => screenProps.onQuote('% npm test\nFAIL'));
    expect(onQuote).toHaveBeenCalledWith('```terminal\n% npm test\nFAIL\n```');
  });
});

describe('the Terminal tab on a phone', () => {
  // A password field has no role of its own: it is found by its name.
  const field = () => screen.getByLabelText('Command') as HTMLInputElement;
  const mode = (m: Partial<ScreenMode>) => act(() => screenProps.onMode({ direct: false, secret: false, applicationCursor: false, ...m }));

  it('types a line in the field and sends it with Enter; a key of the row sends what is typed first', async () => {
    coarse = true;
    list.terminals = [terminal('t1')];
    tab();
    await waitFor(() => expect(shows()).toBe('t1'));
    fireEvent.input(field(), { target: { value: 'ls -la' } });
    // Enter submits the line, as a phone's keyboard does.
    fireEvent.submit(field().form!);
    expect(typed).toEqual(['ls -la\r']);
    expect(field().value).toBe('');
    fireEvent.input(field(), { target: { value: 'git sta' } });
    fireEvent.click(screen.getByRole('button', { name: 'Tab' }));
    expect(typed.slice(1)).toEqual(['git sta', '\t']);
    // The row's characters go into the line being typed.
    fireEvent.click(screen.getByRole('button', { name: 'Pipe' }));
    expect(field().value).toBe('|');
    // Ctrl holds for the next key.
    fireEvent.click(screen.getByRole('button', { name: 'Control' }));
    expect(screen.getByRole('button', { name: 'Control' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.input(field(), { target: { value: '|c' } });
    expect(typed.slice(-2)).toEqual(['|', '\u0003']);
    expect(screen.getByRole('button', { name: 'Control' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Up' }));
    expect(typed.at(-1)).toBe('\u001b[A');
    // An empty field's Backspace is the shell's.
    fireEvent.keyDown(field(), { key: 'Backspace' });
    expect(typed.at(-1)).toBe('\u007f');
  });

  it('gives a full-screen program every key as it is typed, and hides what is typed at a password prompt', async () => {
    coarse = true;
    list.terminals = [terminal('t1', { program: 'vim' })];
    tab();
    await waitFor(() => expect(shows()).toBe('t1'));
    mode({ direct: true, applicationCursor: true });
    const keys = screen.getByRole('textbox', { name: 'Keys for vim' }) as HTMLInputElement;
    expect(keys.placeholder).toBe('Keys go to vim');
    fireEvent.input(keys, { target: { value: 'i' } });
    expect(typed).toEqual(['i']);
    expect(keys.value).toBe('');
    // An input method's characters go once they are chosen.
    fireEvent.compositionStart(keys);
    fireEvent.input(keys, { target: { value: 'nihao' } });
    expect(typed).toEqual(['i']);
    fireEvent.compositionEnd(keys, { target: { value: '你好' } });
    expect(typed).toEqual(['i', '你好']);
    fireEvent.keyDown(keys, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Down' }));
    expect(typed.slice(-2)).toEqual(['\u001b', '\u001bOB']);
    mode({ secret: true });
    expect(field().type).toBe('password');
    expect(field().placeholder).toBe('Password');
    // Sent on the key, not by submitting a form a browser would offer to remember.
    fireEvent.input(field(), { target: { value: 'hunter2' } });
    expect(fireEvent.keyDown(field(), { key: 'Enter' })).toBe(false);
    expect(typed.at(-1)).toBe('hunter2\r');
    expect(field().value).toBe('');
    mode({});
    expect(field().type).toBe('text');
  });

  it('opens the screen as text from a long press, to quote or copy', async () => {
    coarse = true;
    list.terminals = [terminal('t1')];
    const { onQuote } = tab();
    await waitFor(() => expect(shows()).toBe('t1'));
    act(() => screenProps.onLongPress());
    const sheet = await screen.findByRole('dialog');
    expect(sheet.textContent).toContain('line one');
    expect(sheet.textContent).toContain('The screen');
    fireEvent.click(screen.getByRole('button', { name: 'Quote' }));
    expect(onQuote).toHaveBeenCalledWith('```terminal\nline two\n```');
  });
});
