// @vitest-environment jsdom
// Rewind to here and Fork from here on the page, as Claude Desktop has them: its dialog, with the
// three choices only when files changed after the message; one tap when none did; Undo rewind at
// the "Rewound here" marker, until the next message; /rewind, which asks which message; and Fork
// from here, whose new session's box has the prompt's words and files.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Attachment, ChatMessage, RecordedSettings, RewindCheck, RewindDone, RewindRestore, Rewound, RunState } from '../src/shared/protocol';

const SESSION = '33333333-2222-4333-8444-555555555555';
const FORKED = '44444444-2222-4333-8444-555555555555';
const CWD = '/code/acme-web';
const at = Date.now() - 600_000;
const FILE: Attachment = { id: 'up-1', name: 'notes.md', mime: 'text/markdown', size: 12, path: '/uploads/up-1/notes.md' };

/** What the computer answers, as each test sets it. */
const server = vi.hoisted(() => ({
  check: undefined as RewindCheck | undefined,
  /** Holds Claude Code's check until it settles: a Claude that has to start first. */
  hold: undefined as Promise<void> | undefined,
  rewinds: [] as Array<[string, RewindRestore]>,
  undos: 0,
  rewound: undefined as Rewound | undefined,
  run: null as RunState | null,
  /** What the session's last turn ran with, by its transcript. */
  recorded: {} as RecordedSettings,
  failure: undefined as Error | undefined,
  /** What each check carried as the folder's trust, and whether the folder still waits for an answer. */
  checks: [] as Array<string | undefined>,
  untrusted: false,
}));

const conversation = (): ChatMessage[] => [
  { uuid: 'u1', role: 'user', blocks: [{ type: 'text', text: 'Add a dark theme to the settings page' }], timestamp: at },
  { uuid: 'a1', role: 'assistant', model: 'claude-opus-5-5', blocks: [{ type: 'text', text: 'Done. The toggle sits under Display.' }], timestamp: at + 1000 },
  { uuid: 'u2', role: 'user', blocks: [{ type: 'text', text: 'Now remember the choice' }], timestamp: at + 2000 },
  { uuid: 'a2', role: 'assistant', model: 'claude-opus-5-5', blocks: [{ type: 'text', text: 'It stays after a reload now.' }], timestamp: at + 3000 },
];

vi.mock('../src/web/lib/api', async (original) => {
  const actual = await original<typeof import('../src/web/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      models: async () => ({ models: [], signedIn: true }),
      usage: async () => [],
      defaults: async () => (await import('./start-defaults')).BUILT_IN,
      completions: async () => ({ commands: [], agents: [] }),
      git: async () => ({ repo: false }),
      changes: async () => ({ turns: [], lines: {} }),
      session: async (id: string) => ({
        session: { id, title: 'Add a dark theme to the settings page', cwd: CWD, project: 'acme-web', lastActivity: at + 3000, status: 'idle' },
        run: server.run,
        tasks: [],
        settings: server.recorded,
      }),
      messages: async () => {
        const all = conversation();
        const cut = server.rewound ? all.findIndex((m) => m.uuid === server.rewound!.prompt) : -1;
        const messages = cut < 0 ? all : all.slice(0, cut);
        return { messages, total: messages.length, offset: 0, ...(server.rewound ? { rewound: server.rewound } : {}) };
      },
      rewindCheck: async (_id: string, _uuid: string, trust?: string) => {
        server.checks.push(trust);
        await server.hold;
        if (server.untrusted && !trust) throw new actual.ApiError('Trust this folder before Claude Code starts in it.', 409, false, { brings: ['hooks: SessionStart (.claude/settings.json)'] });
        if (server.failure) throw server.failure;
        return server.check!;
      },
      rewind: async (_id: string, uuid: string, restore: RewindRestore): Promise<RewindDone> => {
        server.rewinds.push([uuid, restore]);
        const code = restore === 'conversation' ? {} : { files: server.check!.files, insertions: server.check!.insertions, deletions: server.check!.deletions };
        if (restore === 'code') return code;
        server.rewound = { prompt: uuid, at: Date.now() };
        const words = conversation().find((m) => m.uuid === uuid)!.blocks[0]!;
        return { ...code, prompt: { text: words.type === 'text' ? words.text : '', attachments: [] } };
      },
      undoRewind: async () => {
        server.undos += 1;
        server.rewound = undefined;
        return { ok: true };
      },
      forkBefore: async (_id: string, before: string) => ({
        sessionId: before === 'u1' ? null : FORKED,
        prompt: { text: `<!-- reply 1 -->\n> The toggle sits under Display.\n\nKeep it there\n\n\n${before === 'u1' ? 'Add a dark theme to the settings page' : 'Now remember the choice'}`, attachments: [FILE] },
      }),
    },
  };
});

let media: Record<string, boolean> = {};
beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: Boolean(media[query]), media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    setTimeout(() => this.dispatchEvent(new Event('close')), 0);
  };
});

const { Chat } = await import('../src/web/components/Chat');
const { loadDraft, saveDraft, waitingOf, setWaiting } = await import('../src/web/lib/drafts');
const { CommandMenu, showCommandMenu } = await import('../src/web/components/CommandMenu');
const { setRun } = await import('../src/web/lib/store');

afterEach(async () => {
  cleanup();
  setRun(SESSION, undefined);
  localStorage.clear();
  setWaiting(SESSION, []);
  setWaiting(FORKED, []);
  media = {};
  Object.assign(server, { check: undefined, hold: undefined, rewinds: [], undos: 0, rewound: undefined, run: null, recorded: {}, failure: undefined, checks: [], untrusted: false });
  await new Promise((resolve) => setTimeout(resolve, 0));
  history.replaceState(null, '', '/');
});

const onOpen = vi.fn();
const onStartIn = vi.fn();
const open = () => render(
  <QueryClientProvider client={new QueryClient()}>
    <Chat sessionId={SESSION} home="/home/me" machine="studio" wide onBack={() => {}} onOpen={onOpen} onStartIn={onStartIn} />
    <CommandMenu sessions={[]} onOpenSession={() => {}} />
  </QueryClientProvider>,
);
const box = () => screen.getByLabelText('Message Claude') as HTMLTextAreaElement;
const loaded = () => screen.findByText('Now remember the choice', { selector: 'div' });
/** The prompt's own Rewind to here, in the gutter beside it on a computer. */
const rewindOn = (words: string) => {
  const bubble = screen.getByText(words, { selector: 'div' }).closest('.group\\/user')!;
  return within(bubble as HTMLElement).getByRole('button', { name: 'Rewind to here' });
};
const dialog = () => screen.queryByRole('dialog', { name: 'Rewind to this message?' });
const marker = () => document.querySelector('[data-rewound]');

describe('Rewind to here', () => {
  it('asks with Desktop’s three choices when files changed after the message: what goes back, and the words for each', async () => {
    media = { '(hover: hover) and (pointer: fine)': true };
    server.check = { files: [`${CWD}/src/settings/prefs.ts`, `${CWD}/src/settings/ThemeToggle.tsx`], insertions: 10, deletions: 1 };
    open();
    await loaded();
    fireEvent.click(rewindOn('Now remember the choice'));
    const asked = await screen.findByRole('dialog', { name: 'Rewind to this message?' });
    expect(within(asked).getByText('Now remember the choice')).toBeTruthy();
    const choices = within(asked).getAllByRole('radio');
    expect(choices.map((c) => c.textContent)).toEqual(['Code and conversation', 'Conversation only', 'Code only']);
    expect(choices.map((c) => c.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    expect(asked.textContent).toContain('2 files go back+10 −1');
    expect(asked.textContent).toContain('src/settings/ThemeToggle.tsx');
    expect(asked.textContent).toContain('Your message goes back in the box. Changes made through shell commands aren’t reverted. Commits stay in place.');
    // Conversation only: the files stay, and so the words about them go.
    fireEvent.click(choices[1]!);
    expect(asked.textContent).not.toContain('Commits stay in place');
    expect(within(asked).getByText('2 files go back').closest('[aria-hidden="true"]')).toBeTruthy();
    // Code only: the conversation stays, and nothing goes back in the box.
    fireEvent.click(choices[2]!);
    expect(asked.textContent).not.toContain('Your message goes back in the box.');
    fireEvent.click(choices[0]!);
    fireEvent.click(within(asked).getByRole('button', { name: 'Rewind' }));
    await waitFor(() => expect(server.rewinds).toEqual([['u2', 'both']]));
    // The conversation ends before the message, which is back in the box, at the marker.
    await waitFor(() => expect(box().value).toBe('Now remember the choice'));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(screen.queryByText('It stays after a reload now.')).toBeNull();
    expect(marker()?.textContent).toBe('Rewound here·Undo rewind');
  });

  it('takes one tap when nothing changed after the message: the conversation goes back at once, no dialog', async () => {
    media = { '(hover: hover) and (pointer: fine)': true };
    server.check = { files: [], insertions: 0, deletions: 0 };
    open();
    await loaded();
    fireEvent.click(rewindOn('Now remember the choice'));
    await waitFor(() => expect(server.rewinds).toEqual([['u2', 'conversation']]));
    expect(dialog()).toBeNull();
    await waitFor(() => expect(box().value).toBe('Now remember the choice'));
    await waitFor(() => expect(marker()).toBeTruthy());
  });

  it('asks after all, with no choices, when Claude Code’s check takes a while, as Desktop does', async () => {
    media = { '(hover: hover) and (pointer: fine)': true };
    server.check = { files: [], insertions: 0, deletions: 0 };
    let release = () => {};
    server.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    open();
    await loaded();
    fireEvent.click(rewindOn('Now remember the choice'));
    const asked = await screen.findByRole('dialog', { name: 'Rewind to this message?' });
    expect(asked.textContent).toContain('Checking for file changes…');
    expect((within(asked).getByRole('button', { name: 'Rewind' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => release());
    await waitFor(() => expect(asked.textContent).toContain('Your message goes back in the box.'));
    expect(within(asked).queryAllByRole('radio')).toEqual([]);
    expect(server.rewinds).toEqual([]);
    fireEvent.click(within(asked).getByRole('button', { name: 'Rewind' }));
    await waitFor(() => expect(server.rewinds).toEqual([['u2', 'conversation']]));
  });

  it('Undo rewind brings the messages back, and takes the words back out of the box', async () => {
    media = { '(hover: hover) and (pointer: fine)': true };
    server.check = { files: [], insertions: 0, deletions: 0 };
    open();
    await loaded();
    fireEvent.click(rewindOn('Now remember the choice'));
    await waitFor(() => expect(box().value).toBe('Now remember the choice'));
    const undo = await screen.findByRole('button', { name: 'Undo rewind' });
    expect(undo.getAttribute('title')).toBe('Brings back the messages this rewind took out of the conversation. Your files stay as they are. Undo works until you send your next message.');
    fireEvent.click(undo);
    await waitFor(() => expect(server.undos).toBe(1));
    await screen.findByText('It stays after a reload now.');
    await waitFor(() => expect(box().value).toBe(''));
    expect(marker()).toBeNull();
  });

  it('Undo rewind takes the words back out of the box after a reload too, from the prompt back in the conversation', async () => {
    media = { '(hover: hover) and (pointer: fine)': true };
    // Rewound in another visit of the page: the cut is the server's, the words this browser's draft.
    server.rewound = { prompt: 'u2', at: Date.now() };
    saveDraft(SESSION, 'Now remember the choice');
    setWaiting(SESSION, []);
    open();
    await screen.findByText('Done. The toggle sits under Display.');
    expect(screen.queryByText('It stays after a reload now.')).toBeNull();
    await waitFor(() => expect(box().value).toBe('Now remember the choice'));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo rewind' }));
    await screen.findByText('It stays after a reload now.');
    await waitFor(() => expect(box().value).toBe(''));
  });

  it('Undo rewind leaves what was typed since in the box', async () => {
    media = { '(hover: hover) and (pointer: fine)': true };
    server.check = { files: [], insertions: 0, deletions: 0 };
    open();
    await loaded();
    fireEvent.click(rewindOn('Now remember the choice'));
    await waitFor(() => expect(box().value).toBe('Now remember the choice'));
    fireEvent.change(box(), { target: { value: 'Now remember the choice, per user' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Undo rewind' }));
    await screen.findByText('It stays after a reload now.');
    expect(box().value).toBe('Now remember the choice, per user');
  });

  it('says so, and asks nothing, while Claude works', async () => {
    media = { '(hover: hover) and (pointer: fine)': true };
    server.run = { sessionId: SESSION, cwd: CWD, busy: true, settings: {}, permissions: [], partial: [] };
    server.check = { files: [], insertions: 0, deletions: 0 };
    open();
    await loaded();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy());
    fireEvent.click(rewindOn('Now remember the choice'));
    await screen.findByText('Rewind is unavailable while Claude is working.');
    expect(server.rewinds).toEqual([]);
    expect(dialog()).toBeNull();
  });

  it('offers only the code where the conversation cannot go back, and says why when there is no code to put back', async () => {
    media = { '(hover: hover) and (pointer: fine)': true };
    server.check = { files: [`${CWD}/src/theme.css`], insertions: 2, deletions: 0, conversationStays: 'The session is open in Claude Desktop too, so only its code can go back here.' };
    open();
    await loaded();
    fireEvent.click(rewindOn('Now remember the choice'));
    const asked = await screen.findByRole('dialog', { name: 'Rewind to this message?' });
    expect(within(asked).getAllByRole('radio').map((c) => c.textContent)).toEqual(['Code only']);
    expect(asked.textContent).toContain('The session is open in Claude Desktop too, so only its code can go back here. Changes made through shell commands aren’t reverted.');
    fireEvent.click(within(asked).getByRole('button', { name: 'Rewind' }));
    await waitFor(() => expect(server.rewinds).toEqual([['u2', 'code']]));
    await screen.findByText('Code restored');
    expect(marker()).toBeNull();
    cleanup();
    server.check = { files: [], insertions: 0, deletions: 0, conversationStays: 'It is the conversation’s first message: Fork from here starts it again in a new session.' };
    open();
    await loaded();
    fireEvent.click(rewindOn('Add a dark theme to the settings page'));
    await screen.findByText('It is the conversation’s first message: Fork from here starts it again in a new session.');
    expect(server.rewinds).toEqual([['u2', 'code']]);
  });

  it('asks first in a folder nobody trusted, as a message does, its check starting the session’s Claude', async () => {
    media = { '(hover: hover) and (pointer: fine)': true };
    server.check = { files: [], insertions: 0, deletions: 0 };
    server.untrusted = true;
    open();
    await loaded();
    fireEvent.click(rewindOn('Now remember the choice'));
    fireEvent.click(await screen.findByText('Trust and start'));
    await waitFor(() => expect(server.rewinds).toEqual([['u2', 'conversation']]));
    expect(server.checks).toEqual([undefined, 'trusted']);
  });

  it('leaves the session’s model and mode as they were, though the Claude it started again has run no turn yet', async () => {
    media = { '(hover: hover) and (pointer: fine)': true };
    // Opened again after a rewind: its Claude waits for the next message, told nothing so far, and
    // the page hears of it (the socket) before it reads the session.
    server.rewound = { prompt: 'u2', at: Date.now() };
    server.run = { sessionId: SESSION, cwd: CWD, busy: false, settings: {}, permissions: [], partial: [] };
    server.recorded = { model: 'claude-opus-5-5', effort: 'medium', permissionMode: 'acceptEdits' };
    setRun(SESSION, server.run);
    open();
    await screen.findByText('Done. The toggle sits under Display.');
    await waitFor(() => expect(screen.getByLabelText('Permission mode').textContent).toBe('Accept edits'));
    expect(screen.getByLabelText('Model, effort and speed').textContent).toContain('Med');
  });

  it('acts on its turn’s prompt from a reply’s ⋯, on a phone', async () => {
    media = { '(hover: none)': true };
    server.check = { files: [], insertions: 0, deletions: 0 };
    open();
    await loaded();
    fireEvent.click(screen.getAllByRole('button', { name: 'More for Claude’s reply' }).at(-1)!);
    fireEvent.click(within(await screen.findByRole('menu', { name: 'Claude’s reply' })).getByRole('menuitem', { name: 'Rewind to here' }));
    await waitFor(() => expect(server.rewinds).toEqual([['u2', 'conversation']]));
  });
});

describe('/rewind', () => {
  it('lists the conversation’s prompts, oldest first, and picking one is its Rewind to here', async () => {
    media = { '(hover: hover) and (pointer: fine)': true };
    server.check = { files: [], insertions: 0, deletions: 0 };
    open();
    await loaded();
    act(() => showCommandMenu(true));
    const menu = await screen.findByRole('dialog', { name: 'Command menu' });
    const field = within(menu).getByRole('combobox');
    fireEvent.change(field, { target: { value: 'rewind' } });
    fireEvent.click(await within(menu).findByText('Rewind to an earlier message'));
    const list = await screen.findByRole('dialog', { name: 'Rewind' });
    expect(within(list).getAllByRole('button').map((b) => b.textContent?.replace(/\d{1,2}:\d{2}.*$/, ''))).toEqual(['Add a dark theme to the settings page', 'Now remember the choice']);
    fireEvent.click(within(list).getByText('Now remember the choice'));
    await waitFor(() => expect(server.rewinds).toEqual([['u2', 'conversation']]));
  });
});

describe('Fork from here', () => {
  it('opens a copy up to just before the prompt, its words, quotes and files in the new session’s box', async () => {
    media = { '(hover: hover) and (pointer: fine)': true };
    open();
    await loaded();
    const bubble = screen.getByText('Now remember the choice', { selector: 'div' }).closest('.group\\/user') as HTMLElement;
    fireEvent.click(within(bubble).getByRole('button', { name: 'Fork from here' }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(FORKED));
    expect(loadDraft(FORKED)).toMatchObject({ text: 'Now remember the choice', attachments: [FILE] });
    expect(waitingOf(FORKED)).toMatchObject([{ kind: 'quote', text: 'The toggle sits under Display.', note: 'Keep it there' }]);
    // The first prompt: a new session in the folder, with them.
    fireEvent.click(within(screen.getByText('Add a dark theme to the settings page', { selector: 'div' }).closest('.group\\/user') as HTMLElement).getByRole('button', { name: 'Fork from here' }));
    await waitFor(() => expect(onStartIn).toHaveBeenCalledWith({ cwd: CWD }, true));
    expect(loadDraft(`new:${CWD}`)).toMatchObject({ text: 'Add a dark theme to the settings page', attachments: [FILE] });
  });

  it('on the first prompt keeps what was typed for a new session in the folder, the prompt’s words after it', async () => {
    media = { '(hover: hover) and (pointer: fine)': true };
    const typed: Attachment = { id: 'up-2', name: 'plan.md', mime: 'text/markdown', size: 9, path: '/uploads/up-2/plan.md' };
    saveDraft(`new:${CWD}`, 'My half-written idea for a new session', [typed]);
    open();
    await loaded();
    fireEvent.click(within(screen.getByText('Add a dark theme to the settings page', { selector: 'div' }).closest('.group\\/user') as HTMLElement).getByRole('button', { name: 'Fork from here' }));
    await waitFor(() => expect(onStartIn).toHaveBeenCalledWith({ cwd: CWD }, true));
    expect(loadDraft(`new:${CWD}`)).toMatchObject({ text: 'My half-written idea for a new session\n\nAdd a dark theme to the settings page', attachments: [typed, FILE] });
  });
});
