// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { GitStatus, SessionChanges } from '../src/shared/protocol';

const CWD = '/code/app';
const server = vi.hoisted(() => ({ asked: [] as string[], diff: '', /** A folder git does not track, where no turn changed files. */ plain: false }));

vi.mock('../src/web/lib/api', async (original) => {
  const actual = await original<typeof import('../src/web/lib/api')>();
  // A branch with a commit of its own beyond main, and a file not committed yet; origin on GitHub.
  const status: GitStatus = { repo: true, branch: 'feat/x', base: 'main', split: true, remote: true, github: 'acme/app', files: [{ path: 'src/a.ts', status: 'modified', added: 1, removed: 1 }] };
  const since: GitStatus = { ...status, uncommitted: 1, files: [...status.files, { path: 'README.md', status: 'modified', added: 2, removed: 0, committed: true }] };
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
        if (server.plain) return { repo: false };
        return scope === 'base' ? since : status;
      },
      changes: async () => (server.plain ? { turns: [], lines: {} } : changes),
      gitDiff: async () => server.diff,
      turnDiff: async (_id: string, turn: string, path: string) => {
        server.asked.push(`turn ${turn} ${path}`);
        return `--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,1 @@\n+:root {}\n`;
      },
      tree: async () => (server.plain ? [{ name: 'notes.md', path: 'notes.md', dir: false, size: 30 }] : []),
      file: async (_cwd: string, path: string) => ({ path, size: 40, text: 'const a = 1;\nconst b = 2;\nconst c = 3;\n' }),
    },
  };
});

/** A computer's pointer (hover and fine), where a test asks for one; a finger otherwise. */
const media = { fine: false };
beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: media.fine && /hover: hover|pointer: fine/.test(query), media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
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
const { commentsOf, setComments, withComments } = await import('../src/web/lib/review');
const { SendComments } = await import('../src/web/components/Comments');
const { setWaiting, waitingOf } = await import('../src/web/lib/drafts');
const { COMMIT_REQUEST, createPrRequest } = await import('../src/web/lib/requests');
const { setPrefs } = await import('../src/web/lib/prefs');

afterEach(() => {
  cleanup();
  setComments(CWD, []);
  setWaiting(CWD, []);
  server.asked = [];
  server.diff = '';
  server.plain = false;
  history.replaceState(null, '', '/');
});

const wrap = (node: React.ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);
/** The tabs of Changes and files load when first shown, which takes longer on a busy machine. */
const LAZY = { timeout: 5000 };

describe('what Changes shows', () => {
  it('shows All changes vs main first, as Desktop names it, then Uncommitted changes and the turns under their own heading; a turn ends with its prompt’s Rewind to here', async () => {
    history.replaceState(null, '', '/?s=s1&w=changes');
    const onRewind = vi.fn();
    wrap(<Workspace open cwd={CWD} sessionId="s1" onRewind={onRewind} onClose={() => {}} onAddToMessage={() => {}} />);
    const show = await screen.findByRole('button', { name: /^Show:/ }, LAZY);
    expect(show.textContent).toBe('Show:All changesvs main');
    // All of it, by /diff's rule: the branch's commit too, the file not committed first.
    await waitFor(() => expect(screen.getAllByText(/^(a\.ts|README\.md)$/).map((name) => name.textContent)).toEqual(['a.ts', 'README.md']));
    fireEvent.click(show);
    const sheet = screen.getByRole('dialog', { name: 'Show' });
    const rows = within(sheet).getAllByRole('menuitemradio');
    expect(rows.map((row) => row.textContent)).toEqual(['All changesvs main', 'Uncommitted changes1 file', 'Fix the toggle1 file', 'Add a dark theme1 file']);
    expect(rows.map((row) => row.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false', 'false']);
    // The turns are Pelican's, under their own heading, the newest first.
    expect(within(sheet).getByText('Turns')).toBeTruthy();
    fireEvent.click(within(sheet).getByText('Uncommitted changes'));
    await waitFor(() => expect(location.search).toBe('?s=s1&w=changes&t=uncommitted'));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Show:/ }).textContent).toBe('Show:Uncommitted changes'));
    expect(server.asked).toContain('git ');
    await waitFor(() => expect(screen.queryByText('README.md')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: /^Show:/ }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Show' })).getByText('Add a dark theme'));
    await waitFor(() => expect(location.search).toBe('?s=s1&w=changes&t=p1'));
    fireEvent.click(await screen.findByText('theme.css'));
    await waitFor(() => expect(server.asked).toContain('turn p1 src/theme.css'));
    expect(location.search).toBe('?s=s1&w=changes&p=src%2Ftheme.css&t=p1');
    fireEvent.click(screen.getByRole('button', { name: 'Changes' }));
    await waitFor(() => expect(location.search).toBe('?s=s1&w=changes&t=p1'));
    fireEvent.click(await screen.findByRole('button', { name: 'Rewind to here' }));
    expect(onRewind).toHaveBeenCalledWith(expect.objectContaining({ uuid: 'p1', text: 'Add a dark theme' }));
  });

  it('lets Esc in a sheet opened from it close that sheet only', async () => {
    history.replaceState(null, '', '/?s=s1&w=changes');
    const onClose = vi.fn();
    wrap(<Workspace open cwd={CWD} sessionId="s1" onClose={onClose} onAddToMessage={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Show:/ }, LAZY));
    const sheet = screen.getByRole('dialog', { name: 'Show' });
    fireEvent.keyDown(within(sheet).getAllByRole('menuitemradio')[0]!, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('region', { name: 'Changes and files' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('in a folder git does not track, where no turn changed files: opens on Files, and Changes, tapped, says why it is empty', async () => {
    server.plain = true;
    history.replaceState(null, '', '/?s=s1&w=changes');
    wrap(<Workspace open cwd="/code/notes" sessionId="s1" onClose={() => {}} onAddToMessage={() => {}} />);
    await waitFor(() => expect(location.search).toBe('?s=s1&w=files'));
    await screen.findByText('notes.md', {}, LAZY);
    fireEvent.click(screen.getByRole('button', { name: 'Changes' }));
    expect(await screen.findByText('This folder is not a git repository', {}, LAZY)).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(location.search).toBe('?s=s1&w=changes');
    expect(screen.getByRole('button', { name: 'Changes' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('on a tablet with a keyboard: Esc puts away a comment being written on a file, and the next closes the view', async () => {
    history.replaceState(null, '', '/?s=s1&w=files&p=src%2Fa.ts');
    const onClose = vi.fn();
    wrap(<Workspace open cwd={CWD} sessionId="s1" onClose={onClose} onAddToMessage={() => {}} />);
    await waitFor(() => expect(document.querySelector('[data-line="2"]')).toBeTruthy(), LAZY);
    fireEvent.click(document.querySelector('[data-line="2"]')!);
    fireEvent.click(within(screen.getByRole('toolbar', { name: 'Picked lines' })).getByRole('button', { name: 'Add comment' }));
    const box = screen.getByLabelText('Comment for Claude');
    fireEvent.change(box, { target: { value: 'Rename b' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByLabelText('Comment for Claude')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    // The keys are back on the file's text, in the view, as they are on a diff.
    expect(document.activeElement).toBe(screen.getByRole('group', { name: 'The text of src/a.ts' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
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

describe('Commit changes and Create PR, at the foot of Changes', () => {
  const PR = { repo: 'acme/app', branch: 'feat/x', baseBranch: 'main', cwd: CWD };
  afterEach(() => setPrefs({ prKind: 'ready' }));

  it('send Desktop’s requests at once on a tap, and offer no Push', async () => {
    history.replaceState(null, '', '/?s=s1&w=changes');
    const onRequest = vi.fn();
    wrap(<Workspace open cwd={CWD} sessionId="s1" onRequest={onRequest} onClose={() => {}} onAddToMessage={() => {}} />);
    const commit = await screen.findByRole('button', { name: 'Commit changes' }, LAZY);
    // At the foot, after the files.
    const foot = commit.closest('[data-requests]')!;
    expect(screen.getByText('README.md').compareDocumentPosition(foot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(commit);
    expect(onRequest).toHaveBeenLastCalledWith(COMMIT_REQUEST, 'send');
    fireEvent.click(screen.getByRole('button', { name: 'Create PR' }));
    expect(onRequest).toHaveBeenLastCalledWith(createPrRequest({ ...PR, draft: false }), 'send');
    expect(screen.queryByRole('button', { name: /push/i })).toBeNull();
    expect(document.body.textContent).not.toMatch(/\bPush\b/);
  });

  it('put a request in the message box first on ⌘-click (Ctrl-click), and on a long press under a finger', async () => {
    history.replaceState(null, '', '/?s=s1&w=changes');
    const onRequest = vi.fn();
    wrap(<Workspace open cwd={CWD} sessionId="s1" onRequest={onRequest} onClose={() => {}} onAddToMessage={() => {}} />);
    const commit = await screen.findByRole('button', { name: 'Commit changes' }, LAZY);
    fireEvent.click(commit, { metaKey: true });
    expect(onRequest).toHaveBeenLastCalledWith(COMMIT_REQUEST, 'box');
    fireEvent.click(screen.getByRole('button', { name: 'Create PR' }), { ctrlKey: true });
    expect(onRequest).toHaveBeenLastCalledWith(createPrRequest({ ...PR, draft: false }), 'box');
    onRequest.mockClear();
    vi.useFakeTimers();
    try {
      fireEvent.pointerDown(commit, { pointerType: 'touch', isPrimary: true, pointerId: 4, clientX: 40, clientY: 40 });
      act(() => vi.advanceTimersByTime(510));
      fireEvent.pointerUp(commit, { pointerType: 'touch', isPrimary: true, pointerId: 4 });
      // The finger lifting is the press's, not a tap that would send it.
      fireEvent.click(commit);
    } finally {
      vi.useRealTimers();
    }
    expect(onRequest.mock.calls).toEqual([[COMMIT_REQUEST, 'box']]);
  });

  it('pick Create draft PR under Create PR’s ▾, remembered for the button, as Desktop does', async () => {
    history.replaceState(null, '', '/?s=s1&w=changes');
    const onRequest = vi.fn();
    wrap(<Workspace open cwd={CWD} sessionId="s1" onRequest={onRequest} onClose={() => {}} onAddToMessage={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create PR or Create draft PR' }, LAZY));
    const menu = screen.getByRole('dialog', { name: 'Create PR' });
    expect(within(menu).getAllByRole('menuitemradio').map((item) => [item.textContent, item.getAttribute('aria-checked')])).toEqual([['Create PR', 'true'], ['Create draft PR', 'false']]);
    // Picking one picks the button's kind; the button sends it.
    fireEvent.click(within(menu).getByText('Create draft PR'));
    expect(onRequest).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Create draft PR' }));
    expect(onRequest).toHaveBeenLastCalledWith(createPrRequest({ ...PR, draft: true }), 'send');
  });

  it('are not offered in a side chat, nor in a turn’s changes', async () => {
    history.replaceState(null, '', '/?s=s1&w=changes');
    const view = wrap(<Workspace open cwd={CWD} sessionId="s1" requests={false} onRequest={() => {}} onClose={() => {}} onAddToMessage={() => {}} />);
    await screen.findByText('README.md', {}, LAZY);
    expect(screen.queryByRole('button', { name: 'Commit changes' })).toBeNull();
    view.unmount();
    history.replaceState(null, '', '/?s=s1&w=changes&t=p1');
    wrap(<Workspace open cwd={CWD} sessionId="s1" onRequest={() => {}} onClose={() => {}} onAddToMessage={() => {}} />);
    await screen.findByText('theme.css', {}, LAZY);
    expect(screen.queryByRole('button', { name: 'Commit changes' })).toBeNull();
  });

  it('end the view with what waits on a phone, and with Send now alone beside the conversation', async () => {
    history.replaceState(null, '', '/?s=s1&w=changes');
    act(() => setComments(CWD, [{ id: 'c1', path: 'src/a.ts', kind: 'same', line: 2, code: 'const b = 2;', note: 'Rename b' }]));
    const client = new QueryClient();
    const at = (node: React.ReactNode) => <QueryClientProvider client={client}>{node}</QueryClientProvider>;
    const onSend = vi.fn();
    const view = render(at(<Workspace open cwd={CWD} sessionId="s1" onRequest={() => {}} onSendComments={onSend} onClose={() => {}} onAddToMessage={() => {}} />));
    await screen.findByRole('button', { name: 'Commit changes' }, LAZY);
    const send = screen.getByRole('button', { name: 'Send now' });
    expect(send.parentElement!.textContent).toBe('1 comment waits for your next messageSend now');
    // The requests are part of the list; what waits ends the view, under them.
    expect(screen.getByRole('button', { name: 'Commit changes' }).compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    view.rerender(at(<Workspace open docked cwd={CWD} sessionId="s1" onRequest={() => {}} onSendComments={onSend} onClose={() => {}} onAddToMessage={() => {}} />));
    const beside = await screen.findByRole('button', { name: 'Send now' });
    expect(beside.parentElement!.textContent).toMatch(/^Send now/);
    expect(beside.parentElement!.textContent).not.toContain('waits');
    expect(screen.getByRole('button', { name: 'Commit changes' })).toBeTruthy();
    fireEvent.click(beside);
    expect(onSend).toHaveBeenCalled();
  });
});

describe('a comment on a diff, in Desktop’s box', () => {
  // Lines 1 and 3 of the new file unchanged, line 2 changed: a removed line and an added one.
  const DIFF = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n const c = 4;\n';
  const row = (text: string) => screen.getByText(text, { exact: false }).closest('[data-row]') as HTMLElement;

  it('opens on a tap: Cancel · Send to Claude · Add comment, and Add comment adds it under its line', () => {
    const send = vi.fn();
    render(<SendComments.Provider value={send}><UnifiedDiff diff={DIFF} path="src/a.ts" cwd={CWD} /></SendComments.Provider>);
    fireEvent.click(row('const b = 3;'));
    const box = screen.getByLabelText('Comment for Claude').closest('form')!;
    expect(within(box).getAllByRole('button').map((button) => button.textContent)).toEqual(['Cancel', 'Send to Claude', 'Add comment']);
    fireEvent.change(within(box).getByLabelText('Comment for Claude'), { target: { value: 'Why 3?' } });
    fireEvent.click(within(box).getByRole('button', { name: 'Add comment' }));
    expect(commentsOf(CWD)).toMatchObject([{ path: 'src/a.ts', kind: 'add', line: 2, code: 'const b = 3;', note: 'Why 3?' }]);
    expect(send).not.toHaveBeenCalled();
    // Send to Claude adds it and sends everything that waits.
    fireEvent.click(screen.getByRole('button', { name: 'Add comment on line 1' }));
    fireEvent.change(screen.getByLabelText('Comment for Claude'), { target: { value: 'Keep a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to Claude' }));
    expect(commentsOf(CWD).map((c) => c.note)).toEqual(['Why 3?', 'Keep a']);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('under a finger, takes in the lines a long press drags over, on the new file, and shows under the last', () => {
    render(<UnifiedDiff diff={DIFF} path="src/a.ts" cwd={CWD} />);
    Object.assign(document, { elementFromPoint: () => row('const c = 4;') });
    vi.useFakeTimers();
    try {
      fireEvent.pointerDown(row('const a = 1;'), { pointerType: 'touch', isPrimary: true, pointerId: 5, clientX: 20, clientY: 5 });
      act(() => vi.advanceTimersByTime(510));
      fireEvent.pointerMove(row('const a = 1;'), { pointerType: 'touch', pointerId: 5, clientX: 20, clientY: 80 });
      fireEvent.pointerUp(row('const a = 1;'), { pointerType: 'touch', pointerId: 5 });
    } finally {
      vi.useRealTimers();
      Object.assign(document, { elementFromPoint: undefined });
    }
    fireEvent.change(screen.getByLabelText('Comment for Claude'), { target: { value: 'One block' } });
    fireEvent.submit(screen.getByLabelText('Comment for Claude').closest('form')!);
    // The removed line is not the new file's: lines 1 to 3 as they read now.
    expect(commentsOf(CWD)).toMatchObject([{ kind: 'add', line: 1, to: 3, code: 'const a = 1;\nconst b = 3;\nconst c = 4;', note: 'One block' }]);
    expect(row('const c = 4;').parentElement!.textContent).toContain('One block');
  });

  it('on removed lines alone is Desktop’s "before changes"; a right-click offers Copy and Add comment', () => {
    media.fine = true;
    try {
      render(<UnifiedDiff diff={DIFF} path="src/a.ts" cwd={CWD} />);
      fireEvent.contextMenu(row('const b = 2;'), { clientX: 10, clientY: 10 });
      const menu = screen.getByRole('menu', { name: 'Lines' });
      expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Copy', 'Add comment']);
      fireEvent.click(within(menu).getByText('Add comment'));
      fireEvent.change(screen.getByLabelText('Comment for Claude'), { target: { value: 'Was 2' } });
      fireEvent.submit(screen.getByLabelText('Comment for Claude').closest('form')!);
      expect(commentsOf(CWD)).toMatchObject([{ kind: 'del', line: 2, code: 'const b = 2;' }]);
      expect(withComments('', commentsOf(CWD))).toMatch(/^In `src\/a\.ts` at line 2 \(before changes\):/);
    } finally {
      media.fine = false;
    }
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

  it('says a file renamed whole was renamed from its old path, unchanged, rather than show git’s header', () => {
    // As git writes it, the new name quoted for its quotes.
    const renamed = 'diff --git a/src/old.ts "b/src/new \\"name\\".ts"\nsimilarity index 100%\nrename from src/old.ts\nrename to "src/new \\"name\\".ts"\n';
    const view = render(<UnifiedDiff diff={renamed} path={'src/new "name".ts'} cwd={CWD} />);
    expect(screen.getByText('Renamed from src/old.ts, unchanged')).toBeTruthy();
    expect(screen.queryByText(/similarity index/)).toBeNull();
    view.rerender(<UnifiedDiff diff={'diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n'} path="run.sh" cwd={CWD} />);
    expect(screen.getByText('Made executable')).toBeTruthy();
    view.rerender(<UnifiedDiff diff={'diff --git a/tab\\there b/x\nsimilarity index 100%\nrename from "tab\\there"\nrename to x\nold mode 100755\nnew mode 100644\n'} path="x" cwd={CWD} />);
    // A name git writes with escapes, read back as it is (a tab in it, here).
    expect(screen.getByText('Renamed from tab\there, and no longer executable', { normalizer: (text) => text })).toBeTruthy();
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

describe('quoting inside the view', () => {
  it('on a phone opens the quote in place, for a note; added, it waits, the view stays and its foot says so', async () => {
    history.replaceState(null, '', '/?s=s1&w=files&p=src%2Fa.ts');
    const onClose = vi.fn();
    const onSendNow = vi.fn();
    wrap(<Workspace open cwd={CWD} sessionId="s1" onClose={onClose} onSendNow={onSendNow} onSendComments={() => {}} onAddToMessage={() => {}} />);
    await waitFor(() => expect(document.querySelector('[data-line="2"]')).toBeTruthy(), LAZY);
    fireEvent.click(document.querySelector('[data-line="2"]')!);
    fireEvent.click(within(screen.getByRole('toolbar', { name: 'Picked lines' })).getByRole('button', { name: 'Quote' }));
    const sheet = screen.getByRole('dialog', { name: 'Quote · a.ts:2' });
    expect(sheet.textContent).toContain('const b = 2;');
    // The keyboard comes up only once Add a note is tapped; Send now needs a note.
    expect(within(sheet).queryByLabelText('Your note')).toBeNull();
    expect((within(sheet).getByRole('button', { name: 'Send now' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add a note' }));
    fireEvent.change(within(sheet).getByLabelText('Your note'), { target: { value: 'Why 2?' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add' }));
    expect(waitingOf(CWD)).toMatchObject([{ kind: 'quote', text: 'const b = 2;', note: 'Why 2?', path: 'src/a.ts', lines: [2, 2] }]);
    expect(onClose).not.toHaveBeenCalled();
    const foot = screen.getAllByRole('button', { name: 'Send now' }).find((button) => !button.closest('dialog'))!;
    expect(foot.parentElement!.textContent).toBe('1 quote waits for your next messageSend now');
    // Send now sends one at once, with its note.
    fireEvent.click(document.querySelector('[data-line="3"]')!);
    fireEvent.click(within(screen.getByRole('toolbar', { name: 'Picked lines' })).getByRole('button', { name: 'Quote' }));
    const next = screen.getByRole('dialog', { name: 'Quote · a.ts:3' });
    fireEvent.click(within(next).getByRole('button', { name: 'Add a note' }));
    fireEvent.change(within(next).getByLabelText('Your note'), { target: { value: 'And 3?' } });
    fireEvent.click(within(next).getByRole('button', { name: 'Send now' }));
    expect(onSendNow).toHaveBeenCalledWith(expect.objectContaining({ text: 'const c = 3;', note: 'And 3?', path: 'src/a.ts', lines: [3, 3] }));
    setWaiting(CWD, []);
  });

  it('beside the conversation quotes at once, as Desktop’s Attach as context, with no sheet', async () => {
    history.replaceState(null, '', '/?s=s1&w=files&p=src%2Fa.ts');
    wrap(<Workspace open docked cwd={CWD} sessionId="s1" onClose={() => {}} onSendNow={() => {}} onAddToMessage={() => {}} />);
    await waitFor(() => expect(document.querySelector('[data-line="2"]')).toBeTruthy(), LAZY);
    fireEvent.click(document.querySelector('[data-line="1"]')!);
    fireEvent.click(document.querySelector('[data-line="2"]')!, { shiftKey: true });
    fireEvent.click(within(screen.getByRole('toolbar', { name: 'Picked lines' })).getByRole('button', { name: 'Quote' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(waitingOf(CWD)).toMatchObject([{ kind: 'quote', text: 'const a = 1;\nconst b = 2;', path: 'src/a.ts', lines: [1, 2] }]);
    setWaiting(CWD, []);
  });

  it('has the file’s path menu under ⋯ beside its name, as everywhere a path is', async () => {
    history.replaceState(null, '', '/?s=s1&w=files&p=src%2Fa.ts');
    wrap(<Workspace open cwd={CWD} sessionId="s1" onClose={() => {}} onAddToMessage={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'More for a.ts' }, LAZY));
    const menu = screen.getByRole('dialog', { name: 'a.ts' });
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Attach as context', 'Copy', 'Open in Changes', 'Download file']);
    fireEvent.click(within(menu).getByText('Attach as context'));
    expect(waitingOf(CWD)).toMatchObject([{ kind: 'file', path: 'src/a.ts' }]);
    setWaiting(CWD, []);
  });
});

describe('a file’s Quote and Copy', () => {
  /** Padded at least as deep as the home indicator, where there is one: 0 on a computer. */
  const clear = (row: Element) => /\bpb-safe\b|env\(safe-area-inset-bottom\)/.test(row.className);
  function select(from: number, to: number) {
    const first = document.querySelector(`[data-line="${from}"]`)!;
    const last = document.querySelector(`[data-line="${to}"]`)!;
    const range = document.createRange();
    range.setStart(first.lastChild!, 0);
    range.setEnd(last.lastChild!, 1);
    act(() => {
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
  }

  it('sit in a row of their own under what scrolls, the lowest of a phone’s view clear of the home indicator', async () => {
    history.replaceState(null, '', '/?s=s1&w=files&p=src%2Fa.ts');
    const view = wrap(<Workspace open cwd={CWD} sessionId="s1" onClose={() => {}} onAddToMessage={() => {}} />);
    await waitFor(() => expect(document.querySelector('[data-line="2"]')).toBeTruthy(), LAZY);
    select(1, 2);
    const bar = (await screen.findByRole('button', { name: 'Quote' })).closest('[data-lines-bar]')!;
    expect(bar.textContent).toContain('Lines 1–2');
    expect(bar.closest('.overflow-y-auto')).toBeNull();
    expect(bar.closest('[role="region"]')).toBe(screen.getByRole('region', { name: 'Changes and files' }));
    expect(clear(bar)).toBe(true);
    // Below it, the bar saying Claude waits is the lowest row, and keeps clear itself.
    view.rerender(<QueryClientProvider client={new QueryClient()}><Workspace open cwd={CWD} sessionId="s1" needsYou="Claude wants to run npm test" onClose={() => {}} onAddToMessage={() => {}} /></QueryClientProvider>);
    await waitFor(() => expect(document.querySelector('[data-line="2"]')).toBeTruthy());
    select(1, 2);
    const under = (await screen.findByRole('button', { name: 'Quote' })).closest('[data-lines-bar]')!;
    expect(clear(under)).toBe(false);
    expect(clear(screen.getByText('Claude wants to run npm test').closest('button')!)).toBe(true);
  });

  it('end as far above the edge as the view’s other lowest rows, 8px where there is no home indicator, on a phone and beside the conversation alike', async () => {
    /** How far above the edge a row ends with no home indicator: pb-safe's 8px at least, or a floor of its own. */
    const floor = (row: Element) => (row.classList.contains('pb-safe') ? '8px' : /pb-\[max\(0\.375rem,env\(safe-area-inset-bottom\)\)\]/.test(row.className) ? '6px' : 'none');
    history.replaceState(null, '', '/?s=s1&w=files&p=src%2Fa.ts');
    const client = new QueryClient();
    const at = (node: React.ReactNode) => <QueryClientProvider client={client}>{node}</QueryClientProvider>;
    const view = render(at(<Workspace open cwd={CWD} sessionId="s1" onClose={() => {}} onAddToMessage={() => {}} onSendComments={() => {}} />));
    await waitFor(() => expect(document.querySelector('[data-line="2"]')).toBeTruthy(), LAZY);
    select(1, 2);
    expect(floor((await screen.findByRole('button', { name: 'Quote' })).closest('[data-lines-bar]')!)).toBe('8px');
    // The view's other lowest rows: the comments, with Send now, and the bar saying Claude waits.
    act(() => setComments(CWD, [{ id: 'c1', path: 'src/a.ts', kind: 'same', line: 2, code: 'const b = 2;', note: 'Rename b' }]));
    expect(floor(screen.getByRole('button', { name: 'Send now' }).parentElement!)).toBe('8px');
    act(() => setComments(CWD, []));
    view.rerender(at(<Workspace open cwd={CWD} sessionId="s1" needsYou="Claude wants to run npm test" onClose={() => {}} onAddToMessage={() => {}} />));
    expect(floor(screen.getByText('Claude wants to run npm test').closest('button')!)).toBe('8px');
    // Beside the conversation on a computer, level with Send now and the message boxes (which end
    // 8px above the edge too), not 2px lower.
    view.rerender(at(<Workspace open docked cwd={CWD} sessionId="s1" onClose={() => {}} onAddToMessage={() => {}} onSendComments={() => {}} />));
    await waitFor(() => expect(document.querySelector('[data-line="2"]')).toBeTruthy());
    select(1, 2);
    expect(floor((await screen.findByRole('button', { name: 'Quote' })).closest('[data-lines-bar]')!)).toBe('8px');
    act(() => setComments(CWD, [{ id: 'c1', path: 'src/a.ts', kind: 'same', line: 2, code: 'const b = 2;', note: 'Rename b' }]));
    expect(floor(screen.getByRole('button', { name: 'Send now' }).parentElement!)).toBe('8px');
    act(() => setComments(CWD, []));
  });

  it('beside the conversation, on a tablet, keep clear of the home indicator as on a phone, as do Send now and the end of what scrolls', async () => {
    history.replaceState(null, '', '/?s=s1&w=files&p=src%2Fa.ts');
    const at = (node: React.ReactNode) => <QueryClientProvider client={client}>{node}</QueryClientProvider>;
    const client = new QueryClient();
    const view = render(at(<Workspace open docked cwd={CWD} sessionId="s1" needsYou="Claude wants to run npm test" onClose={() => {}} onAddToMessage={() => {}} onSendComments={() => {}} />));
    await waitFor(() => expect(document.querySelector('[data-line="2"]')).toBeTruthy(), LAZY);
    const pane = screen.getByRole('complementary', { name: 'Changes and files' });
    expect(clear(pane.querySelector('.overflow-y-auto')!)).toBe(true);
    // The conversation beside it says Claude waits: the selection's row is the pane's lowest.
    select(1, 2);
    const bar = (await screen.findByRole('button', { name: 'Quote' })).closest('[data-lines-bar]')!;
    expect(bar.closest('aside')).toBe(pane);
    expect(clear(bar)).toBe(true);
    // Comments waiting: their row, with Send now, is the lowest.
    act(() => setComments(CWD, [{ id: 'c1', path: 'src/a.ts', kind: 'same', line: 2, code: 'const b = 2;', note: 'Rename b' }]));
    view.rerender(at(<Workspace open docked cwd={CWD} sessionId="s1" onClose={() => {}} onAddToMessage={() => {}} onSendComments={() => {}} />));
    expect(clear(screen.getByRole('button', { name: 'Send now' }).parentElement!)).toBe(true);
    select(1, 2);
    expect(clear((await screen.findByRole('button', { name: 'Quote' })).closest('[data-lines-bar]')!)).toBe(false);
  });
});

describe('a phone on its side', () => {
  it('folds the view’s header and tabs, and the terminal’s, away from its screen until a tap on it; typing in its line folds them again', async () => {
    history.replaceState(null, '', '/?s=s1&w=files');
    wrap(<Workspace open cwd={CWD} sessionId="s1" onClose={() => {}} onAddToMessage={() => {}} />);
    const view = await screen.findByRole('region', { name: 'Changes and files' });
    // What folds is marked (styles.css folds it, on the Terminal tab of a phone on its side).
    expect(view.getAttribute('data-tab')).toBe('files');
    expect(view.querySelectorAll('[data-makes-room="short"]').length).toBeGreaterThan(0);
    const shown = document.createElement('div');
    shown.setAttribute('data-terminal', '');
    const line = document.createElement('input');
    line.setAttribute('data-terminal-line', '');
    view.append(shown, line);
    const touch = (pointerId: number, from: [number, number], to: [number, number]) => {
      fireEvent.pointerDown(shown, { pointerType: 'touch', pointerId, clientX: from[0], clientY: from[1] });
      fireEvent.pointerUp(shown, { pointerType: 'touch', pointerId, clientX: to[0], clientY: to[1] });
    };
    expect(view.hasAttribute('data-unfolded')).toBe(false);
    touch(1, [50, 50], [52, 51]);
    expect(view.hasAttribute('data-unfolded')).toBe(true);
    // A swipe through the output is no tap.
    touch(2, [50, 50], [50, 150]);
    expect(view.hasAttribute('data-unfolded')).toBe(true);
    fireEvent.focusIn(line);
    expect(view.hasAttribute('data-unfolded')).toBe(false);
    touch(3, [60, 60], [60, 60]);
    expect(view.hasAttribute('data-unfolded')).toBe(true);
    touch(4, [60, 60], [60, 60]);
    expect(view.hasAttribute('data-unfolded')).toBe(false);
  });

  it('lets the tap that shows them land on none of them, nor a tap made at once: Files, Changes, End', async () => {
    history.replaceState(null, '', '/?s=s1&w=files');
    // Laid out as styles.css folds them: the rows that make room are on screen once unfolded.
    vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
      const folded = this.closest('[data-makes-room="short"]') && !this.closest('[data-workspace]')?.hasAttribute('data-unfolded');
      return (folded ? [] : [{}]) as unknown as DOMRectList;
    });
    let clock = 5000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    try {
      wrap(<Workspace open cwd={CWD} sessionId="s1" onClose={() => {}} onAddToMessage={() => {}} />);
      const view = await screen.findByRole('region', { name: 'Changes and files' });
      const shown = document.createElement('div');
      shown.setAttribute('data-terminal', '');
      view.append(shown);
      const changes = await screen.findByRole('button', { name: /^Changes/ });
      const tab = () => new URLSearchParams(location.search).get('w');
      // A tap on the screen shows the tabs; its click lands where Changes now is, and is not taken.
      fireEvent.pointerDown(shown, { pointerType: 'touch', pointerId: 1, clientX: 50, clientY: 50 });
      fireEvent.pointerUp(shown, { pointerType: 'touch', pointerId: 1, clientX: 50, clientY: 50 });
      expect(view.hasAttribute('data-unfolded')).toBe(true);
      expect(view.hasAttribute('data-settling')).toBe(true);
      fireEvent.click(changes, { detail: 1 });
      expect(tab()).toBe('files');
      // Nor is a tap a moment later.
      clock += 200;
      fireEvent.pointerDown(changes, { pointerType: 'touch', pointerId: 2 });
      fireEvent.click(changes, { detail: 1 });
      expect(tab()).toBe('files');
      // Once they have been on screen for a moment, a tap is theirs.
      clock += 600;
      fireEvent.pointerDown(changes, { pointerType: 'touch', pointerId: 3 });
      fireEvent.click(changes, { detail: 1 });
      expect(tab()).toBe('changes');
    } finally {
      vi.restoreAllMocks();
    }
  });
});
