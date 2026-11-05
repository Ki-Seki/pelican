// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Attachment, ChatMessage, GitStatus, RunState, SessionSummary } from '../src/shared/protocol';

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
  sent: [] as Array<{ text: string; attachments: string[]; trust?: string }>,
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
      defaults: async () => ({ permissionMode: null }),
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
const { setPrefs } = await import('../src/web/lib/prefs');
const { commentsOf, setComments } = await import('../src/web/lib/review');
const { setRun } = await import('../src/web/lib/store');
const { goTo } = await import('../src/web/lib/workspace-route');

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
  Object.assign(server, { answers: [], hold: undefined, sent: [], shells: [], session: {}, run: null, after: [], gitReads: 0, git: { repo: false } });
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
const loaded = () => screen.findAllByText('Clean up the build');
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
    fireEvent.click(screen.getByLabelText('Changes and files'));
    fireEvent.click(await screen.findByText('Send now'));
    await screen.findByText('Can’t reach studio');
    expect(server.sent.map((body) => body.text)).toEqual(['src/a.ts:3\n> + const a = 1;\nName this better']);
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
    fireEvent.click(screen.getByLabelText('Changes and files'));
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

  /** What waits above the box to be put back. */
  const waiting = () => screen.queryAllByText(/^Not sent:/).map((row) => row.textContent?.replace(/^Not sent:\s*/, ''));

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
    fireEvent.click(screen.getByRole('button', { name: 'Put back' }));
    expect(box().value).toBe('/compact');
    expect(waiting()).toEqual(['next question']);
    await waitFor(() => expect(loadDraft(SESSION)).toMatchObject({ text: '/compact', held: ['next question'] }), { timeout: 2000 });
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
    await waitFor(() => expect(loadDraft(SESSION)).toMatchObject({ text: 'Then fix what fails', held: ['!npm test'] }), { timeout: 2000 });
    // Sent, the words go; the command still waits, in the box's draft too.
    sendText('Then fix what fails');
    await waitFor(() => expect(server.sent.map((body) => body.text)).toEqual(['Then fix what fails']));
    expect(waiting()).toEqual(['!npm test']);
    await waitFor(() => expect(loadDraft(SESSION)).toMatchObject({ text: '', held: ['!npm test'] }), { timeout: 2000 });
    fireEvent.click(screen.getByRole('button', { name: 'Put back' }));
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
  const said = "src/styles/theme.css:8\n> + :root[data-theme='dark'] {\nUse the variables here too";

  it('go with the next message, before what was typed and a blank line, and are gone once it went', async () => {
    setComments(SESSION, [comment]);
    session();
    await loaded();
    expect(screen.getByText('1 comment goes with your next message')).toBeTruthy();
    fireEvent.change(box(), { target: { value: 'Looks good otherwise' } });
    fireEvent.keyDown(box(), { key: 'Enter', metaKey: true });
    await waitFor(() => expect(server.sent).toHaveLength(1));
    expect(server.sent[0]!.text).toBe(`${said}\n\nLooks good otherwise`);
    await waitFor(() => expect(screen.queryByText('1 comment goes with your next message')).toBeNull());
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
      fireEvent.click(document.querySelector('[data-line="2"]')!);
      fireEvent.change(screen.getByLabelText('Comment for Claude'), { target: { value: 'Name it b2' } });
      fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
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
    expect(screen.queryByText('1 comment goes with your next message')).toBeNull();
    sendText('Also run the tests');
    await waitFor(() => expect(server.sent).toHaveLength(2));
    release();
    expect(server.sent.map((body) => body.text)).toEqual([`${said}\n\nLooks good otherwise`, 'Also run the tests']);
  });

  it('go once however often Send now is tapped while they are on their way', async () => {
    media['(min-width: 1024px)'] = true;
    setComments(SESSION, [comment]);
    session();
    await loaded();
    fireEvent.click(screen.getByLabelText('Changes and files'));
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
    expect(screen.getByText('2 comments go with your next message')).toBeTruthy();
  });

  it('stay when the message does not go through, and never go with a command', async () => {
    setComments(SESSION, [comment]);
    server.answers = [new Error('Can’t reach studio')];
    session();
    await loaded();
    fireEvent.change(box(), { target: { value: 'Looks good' } });
    fireEvent.keyDown(box(), { key: 'Enter', metaKey: true });
    await waitFor(() => expect(server.sent).toHaveLength(1));
    await screen.findByText('1 comment goes with your next message');
    fireEvent.change(box(), { target: { value: '/compact' } });
    fireEvent.keyDown(box(), { key: 'Enter', metaKey: true });
    await waitFor(() => expect(server.sent).toHaveLength(2));
    expect(server.sent[1]!.text).toBe('/compact');
    expect(screen.getByText('1 comment goes with your next message')).toBeTruthy();
  });

  it('are sent on their own with Send now, from Changes and files', async () => {
    setComments(SESSION, [comment]);
    session();
    await loaded();
    fireEvent.click(screen.getByLabelText('Changes and files'));
    fireEvent.click(await screen.findByText('Send now'));
    await waitFor(() => expect(server.sent).toHaveLength(1));
    expect(server.sent[0]!.text).toBe(said);
  });

  it('written before a new session starts, go with its first message', async () => {
    setComments(`new:${CWD}`, [comment]);
    fresh();
    sendText('Start with the theme');
    await waitFor(() => expect(server.sent).toHaveLength(1));
    expect(server.sent[0]!.text).toBe(`${said}\n\nStart with the theme`);
    expect(commentsOf(`new:${CWD}`)).toEqual([]);
  });
});

describe('Commit, Push and Create PR', () => {
  it('fill the message box with a request to Claude, to be read and sent from there: nothing runs', async () => {
    server.git = { repo: true, branch: 'feat/x', base: 'main', remote: true, files: [{ path: 'src/a.ts', status: 'modified', added: 1 }] };
    session();
    await loaded();
    fireEvent.change(box(), { target: { value: 'First this.' } });
    fireEvent.click(screen.getByLabelText('Changes and files'));
    fireEvent.click(await screen.findByRole('button', { name: 'Create PR' }, LAZY));
    await waitFor(() => expect(box().value).toMatch(/^First this\.\n\nCreate a pull request from feat\/x into main/));
    expect(server.sent).toEqual([]);
  });
});

describe('a file open in Changes and files', () => {
  const open = async () => {
    media['(min-width: 1024px)'] = true;
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
    const quotes = await screen.findByRole('list', { name: 'Quotes' });
    expect(within(quotes).getByText('a.ts:1-2')).toBeTruthy();
    expect(box().value).toBe('First this.');
    getSelection()!.removeAllRanges();
  });

  it('mentions the file in the message box, after what is typed', async () => {
    const pane = await open();
    fireEvent.click(within(pane).getByRole('button', { name: 'Mention' }));
    await waitFor(() => expect(box().value).toBe('First this. @src/a.ts '));
    expect(screen.queryByRole('list', { name: 'Quotes' })).toBeNull();
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
    fireEvent.click(screen.getByRole('button', { name: 'Session menu' }));
    await screen.findByRole('dialog');
    ctrlO();
    expect(screen.queryByText(thinking)).toBeNull();
  });
});

describe('a session another app is waiting in, while Claude is idle here', () => {
  it('says so, and that a message sent here starts a second Claude', async () => {
    server.session = { status: 'waiting', runningIn: 'the terminal' };
    server.run = { sessionId: SESSION, cwd: CWD, busy: false, settings: {}, permissions: [], partial: [] };
    session();
    const header = (await screen.findByText('Needs you in the terminal')).closest('header');
    expect(header).toBeTruthy();
    expect(screen.getByText(/Claude is waiting for an answer in the terminal; answer it there\. A message sent here starts a second Claude/)).toBeTruthy();
    expect(box().placeholder).toBe('Needs you in the terminal · a message starts a second Claude');
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
