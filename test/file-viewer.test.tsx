// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const CWD = '/code/app';
const TEXT = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';
const server = vi.hoisted(() => ({ searched: [] as string[], files: {} as Record<string, string> }));

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
        return { engine: 'rg', truncated: false, files: [{ path: 'src/a.ts', lines: [{ n: 2, text: 'const b = 2;' }] }] };
      },
      tree: async () => [],
    },
  };
});

beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  Element.prototype.scrollIntoView = vi.fn();
});

const { FileViewer } = await import('../src/web/components/FileViewer');
const { WorkspaceFiles } = await import('../src/web/components/WorkspaceFiles');
const { setComments, commentsOf } = await import('../src/web/lib/review');

afterEach(() => {
  cleanup();
  setComments(CWD, []);
  server.searched = [];
  server.files = {};
});

const wrap = (node: React.ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);

describe('a file', () => {
  it('opens at its line, numbered, and a tap on a line comments on it', async () => {
    wrap(<FileViewer cwd={CWD} path="src/a.ts" line={2} onAddToMessage={() => {}} />);
    await waitFor(() => expect(document.querySelector('[data-line="2"]')?.textContent).toBe('2const b = 2;'));
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'center' }));
    const line = document.querySelector('[data-line="3"]')!;
    fireEvent.click(line);
    fireEvent.change(screen.getByLabelText('Comment for Claude'), { target: { value: 'Name it c3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    expect(commentsOf(CWD)).toMatchObject([{ path: 'src/a.ts', kind: 'same', line: 3, code: 'const c = 3;', note: 'Name it c3' }]);
    expect(screen.getByText('Name it c3')).toBeTruthy();
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
  const line = (n: number) => document.querySelector(`[data-line="${n}"]`);

  it('shows a source file numbered after a Markdown file was shown as it reads', async () => {
    server.files = { 'README.md': '# Title\n\nSome *words*.\n', 'src/a.ts': TEXT };
    const { go } = open('README.md');
    await screen.findByRole('heading', { name: 'Title' });
    go('src/a.ts');
    await waitFor(() => expect(line(2)?.textContent).toBe('2const b = 2;'));
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
    fireEvent.click(line(2)!);
    fireEvent.change(screen.getByLabelText('Comment for Claude'), { target: { value: 'Rename b' } });
    go('src/b.ts');
    await waitFor(() => expect(line(2)?.textContent).toBe('2let y = 2;'));
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
