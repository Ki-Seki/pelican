// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ChatMessage, GitStatus, SessionSummary } from '../src/shared/protocol';
import type { SessionView } from '../src/web/lib/store';

// Chinese, Japanese and Korean are typed through an input method, and its Esc cancels the word
// being put together. Browsers send that Esc to the page too, marked as the input method's
// (isComposing, and keyCode 229 in Safari): it must not close or clear what is being written.
const IME_ESCAPES = [{ key: 'Escape', isComposing: true }, { key: 'Escape', keyCode: 229 }];

vi.mock('../src/web/lib/api', async (original) => {
  const actual = await original<typeof import('../src/web/lib/api')>();
  const session: SessionSummary = { id: 's1', title: 'Fix the login test', cwd: '/code/app', project: 'app', lastActivity: Date.now() - 60_000, status: 'idle' };
  return {
    ...actual,
    api: {
      ...actual.api,
      sessions: async () => [session],
      completions: async () => ({ commands: [{ name: 'review', description: 'Review the changes', argumentHint: '' }], agents: [] }),
      git: async (): Promise<GitStatus> => ({ repo: true, branch: 'main', files: [{ path: 'src/theme.css', status: 'modified', added: 1, removed: 0 }] }),
      gitDiff: async () => 'diff --git a/src/theme.css b/src/theme.css\n--- a/src/theme.css\n+++ b/src/theme.css\n@@ -1,2 +1,3 @@\n :root {\n+  --bg: #0b0b0c;\n }\n',
    },
  };
});

beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  Object.assign(globalThis, {
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
  });
});

const { Composer } = await import('../src/web/components/Composer');
const { MessageList } = await import('../src/web/components/MessageList');
const { SessionList } = await import('../src/web/components/SessionList');
const { Workspace } = await import('../src/web/components/Workspace');

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const wrap = (node: React.ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);
/** The tabs of Changes and files load when first shown, which takes longer on a busy machine. */
const LAZY = { timeout: 5000 };
const imeEscapes = (el: Element) => {
  for (const key of IME_ESCAPES) fireEvent.keyDown(el, key);
};

describe('the Esc of an input method', () => {
  it('leaves a line comment in Changes open, with what was written', async () => {
    wrap(<Workspace open docked cwd="/code/app" onClose={() => {}} onAddToMessage={() => {}} />);
    fireEvent.click(await screen.findByText('theme.css', {}, LAZY));
    fireEvent.click(await screen.findByText('--bg: #0b0b0c;', { exact: false }));
    const box = screen.getByLabelText('Comment for Claude');
    fireEvent.change(box, { target: { value: '変数を使って' } });
    imeEscapes(box);
    expect((screen.getByLabelText('Comment for Claude') as HTMLTextAreaElement).value).toBe('変数を使って');
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByLabelText('Comment for Claude')).toBeNull();
  });

  it('leaves a prompt being edited open', () => {
    const messages: ChatMessage[] = [
      { uuid: 'u1', role: 'user', blocks: [{ type: 'text', text: 'Add a dark theme' }], timestamp: Date.now() - 60_000 },
      { uuid: 'a1', role: 'assistant', blocks: [{ type: 'text', text: 'Done.' }], timestamp: Date.now() - 50_000 },
    ];
    const view: SessionView = { messages, offset: 0, total: 2, loaded: true, loadingOlder: false };
    render(<MessageList sessionId="s1" view={view} mode="normal" onEdit={async () => true} />);
    // Edit is in the prompt's menu, until Rewind to here gives its words back to the box.
    HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) { this.setAttribute('open', ''); };
    HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) { this.removeAttribute('open'); };
    fireEvent.contextMenu(screen.getByText('Add a dark theme'));
    fireEvent.click(within(screen.getByRole('menu', { name: 'Your message' })).getByRole('menuitem', { name: 'Edit' }));
    const editor = screen.getByLabelText('Edit the prompt');
    imeEscapes(editor);
    expect(screen.getByLabelText('Edit the prompt')).toBe(editor);
    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(screen.queryByLabelText('Edit the prompt')).toBeNull();
  });

  it('leaves the session search as it is', async () => {
    wrap(<SessionList machine="studio" onOpen={() => {}} onNew={() => {}} onSettings={() => {}} connected />);
    const search = screen.getByLabelText('Search sessions') as HTMLInputElement;
    fireEvent.change(search, { target: { value: 'ログイン' } });
    imeEscapes(search);
    expect(search.value).toBe('ログイン');
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(search.value).toBe('');
  });

  it('leaves the list of / commands open', async () => {
    wrap(<Composer busy={false} settings={{}} onSettings={() => {}} models={[]} onSend={() => {}} onStop={() => {}} cwd="/code/app" />);
    const box = screen.getByLabelText('Message Claude');
    fireEvent.change(box, { target: { value: '/re' } });
    expect(await screen.findByRole('option', { name: /\/review/ })).toBeTruthy();
    imeEscapes(box);
    expect(screen.getByRole('listbox', { name: 'Commands' })).toBeTruthy();
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByRole('listbox', { name: 'Commands' })).toBeNull();
  });
});
