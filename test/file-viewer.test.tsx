// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const CWD = '/code/app';
const TEXT = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';
const server = vi.hoisted(() => ({ searched: [] as string[], files: {} as Record<string, string>, found: [] as Array<{ n: number; text: string }> }));

vi.mock('../src/web/lib/api', async (original) => {
  const actual = await original<typeof import('../src/web/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      file: async (_cwd: string, path: string) => {
        const text = server.files[path] ?? TEXT;
        return { path, size: text.length, text };
      },
      files: async (_cwd: string, q: string) => ['src/a.ts', 'src/'].filter((f) => f.includes(q)),
      search: async (_cwd: string, q: string) => {
        server.searched.push(q);
        return { engine: 'rg', truncated: false, files: [{ path: 'src/a.ts', lines: [{ n: 2, text: 'const b = 2;' }, ...server.found] }] };
      },
      tree: async () => [],
    },
  };
});

let media: Record<string, boolean> = {};
beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: Boolean(media[query]), media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  Element.prototype.scrollIntoView = vi.fn();
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});

const { FileViewer, PaneQuote } = await import('../src/web/components/FileViewer');
const { SendComments } = await import('../src/web/components/Comments');
const { WorkspaceFiles } = await import('../src/web/components/WorkspaceFiles');
const { setComments, commentsOf } = await import('../src/web/lib/review');

afterEach(() => {
  cleanup();
  media = {};
  setComments(CWD, []);
  server.searched = [];
  server.files = {};
  server.found = [];
});

const wrap = (node: React.ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);

const line = (n: number) => document.querySelector(`[data-line="${n}"]`)!;
const bar = () => screen.getByRole('toolbar', { name: 'Picked lines' });

describe('a file', () => {
  it('opens at its line, numbered; a tap on a line picks it, for Copy · Quote · Add comment, and Add comment comments on it', async () => {
    wrap(<FileViewer cwd={CWD} path="src/a.ts" line={2} onAddToMessage={() => {}} />);
    await waitFor(() => expect(line(2).textContent).toBe('2+const b = 2;'));
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'center' }));
    fireEvent.click(line(3));
    expect(bar().textContent).toBe('Line 3CopyQuoteAdd comment');
    fireEvent.click(within(bar()).getByRole('button', { name: 'Add comment' }));
    expect(screen.queryByRole('toolbar', { name: 'Picked lines' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Comment for Claude'), { target: { value: 'Name it c3' } });
    // Desktop's box: Cancel · Send to Claude (where comments can be sent from) · Add comment.
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Send to Claude/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }));
    expect(commentsOf(CWD)).toMatchObject([{ path: 'src/a.ts', kind: 'same', line: 3, code: 'const c = 3;', note: 'Name it c3' }]);
    expect(screen.getByText('Name it c3')).toBeTruthy();
    // A tap on the one line picked lets it go.
    fireEvent.click(line(1));
    fireEvent.click(line(1));
    expect(screen.queryByRole('toolbar', { name: 'Picked lines' })).toBeNull();
  });

  it('picks a few lines in a row with Shift, and comments on them all, as Desktop’s "at lines 1-3"', async () => {
    wrap(<FileViewer cwd={CWD} path="src/a.ts" onAddToMessage={() => {}} />);
    await waitFor(() => expect(line(3)).toBeTruthy());
    fireEvent.click(line(1));
    fireEvent.click(line(3), { shiftKey: true });
    expect(bar().textContent).toMatch(/^Lines 1\u20133/);
    expect([1, 2, 3].map((n) => line(n).className.includes('bg-mark'))).toEqual([true, true, true]);
    fireEvent.click(within(bar()).getByRole('button', { name: 'Add comment' }));
    fireEvent.change(screen.getByLabelText('Comment for Claude'), { target: { value: 'One block' } });
    fireEvent.submit(screen.getByLabelText('Comment for Claude').closest('form')!);
    expect(commentsOf(CWD)).toMatchObject([{ line: 1, to: 3, code: 'const a = 1;\nconst b = 2;\nconst c = 3;', note: 'One block' }]);
    // It shows under its last line.
    expect(line(3).parentElement!.textContent).toContain('One block');
  });

  it('comments on a line at once from the + its number shows with a pointer, and Send to Claude sends what waits', async () => {
    const send = vi.fn();
    wrap(<SendComments.Provider value={send}><FileViewer cwd={CWD} path="src/a.ts" onAddToMessage={() => {}} /></SendComments.Provider>);
    await waitFor(() => expect(line(2)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Add comment on line 2' }));
    fireEvent.change(screen.getByLabelText('Comment for Claude'), { target: { value: 'Rename b' } });
    fireEvent.click(screen.getByRole('button', { name: /^Send to Claude/ }));
    expect(commentsOf(CWD)).toMatchObject([{ line: 2, note: 'Rename b' }]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('under a finger, picks the lines a long press drags over', async () => {
    wrap(<FileViewer cwd={CWD} path="src/a.ts" onAddToMessage={() => {}} />);
    await waitFor(() => expect(line(3)).toBeTruthy());
    // jsdom lays nothing out: the finger is over line 3 once it moves.
    Object.assign(document, { elementFromPoint: () => line(3).lastChild });
    vi.useFakeTimers();
    try {
      fireEvent.pointerDown(line(1).lastChild!, { pointerType: 'touch', isPrimary: true, pointerId: 7, clientX: 50, clientY: 10 });
      act(() => vi.advanceTimersByTime(510));
      fireEvent.pointerMove(line(1).lastChild!, { pointerType: 'touch', pointerId: 7, clientX: 50, clientY: 60 });
      fireEvent.pointerUp(line(1).lastChild!, { pointerType: 'touch', pointerId: 7 });
      // The tap that ends the press is the press's.
      fireEvent.click(line(1).lastChild!);
    } finally {
      vi.useRealTimers();
      Object.assign(document, { elementFromPoint: undefined });
    }
    expect(bar().textContent).toMatch(/^Lines 1\u20133/);
  });

  it('quotes lines picked with ⇧⌘L, and a right-click opens the bar’s list for them', async () => {
    const quoted = vi.fn();
    wrap(<PaneQuote.Provider value={quoted}><FileViewer cwd={CWD} path="src/a.ts" onAddToMessage={() => {}} /></PaneQuote.Provider>);
    await waitFor(() => expect(line(3)).toBeTruthy());
    fireEvent.click(line(2));
    fireEvent.keyDown(screen.getByRole('group', { name: 'The text of src/a.ts' }), { key: 'l', code: 'KeyL', ctrlKey: true, shiftKey: true });
    expect(quoted).toHaveBeenCalledWith(expect.objectContaining({ kind: 'quote', text: 'const b = 2;', path: 'src/a.ts', lines: [2, 2], from: { what: 'file' } }));
    expect(screen.queryByRole('toolbar', { name: 'Picked lines' })).toBeNull();
    media = { '(hover: hover) and (pointer: fine)': true, '(pointer: fine)': true };
    fireEvent.contextMenu(line(3).lastChild!, { clientX: 20, clientY: 20 });
    const menu = screen.getByRole('menu', { name: 'Lines' });
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Copy', expect.stringMatching(/^Quote/), 'Add comment']);
    fireEvent.click(within(menu).getByText('Quote'));
    expect(quoted).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'const c = 3;', lines: [3, 3] }));
  });

  it('numbers the lines it has, highlighted or plain: the line break a file ends with starts no line', async () => {
    // Each row's number and text, without the + its number turns into under a pointer.
    const numbered = () => [...document.querySelectorAll('[data-line]')].map((row) => row.textContent!.replace('+', ''));
    const shown = async (path: string, text: string) => {
      server.files = { [path]: text };
      const view = wrap(<FileViewer cwd={CWD} path={path} onAddToMessage={() => {}} />);
      await waitFor(() => expect(document.querySelector('[data-line="1"]')).toBeTruthy());
      const lines = numbered();
      view.unmount();
      return lines;
    };
    expect(await shown('src/a.ts', TEXT)).toEqual(['1const a = 1;', '2const b = 2;', '3const c = 3;']);
    expect(await shown('notes.txt', TEXT)).toEqual(['1const a = 1;', '2const b = 2;', '3const c = 3;']);
    expect(await shown('src/b.ts', 'let x = 1;')).toEqual(['1let x = 1;']);
    // A blank last line is a line of the file, numbered as in an editor.
    expect(await shown('src/c.ts', 'let x = 1;\n\n')).toEqual(['1let x = 1;', '2 ']);
    expect(await shown('notes.txt', 'one\n\n')).toEqual(['1one', '2 ']);
  });

  it('quotes the lines selected into the message as path:7-8 and the lines', async () => {
    const add = vi.fn();
    wrap(<FileViewer cwd={CWD} path="src/a.ts" onAddToMessage={add} />);
    await waitFor(() => expect(document.querySelector('[data-line="2"]')).toBeTruthy());
    const first = document.querySelector('[data-line="1"]')!;
    const second = document.querySelector('[data-line="2"]')!;
    const range = document.createRange();
    range.setStart(first.lastChild!, 0);
    range.setEnd(second.lastChild!, 1);
    act(() => {
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Quote' }));
    expect(add).toHaveBeenCalledWith('src/a.ts:1-2\n> const a = 1;\n> const b = 2;', 'quote');
  });
});

describe('searching Files', () => {
  it('finds names as you type, then the text, and opens a line it found', async () => {
    const go = vi.fn();
    wrap(<WorkspaceFiles cwd={CWD} step={{ tab: 'files' }} open go={go} up={() => {}} onAddToMessage={() => {}} />);
    fireEvent.change(screen.getByLabelText('Search files'), { target: { value: 'a.ts' } });
    fireEvent.click(await screen.findByText('a.ts'));
    expect(go).toHaveBeenLastCalledWith({ tab: 'files', path: 'src/a.ts' });
    fireEvent.click(screen.getByText(/Search in files for/));
    fireEvent.click(await screen.findByText('const b = 2;', { exact: false }));
    expect(server.searched).toEqual(['a.ts']);
    expect(go).toHaveBeenLastCalledWith({ tab: 'files', path: 'src/a.ts', line: 2 });
  });

  it('shows what it found on a long line where it is, after a "…", and marks it', async () => {
    server.found = [
      { n: 7, text: '    // Every color the page uses is a CSS variable, and the dark one is set by data-theme on the root.' },
      { n: 9, text: 'theme: dark' },
    ];
    wrap(<WorkspaceFiles cwd={CWD} step={{ tab: 'files' }} open go={() => {}} up={() => {}} onAddToMessage={() => {}} />);
    fireEvent.change(screen.getByLabelText('Search files'), { target: { value: 'theme' } });
    fireEvent.click(screen.getByText(/Search in files for/));
    const far = (await screen.findByText('7')).nextElementSibling!;
    expect(far.textContent).toBe('…set by data-theme on the root.');
    expect(far.querySelector('mark')?.textContent).toBe('theme');
    // Near the start of its line, it shows from the start.
    expect(screen.getByText('9').nextElementSibling!.textContent).toBe('theme: dark');
  });
});

describe('going straight from one file to another', () => {
  // As a path in the conversation does while a file is open beside it: the step changes, the view stays.
  function open(path: string) {
    const client = new QueryClient();
    const at = (p: string) => (
      <QueryClientProvider client={client}>
        <WorkspaceFiles cwd={CWD} step={{ tab: 'files', path: p }} open go={() => {}} up={() => {}} onAddToMessage={() => {}} />
      </QueryClientProvider>
    );
    const view = render(at(path));
    return { client, go: (p: string) => view.rerender(at(p)) };
  }
  it('shows a source file numbered after a Markdown file was shown as it reads', async () => {
    server.files = { 'README.md': '# Title\n\nSome *words*.\n', 'src/a.ts': TEXT };
    const { go } = open('README.md');
    await screen.findByRole('heading', { name: 'Title' });
    go('src/a.ts');
    await waitFor(() => expect(line(2)?.textContent).toBe('2+const b = 2;'));
    expect(screen.getByRole('button', { name: 'Wrap' })).toBeTruthy();
  });

  it('opens another page as its code, and nothing of it runs until its own Run', async () => {
    server.files = { 'a.html': '<p>first page</p>\n<script>parent.ran = "a"</script>\n', 'b.html': '<p>second page</p>\n<script>parent.ran = "b"</script>\n' };
    const { go } = open('a.html');
    fireEvent.click(await screen.findByRole('button', { name: 'Preview' }));
    fireEvent.click(await screen.findByTitle('Run its scripts'));
    expect(screen.queryByTitle('Run its scripts')).toBeNull();
    go('b.html');
    await waitFor(() => expect(line(1)?.textContent).toContain('second page'));
    expect(screen.queryByRole('button', { name: 'Source' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(screen.getByTitle('Run its scripts')).toBeTruthy();
    expect(document.querySelector('iframe')?.getAttribute('sandbox')).toBe('');
  });

  it('leaves a comment being written on one file behind', async () => {
    server.files = { 'src/a.ts': TEXT, 'src/b.ts': 'let x = 1;\nlet y = 2;\nlet z = 3;\n' };
    const { go } = open('src/a.ts');
    await waitFor(() => expect(line(2)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Add comment on line 2' }));
    fireEvent.change(screen.getByLabelText('Comment for Claude'), { target: { value: 'Rename b' } });
    go('src/b.ts');
    await waitFor(() => expect(line(2)?.textContent).toBe('2+let y = 2;'));
    expect(screen.queryByLabelText('Comment for Claude')).toBeNull();
    expect(commentsOf(CWD)).toEqual([]);
  });
});

describe('a page that was run', () => {
  it('waits for Run again once it is rewritten', async () => {
    server.files = { 'a.html': '<p>first</p>\n<script>parent.ran = 1</script>\n' };
    const client = new QueryClient();
    render(<QueryClientProvider client={client}><FileViewer cwd={CWD} path="a.html" onAddToMessage={() => {}} /></QueryClientProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Preview' }));
    fireEvent.click(await screen.findByTitle('Run its scripts'));
    expect(document.querySelector('iframe')?.getAttribute('sandbox')).toBe('allow-scripts');
    // Claude rewrites it; the viewer reads it again.
    server.files = { 'a.html': '<p>second</p>\n<script>parent.ran = 2</script>\n' };
    await act(() => client.refetchQueries({ queryKey: ['file'] }));
    await waitFor(() => expect(screen.getByTitle('Run its scripts')).toBeTruthy());
    expect(document.querySelector('iframe')?.getAttribute('sandbox')).toBe('');
  });
});

describe('a row in Files', () => {
  it('has its path’s menu on a right-click: a folder’s opens a terminal there, a changed file’s shows its changes', async () => {
    media = { '(hover: hover) and (pointer: fine)': true, '(pointer: fine)': true };
    const tree = vi.spyOn((await import('../src/web/lib/api')).api, 'tree').mockResolvedValue([
      { name: 'styles', path: 'src/styles', dir: true },
      { name: 'theme.css', path: 'src/theme.css', dir: false, size: 120 },
    ]);
    const info = vi.spyOn((await import('../src/web/lib/api')).api, 'info').mockResolvedValue({ terminal: { available: true } } as never);
    const go = vi.fn();
    wrap(<WorkspaceFiles cwd={CWD} step={{ tab: 'files', path: 'src/' }} open go={go} up={() => {}} onAddToMessage={() => {}} changed={new Set(['src/theme.css'])} />);
    // The terminals are known to run here before the folder's menu offers one.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open in terminal' })).toBeTruthy());
    fireEvent.contextMenu(await screen.findByText('styles'), { clientX: 10, clientY: 10 });
    let menu = screen.getByRole('menu', { name: 'src/styles' });
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Attach as context', 'Copy', 'Open in terminal']);
    fireEvent.click(within(menu).getByText('Open in terminal'));
    expect(go).toHaveBeenLastCalledWith({ tab: 'terminal' });
    fireEvent.contextMenu(screen.getByText('theme.css'), { clientX: 10, clientY: 30 });
    menu = screen.getByRole('menu', { name: 'src/theme.css' });
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Attach as context', 'Copy', 'Open in Changes', 'Download file']);
    fireEvent.click(within(menu).getByText('Open in Changes'));
    expect(go).toHaveBeenLastCalledWith({ tab: 'changes', path: 'src/theme.css' });
    tree.mockRestore();
    info.mockRestore();
  });
});
