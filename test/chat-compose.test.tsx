// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Attachment, ChatMessage, GitStatus, PermissionRequest, RunState, SessionSummary } from '../src/shared/protocol';

const SESSION = '33333333-2222-4333-8444-555555555555';
const CREATED = '44444444-2222-4333-8444-555555555555';
/** Another session in the same folder. */
const OTHER = '66666666-2222-4333-8444-555555555555';
const CWD = '/code/app';
const FILE = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';

/** What the computer answers, as each test sets it. */
const server = vi.hoisted(() => ({
  /** Each send's answer in turn: an error it fails with, or nothing for one that goes through. */
  answers: [] as Array<Error | undefined>,
  /** Holds the next send's answer until it settles: a slow link, or a Claude still starting. */
  hold: undefined as Promise<void> | undefined,
  sent: [] as Array<{ text: string; attachments: string[]; trust?: string; mode?: string }>,
  /** Queued messages taken back, by id. */
  unqueued: [] as string[],
  /** The `!` commands asked to run; each takes its answer from `answers`, as a send does. */
  shells: [] as string[],
  session: {} as Partial<SessionSummary>,
  run: null as RunState | null,
  /** What the conversation holds after its first prompt. */
  after: [] as ChatMessage[],
  /** How often git status was asked for, and what it says. */
  gitReads: 0,
  git: { repo: false } as GitStatus,
}));

vi.mock('../src/web/lib/api', async (original) => {
  const actual = await original<typeof import('../src/web/lib/api')>();
  const answer = async (body: { text: string; attachments: string[]; trust?: string }) => {
    server.sent.push(body);
    const failure = server.answers.shift();
    const held = server.hold;
    server.hold = undefined;
    await held;
    if (failure) throw failure;
  };
  return {
    ...actual,
    api: {
      ...actual.api,
      models: async () => ({ models: [], signedIn: true }),
      usage: async () => [],
      defaults: async () => (await import('./start-defaults')).BUILT_IN,
      completions: async () => ({ commands: [], agents: [] }),
      projects: async () => [
        { path: '/code/app', name: 'app', lastActivity: Date.now() - 60_000, sessions: 2 },
        { path: '/code/site', name: 'site', lastActivity: Date.now() - 120_000, sessions: 1 },
      ],
      git: async () => {
        server.gitReads += 1;
        return server.git;
      },
      tree: async () => [],
      file: async (_cwd: string, path: string) => ({ path, size: FILE.length, text: FILE }),
      session: async (id: string) => ({
        session: { id, title: 'Clean up the build', cwd: CWD, project: 'app', lastActivity: Date.now() - 60_000, status: 'idle', ...server.session },
        run: server.run,
        tasks: [],
        settings: {},
      }),
      messages: async () => {
        const messages: ChatMessage[] = [{ uuid: 'u1', role: 'user', blocks: [{ type: 'text', text: 'Clean up the build' }], timestamp: Date.now() - 60_000 }, ...server.after];
        return { messages, total: messages.length, offset: 0 };
      },
      send: async (_id: string, body: { text: string; attachments: string[]; trust?: string }) => {
        await answer(body);
        return { sessionId: SESSION };
      },
      create: async (body: { text: string; attachments: string[]; trust?: string }) => {
        await answer(body);
        return { sessionId: CREATED };
      },
      shell: async (_id: string, command: string) => {
        server.shells.push(command);
        const failure = server.answers.shift();
        const held = server.hold;
        server.hold = undefined;
        await held;
        if (failure) throw failure;
        return { shell: { id: `sh-${server.shells.length}`, command, startedAt: Date.now(), output: '' } };
      },
      upload: async (file: File): Promise<Attachment> => ({ id: `up-${file.name}`, name: file.name, mime: file.type || 'text/plain', size: file.size, path: `/tmp/${file.name}` }),
      unqueue: async (_id: string, uuid: string) => {
        server.unqueued.push(uuid);
        return {};
      },
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
const { loadDraft } = await import('../src/web/lib/drafts');
const { COMMIT_REQUEST, createPrRequest } = await import('../src/shared/requests');
const { setPrefs } = await import('../src/web/lib/prefs');
const { commentsOf, setComments } = await import('../src/web/lib/review');
const { addWaiting, setWaiting, waitingOf } = await import('../src/web/lib/drafts');
const { fileItem, messageWith } = await import('../src/web/lib/quote');
type WaitingItem = import('../src/web/lib/quote').WaitingItem;
const { getView, setRun } = await import('../src/web/lib/store');
const { goTo } = await import('../src/web/lib/workspace-route');

/** The title's ▾, which opens the session's menu. */
const sessionMenu = () => document.querySelector<HTMLElement>('header h2 button')!;

/** The header's way to Changes: its button on a computer, its one button on a phone. */
const paneButton = () => screen.findByRole('button', { name: /^Changes(,|$)/ });

/** The address with Changes and files at a file of the folder, as a path in the conversation opens it. */
function atFile(id: string, path: string) {
  history.replaceState(null, '', `/?s=${id}`);
  goTo({ tab: 'files', path }, false);
}

afterEach(async () => {
  cleanup();
  localStorage.clear();
  for (const chat of [SESSION, OTHER, `new:${CWD}`, CWD]) setComments(chat, []);
  media = {};
  // Opened beside the conversation, Changes and files stays open from one session to the next, in
  // memory as well as in storage: the next test starts with it closed, as a first visit does.
  setPrefs({ workspacePane: false });
  Object.assign(server, { answers: [], hold: undefined, sent: [], unqueued: [], shells: [], session: {}, run: null, after: [], gitReads: 0, git: { repo: false } });
  // A view of Changes and files left open keeps its step in the address; one closed on a phone
  // goes back through the history a moment later, which must land before the next test begins.
  await new Promise((resolve) => setTimeout(resolve, 0));
  history.replaceState(null, '', '/');
});

const wrap = (node: React.ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);
const session = (id = SESSION) => wrap(<Chat sessionId={id} home="/home/me" machine="studio" demo wide onBack={() => {}} onOpen={() => {}} onStartIn={() => {}} />);
const fresh = () => wrap(<Chat newCwd={CWD} home="/home/me" machine="studio" wide onBack={() => {}} onOpen={() => {}} onStartIn={() => {}} />);
const box = () => screen.getByLabelText('Message Claude') as HTMLTextAreaElement;
/** The tabs of Changes and files load when first shown, which takes longer on a busy machine. */
const LAZY = { timeout: 5000 };
/** The conversation, and the session's own page (its folder, under the title): what the chat knows of it once loaded. */
const loaded = async () => {
  await screen.findAllByText('Clean up the build');
  await waitFor(() => expect(document.querySelector('header')?.textContent).toContain('/code/app'));
};
const untrusted = () => new ApiError('Trust this folder before Claude Code starts in it.', 409, false, { brings: ['hooks: PreToolUse (.claude/settings.json)'] });

/** Holds the next send's answer: what it returns lets it go. */
function holdNextSend(): () => void {
  let release = () => {};
  server.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  return () => act(release);
}

function sendText(text: string) {
  fireEvent.change(box(), { target: { value: text } });
  fireEvent.keyDown(box(), { key: 'Enter', keyCode: 13 });
}

/** What waits above the box to be put back: what did not go, and what Put back took out of the box for it. */
const waiting = () => screen.queryAllByText(/^Not sent:/).map((row) => row.textContent?.replace(/^Not sent:\s*/, ''));
const setAside = () => screen.queryAllByText(/^Set aside:/).map((row) => row.textContent?.replace(/^Set aside:\s*/, ''));

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

describe('a message that did not go', () => {
  const attach = async (name: string) => {
    const picker = document.querySelector('input[type=file]') as HTMLInputElement;
    fireEvent.change(picker, { target: { files: [new File(['ERROR export failed\n'], name, { type: 'text/plain' })] } });
    await screen.findByLabelText(`Remove ${name}`);
  };
  const stored = () => (JSON.parse(localStorage.getItem('pelican:drafts') ?? '{}') as Record<string, { text: string; attachments?: Attachment[] }>)[SESSION];

  it('comes back with its files when the computer is out of reach, in the box and in the saved draft', async () => {
    server.answers.push(new ApiError('Can’t reach studio', 0));
    session();
    await loaded();
    await attach('export.log');
    sendText('Why does this log say the export failed?');
    await waitFor(() => expect(box().value).toBe('Why does this log say the export failed?'));
    expect(screen.getByLabelText('Remove export.log')).toBeTruthy();
    await waitFor(() => expect(stored()?.attachments).toEqual([expect.objectContaining({ id: 'up-export.log' })]), { timeout: 2000 });
  });

  it('with a file, while a / command was typed, waits with its file: the command goes without it, and Put back brings both', async () => {
    server.answers = [new ApiError('Can’t reach studio', 0)];
    session();
    await loaded();
    await attach('export.log');
    const release = holdNextSend();
    sendText('Why does this log say the export failed?');
    await waitFor(() => expect(server.sent).toHaveLength(1));
    fireEvent.change(box(), { target: { value: '/compact' } });
    release();
    await waitFor(() => expect(waiting()).toEqual(['Why does this log say the export failed? · export.log']));
    expect(screen.queryByLabelText('Remove export.log')).toBeNull();
    await waitFor(() => expect(stored()).toMatchObject({ text: '/compact', held: [{ text: 'Why does this log say the export failed?', attachments: [expect.objectContaining({ id: 'up-export.log' })] }] }), { timeout: 2000 });
    fireEvent.keyDown(box(), { key: 'Enter', keyCode: 13 });
    await waitFor(() => expect(server.sent).toHaveLength(2));
    expect(server.sent[1]).toMatchObject({ text: '/compact', attachments: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Put back Why does this log say the export failed? with export.log' }));
    expect(box().value).toBe('Why does this log say the export failed?');
    expect(screen.getByLabelText('Remove export.log')).toBeTruthy();
    sendText('Why does this log say the export failed?');
    await waitFor(() => expect(server.sent).toHaveLength(3));
    expect(server.sent[2]).toMatchObject({ text: 'Why does this log say the export failed?', attachments: ['up-export.log'] });
  });

  it('to a new session whose Claude Code stopped before the message reached it says why line for line, as Claude Code printed it, and comes back to the box', async () => {
    const printed = 'Error: Invalid MCP configuration:\nmcpServers: Invalid input: expected record, received number';
    server.answers.push(new ApiError(printed, 500));
    fresh();
    sendText('Fix the login test');
    await waitFor(() => expect(box().value).toBe('Fix the login test'));
    const said = await screen.findByText((_, element) => element?.tagName === 'SPAN' && element.textContent === printed);
    expect(said.className).toContain('whitespace-pre-wrap');
  });

  it('comes back with its files when the trust question is put away', async () => {
    server.answers.push(untrusted());
    session();
    await loaded();
    await attach('notes.txt');
    sendText('Summarise these notes');
    const sheet = await screen.findByRole('dialog', { name: 'Trust this folder?' });
    act(() => {
      sheet.dispatchEvent(new Event('cancel', { cancelable: true }));
    });
    await waitFor(() => expect(box().value).toBe('Summarise these notes'));
    expect(screen.getByLabelText('Remove notes.txt')).toBeTruthy();
    await waitFor(() => expect(stored()?.attachments).toEqual([expect.objectContaining({ id: 'up-notes.txt' })]), { timeout: 2000 });
    expect(server.sent).toHaveLength(1);
  });
});

describe('what is being typed, when a message the chat sends on its own does not go', () => {
  const comment = { id: 'c1', path: 'src/a.ts', kind: 'add' as const, line: 3, code: 'const a = 1;', note: 'Name this better' };
  const typing = () => fireEvent.change(box(), { target: { value: 'Half-written thought' } });
  const apiError = (text: string): ChatMessage => ({ uuid: 'e1', role: 'assistant', blocks: [{ type: 'text', text }], apiError: true, timestamp: Date.now() - 50_000 });

  it('stays in the box after Send now, and the comments wait again', async () => {
    setComments(SESSION, [comment]);
    server.answers = [new Error('Can’t reach studio')];
    session();
    await loaded();
    typing();
    fireEvent.click(await paneButton());
    fireEvent.click(await screen.findByText('Send now'));
    await screen.findByText('Can’t reach studio');
    expect(server.sent.map((body) => body.text)).toEqual(['In `src/a.ts` at line 3:\n```ts\nconst a = 1;\n```\nName this better']);
    expect(box().value).toBe('Half-written thought');
    expect(commentsOf(SESSION)).toEqual([comment]);
    await waitFor(() => expect(loadDraft(SESSION)?.text).toBe('Half-written thought'), { timeout: 2000 });
  });

  it('stays in the box after Send now in a folder nobody trusted, the question put away', async () => {
    setComments(SESSION, [comment]);
    server.answers = [untrusted()];
    session();
    await loaded();
    typing();
    fireEvent.click(await paneButton());
    fireEvent.click(await screen.findByText('Send now'));
    const sheet = await screen.findByRole('dialog', { name: 'Trust this folder?' });
    act(() => {
      sheet.dispatchEvent(new Event('cancel', { cancelable: true }));
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Trust this folder?' })).toBeNull());
    expect(box().value).toBe('Half-written thought');
    expect(commentsOf(SESSION)).toEqual([comment]);
  });

  it('stays in the box after Compact, Retry or Cancel on a check-in, which take no comments', async () => {
    // Sessions of their own: the conversation must end on the error, with nothing sent after it.
    const ended = ['77777777-2222-4333-8444-555555555551', '77777777-2222-4333-8444-555555555552', '77777777-2222-4333-8444-555555555553'] as const;
    for (const [id, error, button] of [[ended[0], 'Prompt is too long', 'Compact'], [ended[1], 'API Error: 529 Overloaded', 'Retry']] as const) {
      setComments(id, [comment]);
      server.after = [apiError(error)];
      server.answers = [new Error('Can’t reach studio')];
      session(id);
      const next = await screen.findByRole('button', { name: button });
      typing();
      fireEvent.click(next);
      await screen.findByText('Can’t reach studio');
      expect(box().value).toBe('Half-written thought');
      expect(commentsOf(id)).toEqual([comment]);
      cleanup();
    }
    server.after = [];
    server.run = { sessionId: ended[2], cwd: CWD, busy: false, settings: {}, permissions: [], partial: [], scheduled: [{ id: 'wakeup', what: 'Check the deploy', repeats: true }] };
    server.answers = [new Error('Can’t reach studio')];
    try {
      session(ended[2]);
      const cancel = await screen.findByRole('button', { name: 'Cancel' });
      typing();
      fireEvent.click(cancel);
      await screen.findByText('Can’t reach studio');
      expect(box().value).toBe('Half-written thought');
      expect(server.sent.map((body) => body.text)).toEqual(['/compact', 'Clean up the build', 'Stop the loop (Check the deploy).']);
    } finally {
      act(() => setRun(ended[2], undefined));
      for (const id of ended) setComments(id, []);
    }
  });
});

describe('a message from the box that does not go', () => {
  it('goes back above what was typed since it went', async () => {
    server.answers = [new Error('Can’t reach studio')];
    session();
    await loaded();
    const release = holdNextSend();
    sendText('Why does the export fail?');
    await waitFor(() => expect(server.sent).toHaveLength(1));
    fireEvent.change(box(), { target: { value: 'Also: the logs' } });
    release();
    await screen.findByText('Can’t reach studio');
    // The box takes it back once it has the message, a moment after the notice shows.
    await waitFor(() => expect(box().value).toBe('Why does the export fail?\n\nAlso: the logs'));
  });

  it('a / command, while more was typed, waits above the box: the words typed never become its arguments', async () => {
    server.answers = [new Error('Can’t reach studio')];
    session();
    await loaded();
    const release = holdNextSend();
    sendText('/compact');
    await waitFor(() => expect(server.sent).toHaveLength(1));
    fireEvent.change(box(), { target: { value: 'next question' } });
    release();
    await screen.findByText('Can’t reach studio');
    await waitFor(() => expect(waiting()).toEqual(['/compact']));
    expect(box().value).toBe('next question');
    // Put back, it takes the box, and the words wait in its place until they are put back in turn.
    fireEvent.click(screen.getByRole('button', { name: 'Put back /compact' }));
    expect(box().value).toBe('/compact');
    expect(waiting()).toEqual([]);
    expect(setAside()).toEqual(['next question']);
    await waitFor(() => expect(loadDraft(SESSION)).toMatchObject({ text: '/compact', held: [{ text: 'next question' }] }), { timeout: 2000 });
  });

  it('a ! command that does not run, while more was typed, waits above the box, never lost', async () => {
    server.answers = [new Error('Can’t reach studio')];
    session();
    await loaded();
    const release = holdNextSend();
    fireEvent.change(box(), { target: { value: '!npm test' } });
    fireEvent.keyDown(box(), { key: 'Enter', keyCode: 13 });
    await waitFor(() => expect(server.shells).toEqual(['npm test']));
    fireEvent.change(box(), { target: { value: 'Then fix what fails' } });
    release();
    await screen.findByText('Can’t reach studio');
    await waitFor(() => expect(waiting()).toEqual(['!npm test']));
    expect(box().value).toBe('Then fix what fails');
    await waitFor(() => expect(loadDraft(SESSION)).toMatchObject({ text: 'Then fix what fails', held: [{ text: '!npm test' }] }), { timeout: 2000 });
    // Sent, the words go; the command still waits, in the box's draft too.
    sendText('Then fix what fails');
    await waitFor(() => expect(server.sent.map((body) => body.text)).toEqual(['Then fix what fails']));
    expect(waiting()).toEqual(['!npm test']);
    await waitFor(() => expect(loadDraft(SESSION)).toMatchObject({ text: '', held: [{ text: '!npm test' }] }), { timeout: 2000 });
    fireEvent.click(screen.getByRole('button', { name: 'Put back !npm test' }));
    expect(box().value).toBe('!npm test');
    expect(waiting()).toEqual([]);
  });
});

describe('/clear', () => {
  it('opens a new session and leaves nothing behind in the old one to clear it again', async () => {
    const onStartIn = vi.fn();
    wrap(<Chat sessionId={SESSION} home="/home/me" machine="studio" demo wide onBack={() => {}} onOpen={() => {}} onStartIn={onStartIn} />);
    await loaded();
    sendText('/clear');
    expect(onStartIn).toHaveBeenCalledWith({ cwd: CWD });
    cleanup();
    expect(loadDraft(SESSION)).toBeUndefined();
    session();
    expect(box().value).toBe('');
  });
});

describe('a new session, once its first message starts it', () => {
  it('takes what waits above its box along: the session it was for shows it, the next new session in the folder does not', async () => {
    server.answers = [new Error('Can’t reach studio'), undefined];
    const view = fresh();
    const release = holdNextSend();
    sendText('/init');
    await waitFor(() => expect(server.sent).toHaveLength(1));
    fireEvent.change(box(), { target: { value: 'then explain the layout' } });
    release();
    await waitFor(() => expect(waiting()).toEqual(['/init']));
    sendText('then explain the layout');
    await waitFor(() => expect(loadDraft(CREATED)).toMatchObject({ text: '', held: [{ text: '/init' }] }));
    expect(server.sent.map((body) => body.text)).toEqual(['/init', 'then explain the layout']);
    view.unmount();
    expect(loadDraft(`new:${CWD}`)).toBeUndefined();
    // The session it started, as App opens it.
    session(CREATED);
    await loaded();
    expect(waiting()).toEqual(['/init']);
    cleanup();
    fresh();
    expect(waiting()).toEqual([]);
    expect(box().value).toBe('');
  });
});

describe('a new session moved to another folder before it starts', () => {
  it('takes what is typed, and the mode picked, along', async () => {
    const onStartIn = vi.fn();
    wrap(<Chat newCwd={CWD} home="/home/me" machine="studio" wide onBack={() => {}} onOpen={() => {}} onStartIn={onStartIn} />);
    fireEvent.change(box(), { target: { value: 'A long prompt I wrote before noticing the folder was wrong' } });
    fireEvent.click(screen.getByLabelText('Permission mode'));
    fireEvent.click(within(screen.getAllByRole('dialog').at(-1)!).getByText('Plan'));
    fireEvent.click(screen.getByLabelText(`Folder: ${CWD}`));
    fireEvent.click(await screen.findByText('site'));
    expect(onStartIn).toHaveBeenCalledWith({ cwd: '/code/site' });
    cleanup();
    expect(loadDraft(`new:${CWD}`)).toBeUndefined();
    wrap(<Chat newCwd="/code/site" home="/home/me" machine="studio" wide onBack={() => {}} onOpen={() => {}} onStartIn={() => {}} />);
    expect(box().value).toBe('A long prompt I wrote before noticing the folder was wrong');
    await waitFor(() => expect(screen.getByLabelText('Permission mode').textContent).toBe('Plan'));
  });

  it('names the folder in the middle of the empty chat with its name kept, a long path giving way from its start, as the header does', () => {
    const deep = '/tmp/pelican-check/v50-gate/fb-scratch/live/repos/cloned-app';
    wrap(<Chat newCwd={deep} home="/home/me" machine="studio" wide={false} onBack={() => {}} onOpen={() => {}} onStartIn={() => {}} />);
    const folder = screen.getByLabelText(`Folder: ${deep}`);
    const path = folder.querySelector('span[dir="rtl"]')!;
    expect(path.className).toContain('truncate');
    expect(path.querySelector('bdi[dir="ltr"]')?.textContent).toBe(deep);
    expect(folder.getAttribute('title')).toBe(deep);
  });

  it('never takes Bypass along: in the other folder it starts as a new session there does', async () => {
    wrap(<Chat newCwd={CWD} home="/home/me" machine="studio" wide onBack={() => {}} onOpen={() => {}} onStartIn={() => {}} />);
    fireEvent.click(screen.getByLabelText('Permission mode'));
    fireEvent.click(within(screen.getAllByRole('dialog').at(-1)!).getByText('Bypass permissions'));
    expect(screen.getByLabelText('Permission mode').textContent).toBe('Bypass');
    fireEvent.click(screen.getByLabelText(`Folder: ${CWD}`));
    fireEvent.click(await screen.findByText('site'));
    cleanup();
    wrap(<Chat newCwd="/code/site" home="/home/me" machine="studio" wide onBack={() => {}} onOpen={() => {}} onStartIn={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('Permission mode').textContent).toBe('Auto'));
  });
});

describe('line comments, as in Claude Desktop', () => {
  const comment = { id: 'c1', path: 'src/styles/theme.css', kind: 'add' as const, line: 8, code: ":root[data-theme='dark'] {", note: 'Use the variables here too' };
  const said = "In `src/styles/theme.css` at line 8:\n```css\n:root[data-theme='dark'] {\n```\nUse the variables here too";
  /** The comment's chip above the message box, where what goes with the next message waits. */
  const chip = (note = 'Use the variables here too', line = 8) => screen.queryByRole('button', { name: `Comment on theme.css:${line}: ${note}` });

  it('wait as chips in the box, go with the next message before what was typed, and are gone once it went', async () => {
    setComments(SESSION, [comment]);
    session();
    await loaded();
    expect(chip()).toBeTruthy();
    // The line that used to say so above the box is gone: the chips say it.
    expect(screen.queryByText(/go(es)? with your next message/)).toBeNull();
    fireEvent.change(box(), { target: { value: 'Looks good otherwise' } });
    fireEvent.keyDown(box(), { key: 'Enter', metaKey: true });
    await waitFor(() => expect(server.sent).toHaveLength(1));
    expect(server.sent[0]!.text).toBe(`${said}\n\n\nLooks good otherwise`);
    await waitFor(() => expect(chip()).toBeNull());
  });

  it('belong to the session they were written in: another session in the folder neither shows nor sends them', async () => {
    media['(min-width: 1024px)'] = true;
    setPrefs({ workspacePane: true });
    atFile(SESSION, 'src/a.ts');
    try {
      session();
      await loaded();
      // Written in the file this session's pane shows.
      await waitFor(() => expect(document.querySelector('[data-line="2"]')).toBeTruthy(), LAZY);
      fireEvent.click(screen.getByRole('button', { name: 'Add comment on line 2' }));
      fireEvent.change(screen.getByLabelText('Comment for Claude'), { target: { value: 'Name it b2' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add comment' }));
      expect(commentsOf(SESSION)).toMatchObject([{ path: 'src/a.ts', line: 2, note: 'Name it b2' }]);
      expect(commentsOf(CWD)).toEqual([]);
      cleanup();

      history.replaceState(null, '', `/?s=${OTHER}`);
      session(OTHER);
      await loaded();
      expect(within(screen.getByRole('complementary', { name: 'Changes and files' })).queryByText(/comment/)).toBeNull();
      sendText('Run the login test once more');
      await waitFor(() => expect(server.sent).toHaveLength(1));
      expect(server.sent[0]!.text).toBe('Run the login test once more');
      expect(commentsOf(SESSION)).toHaveLength(1);
    } finally {
      setPrefs({ workspacePane: false });
    }
  });

  it('go with one message only: one sent while the first is on its way carries none of them', async () => {
    setComments(SESSION, [comment]);
    session();
    await loaded();
    const release = holdNextSend();
    sendText('Looks good otherwise');
    await waitFor(() => expect(server.sent).toHaveLength(1));
    // On their way with it: no longer waiting for the next message.
    expect(chip()).toBeNull();
    sendText('Also run the tests');
    await waitFor(() => expect(server.sent).toHaveLength(2));
    release();
    expect(server.sent.map((body) => body.text)).toEqual([`${said}\n\n\nLooks good otherwise`, 'Also run the tests']);
  });

  it('go once however often Send now is tapped while they are on their way', async () => {
    media['(min-width: 1024px)'] = true;
    setComments(SESSION, [comment]);
    session();
    await loaded();
    fireEvent.click(await paneButton());
    const release = holdNextSend();
    const sendNow = await screen.findByText('Send now');
    fireEvent.click(sendNow);
    await waitFor(() => expect(server.sent).toHaveLength(1));
    if (sendNow.isConnected) fireEvent.click(sendNow);
    fireEvent.keyDown(screen.getByRole('complementary', { name: 'Changes and files' }), { key: 'Enter', metaKey: true });
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    release();
    expect(server.sent.map((body) => body.text)).toEqual([said]);
  });

  it('come back when the message they went with does not go, before any written meanwhile', async () => {
    const later = { ...comment, id: 'c2', line: 9, note: 'And here' };
    setComments(SESSION, [comment]);
    server.answers = [new Error('Can’t reach studio')];
    session();
    await loaded();
    const release = holdNextSend();
    sendText('Looks good');
    await waitFor(() => expect(server.sent).toHaveLength(1));
    act(() => setComments(SESSION, [later]));
    release();
    await screen.findByText('Can’t reach studio');
    expect(commentsOf(SESSION).map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(chip()).toBeTruthy();
    expect(chip('And here', 9)).toBeTruthy();
  });

  it('stay when the message does not go through, and never go with a command', async () => {
    setComments(SESSION, [comment]);
    server.answers = [new Error('Can’t reach studio')];
    session();
    await loaded();
    fireEvent.change(box(), { target: { value: 'Looks good' } });
    fireEvent.keyDown(box(), { key: 'Enter', metaKey: true });
    await waitFor(() => expect(server.sent).toHaveLength(1));
    await waitFor(() => expect(chip()).toBeTruthy());
    fireEvent.change(box(), { target: { value: '/compact' } });
    fireEvent.keyDown(box(), { key: 'Enter', metaKey: true });
    await waitFor(() => expect(server.sent).toHaveLength(2));
    expect(server.sent[1]!.text).toBe('/compact');
    expect(chip()).toBeTruthy();
  });

  it('are sent on their own with Send now, from Changes and files', async () => {
    setComments(SESSION, [comment]);
    session();
    await loaded();
    fireEvent.click(await paneButton());
    fireEvent.click(await screen.findByText('Send now'));
    await waitFor(() => expect(server.sent).toHaveLength(1));
    expect(server.sent[0]!.text).toBe(said);
  });

  it('written before a new session whose first message is a / command, go on with that session, not the folder’s next one', async () => {
    setComments(`new:${CWD}`, [comment]);
    fresh();
    sendText('/init');
    await waitFor(() => expect(server.sent).toHaveLength(1));
    expect(server.sent[0]!.text).toBe('/init');
    await waitFor(() => expect(commentsOf(CREATED)).toEqual([comment]));
    expect(commentsOf(`new:${CWD}`)).toEqual([]);
    setComments(CREATED, []);
  });

  it('written before a new session starts, go with its first message', async () => {
    setComments(`new:${CWD}`, [comment]);
    fresh();
    sendText('Start with the theme');
    await waitFor(() => expect(server.sent).toHaveLength(1));
    expect(server.sent[0]!.text).toBe(`${said}\n\n\nStart with the theme`);
    expect(commentsOf(`new:${CWD}`)).toEqual([]);
  });
});

describe('what runs in the background', () => {
  const tasks = [
    { id: 'bash_1', description: 'Start the dev server', type: 'local_bash', output: true },
    { id: 'w1', description: 'checkout-fixes', type: 'local_workflow', summary: '1/2 agents', toolUseId: 'toolu_w' },
  ];
  const ctrlAltB = () => fireEvent.keyDown(box(), { key: 'b', code: 'KeyB', ctrlKey: true, altKey: true });

  it('reads “2 in background”; ⌃B (Ctrl+Alt+B off a Mac) opens the list with the keys in it, and closes it again', async () => {
    server.run = { sessionId: SESSION, cwd: CWD, busy: false, settings: {}, permissions: [], partial: [], tasks };
    session();
    await loaded();
    const bar = await screen.findByRole('region', { name: '2 in background' });
    expect(within(bar).getByRole('button', { expanded: false }).textContent).toContain('2 in background');
    ctrlAltB();
    await waitFor(() => expect(bar.contains(document.activeElement)).toBe(true));
    expect(within(bar).getByRole('button', { expanded: true })).toBeTruthy();
    // A command's row stops it; a workflow's leads to its card, where its one Stop is.
    expect(within(bar).getAllByRole('button', { name: 'Stop' })).toHaveLength(1);
    expect(within(bar).getByRole('button', { name: /checkout-fixes/ }).getAttribute('title')).toBe('Show the workflow');
    fireEvent.keyDown(document.activeElement!, { key: 'b', code: 'KeyB', ctrlKey: true, altKey: true });
    await waitFor(() => expect(document.activeElement).toBe(box()));
  });

  it('folds, with Claude’s task list, into one line under a card Claude waits on; a tap or ⌃B unfolds them until the next card', async () => {
    const asking = (id: string): PermissionRequest => ({ id, sessionId: SESSION, toolName: 'Bash', input: { command: 'npm test' }, createdAt: Date.now() });
    const todo = { type: 'tool_use' as const, id: 'todo1', name: 'TodoWrite', input: { todos: [{ content: 'Read', status: 'completed' }, { content: 'Test', activeForm: 'Testing', status: 'in_progress' }] } };
    server.after = [{ uuid: 'a1', role: 'assistant', blocks: [todo], timestamp: Date.now() - 30_000 }];
    server.run = { sessionId: SESSION, cwd: CWD, busy: true, settings: {}, permissions: [asking('p1')], partial: [], tasks };
    session();
    await loaded();
    const line = await screen.findByRole('button', { name: /1\/2.*Testing.*2 in background/ });
    expect(line.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('region', { name: '2 in background' })).toBeNull();
    // It keeps to the fold of what can be seen, the card's buttons just above it, where the dock
    // scrolls (at 844×390 it lay 50 px under the fold): stuck at the dock's foot, the room it takes said.
    const dock = line.closest('[data-dock]')!;
    expect(line.parentElement!.className).toMatch(/(^| )sticky( |$)/);
    expect(line.parentElement!.parentElement).toBe(dock);
    expect(dock.className).toContain('[--folded-h:2.5rem]');
    expect(dock.querySelector('[data-card-foot]')!.className).toContain('bottom-[var(--folded-h,0px)]');
    fireEvent.click(line);
    expect(await screen.findByRole('region', { name: '2 in background' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^1\/2\s*Testing/ })).toBeTruthy();
    // The next card folds them again; ⌃B unfolds them, with the list open and the keys in it.
    act(() => setRun(SESSION, { ...getView(SESSION).run!, permissions: [asking('p2')] }));
    expect(await screen.findByRole('button', { name: /1\/2.*Testing.*2 in background/ })).toBeTruthy();
    ctrlAltB();
    const bar = await screen.findByRole('region', { name: '2 in background' });
    await waitFor(() => expect(bar.contains(document.activeElement)).toBe(true));
    // With no card waiting, the bars show as they do.
    act(() => setRun(SESSION, { ...getView(SESSION).run!, permissions: [] }));
    expect(screen.getByRole('region', { name: '2 in background' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /1\/2.*Testing.*2 in background/ })).toBeNull();
  });

  it('/tasks opens the same, as Claude Code names it; with nothing running it says so', async () => {
    server.run = { sessionId: SESSION, cwd: CWD, busy: false, settings: {}, permissions: [], partial: [] };
    session();
    await loaded();
    sendText('/tasks');
    expect(await screen.findByText('Nothing runs in the background here.')).toBeTruthy();
    expect(server.sent).toEqual([]);
  });
});

describe('Commit changes and Create PR', () => {
  const repository: GitStatus = { repo: true, branch: 'feat/x', base: 'main', remote: true, github: 'acme/app', files: [{ path: 'src/a.ts', status: 'modified', added: 1 }] };

  it('send Claude Desktop’s request at once on a tap, leaving what is typed and what waits; there is no Push', async () => {
    server.git = repository;
    session();
    await loaded();
    fireEvent.change(box(), { target: { value: 'First this.' } });
    fireEvent.click(await paneButton());
    fireEvent.click(await screen.findByRole('button', { name: 'Commit changes' }, LAZY));
    await waitFor(() => expect(server.sent).toHaveLength(1));
    expect(server.sent[0]!.text).toBe(COMMIT_REQUEST);
    expect(box().value).toBe('First this.');
    expect(screen.queryByRole('button', { name: /^Push/ })).toBeNull();
    // On a phone the conversation came back, to show the request go: Changes again for the next.
    fireEvent.click(await paneButton());
    fireEvent.click(await screen.findByRole('button', { name: 'Create PR' }, LAZY));
    await waitFor(() => expect(server.sent).toHaveLength(2));
    expect(server.sent[1]!.text).toBe(createPrRequest({ repo: 'acme/app', branch: 'feat/x', baseBranch: 'main', cwd: CWD, draft: false }));
    // It shows in the conversation as Desktop shows it.
    expect(await screen.findByText('/create-pr')).toBeTruthy();
  });

  it('while Claude works, wait for the end of the turn as a queued message, whatever Settings says; the button says so, and Take back takes it out of the queue', async () => {
    server.git = repository;
    server.run = { sessionId: SESSION, cwd: CWD, busy: true, settings: {}, permissions: [], partial: [] };
    // Settings has typed messages sent at once while Claude works: a request is queued all the same.
    setPrefs({ sendWhileBusy: 'steer' });
    session();
    await loaded();
    fireEvent.click(await paneButton());
    fireEvent.click(await screen.findByRole('button', { name: 'Commit changes' }, LAZY));
    await waitFor(() => expect(server.sent).toHaveLength(1));
    expect(server.sent[0]).toMatchObject({ text: COMMIT_REQUEST, mode: 'queue' });
    // Not in the conversation yet: in the queue, and on its button, until the turn ends.
    const uuid = (server.sent[0] as { uuid?: string }).uuid!;
    expect(getView(SESSION).messages.some((m) => m.uuid === uuid)).toBe(false);
    act(() => setRun(SESSION, { ...server.run!, queued: [{ uuid, text: COMMIT_REQUEST }] }));
    fireEvent.click(await paneButton());
    const queued = await screen.findByRole('group', { name: 'Commit changes, queued' }, LAZY);
    expect(queued.textContent).toContain('Queued');
    expect(screen.queryByRole('button', { name: 'Commit changes' })).toBeNull();
    fireEvent.click(within(queued).getByRole('button', { name: 'Take back' }));
    expect(server.unqueued).toEqual([uuid]);
    act(() => setRun(SESSION, { ...server.run!, queued: [] }));
    expect(await screen.findByRole('button', { name: 'Commit changes' })).toBeTruthy();
  });

  it('send once on a double tap, while Claude works and while it is idle', async () => {
    // On a computer, where Changes stays beside the conversation after a tap.
    media['(min-width: 1024px)'] = true;
    media['(hover: hover) and (pointer: fine)'] = true;
    setPrefs({ workspacePane: true });
    server.git = repository;
    session();
    await loaded();
    const commit = await screen.findByRole('button', { name: 'Commit changes' }, LAZY);
    // The second tap lands while the first is on its way.
    server.hold = new Promise((resolve) => setTimeout(resolve, 50));
    fireEvent.click(commit);
    fireEvent.click(commit);
    await waitFor(() => expect(server.sent).toHaveLength(1));
    // And a moment after it landed, before its button can say it is queued.
    fireEvent.click(commit);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server.sent).toHaveLength(1);
    cleanup();
    server.sent = [];
    server.run = { sessionId: SESSION, cwd: CWD, busy: true, settings: {}, permissions: [], partial: [] };
    session();
    await loaded();
    const pr = await screen.findByRole('button', { name: 'Create PR' }, LAZY);
    fireEvent.click(pr);
    fireEvent.click(pr);
    await waitFor(() => expect(server.sent).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server.sent).toHaveLength(1);
  });

  it('say they wait for a turn under way also when this page saw Claude idle, and leave the conversation once queued', async () => {
    server.git = repository;
    session();
    await loaded();
    fireEvent.click(await paneButton());
    fireEvent.click(await screen.findByRole('button', { name: 'Commit changes' }, LAZY));
    await waitFor(() => expect(server.sent).toHaveLength(1));
    // Claude had started a turn the page had not heard of: the server queues it, never steers it in.
    expect(server.sent[0]).toMatchObject({ text: COMMIT_REQUEST, mode: 'queue' });
    const uuid = (server.sent[0] as { uuid?: string }).uuid!;
    expect(getView(SESSION).messages.some((m) => m.uuid === uuid)).toBe(true);
    act(() => setRun(SESSION, { sessionId: SESSION, cwd: CWD, busy: true, settings: {}, permissions: [], partial: [], queued: [{ uuid, text: COMMIT_REQUEST }] }));
    expect(getView(SESSION).messages.some((m) => m.uuid === uuid)).toBe(false);
  });

  it('take a queued Create PR back as they take back Commit changes', async () => {
    server.git = repository;
    const pr = createPrRequest({ repo: 'acme/app', branch: 'feat/x', baseBranch: 'main', cwd: CWD, draft: false });
    server.run = { sessionId: SESSION, cwd: CWD, busy: true, settings: {}, permissions: [], partial: [], queued: [{ uuid: 'q-pr', text: pr }] };
    session();
    await loaded();
    fireEvent.click(await paneButton());
    const queued = await screen.findByRole('group', { name: 'Create PR, queued' }, LAZY);
    expect(screen.queryByRole('button', { name: 'Create PR' })).toBeNull();
    fireEvent.click(within(queued).getByRole('button', { name: 'Take back' }));
    expect(server.unqueued).toEqual(['q-pr']);
  });

  it('put the request in the message box first on ⌘-click, after what is typed: nothing is sent', async () => {
    server.git = repository;
    session();
    await loaded();
    fireEvent.change(box(), { target: { value: 'First this.' } });
    fireEvent.click(await paneButton());
    fireEvent.click(await screen.findByRole('button', { name: 'Commit changes' }, LAZY), { metaKey: true, ctrlKey: true });
    await waitFor(() => expect(box().value).toBe(`First this.\n\n${COMMIT_REQUEST}\n\n`));
    expect(server.sent).toEqual([]);
  });
});

describe('a file open in Changes and files', () => {
  const open = async () => {
    media['(min-width: 1024px)'] = true;
    media['(hover: hover) and (pointer: fine)'] = true;
    setPrefs({ workspacePane: true });
    atFile(SESSION, 'src/a.ts');
    session();
    await loaded();
    fireEvent.change(box(), { target: { value: 'First this.' } });
    await waitFor(() => expect(document.querySelector('[data-line="2"]')).toBeTruthy(), LAZY);
    return screen.getByRole('complementary', { name: 'Changes and files' });
  };
  afterEach(() => setPrefs({ workspacePane: false }));

  it('quotes the lines selected above the message box, as a quote waits, leaving what is typed', async () => {
    const pane = await open();
    const range = document.createRange();
    range.setStart(document.querySelector('[data-line="1"]')!.lastChild!, 0);
    range.setEnd(document.querySelector('[data-line="2"]')!.lastChild!, 1);
    act(() => {
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    fireEvent.click(await within(pane).findByRole('button', { name: 'Quote' }));
    const chips = await screen.findByRole('list', { name: 'With your next message' });
    expect(within(chips).getByText('a.ts:1-2')).toBeTruthy();
    // As wide as the box has room for, so a note reads in it (it stopped at 24rem), a little less beside others.
    const chip = within(chips).getByText('a.ts:1-2').closest('li')!;
    expect(chip.className).toContain('only:max-w-full');
    expect(chip.className).toContain('max-w-[calc(100%-4rem)]');
    expect(box().value).toBe('First this.');
    getSelection()!.removeAllRanges();
    // It goes as Desktop attaches lines of a file: where they are, then the lines.
    sendText('Why both?');
    await waitFor(() => expect(server.sent).toHaveLength(1));
    expect(server.sent[0]!.text).toBe('<!-- attach: src/a.ts:1-2 -->\n> const a = 1;\n> const b = 2;\n\nWhy both?');
  });

  it('attaches the file from its ⋯, as Desktop’s Attach as context, leaving what is typed', async () => {
    const pane = await open();
    fireEvent.click(within(pane).getByRole('button', { name: 'More for a.ts' }));
    fireEvent.click(within(await screen.findByRole('menu', { name: 'src/a.ts' })).getByText('Attach as context'));
    const chips = await screen.findByRole('list', { name: 'With your next message' });
    expect(within(chips).getByText('a.ts')).toBeTruthy();
    expect(box().value).toBe('First this.');
    setWaiting(SESSION, []);
  });
});

describe('quotes with a note, as Claude Desktop sends them', () => {
  const REPLY = 'The colors are already variables, so a dark theme is one more set of values.';
  const answer = (text = REPLY): ChatMessage => ({ uuid: 'a1', role: 'assistant', blocks: [{ type: 'text', text }], timestamp: Date.now() - 50_000 });
  const quote = (id: string, text: string, note?: string): WaitingItem => ({ id, kind: 'quote', text, from: { what: 'reply', key: 'a1' }, ...(note ? { note } : {}) });
  const comment = { id: 'c1', path: 'src/a.ts', kind: 'add' as const, line: 3, code: 'const a = 1;', note: 'Name this better' };
  /** Selects words of the reply with a mouse, and waits the 250 ms the pill takes. */
  async function selectInReply(words: string) {
    const node = [...document.querySelectorAll('[data-quote-from="a1"] p')].find((p) => p.textContent?.includes(words))!.firstChild!;
    const at = node.textContent!.indexOf(words);
    fireEvent.pointerDown(node.parentElement!, { pointerType: 'mouse' });
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + words.length);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    fireEvent.pointerUp(node.parentElement!, { pointerType: 'mouse' });
    return screen.findByRole('toolbar', { name: 'Selected text' }, { timeout: 1000 });
  }
  beforeAll(() => {
    const rect = { x: 10, y: 40, top: 40, left: 10, bottom: 60, right: 200, width: 190, height: 20, toJSON: () => ({}) } as DOMRect;
    Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => rect;
  });
  afterEach(() => {
    getSelection()?.removeAllRanges();
    for (const chat of [SESSION, `new:${CWD}`, `side:${SESSION}`]) setWaiting(chat, []);
  });

  it('go with the next message in Desktop’s order, and come back in theirs, notes and all, when it does not go', async () => {
    const items = [quote('q1', 'All 14 theme tests pass.'), quote('q2', 'one more set of values', 'Use the names we have'), fileItem('src/prefs.ts')];
    for (const item of items) addWaiting(SESSION, item);
    setComments(SESSION, [comment]);
    server.answers = [new Error('Can’t reach studio')];
    session();
    await loaded();
    sendText('Then run the tests.');
    await screen.findByText('Can’t reach studio');
    expect(server.sent[0]!.text).toBe([
      '@"src/prefs.ts"',
      '<!-- reply 1 -->', '> one more set of values', '', 'Use the names we have', '', '',
      'In `src/a.ts` at line 3:', '```ts', 'const a = 1;', '```', 'Name this better', '', '',
      '<!-- attach -->', '> All 14 theme tests pass.', '',
      'Then run the tests.',
    ].join('\n'));
    // Every one back where it was, its note with it, and the words back in the box.
    expect(waitingOf(SESSION).map((item) => item.id)).toEqual(['q1', 'q2', 'f-src/prefs.ts', 'c1'].map((id) => (id.startsWith('f-') ? items[2]!.id : id)));
    expect(waitingOf(SESSION)[1]!.note).toBe('Use the names we have');
    expect(box().value).toBe('Then run the tests.');
  });

  it('selected in a reply: ↵ opens the note box, ↵ adds the quote with its note, and the message carries Desktop’s reply block', async () => {
    media['(hover: hover) and (pointer: fine)'] = true;
    server.after = [answer()];
    session();
    await loaded();
    await screen.findByText(REPLY);
    await selectInReply('one more set of values');
    fireEvent.keyDown(document.body, { key: 'Enter' });
    const note = within(screen.getByRole('dialog', { name: 'Quote with a note' })).getByLabelText('Your note');
    fireEvent.change(note, { target: { value: 'Use the --bg and --fg names we have' } });
    fireEvent.keyDown(note, { key: 'Enter' });
    await waitFor(() => expect(document.activeElement).toBe(box()));
    expect(screen.getByRole('button', { name: 'Your note on “one more set of values”: Use the --bg and --fg names we have' })).toBeTruthy();
    sendText('Then run the tests.');
    await waitFor(() => expect(server.sent).toHaveLength(1));
    expect(server.sent[0]!.text).toBe('<!-- reply 1 -->\n> one more set of values\n\nUse the --bg and --fg names we have\n\n\nThen run the tests.');
    // The prompt reads back as a quote, quietly, its note and words after it.
    await waitFor(() => expect(screen.getByText('Use the --bg and --fg names we have')).toBeTruthy());
    expect(document.body.textContent).not.toContain('<!-- reply');
  });

  it('a note half written, back from another session, has the keys again: what is typed goes on with it', async () => {
    media['(hover: hover) and (pointer: fine)'] = true;
    server.after = [answer()];
    session();
    await loaded();
    await screen.findByText(REPLY);
    await selectInReply('one more set of values');
    fireEvent.keyDown(document.body, { key: 'Enter' });
    fireEvent.change(within(screen.getByRole('dialog', { name: 'Quote with a note' })).getByLabelText('Your note'), { target: { value: 'Name the wait helper' } });
    // Another session, then this one again.
    cleanup();
    session();
    await loaded();
    const note = within(await screen.findByRole('dialog', { name: 'Quote with a note' })).getByLabelText('Your note') as HTMLTextAreaElement;
    expect(note.value).toBe('Name the wait helper');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.activeElement).toBe(note);
    fireEvent.keyDown(note, { key: 'Escape' });
  });

  it('Send now in the note box sends that one at once, a steer while Claude works, leaving the box as it is; if it does not go, it waits', async () => {
    media['(hover: hover) and (pointer: fine)'] = true;
    server.after = [answer()];
    server.run = { sessionId: SESSION, cwd: CWD, busy: true, settings: {}, permissions: [], partial: [] };
    server.answers = [undefined, new Error('Can’t reach studio')];
    session();
    await loaded();
    await screen.findByText(REPLY);
    fireEvent.change(box(), { target: { value: 'Half-written thought' } });
    for (const note of ['Keep the names', 'And the toggle']) {
      await selectInReply('one more set of values');
      fireEvent.click(within(screen.getByRole('toolbar', { name: 'Selected text' })).getByRole('button', { name: /^Quote/ }));
      const field = within(screen.getByRole('dialog', { name: 'Quote with a note' })).getByLabelText('Your note');
      fireEvent.change(field, { target: { value: note } });
      fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true });
      await waitFor(() => expect(server.sent.map((body) => body.text)).toContain(`<!-- reply -->\n> one more set of values\n\n${note}`));
    }
    expect((server.sent[0] as { mode?: string }).mode).toBe('steer');
    await screen.findByText('Can’t reach studio');
    expect(box().value).toBe('Half-written thought');
    expect(waitingOf(SESSION)).toMatchObject([{ kind: 'quote', text: 'one more set of values', note: 'And the toggle' }]);
  });

  it('Send now in a folder nobody trusted goes once the folder is trusted, and waits no more', async () => {
    media['(hover: hover) and (pointer: fine)'] = true;
    server.after = [answer()];
    server.answers = [untrusted()];
    session();
    await loaded();
    await screen.findByText(REPLY);
    await selectInReply('one more set of values');
    fireEvent.keyDown(document.body, { key: 'Enter' });
    const field = within(screen.getByRole('dialog', { name: 'Quote with a note' })).getByLabelText('Your note');
    fireEvent.change(field, { target: { value: 'Keep the names' } });
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true, ctrlKey: true });
    fireEvent.click(await screen.findByText('Trust and start'));
    await waitFor(() => expect(server.sent).toHaveLength(2));
    expect(server.sent.map((body) => [body.text, body.trust])).toEqual([
      ['<!-- reply -->\n> one more set of values\n\nKeep the names', undefined],
      ['<!-- reply -->\n> one more set of values\n\nKeep the names', 'trusted'],
    ]);
    expect(waitingOf(SESSION)).toEqual([]);
  });

  it('a queued message taken back to edit brings back what waited with it, and its words', async () => {
    const queued = messageWith([quote('q1', 'one more set of values', 'Keep the names')], 'And run the tests');
    server.run = { sessionId: SESSION, cwd: CWD, busy: true, settings: {}, permissions: [], partial: [], queued: [{ uuid: 'p1', text: queued }] };
    session();
    await loaded();
    // Shown by its words, not its markers.
    const row = await screen.findByRole('button', { name: 'And run the tests' });
    expect(row.getAttribute('title')).toBe('Edit');
    fireEvent.click(row);
    await waitFor(() => expect(box().value).toBe('And run the tests'));
    expect(waitingOf(SESSION)).toMatchObject([{ kind: 'quote', text: 'one more set of values', note: 'Keep the names' }]);
  });

  it('inside Changes and files: on a phone the foot says what waits, beside the conversation only Send now', async () => {
    addWaiting(SESSION, quote('q1', 'All 14 theme tests pass.'));
    setComments(SESSION, [comment]);
    session();
    await loaded();
    fireEvent.click(await paneButton());
    expect(await screen.findByText('1 comment, 1 quote')).toBeTruthy();
    expect(screen.getByText(/wait for your next message/)).toBeTruthy();
    cleanup();
    media['(min-width: 1024px)'] = true;
    setPrefs({ workspacePane: true });
    session();
    await loaded();
    const pane = await screen.findByRole('complementary', { name: 'Changes and files' });
    expect(within(pane).getByRole('button', { name: /^Send now/ })).toBeTruthy();
    expect(within(pane).queryByText(/wait for your next message/)).toBeNull();
    setPrefs({ workspacePane: false });
  });
});

describe('Ctrl+O', () => {
  // A session of its own, whose conversation ends on what Claude thought and ran.
  const THOUGHT = '88888888-2222-4333-8444-555555555555';
  const thinking = 'The owners lookup runs once per row.';
  const output = 'def export_rows(batch):';
  beforeEach(() => {
    server.after = [
      { uuid: 'a1', role: 'assistant', blocks: [{ type: 'thinking', thinking }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/code/app/export.py' } }], timestamp: Date.now() - 50_000 },
      { uuid: 'r1', role: 'user', blocks: [{ type: 'tool_result', tool_use_id: 't1', content: output }], timestamp: Date.now() - 49_000 },
      { uuid: 'a2', role: 'assistant', blocks: [{ type: 'text', text: 'Each row asks for its owner.' }], timestamp: Date.now() - 48_000 },
    ];
  });
  const ctrlO = (extra: Partial<KeyboardEventInit> = {}) => act(() => {
    fireEvent.keyDown(window, { key: 'o', ctrlKey: true, ...extra });
  });

  it('steps the conversation through Normal, Thinking and Verbose, as in Claude Desktop', async () => {
    session(THOUGHT);
    await screen.findByText('Each row asks for its owner.');
    expect(screen.queryByText(thinking)).toBeNull();
    ctrlO();
    expect(screen.getByText(thinking)).toBeTruthy();
    expect(screen.queryByText(output)).toBeNull();
    ctrlO();
    expect(screen.getByText(new RegExp(output.replace(/[()]/g, '\\$&')))).toBeTruthy();
    ctrlO();
    expect(screen.queryByText(thinking)).toBeNull();
  });

  it('leaves the view as it is with another key held, or with a sheet open', async () => {
    session(THOUGHT);
    await screen.findByText('Each row asks for its owner.');
    ctrlO({ shiftKey: true });
    ctrlO({ metaKey: true });
    expect(screen.queryByText(thinking)).toBeNull();
    fireEvent.click(sessionMenu());
    await screen.findByRole('dialog');
    ctrlO();
    expect(screen.queryByText(thinking)).toBeNull();
  });
});

describe('a session another app is waiting in, while Claude is idle here', () => {
  it('says so in its status and in the box, which says that a message sent here starts a second Claude; no tip says it again', async () => {
    server.session = { status: 'waiting', runningIn: 'the terminal' };
    server.run = { sessionId: SESSION, cwd: CWD, busy: false, settings: {}, permissions: [], partial: [] };
    session();
    const header = (await screen.findByText('Needs you in the terminal')).closest('header');
    expect(header).toBeTruthy();
    expect(box().placeholder).toBe('Needs you in the terminal · a message starts a second Claude');
    expect(screen.queryByText(/answer it there/)).toBeNull();
  });
});

describe('Changes and files, open beside the conversation', () => {
  const idle: RunState = { sessionId: SESSION, cwd: CWD, busy: false, settings: {}, permissions: [], partial: [] };
  const working: RunState = { ...idle, busy: true };
  const asking: RunState = {
    ...working,
    permissions: [{ id: 'p1', sessionId: SESSION, toolName: 'Bash', input: { command: 'npm test' }, createdAt: Date.now() }],
  };
  const runIs = (run: RunState) => {
    server.run = run;
    act(() => setRun(SESSION, run));
  };
  /**
   * What was asked for lands, in real time (only the polls are timed here): the session as read
   * at the last poll must not come back over the run a test sets next.
   */
  const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
  /** Git status reads over that many seconds of a window that stays in view. */
  const readsIn = async (seconds: number) => {
    const before = server.gitReads;
    await act(() => vi.advanceTimersByTimeAsync(seconds * 1000));
    const reads = server.gitReads - before;
    await settle();
    return reads;
  };

  it('reads git status every few seconds only while Claude works, and every 30 s while it is idle', async () => {
    media['(min-width: 1024px)'] = true;
    server.git = { repo: true, branch: 'main', files: [] };
    setPrefs({ workspacePane: true });
    server.run = idle;
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      session();
      await screen.findByRole('complementary', { name: 'Changes and files' });
      await loaded();
      await waitFor(() => expect(server.gitReads).toBeGreaterThan(0));
      await settle();
      // A pane that stays open from one session to the next, and is looked at: every 30 s.
      expect(await readsIn(60)).toBe(2);
      runIs(working);
      expect(await readsIn(10)).toBe(2);
      // Claude waits for an answer: nothing changes meanwhile.
      runIs(asking);
      expect(await readsIn(20)).toBeLessThanOrEqual(1);
      // The turn ends: read once more, at once.
      const before = server.gitReads;
      runIs(idle);
      await waitFor(() => expect(server.gitReads).toBe(before + 1));
    } finally {
      vi.useRealTimers();
      setPrefs({ workspacePane: false });
      act(() => setRun(SESSION, undefined));
      delete media['(min-width: 1024px)'];
    }
  });

  it('reads it only as each turn ends while nobody looks at it', async () => {
    media['(min-width: 1024px)'] = true;
    server.git = { repo: true, branch: 'main', files: [] };
    server.run = working;
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      session();
      await loaded();
      await waitFor(() => expect(server.gitReads).toBeGreaterThan(0));
      await settle();
      expect(screen.queryByRole('complementary', { name: 'Changes and files' })).toBeNull();
      expect(await readsIn(120)).toBe(0);
      const before = server.gitReads;
      runIs(idle);
      await waitFor(() => expect(server.gitReads).toBe(before + 1));
    } finally {
      vi.useRealTimers();
      act(() => setRun(SESSION, undefined));
      delete media['(min-width: 1024px)'];
    }
  });
});

describe('the folder it is in, picked again', () => {
  it('leaves the next new session there to start as a new session does', async () => {
    wrap(<Chat newCwd={CWD} home="/home/me" machine="studio" wide onBack={() => {}} onOpen={() => {}} onStartIn={() => {}} />);
    fireEvent.click(screen.getByLabelText('Permission mode'));
    fireEvent.click(within(screen.getAllByRole('dialog').at(-1)!).getByText('Accept edits'));
    expect(screen.getByLabelText('Permission mode').textContent).toBe('Accept edits');
    // The sheet marks the folder it is in; a tap on it changes nothing (the route stays, the chat stays).
    fireEvent.click(screen.getByLabelText(`Folder: ${CWD}`));
    fireEvent.click(await screen.findByText('app'));
    cleanup();
    // Later, in the same page: a new session in that folder.
    wrap(<Chat newCwd={CWD} home="/home/me" machine="studio" wide onBack={() => {}} onOpen={() => {}} onStartIn={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('Permission mode').textContent).toBe('Auto'));
  });
});
