// @vitest-environment jsdom
// Each thing in the conversation has its own list (lib/actions), reached where it is: your prompt,
// Claude's reply, a step, a path. A right-click puts what was clicked first; a long press opens the
// same list under a finger, where the words are not prose to select.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ChatMessage } from '../src/shared/protocol';
import type { SessionView } from '../src/web/lib/store';

let media: Record<string, boolean> = {};
beforeAll(() => {
  Object.assign(window, { matchMedia: (query: string) => ({ matches: Boolean(media[query]), media: query, addEventListener() {}, removeEventListener() {} }) });
  Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});

const { MessageList } = await import('../src/web/components/MessageList');
const { QuoteTargetContext } = await import('../src/web/components/Quotes');
const { forgetFound, PathLinksContext } = await import('../src/web/lib/path-links');
const { RunInTerminal, TerminalShell } = await import('../src/web/lib/terminals');
const { waitingOf, setWaiting } = await import('../src/web/lib/drafts');
const { api } = await import('../src/web/lib/api');

afterEach(() => {
  cleanup();
  media = {};
  setWaiting('chat', []);
  // Which files the folder holds is asked again, of the next test's own answers.
  forgetFound();
  vi.restoreAllMocks();
});

const computer = () => {
  media = { '(hover: hover) and (pointer: fine)': true, '(hover: hover)': true, '(pointer: fine)': true };
};
const phone = () => {
  media = { '(hover: none)': true, '(pointer: coarse)': true };
};

const at = Date.now() - 60_000;
const messages: ChatMessage[] = [
  { uuid: 'u1', role: 'user', blocks: [{ type: 'text', text: 'Run the theme tests' }], timestamp: at },
  {
    uuid: 'a1', role: 'assistant', model: 'claude-opus-5-5', timestamp: at + 1000,
    blocks: [
      { type: 'text', text: 'Running them now, see `src/theme.css:12`.' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test -- theme', description: 'Run the theme tests' } },
      { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/p/src/theme.css', old_string: 'a', new_string: 'b' } },
    ],
  },
  { uuid: 'r1', role: 'user', blocks: [{ type: 'tool_result', tool_use_id: 't1', content: 'Test Files  2 passed (2)' }, { type: 'tool_result', tool_use_id: 't2', content: 'ok' }], timestamp: at + 2000 },
  { uuid: 'a2', role: 'assistant', model: 'claude-opus-5-5', blocks: [{ type: 'text', text: 'All 14 theme tests pass. See [the docs](https://example.com) and:\n\n```sh\nnpm run build\n```' }], timestamp: at + 3000 },
];
const view: SessionView = { messages, offset: 0, total: messages.length, loaded: true, loadingOlder: false };

function conversation(handlers: { onRewind?: (point: { uuid: string; text: string }) => void; onFork?: () => void; onForkReply?: (upTo: string) => void } = {}) {
  const sideChat = vi.fn();
  const runInTerminal = vi.fn();
  const openFile = vi.fn();
  vi.spyOn(api, 'exists').mockImplementation(async (_cwd: string, paths: string[]) => paths);
  render(
    <PathLinksContext.Provider value={{ cwd: '/p', openFile, openChanges: vi.fn(), changed: new Set(['src/theme.css']) }}>
      <RunInTerminal.Provider value={runInTerminal}>
        <QuoteTargetContext.Provider value={{ chat: 'chat', sideChat: { open: false, start: sideChat } }}>
          <MessageList sessionId="s" view={view} cwd="/p" mode="normal" {...handlers} />
        </QuoteTargetContext.Provider>
      </RunInTerminal.Provider>
    </PathLinksContext.Provider>,
  );
  return { sideChat, runInTerminal, openFile };
}
const menuItems = (name: string) => within(screen.getByRole('menu', { name })).getAllByRole('menuitem').map((item) => item.textContent);

describe('Claude’s reply', () => {
  it('has its row under it on a computer: Copy message · Fork from here · ⋯ · the model and the time', () => {
    computer();
    conversation({ onRewind: vi.fn(), onForkReply: vi.fn() });
    const more = screen.getAllByRole('button', { name: 'More for Claude’s reply' }).at(-1)!;
    const row = more.parentElement!;
    expect([...row.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual(['Copy message', 'Fork from here', 'More for Claude’s reply']);
    expect(row.textContent).toContain('Opus 5.5 · ');
    // Kept room, shown on hover or focus: nothing moves when it shows.
    expect(row.className).toContain('[@media(hover:hover)]:opacity-0');
  });

  it('opens its whole list from ⋯, the turn’s figures at its foot, acting on its prompt and its end', () => {
    computer();
    const onRewind = vi.fn();
    const onForkReply = vi.fn();
    conversation({ onRewind, onForkReply });
    fireEvent.click(screen.getAllByRole('button', { name: 'More for Claude’s reply' }).at(-1)!);
    expect(menuItems('Claude’s reply')).toEqual(['Copy message', 'Copy message as Markdown', 'Start a side chat', 'Quote message', 'Rewind to here', 'Fork from here']);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Rewind to here' }));
    expect(onRewind).toHaveBeenCalledWith({ uuid: 'u1', text: 'Run the theme tests', timestamp: at });
    fireEvent.click(screen.getAllByRole('button', { name: 'More for Claude’s reply' }).at(-1)!);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Fork from here' }));
    expect(onForkReply).toHaveBeenCalledWith('a2');
  });

  it('puts what was right-clicked first: a selection’s Copy and Quote, a code block’s Copy code', () => {
    computer();
    conversation({ onRewind: vi.fn() });
    const words = screen.getByText(/All 14 theme tests pass/);
    vi.spyOn(window, 'getSelection').mockReturnValue({ isCollapsed: false, anchorNode: words.firstChild, toString: () => 'All 14 theme tests pass', removeAllRanges() {} } as unknown as Selection);
    fireEvent.pointerDown(words, { pointerType: 'mouse', button: 2 });
    fireEvent.contextMenu(words, { clientX: 300, clientY: 200 });
    const list = menuItems('Claude’s reply');
    expect(list.slice(0, 2)).toEqual(['CopyCtrl+C', 'Copy message']);
    expect(list).toContain('Quote selectionCtrl+Shift+L');
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /^Quote selection/ }));
    expect(waitingOf('chat').map((item) => item.text)).toEqual(['All 14 theme tests pass']);
    vi.restoreAllMocks();
    const code = screen.getByText('npm run build');
    fireEvent.pointerDown(code, { pointerType: 'mouse', button: 2 });
    fireEvent.contextMenu(code, { clientX: 300, clientY: 300 });
    expect(menuItems('Claude’s reply')[0]).toBe('Copy code');
  });

  it('leaves a link’s and a picture’s menu to the browser, and a finger’s long press on its words to the system', () => {
    computer();
    conversation();
    const link = screen.getByRole('link', { name: 'the docs' });
    fireEvent.pointerDown(link, { pointerType: 'mouse', button: 2 });
    expect(fireEvent.contextMenu(link)).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
    // Android sends a long press on words as a context menu: a finger's is the system's selection.
    const words = screen.getByText(/All 14 theme tests pass/);
    fireEvent.pointerDown(words, { pointerType: 'touch' });
    expect(fireEvent.contextMenu(words)).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('on a phone, always shows Copy · ⋯ · the time, and its sheet has the turn’s figures', () => {
    phone();
    conversation({ onRewind: vi.fn(), onForkReply: vi.fn() });
    const more = screen.getAllByRole('button', { name: 'More for Claude’s reply' }).at(-1)!;
    expect([...more.parentElement!.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual(['Copy message', 'More for Claude’s reply']);
    fireEvent.click(more);
    const sheet = screen.getByRole('dialog');
    expect(sheet.textContent).toMatch(/^Claude’s reply · /);
    expect(menuItems('Claude’s reply')).toEqual(['Copy message', 'Copy message as Markdown', 'Start a side chat', 'Quote message', 'Rewind to here', 'Fork from here']);
    expect(sheet.textContent).toContain('Opus 5.5');
  });
});

describe('a step', () => {
  it('a command’s: Copy command · Run in terminal · Copy output · Start a side chat · Quote output, from a right-click or its ⋯', () => {
    computer();
    const { runInTerminal } = conversation();
    const step = screen.getByRole('button', { name: 'More for Run Run the theme tests' }).closest('[data-step]')!;
    fireEvent.pointerDown(step, { pointerType: 'mouse', button: 2 });
    fireEvent.contextMenu(step, { clientX: 100, clientY: 100 });
    expect(menuItems('Run Run the theme tests')).toEqual(['Copy command', 'Run in terminal', 'Copy output', 'Start a side chat', 'Quote output']);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Run in terminal' }));
    // It asks first, in place, showing the command itself, never the row's description of it.
    expect(runInTerminal).not.toHaveBeenCalled();
    const asked = screen.getByText('Run this line in a new terminal?').closest('[data-run-question]')! as HTMLElement;
    expect(step.contains(asked)).toBe(true);
    expect(within(asked).getByRole('group', { name: 'The command' }).textContent).toBe('1npm test -- theme');
    fireEvent.click(within(asked).getByRole('button', { name: 'Run' }));
    expect(runInTerminal).toHaveBeenCalledWith('npm test -- theme');
    expect(screen.queryByText('Run this line in a new terminal?')).toBeNull();
    // Its own list, not the reply's it is in.
    expect(screen.queryByRole('menu', { name: 'Claude’s reply' })).toBeNull();
    fireEvent.click(within(step as HTMLElement).getByRole('button', { name: /^More for Run/ }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Quote output' }));
    expect(waitingOf('chat').map((item) => item.text)).toEqual(['Test Files  2 passed (2)']);
  });

  it('a file’s: its path’s menu, Open in Changes for a file with changes', async () => {
    computer();
    conversation();
    // Once the folder is known to hold the file, its name is a link, and the step has the path's menu.
    const step = (await screen.findByRole('button', { name: /^More for Edit/ })).closest('[data-step]')!;
    fireEvent.pointerDown(step, { pointerType: 'mouse', button: 2 });
    fireEvent.contextMenu(step, { clientX: 100, clientY: 100 });
    const menu = screen.getByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Attach as context', 'Copy', 'Open in Changes', 'Open in Files', 'Download file']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Attach as context' }));
    expect(waitingOf('chat').map((item) => [item.kind, item.path])).toEqual([['file', 'src/theme.css']]);
  });

  it('under a finger, opens on a long press, as a sheet named for the step', () => {
    phone();
    conversation();
    const step = screen.getByRole('button', { name: 'More for Run Run the theme tests' }).closest('[data-step]')!;
    vi.useFakeTimers();
    try {
      fireEvent.pointerDown(step, { pointerType: 'touch', isPrimary: true, pointerId: 3, clientX: 100, clientY: 100 });
      act(() => vi.advanceTimersByTime(510));
    } finally {
      vi.useRealTimers();
    }
    const sheet = screen.getByRole('dialog', { name: 'Run · Run the theme tests' });
    // The step itself is raised over the dim, a copy that takes no taps.
    expect(sheet.querySelector('[inert] [data-step]')).not.toBeNull();
    expect(within(sheet).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Copy command', 'Run in terminal', 'Copy output', 'Start a side chat', 'Quote output']);
  });
});

describe('a step’s Run in terminal', () => {
  /** A conversation of one step, Claude's command with a description, its outcome as given. */
  function step(input: Record<string, unknown>, result: { content: string; is_error?: boolean }, name = 'Bash', shell = 'zsh') {
    const runInTerminal = vi.fn();
    const messages: ChatMessage[] = [
      { uuid: 'u1', role: 'user', blocks: [{ type: 'text', text: 'Clean up' }], timestamp: at },
      { uuid: 'a1', role: 'assistant', model: 'claude-opus-5-5', timestamp: at + 1000, blocks: [{ type: 'tool_use', id: 't1', name, input }] },
      { uuid: 'r1', role: 'user', blocks: [{ type: 'tool_result', tool_use_id: 't1', ...result }], timestamp: at + 2000 },
    ];
    render(
      <RunInTerminal.Provider value={runInTerminal}>
        <TerminalShell.Provider value={shell}>
          <QuoteTargetContext.Provider value={{ chat: 'chat' }}>
            <MessageList sessionId="s" view={{ messages, offset: 0, total: messages.length, loaded: true, loadingOlder: false }} cwd="/p" mode="normal" />
          </QuoteTargetContext.Provider>
        </TerminalShell.Provider>
      </RunInTerminal.Provider>,
    );
    return runInTerminal;
  }
  const menuOf = (label: RegExp) => {
    fireEvent.click(screen.getByRole('button', { name: label }));
    return within(screen.getByRole('menu')).getAllByRole('menuitem').map((item) => item.textContent);
  };

  it('asks with the whole command, as it runs, wrapped and its blanks drawn, where the row says only Claude’s description', () => {
    computer();
    const command = `rm -rf build${'  '}&& npm run build\nls -la build`;
    const runInTerminal = step({ command, description: 'Clean the build folder' }, { content: 'done' });
    expect(menuOf(/^More for Run Clean the build folder/)).toContain('Run in terminal');
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Run in terminal' }));
    expect(screen.getByText('Run these 2 lines in a new terminal?')).toBeTruthy();
    const shown = screen.getByRole('group', { name: 'The command' });
    expect([...shown.querySelectorAll('[data-line]')].map((line) => line.textContent)).toEqual(['rm -rf build\u00b7\u00b7&& npm run build', 'ls -la build']);
    expect(shown.textContent).not.toContain('Clean the build folder');
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(runInTerminal).toHaveBeenCalledWith(command);
  });

  it('is not offered on a step you denied', () => {
    computer();
    step({ command: 'ls -la && touch DENIED_STEP_RAN', description: 'Clean the build folder' }, {
      content: 'The user doesn\'t want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.',
      is_error: true,
    });
    expect(screen.getByText('denied')).toBeTruthy();
    expect(menuOf(/^More for Run Clean the build folder/)).toEqual(['Copy command']);
  });

  it('is offered for PowerShell’s command only where the terminal runs PowerShell, and for a POSIX shell’s only where it does not', () => {
    computer();
    step({ command: 'Get-ChildItem', description: 'List the files' }, { content: 'README.md' }, 'PowerShell', 'zsh');
    expect(menuOf(/^More for Run List the files/)).not.toContain('Run in terminal');
    cleanup();
    step({ command: 'Get-ChildItem', description: 'List the files' }, { content: 'README.md' }, 'PowerShell', 'pwsh');
    expect(menuOf(/^More for Run List the files/)).toContain('Run in terminal');
    cleanup();
    step({ command: 'ls', description: 'List the files' }, { content: 'README.md' }, 'Bash', 'pwsh');
    expect(menuOf(/^More for Run List the files/)).not.toContain('Run in terminal');
  });
});

describe('a path in a reply', () => {
  it('opens the file on a click, and its path’s menu on a right-click', async () => {
    computer();
    const { openFile } = conversation();
    const link = await screen.findByRole('link', { name: 'src/theme.css:12' });
    fireEvent.click(link);
    expect(openFile).toHaveBeenCalledWith('src/theme.css', 12);
    fireEvent.pointerDown(link, { pointerType: 'mouse', button: 2 });
    fireEvent.contextMenu(link, { clientX: 50, clientY: 50 });
    expect(menuItems('src/theme.css')).toEqual(['Attach as context', 'Copy', 'Open in Changes', 'Open in Files', 'Download file']);
    // The reply's own list stays shut: the path's is what was clicked.
    expect(screen.queryByRole('menu', { name: 'Claude’s reply' })).toBeNull();
  });
});

describe('your prompt', () => {
  it('right-clicked: Copy · Quote · Rewind to here · Fork from here', () => {
    computer();
    const onRewind = vi.fn();
    const onFork = vi.fn();
    conversation({ onRewind, onFork });
    const prompt = screen.getByText('Run the theme tests', { selector: 'div' });
    fireEvent.pointerDown(prompt, { pointerType: 'mouse', button: 2 });
    fireEvent.contextMenu(prompt, { clientX: 400, clientY: 40 });
    expect(menuItems('Your message')).toEqual(['Copy', 'Quote', 'Rewind to here', 'Fork from here']);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Fork from here' }));
    expect(onFork).toHaveBeenCalledWith(expect.objectContaining({ key: 'u1', text: 'Run the theme tests' }));
  });

  it('long-pressed under a finger: its sheet, with Select text, and the press’s own click does nothing else', () => {
    phone();
    conversation({ onRewind: vi.fn(), onFork: vi.fn() });
    const prompt = screen.getByText('Run the theme tests', { selector: 'div' });
    vi.useFakeTimers();
    try {
      fireEvent.pointerDown(prompt, { pointerType: 'touch', isPrimary: true, pointerId: 2, clientX: 300, clientY: 40 });
      act(() => vi.advanceTimersByTime(510));
    } finally {
      vi.useRealTimers();
    }
    expect(menuItems('Your message')).toEqual(['Copy', 'Quote', 'Rewind to here', 'Fork from here', 'Select text']);
    // The finger lifting is the press's: the tapped row does not open, and the sheet stays.
    fireEvent.pointerUp(prompt, { pointerType: 'touch', isPrimary: true, pointerId: 2 });
    fireEvent.click(prompt);
    expect(screen.queryByRole('button', { name: 'Rewind to here' })).toBeNull();
    expect(screen.getByRole('menu', { name: 'Your message' })).toBeTruthy();
  });
});

describe('a `!` command in the conversation', () => {
  const shell: ChatMessage[] = [
    { uuid: 'b1', role: 'user', blocks: [{ type: 'text', text: '<bash-input>npm test -- theme</bash-input>' }], timestamp: at },
    { uuid: 'b2', role: 'user', blocks: [{ type: 'text', text: '<bash-stdout>Tests 14 passed</bash-stdout><bash-stderr></bash-stderr>' }], timestamp: at + 1000 },
  ];
  const record = (messages: ChatMessage[]) => {
    const runInTerminal = vi.fn();
    render(
      <RunInTerminal.Provider value={runInTerminal}>
        <QuoteTargetContext.Provider value={{ chat: 'chat' }}>
          <MessageList sessionId="s" view={{ messages, offset: 0, total: messages.length, loaded: true, loadingOlder: false }} cwd="/p" mode="normal" />
        </QuoteTargetContext.Provider>
      </RunInTerminal.Provider>,
    );
    return runInTerminal;
  };

  it('has a command step’s list, Run in terminal included, on a long press under a finger', () => {
    phone();
    const runInTerminal = record(shell);
    const head = screen.getByText('npm test -- theme').parentElement!;
    vi.useFakeTimers();
    try {
      fireEvent.pointerDown(head, { pointerType: 'touch', isPrimary: true, pointerId: 9, clientX: 60, clientY: 60 });
      act(() => vi.advanceTimersByTime(510));
    } finally {
      vi.useRealTimers();
    }
    const sheet = screen.getByRole('dialog', { name: 'Run · npm test -- theme' });
    expect(within(sheet).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Copy command', 'Run in terminal', 'Copy output', 'Quote output']);
    fireEvent.click(within(sheet).getByText('Run in terminal'));
    // Asked first, the command shown whole; Cancel runs nothing.
    expect(runInTerminal).not.toHaveBeenCalled();
    expect(screen.getByRole('group', { name: 'The command' }).textContent).toBe('1npm test -- theme');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('group', { name: 'The command' })).toBeNull();
    expect(runInTerminal).not.toHaveBeenCalled();
  });

  it('with a pointer, under ⋯ or a right-click; a command that hides what it holds has no Run in terminal', () => {
    computer();
    record([
      { uuid: 'b1', role: 'user', blocks: [{ type: 'text', text: '<bash-input>echo safe\u0001\u000btouch pwned</bash-input>' }], timestamp: at },
      { uuid: 'b2', role: 'user', blocks: [{ type: 'text', text: '<bash-stdout>safe</bash-stdout><bash-stderr></bash-stderr>' }], timestamp: at + 1000 },
    ]);
    fireEvent.click(screen.getByRole('button', { name: /^More for echo safe/ }));
    expect(menuItems('Run echo safe\u0001\u000btouch pwned')).toEqual(['Copy command', 'Copy output', 'Quote output']);
  });
});
