// @vitest-environment jsdom
// The Terminal tab of Changes and files (src/web/components/WorkspaceTerminal.tsx): which terminals
// it shows, how one starts, ends and starts again, the trust sheet, Run and Open in terminal, and a
// phone's key row and line field. The screen itself (xterm.js) is stood in for: it reports what
// a real one would, and records what is typed into it.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { forwardRef, type Ref, useImperativeHandle } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TerminalInfo, TerminalList } from '../src/shared/terminal';
import type { ScreenHandle, ScreenMode } from '../src/web/components/TerminalScreen';

const CWD = '/code/app';
const typed: string[] = [];
const pasted: string[] = [];
/** The screen's connection is down, coming back: what is typed goes nowhere. */
let offline = false;
/** How often the screen was given the keys. */
let focused = 0;
/** What is selected on the screen, and what its menu did to it. */
let selected = '';
const did: string[] = [];
let screenProps: Record<string, any> = {};

vi.mock('../src/web/components/TerminalScreen', () => ({
  TerminalScreen: forwardRef(function Stand(props: Record<string, any>, ref: Ref<ScreenHandle>) {
    screenProps = props;
    useImperativeHandle(ref, () => ({
      size: () => ({ cols: 90, rows: 30 }),
      focus: () => {
        focused += 1;
      },
      input: (text: string) => !offline && typed.push(text) > 0,
      paste: (text: string) => !offline && pasted.push(text) > 0,
      text: () => ({ before: 'line one', screen: 'line two', after: '' }),
      colors: () => undefined,
      readNext: () => undefined,
      selection: () => selected,
      selectAll: () => {
        did.push('select all');
      },
      clearSelection: () => {
        selected = '';
      },
      clear: () => {
        did.push('clear');
      },
    }));
    return <div data-terminal data-shows={props.id ?? ''} />;
  }),
}));

let list: TerminalList;
/** A list fetch that answers when the test says, with the list as it was when asked. */
let slow: (() => Promise<TerminalList>) | undefined;
/** Terminals whose shell has a job running in the background, as the computer says; whether it can say, and whether it answers. */
const jobs = new Set<string>();
let unreachable = false;
let silent = false;
const opened: Array<Record<string, unknown>> = [];
const closed: string[] = [];
let refuse: ((body: Record<string, unknown>) => Error | undefined) | undefined;

vi.mock('../src/web/lib/api', async (original) => {
  const actual = await original<typeof import('../src/web/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      terminals: async () => (slow ? slow() : structuredClone(list)),
      terminal: async (id: string) => {
        if (unreachable) throw new TypeError('Failed to fetch');
        if (silent) return new Promise(() => undefined);
        const found = list.terminals.find((t) => t.id === id);
        if (!found) throw new actual.ApiError('No such terminal', 404);
        return { terminal: structuredClone(found), running: jobs.has(id) || !['zsh', 'bash'].includes(found.program) };
      },
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
  // A touch screen, or a computer's mouse and keyboard.
  window.matchMedia = ((query: string) => ({
    matches: query.includes('coarse') ? coarse : query.includes('fine') ? !coarse : false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  // jsdom draws nothing, so scrolls nothing: the screen as text scrolls to where the screen was.
  Element.prototype.scrollIntoView ??= () => undefined;
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});

const { ApiError } = await import('../src/web/lib/api');
const { askForTerminal } = await import('../src/web/lib/terminals');
const { messageWith } = await import('../src/web/lib/quote');
const { WorkspaceTerminal } = await import('../src/web/components/WorkspaceTerminal');

const terminal = (id: string, extra: Partial<TerminalInfo> = {}): TerminalInfo => ({ id, cwd: CWD, program: 'zsh', viewers: 1, createdAt: Number(id.replace(/\D/g, '')), ...extra });

beforeEach(() => {
  list = { available: true, terminals: [] };
  slow = undefined;
  jobs.clear();
  unreachable = false;
  silent = false;
  opened.length = 0;
  closed.length = 0;
  typed.length = 0;
  pasted.length = 0;
  refuse = undefined;
  coarse = false;
  offline = false;
  focused = 0;
  sessionStorage.clear();
});
afterEach(cleanup);

function tab(props: Partial<Parameters<typeof WorkspaceTerminal>[0]> = {}) {
  const onQuote = vi.fn();
  const askTrust = vi.fn(async () => undefined as 'trusted' | 'user-only' | undefined);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <WorkspaceTerminal cwd={CWD} hidden={false} askTrust={askTrust} onQuote={onQuote} {...props} />
    </QueryClientProvider>,
  );
  return { onQuote, askTrust, client, view };
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
    fireEvent.click(screen.getByRole('tab', { name: 'zsh' }), { detail: 1 });
    expect(shows()).toBe('t1');
    // Clicked on a computer, the tab gives the screen the keys, to type in at once.
    await waitFor(() => expect(focused).toBe(1));
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

  it('asks first before ending a shell with a job in the background, which only the computer can tell, and when it cannot tell', async () => {
    list.terminals = [terminal('t1'), terminal('t2')];
    jobs.add('t2');
    tab();
    await waitFor(() => expect(shows()).toBe('t2'));
    fireEvent.click(screen.getByRole('button', { name: 'End' }));
    expect(await screen.findByText(/A program is still running in it/)).toBeTruthy();
    expect(closed).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    // With no connection to ask over, it asks, as a program may run there.
    unreachable = true;
    fireEvent.click(screen.getByRole('button', { name: 'End' }));
    expect(await screen.findByText(/A program is still running in it/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'End' }));
    await waitFor(() => expect(closed).toEqual(['t2']));
    // The job gone, the shell at its prompt ends at once.
    unreachable = false;
    await waitFor(() => expect(shows()).toBe('t1'));
    fireEvent.click(screen.getByRole('button', { name: 'End' }));
    await waitFor(() => expect(closed).toEqual(['t2', 't1']));
    expect(screen.queryByText(/still running/)).toBeNull();
  });

  it('asks when the computer gives no answer within 3 seconds', async () => {
    list.terminals = [terminal('t1')];
    tab();
    await waitFor(() => expect(shows()).toBe('t1'));
    silent = true;
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      fireEvent.click(screen.getByRole('button', { name: 'End' }));
      await act(async () => vi.advanceTimersByTime(3000));
    } finally {
      vi.useRealTimers();
    }
    expect(await screen.findByText(/A program is still running in it/)).toBeTruthy();
    expect(closed).toEqual([]);
  });

  it('asks about the tab it was asked on, not one picked while the computer answers', async () => {
    list.terminals = [terminal('t1'), terminal('t2')];
    jobs.add('t2');
    tab();
    await waitFor(() => expect(shows()).toBe('t2'));
    fireEvent.click(screen.getByRole('button', { name: 'End' }));
    fireEvent.click(screen.getAllByRole('tab')[0]!);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(shows()).toBe('t1');
    expect(screen.queryByText(/still running/)).toBeNull();
    expect(closed).toEqual([]);
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

  it('keeps a terminal Pelican ended as a tab with Start again when the list says so before its socket does', async () => {
    list.terminals = [terminal('t1')];
    const { client } = tab();
    await waitFor(() => expect(shows()).toBe('t1'));
    // Pelican started again: the page comes back to the front and asks for the list (on focus, or
    // its poll) before the terminal's socket hears it is gone; that socket is stopped with it.
    list.terminals = [];
    await act(() => client.invalidateQueries({ queryKey: ['terminals'] }));
    expect(await screen.findByText('This terminal is no longer running')).toBeTruthy();
    expect(tabs()).toEqual(['zsh']);
    // Nothing starts by itself in its place, and the old screen stays (the screen shows none).
    expect(opened).toEqual([]);
    expect(shows()).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Start again' }));
    await waitFor(() => expect(opened).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText('This terminal is no longer running')).toBeNull());
    expect(closed).toEqual([]);
  });

  it('keeps a terminal’s tab saying it is no longer running while the view closes and opens again, and after Pelican stopped meanwhile', async () => {
    list.terminals = [terminal('t1'), terminal('t2')];
    const first = tab();
    await waitFor(() => expect(tabs()).toEqual(['zsh', 'zsh']));
    act(() => screenProps.onConnection('t2', { kind: 'gone' }));
    expect(await screen.findByText('This terminal is no longer running')).toBeTruthy();
    // The view closes (on a phone, Back), and opens again: the tab still says so.
    first.view.unmount();
    list.terminals = [terminal('t1')];
    tab();
    await waitFor(() => expect(tabs()).toEqual(['zsh', 'zsh']));
    expect(screen.getByText('This terminal is no longer running')).toBeTruthy();
    cleanup();
    // Pelican stops while the view is closed: when it opens again, its terminals' tabs say so, and
    // nothing starts by itself.
    list.terminals = [];
    tab();
    await waitFor(() => expect(tabs()).toEqual(['zsh', 'zsh']));
    expect(screen.getByText('This terminal is no longer running')).toBeTruthy();
    expect(opened).toEqual([]);
    // Ended here, one goes, and the last leaves New terminal, not a new shell by itself.
    fireEvent.click(screen.getByRole('button', { name: 'End' }));
    fireEvent.click(screen.getByRole('button', { name: 'End' }));
    await waitFor(() => expect(tabs()).toEqual([]));
    expect(opened).toEqual([]);
    expect(closed).toEqual([]);
    expect(screen.getAllByRole('button', { name: 'New terminal' }).length).toBeGreaterThan(0);
  });

  it('asks about a folder nobody trusted, and starts nothing by itself when the answer is no', async () => {
    refuse = (body) => (body.trust ? undefined : new ApiError('Trust this folder first', 409, false, { brings: ['.mcp.json: server "db"'] }));
    const { askTrust } = tab();
    await waitFor(() => expect(askTrust).toHaveBeenCalledWith({ brings: ['.mcp.json: server "db"'] }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'New terminal' })).toHaveLength(2));
    expect(opened).toHaveLength(1);
    askTrust.mockResolvedValueOnce('user-only');
    fireEvent.click(screen.getAllByRole('button', { name: 'New terminal' }).at(-1)!);
    await waitFor(() => expect(tabs()).toEqual(['zsh']));
    expect(opened.at(-1)).toEqual({ cwd: CWD, cols: 90, rows: 30, trust: 'user-only' });
  });

  it('says what stopped a terminal from starting, and with as many running as may, lists those elsewhere to end one', async () => {
    list.terminals = Array.from({ length: 10 }, (_, n) => terminal(`t${n + 1}`, { cwd: `/code/other-${n + 1}` }));
    refuse = () => (list.terminals.length >= 10 ? new ApiError('At most 10 terminals run at once. Close one to open another.', 429) : undefined);
    tab();
    expect(await screen.findByText(/At most 10 terminals/)).toBeTruthy();
    expect(opened).toHaveLength(1);
    const elsewhere = screen.getByRole('list', { name: 'Terminals in other folders' });
    expect(elsewhere.textContent).toContain('zsh · other-1');
    expect(elsewhere.querySelectorAll('li')).toHaveLength(10);
    // Ending one of them makes room: the folder's terminal starts.
    fireEvent.click(screen.getByRole('button', { name: 'End zsh in other-3' }));
    await waitFor(() => expect(closed).toEqual(['t3']));
    await waitFor(() => expect(tabs()).toEqual(['zsh']));
    expect(opened).toHaveLength(2);
    expect(screen.queryByText(/At most 10 terminals/)).toBeNull();
  });

  it('asks first before ending a terminal elsewhere while a program runs in it, as the tab’s own End does', async () => {
    list.terminals = Array.from({ length: 10 }, (_, n) => terminal(`t${n + 1}`, { cwd: `/code/other-${n + 1}` }));
    refuse = () => (list.terminals.length >= 10 ? new ApiError('At most 10 terminals run at once. Close one to open another.', 429) : undefined);
    tab();
    expect(await screen.findByText(/At most 10 terminals/)).toBeTruthy();
    // The list says zsh, from before; sleep runs there now.
    list.terminals[2] = { ...list.terminals[2]!, program: 'sleep' };
    fireEvent.click(screen.getByRole('button', { name: 'End zsh in other-3' }));
    expect(await screen.findByText(/It is still running/)).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Terminals in other folders' }).textContent).toContain('End sleep · other-3? It is still running.');
    expect(closed).toEqual([]);
    // Cancel keeps it; End, asked again, ends it.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(/It is still running/)).toBeNull();
    expect(closed).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'End zsh in other-3' }));
    fireEvent.click(await screen.findByRole('button', { name: 'End' }));
    await waitFor(() => expect(closed).toEqual(['t3']));
    await waitFor(() => expect(tabs()).toEqual(['zsh']));
  });

  it('asks first before ending a terminal elsewhere whose shell runs a job in the background', async () => {
    list.terminals = Array.from({ length: 10 }, (_, n) => terminal(`t${n + 1}`, { cwd: `/code/other-${n + 1}` }));
    refuse = () => (list.terminals.length >= 10 ? new ApiError('At most 10 terminals run at once. Close one to open another.', 429) : undefined);
    jobs.add('t3');
    tab();
    expect(await screen.findByText(/At most 10 terminals/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'End zsh in other-3' }));
    expect(await screen.findByText(/A program is still running in it/)).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Terminals in other folders' }).textContent).toContain('End zsh · other-3? A program is still running in it.');
    expect(closed).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'End' }));
    await waitFor(() => expect(closed).toEqual(['t3']));
    // One with nothing running ends at once.
    await waitFor(() => expect(tabs()).toEqual(['zsh']));
  });

  it('shows a terminal it just started as running, though a list fetched before it started answers after', async () => {
    list.terminals = [terminal('t1')];
    const { client } = tab();
    await waitFor(() => expect(tabs()).toEqual(['zsh']));
    // A refetch starts (the 10 s poll, or the window focused), with the list as it is now…
    let answer!: () => void;
    slow = () => {
      const before = structuredClone(list);
      return new Promise<TerminalList>((resolve) => {
        answer = () => resolve(before);
      });
    };
    void client.refetchQueries({ queryKey: ['terminals'] });
    await act(async () => undefined);
    slow = undefined;
    // …and + starts a terminal meanwhile.
    fireEvent.click(screen.getByRole('button', { name: 'New terminal' }));
    await waitFor(() => expect(shows()).toBe('t11'));
    // The refetch answers now, with the list from before the terminal started.
    await act(async () => answer());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(tabs()).toEqual(['zsh', 'zsh']);
    expect(shows()).toBe('t11');
    expect(screen.queryByText('This terminal is no longer running')).toBeNull();
  });

  it('keeps a terminal it ended out, though a list fetched before it ended answers after', async () => {
    list.terminals = [terminal('t1'), terminal('t2')];
    const { client } = tab();
    await waitFor(() => expect(tabs()).toEqual(['zsh', 'zsh']));
    let answer!: () => void;
    slow = () => {
      const before = structuredClone(list);
      return new Promise<TerminalList>((resolve) => {
        answer = () => resolve(before);
      });
    };
    void client.refetchQueries({ queryKey: ['terminals'] });
    await act(async () => undefined);
    slow = undefined;
    fireEvent.click(screen.getByRole('button', { name: 'End' }));
    await waitFor(() => expect(closed).toEqual(['t2']));
    await act(async () => answer());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(tabs()).toEqual(['zsh']);
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

  it('opens the screen as text from a button a keyboard or a screen reader reaches, seen only once it has the focus', async () => {
    list.terminals = [terminal('t1')];
    tab();
    await waitFor(() => expect(shows()).toBe('t1'));
    const button = screen.getByRole('button', { name: 'Screen as text' });
    expect(button.className).toMatch(/\bopacity-0\b.*\bfocus-visible:opacity-100\b/);
    fireEvent.click(button);
    const sheet = await screen.findByRole('dialog');
    expect(sheet.textContent).toContain('line two');
  });

  it('quotes what was selected, as the terminal’s, naming the tab it is from as Claude Desktop does', async () => {
    list.terminals = [terminal('t1'), terminal('t2', { program: 'vim' })];
    const { onQuote } = tab();
    await waitFor(() => expect(shows()).toBe('t2'));
    act(() => screenProps.onQuote('% npm test\nFAIL'));
    expect(onQuote).toHaveBeenCalledWith(expect.objectContaining({ kind: 'quote', text: '% npm test\nFAIL', from: { what: 'terminal' }, tab: '2', label: 'vim' }));
    expect(messageWith([onQuote.mock.calls[0]![0]], 'Why?')).toBe('<!-- attach: vim | tab:2 -->\n> % npm test\n> FAIL\n\nWhy?');
  });
  it('opens Desktop’s terminal menu on a right-click: Quote and Copy what is selected, Select all, Clear terminal', async () => {
    list.terminals = [terminal('t1')];
    const { onQuote } = tab();
    await waitFor(() => expect(shows()).toBe('t1'));
    selected = 'Tests 14 passed';
    act(() => screenProps.onMenu({ x: 40, y: 40 }));
    const menu = await screen.findByRole('menu', { name: 'Terminal' });
    // Desktop's keys, faintly beside them.
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([expect.stringMatching(/^Quote(⇧⌘L|Ctrl\+Shift\+L)$/), expect.stringMatching(/^Copy(⌘C|Ctrl\+C)$/), expect.stringMatching(/^Select all/), 'Clear terminal']);
    fireEvent.click(within(menu).getByText('Quote'));
    expect(onQuote).toHaveBeenCalledWith(expect.objectContaining({ kind: 'quote', text: 'Tests 14 passed', from: { what: 'terminal' } }));
    expect(selected).toBe('');
    act(() => screenProps.onMenu({ x: 40, y: 40 }));
    fireEvent.click(within(await screen.findByRole('menu', { name: 'Terminal' })).getByText('Clear terminal'));
    act(() => screenProps.onMenu({ x: 40, y: 40 }));
    fireEvent.click(within(await screen.findByRole('menu', { name: 'Terminal' })).getByText('Select all'));
    expect(did).toEqual(['clear', 'select all']);
    did.length = 0;
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
    // A control character pasted into the field goes nowhere.
    fireEvent.input(field(), { target: { value: 'echo hi\u001b[201~' } });
    fireEvent.submit(field().form!);
    expect(typed.splice(1)).toEqual(['echo hi[201~\r']);
    // While the connection comes back, a line sent stays in the field, to send once it is back.
    offline = true;
    fireEvent.input(field(), { target: { value: 'echo while away' } });
    fireEvent.submit(field().form!);
    fireEvent.click(screen.getByRole('button', { name: 'Tab' }));
    expect(field().value).toBe('echo while away');
    expect(typed).toEqual(['ls -la\r']);
    offline = false;
    fireEvent.submit(field().form!);
    expect(typed.splice(1)).toEqual(['echo while away\r']);
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
    // Typed in while what can be seen is short, the line keeps its room (styles.css): the terminal's
    // tabs make way, and the key row too when there is room for the line alone.
    expect(field().hasAttribute('data-terminal-line')).toBe(true);
    expect(screen.getByRole('tablist', { name: 'Terminals' }).closest('[data-makes-room]')?.getAttribute('data-makes-room')).toBe('short');
    expect(screen.getByRole('toolbar', { name: 'Keys' }).getAttribute('data-makes-room')).toBe('tiny');
  });

  it('gives a full-screen program every key as it is typed, and hides what is typed at a password prompt', async () => {
    coarse = true;
    list.terminals = [terminal('t1', { program: 'vim' })];
    tab();
    await waitFor(() => expect(shows()).toBe('t1'));
    mode({ direct: true, applicationCursor: true });
    const keys = screen.getByRole('searchbox', { name: 'Keys for vim' }) as HTMLInputElement;
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
    expect(field().type).toBe('search');
  });

  it('takes a second space as a space, not as the ". " a phone’s input method puts in its place', async () => {
    coarse = true;
    list.terminals = [terminal('t1', { program: 'vim' })];
    tab();
    await waitFor(() => expect(shows()).toBe('t1'));
    /** An edit of the input method's, as the browser makes it unless the page cancels it. */
    const edit = (f: HTMLInputElement, inputType: string, data: string | null) => {
      const before = new InputEvent('beforeinput', { inputType, data, cancelable: true, bubbles: true });
      if (!f.dispatchEvent(before)) return;
      const at = f.selectionStart ?? f.value.length;
      if (inputType === 'deleteContentBackward') f.setRangeText('', at - 1, at, 'end');
      else f.setRangeText(data ?? '', at, at, 'end');
      fireEvent.input(f, { inputType, data });
    };
    /** Gboard's double-space shortcut: the space before the caret taken back, ". " put in. */
    const secondSpace = (f: HTMLInputElement) => {
      // An empty field has nothing to take back, and no edit for it.
      if (f.value) edit(f, 'deleteContentBackward', null);
      edit(f, 'insertText', '. ');
    };
    const typeIn = (f: HTMLInputElement, text: string) => {
      for (const char of text) edit(f, 'insertText', char);
    };
    fireEvent.input(field(), { target: { value: 'echo a ' } });
    secondSpace(field());
    expect(field().value).toBe('echo a  ');
    // What the row put in between the spaces stays, though the input method took it for a space.
    fireEvent.input(field(), { target: { value: 'ls -la ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pipe' }));
    secondSpace(field());
    expect(field().value).toBe('ls -la | ');
    // A period and a space typed as two keys stay as they are.
    fireEvent.input(field(), { target: { value: 'end' } });
    typeIn(field(), '. ');
    expect(field().value).toBe('end. ');
    fireEvent.submit(field().form!);
    typed.length = 0;
    // A full-screen program gets the space as a space.
    mode({ direct: true });
    const keys = screen.getByRole('searchbox', { name: 'Keys for vim' }) as HTMLInputElement;
    typeIn(keys, 'a ');
    secondSpace(keys);
    expect(typed).toEqual(['a', ' ', ' ']);
    expect(keys.value).toBe('');
  });

  it('pastes with the row’s key, what the line held first, and says why when the browser does not let it read the clipboard', async () => {
    coarse = true;
    list.terminals = [terminal('t1')];
    let allowed = true;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: async () => {
          if (!allowed) throw new DOMException('Read permission denied.', 'NotAllowedError');
          return 'echo from the clipboard';
        },
      },
    });
    try {
      tab();
      await waitFor(() => expect(shows()).toBe('t1'));
      fireEvent.input(field(), { target: { value: 'cd /tmp && ' } });
      fireEvent.click(screen.getByRole('button', { name: 'Paste' }));
      await waitFor(() => expect(pasted).toEqual(['echo from the clipboard']));
      expect(typed).toEqual(['cd /tmp && ']);
      expect(screen.queryByRole('status')).toBeNull();
      // Told no (or not answered), the browser gives nothing: the key says so, not nothing at all.
      allowed = false;
      fireEvent.click(screen.getByRole('button', { name: 'Paste' }));
      expect((await screen.findByRole('status')).textContent).toMatch(/did not let Pelican read the clipboard/);
      expect(pasted).toEqual(['echo from the clipboard']);
      // The next key takes the words away.
      fireEvent.click(screen.getByRole('button', { name: 'Tab' }));
      expect(screen.queryByRole('status')).toBeNull();
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('opens its menu on a long press under a finger, whose Select text opens the screen as text, to quote or copy', async () => {
    coarse = true;
    list.terminals = [terminal('t1')];
    const { onQuote } = tab();
    await waitFor(() => expect(shows()).toBe('t1'));
    act(() => screenProps.onMenu(null));
    const menu = await screen.findByRole('dialog', { name: 'zsh' });
    // Nothing selected (a finger selects in the screen as text): no Quote or Copy yet.
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Select all', 'Select text', 'Clear terminal']);
    fireEvent.click(within(menu).getByText('Select text'));
    const sheet = await screen.findByRole('dialog', { name: 'zsh' });
    await waitFor(() => expect(sheet.textContent).toContain('line one'));
    expect(sheet.textContent).toContain('The screen');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Quote' }));
    await waitFor(() => expect(onQuote).toHaveBeenCalledWith(expect.objectContaining({ kind: 'quote', text: 'line two', from: { what: 'terminal' }, tab: '1', label: 'zsh' })));
  });

});
