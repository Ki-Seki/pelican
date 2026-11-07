// @vitest-environment jsdom
// Create PR as Claude Desktop sends it, read back: the request shows as /create-pr (or --draft), as
// Desktop shows it, and the pull request Claude names in Desktop's <pr-created> tag is a card, with
// its live status only where gh on the computer can read it.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ChatMessage, PrStatus } from '../src/shared/protocol';
import type { SessionView } from '../src/web/lib/store';

beforeAll(() => {
  Object.assign(window, { matchMedia: (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }) });
  Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
});

const { MessageList } = await import('../src/web/components/MessageList');
const { createPrRequest, COMMIT_REQUEST } = await import('../src/web/lib/requests');
const { api } = await import('../src/web/lib/api');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const at = Date.now() - 60_000;
const target = { repo: 'acme/web', branch: 'feat/dark-theme', baseBranch: 'main', cwd: '/code/acme-web' };

function conversation(messages: ChatMessage[]) {
  const view: SessionView = { messages, offset: 0, total: messages.length, loaded: true, loadingOlder: false };
  return render(<QueryClientProvider client={new QueryClient()}><MessageList sessionId="s" view={view} cwd="/code/acme-web" mode="normal" /></QueryClientProvider>);
}

const reply = (uuid: string, text: string, when: number): ChatMessage => ({ uuid, role: 'assistant', model: 'claude-opus-5-5', blocks: [{ type: 'text', text }], timestamp: when });
const prompt = (uuid: string, text: string, when: number): ChatMessage => ({ uuid, role: 'user', blocks: [{ type: 'text', text }], timestamp: when });

describe('a request sent from Changes, in the conversation', () => {
  it('shows Create PR as /create-pr and Create draft PR as /create-pr --draft, and Commit changes as its words', () => {
    vi.spyOn(api, 'pr').mockResolvedValue({ live: false });
    conversation([
      prompt('u1', COMMIT_REQUEST, at),
      reply('a1', 'Committed.', at + 1000),
      prompt('u2', createPrRequest({ ...target, draft: false }), at + 2000),
      reply('a2', 'Opening it.', at + 3000),
      prompt('u3', createPrRequest({ ...target, draft: true }), at + 4000),
    ]);
    expect(screen.getByText(COMMIT_REQUEST)).toBeTruthy();
    const ready = screen.getByText('/create-pr');
    expect(ready.closest('.font-mono')).not.toBeNull();
    expect(screen.getByText('/create-pr --draft')).toBeTruthy();
    // The request itself is not shown.
    expect(screen.queryByText(/## Overview/)).toBeNull();
  });
});

describe('requests Claude Code took in together, queued while Claude worked', () => {
  it('show as Desktop shows each part: Commit changes as its words, Create PR as /create-pr, never the request itself', () => {
    vi.spyOn(api, 'pr').mockResolvedValue({ live: false });
    // Claude Code read the two as one message, each its own block.
    const both: ChatMessage = { uuid: 'u1', role: 'user', blocks: [{ type: 'text', text: `${COMMIT_REQUEST}\n` }, { type: 'text', text: createPrRequest({ ...target, draft: true }) }], timestamp: at };
    conversation([both, reply('a1', 'Committed, and the draft is open.', at + 1000)]);
    const bubble = document.querySelector('[data-quote-from="u1"]') as HTMLElement;
    expect(bubble.textContent).toBe(`${COMMIT_REQUEST}\n\n/create-pr --draft`);
    expect(screen.queryByText(/## Overview/)).toBeNull();
    expect(screen.queryByText('Show all')).toBeNull();
  });
});

describe('the pull request Claude made', () => {
  const made = 'The pull request is open.\n<pr-created>https://github.com/acme/web/pull/128</pr-created>';

  it('is a card in place of Desktop’s tag, with View PR, naming the repository where gh says nothing', async () => {
    const asked = vi.spyOn(api, 'pr').mockResolvedValue({ live: false });
    conversation([prompt('u1', createPrRequest({ ...target, draft: false }), at), reply('a1', made, at + 1000)]);
    const card = document.querySelector('[data-pr-card]') as HTMLElement;
    expect(card).not.toBeNull();
    expect(within(card).getByText('#128')).toBeTruthy();
    expect(within(card).getByRole('link', { name: /View PR/ }).getAttribute('href')).toBe('https://github.com/acme/web/pull/128');
    await waitFor(() => expect(asked).toHaveBeenCalledWith('https://github.com/acme/web/pull/128'));
    expect(within(card).getByText('acme/web')).toBeTruthy();
    // The reply's words read as written, without the tag.
    expect(screen.getByText('The pull request is open.')).toBeTruthy();
    expect(document.body.textContent).not.toContain('<pr-created>');
  });

  it('on another host, even one made to look like GitHub’s, names the host and asks GitHub nothing', async () => {
    const asked = vi.spyOn(api, 'pr').mockResolvedValue({ live: true, number: 128, title: 'Not what it seems', state: 'open', draft: false });
    const url = 'https://github-com.pr-review.example/acme/acme-web/pull/128';
    conversation([reply('a1', `Opened.\n<pr-created>${url}</pr-created>`, at)]);
    const card = document.querySelector('[data-pr-card]') as HTMLElement;
    expect(card.querySelector('[data-pr-host]')?.textContent).toBe('github-com.pr-review.example/acme/acme-web');
    expect(within(card).getByRole('link', { name: /View PR/ }).getAttribute('href')).toBe(url);
    expect(within(card).getByText('#128')).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(asked).not.toHaveBeenCalled();
    expect(card.textContent).not.toContain('Not what it seems');
  });

  it('shows its live status where gh can read it: its title, open or a draft, its branches and its checks', async () => {
    const status: PrStatus = { live: true, number: 128, title: 'Add a dark theme to the settings page', state: 'open', draft: false, head: 'feat/dark-theme', base: 'main', checks: 'running' };
    vi.spyOn(api, 'pr').mockResolvedValue(status);
    const view = conversation([reply('a1', made, at)]);
    const card = document.querySelector('[data-pr-card]') as HTMLElement;
    await within(card).findByText('Add a dark theme to the settings page');
    expect(card.textContent).toContain('Open');
    expect(card.textContent).toContain('feat/dark-theme → main');
    expect(card.textContent).toContain('checks running');
    view.unmount();
    vi.spyOn(api, 'pr').mockResolvedValue({ ...status, draft: true, checks: 'failing' });
    conversation([reply('a1', made, at)]);
    const draft = document.querySelector('[data-pr-card]') as HTMLElement;
    await within(draft).findByText('Draft');
    expect(draft.textContent).toContain('checks failing');
  });
});
