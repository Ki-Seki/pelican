// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { GitStatus, SessionChanges } from '../src/shared/protocol';

const CWD = '/code/app';
const server = vi.hoisted(() => ({ asked: [] as string[], diff: '' }));

vi.mock('../src/web/lib/api', async (original) => {
  const actual = await original<typeof import('../src/web/lib/api')>();
  const status: GitStatus = { repo: true, branch: 'feat/x', base: 'main', files: [{ path: 'src/a.ts', status: 'modified', added: 1, removed: 1 }] };
  const since: GitStatus = { ...status, files: [...status.files, { path: 'README.md', status: 'modified', added: 2, removed: 0 }] };
  const changes: SessionChanges = {
    turns: [
      { uuid: 'p1', n: 1, text: 'Add a dark theme', files: [{ path: 'src/theme.css', added: 7, removed: 0 }], checkpoint: true },
      { uuid: 'p2', n: 2, text: 'Fix the toggle', files: [{ path: 'src/a.ts', added: 1, removed: 1 }], checkpoint: false },
    ],
    lines: {},
  };
  return {
    ...actual,
    api: {
      ...actual.api,
      git: async (_cwd: string, scope?: string) => {
        server.asked.push(`git ${scope ?? ''}`);
        return scope === 'base' ? since : status;
      },
      changes: async () => changes,
      gitDiff: async () => server.diff,
      turnDiff: async (_id: string, turn: string, path: string) => {
        server.asked.push(`turn ${turn} ${path}`);
        return `--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,1 @@\n+:root {}\n`;
      },
      tree: async () => [],
    },
  };
});

beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});

const { Workspace } = await import('../src/web/components/Workspace');
const { UnifiedDiff } = await import('../src/web/components/UnifiedDiff');
const { WorkspaceChanges } = await import('../src/web/components/WorkspaceChanges');

afterEach(() => {
  cleanup();
  server.asked = [];
  server.diff = '';
  history.replaceState(null, '', '/');
});

const wrap = (node: React.ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);

describe('what Changes shows', () => {
  it('offers Uncommitted, since the branch split and each turn, and a turn ends with Rewind code', async () => {
    history.replaceState(null, '', '/?s=s1&w=changes');
    const onRewind = vi.fn();
    wrap(<Workspace open cwd={CWD} sessionId="s1" onRewind={onRewind} onClose={() => {}} onAddToMessage={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Show:/ }));
    const sheet = screen.getAllByRole('dialog').at(-1)!;
    await waitFor(() => expect(within(sheet).getByText('Since main')).toBeTruthy());
    // The newest turn first, as the list of turns reads back from now.
    const labels = within(sheet).getAllByRole('button').map((b) => b.textContent);
    expect(labels.filter((l) => l?.startsWith('T'))).toEqual(['T2 · Fix the toggle1 file', 'T1 · Add a dark theme1 file']);
    fireEvent.click(within(sheet).getByText('T1 · Add a dark theme'));
    expect(location.search).toBe('?s=s1&w=changes&t=p1');
    fireEvent.click(await screen.findByText('theme.css'));
    await waitFor(() => expect(server.asked).toContain('turn p1 src/theme.css'));
    expect(location.search).toBe('?s=s1&w=changes&p=src%2Ftheme.css&t=p1');
    fireEvent.click(screen.getByRole('button', { name: 'Changes' }));
    await waitFor(() => expect(location.search).toBe('?s=s1&w=changes&t=p1'));
    fireEvent.click(await screen.findByText('Rewind code'));
    expect(onRewind).toHaveBeenCalledWith('p1');
  });

  it('lets Esc in a sheet opened from it close that sheet only', async () => {
    history.replaceState(null, '', '/?s=s1&w=changes');
    const onClose = vi.fn();
    wrap(<Workspace open cwd={CWD} sessionId="s1" onClose={onClose} onAddToMessage={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Show:/ }));
    const sheet = screen.getAllByRole('dialog').at(-1)!;
    fireEvent.keyDown(within(sheet).getAllByRole('button')[0]!, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('region', { name: 'Changes and files' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('on a phone, says at its foot that Claude waits for an answer, which leads back to the conversation', async () => {
    history.replaceState(null, '', '/?s=s1&w=changes');
    const onClose = vi.fn();
    wrap(<Workspace open cwd={CWD} sessionId="s1" needsYou="Claude wants to edit theme.css" onClose={onClose} onAddToMessage={() => {}} />);
    fireEvent.click(await screen.findByText('Claude wants to edit theme.css'));
    expect(onClose).toHaveBeenCalled();
    // What is behind the view takes nothing while it is open.
    expect(screen.getByRole('region', { name: 'Changes and files' }).closest('#root')).toBeNull();
  });
});

describe('a diff read again while it is open', () => {
  const DIFF = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n';

  it('says "No changes in this file" once its change is committed, and shows the lines when Claude edits it again', () => {
    const view = render(<UnifiedDiff diff={DIFF} path="src/a.ts" cwd={CWD} />);
    expect(screen.getByRole('group', { name: 'Changes to src/a.ts' })).toBeTruthy();
    view.rerender(<UnifiedDiff diff="" path="src/a.ts" cwd={CWD} />);
    expect(screen.getByText('No changes in this file')).toBeTruthy();
    view.rerender(<UnifiedDiff diff={DIFF} path="src/a.ts" cwd={CWD} />);
    expect(screen.getByText('const b = 3;', { exact: false })).toBeTruthy();
    view.rerender(<UnifiedDiff diff={'Binary files a/logo.png and b/logo.png differ\n'} path="src/a.ts" cwd={CWD} />);
    expect(screen.getByText('A binary file changed')).toBeTruthy();
  });

  it('in Changes, as when the window gets the focus back after a commit: the view stays and says so', async () => {
    server.diff = DIFF;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const errors: unknown[] = [];
    const onError = (event: ErrorEvent) => errors.push(event.error);
    window.addEventListener('error', onError);
    try {
      const status = { data: { repo: true as const, branch: 'main', files: [{ path: 'src/a.ts', status: 'modified' as const }] }, isLoading: false, isFetching: false, refetch: () => undefined };
      render(
        <QueryClientProvider client={client}>
          <WorkspaceChanges cwd={CWD} sessionId="s1" step={{ tab: 'changes', path: 'src/a.ts' }} looking busy={false} status={status} commentsIn={new Map()} go={() => {}} setScope={() => {}} />
        </QueryClientProvider>,
      );
      await screen.findByText('const b = 3;', { exact: false });
      server.diff = '';
      await act(() => client.refetchQueries({ queryKey: ['diff'] }));
      expect(await screen.findByText('No changes in this file')).toBeTruthy();
      server.diff = DIFF;
      await act(() => client.refetchQueries({ queryKey: ['diff'] }));
      expect(await screen.findByText('const b = 3;', { exact: false })).toBeTruthy();
    } finally {
      window.removeEventListener('error', onError);
    }
    expect(errors).toEqual([]);
  });
});
