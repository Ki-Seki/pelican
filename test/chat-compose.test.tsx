// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Attachment, RunState, SessionSummary } from '../src/shared/protocol';

const SESSION = '33333333-2222-4333-8444-555555555555';
const CREATED = '44444444-2222-4333-8444-555555555555';
const CWD = '/code/app';

/** What the computer answers, as each test sets it. */
const server = vi.hoisted(() => ({
  /** Each send's answer in turn: an error it fails with, or nothing for one that goes through. */
  answers: [] as Array<Error | undefined>,
  sent: [] as Array<{ text: string; attachments: string[]; trust?: string }>,
  session: {} as Partial<SessionSummary>,
  run: null as RunState | null,
}));

vi.mock('../src/web/lib/api', async (original) => {
  const actual = await original<typeof import('../src/web/lib/api')>();
  const answer = async (body: { text: string; attachments: string[]; trust?: string }) => {
    server.sent.push(body);
    const failure = server.answers.shift();
    if (failure) throw failure;
  };
  return {
    ...actual,
    api: {
      ...actual.api,
      models: async () => ({ models: [], signedIn: true }),
      usage: async () => [],
      defaults: async () => ({ permissionMode: null }),
      completions: async () => ({ commands: [], agents: [] }),
      git: async () => ({ repo: false }),
      session: async (id: string) => ({
        session: { id, title: 'Clean up the build', cwd: CWD, project: 'app', lastActivity: Date.now() - 60_000, status: 'idle', ...server.session },
        run: server.run,
        tasks: [],
        settings: {},
      }),
      messages: async () => ({ messages: [{ uuid: 'u1', role: 'user', blocks: [{ type: 'text', text: 'Clean up the build' }], timestamp: Date.now() - 60_000 }], total: 1, offset: 0 }),
      send: async (_id: string, body: { text: string; attachments: string[]; trust?: string }) => {
        await answer(body);
        return { sessionId: SESSION };
      },
      create: async (body: { text: string; attachments: string[]; trust?: string }) => {
        await answer(body);
        return { sessionId: CREATED };
      },
      upload: async (file: File): Promise<Attachment> => ({ id: `up-${file.name}`, name: file.name, mime: file.type || 'text/plain', size: file.size, path: `/tmp/${file.name}` }),
    },
  };
});

let media: Record<string, boolean> = {};
beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: Boolean(media[query]), media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
  // jsdom has the element, not its modal behaviour. As in a browser: close fires its event later,
  // as a task of its own, and behind an open modal dialog, or in an inert one, nothing takes focus.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    setTimeout(() => this.dispatchEvent(new Event('close')), 0);
  };
  const focus = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function focusUnlessInert(this: HTMLElement, options?: FocusOptions) {
    const top = [...document.querySelectorAll('dialog[open]')].at(-1);
    if (this.closest('[inert]') || (top && !top.contains(this))) return;
    focus.call(this, options);
  };
});

const { ApiError } = await import('../src/web/lib/api');
const { Chat } = await import('../src/web/components/Chat');

afterEach(() => {
  cleanup();
  localStorage.clear();
  media = {};
  Object.assign(server, { answers: [], sent: [], session: {}, run: null });
});

const wrap = (node: React.ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);
const session = () => wrap(<Chat sessionId={SESSION} home="/home/me" machine="studio" demo wide onBack={() => {}} onOpen={() => {}} onStartIn={() => {}} />);
const fresh = () => wrap(<Chat newCwd={CWD} home="/home/me" machine="studio" wide onBack={() => {}} onOpen={() => {}} onStartIn={() => {}} />);
const box = () => screen.getByLabelText('Message Claude') as HTMLTextAreaElement;
const loaded = () => screen.findAllByText('Clean up the build');
const untrusted = () => new ApiError('Trust this folder before Claude Code starts in it.', 409, false, { brings: ['hooks: PreToolUse (.claude/settings.json)'] });

function sendText(text: string) {
  fireEvent.change(box(), { target: { value: text } });
  fireEvent.keyDown(box(), { key: 'Enter', keyCode: 13 });
}

describe('opening a chat', () => {
  it('puts the keys in the message box on a computer', async () => {
    media['(hover: hover) and (pointer: fine)'] = true;
    session();
    await loaded();
    expect(document.activeElement).toBe(box());
  });

  it('on a phone, raises no keyboard over a session opened to read; a new session opens ready to type', async () => {
    session();
    await loaded();
    expect(document.activeElement).not.toBe(box());
    cleanup();
    fresh();
    expect(document.activeElement).toBe(box());
  });
});

describe('a folder nobody trusted', () => {
  it('starts Claude once, however often Trust and start is tapped', async () => {
    server.answers.push(untrusted());
    session();
    await loaded();
    sendText('Run the tests');
    const option = await screen.findByText('Trust and start');
    fireEvent.click(option);
    // The second tap of a double tap, on the sheet on its way out.
    fireEvent.click(option);
    await waitFor(() => expect(server.sent).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(server.sent.map((body) => body.trust)).toEqual([undefined, 'trusted']);
  });
});
