// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Attachment, GitStatus, RunState, SessionSummary } from '../src/shared/protocol';

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
  session: {} as Partial<SessionSummary>,
  run: null as RunState | null,
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
const { loadDraft } = await import('../src/web/lib/drafts');
const { setPrefs } = await import('../src/web/lib/prefs');
const { commentsOf, setComments } = await import('../src/web/lib/review');
const { setRun } = await import('../src/web/lib/store');

afterEach(() => {
  cleanup();
  localStorage.clear();
  for (const chat of [SESSION, OTHER, `new:${CWD}`, CWD]) setComments(chat, []);
  media = {};
  Object.assign(server, { answers: [], hold: undefined, sent: [], session: {}, run: null, gitReads: 0, git: { repo: false } });
  // A view of Changes and files left open keeps its step in the address.
  history.replaceState(null, '', '/');
});

const wrap = (node: React.ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);
const session = (id = SESSION) => wrap(<Chat sessionId={id} home="/home/me" machine="studio" demo wide onBack={() => {}} onOpen={() => {}} onStartIn={() => {}} />);
const fresh = () => wrap(<Chat newCwd={CWD} home="/home/me" machine="studio" wide onBack={() => {}} onOpen={() => {}} onStartIn={() => {}} />);
const box = () => screen.getByLabelText('Message Claude') as HTMLTextAreaElement;
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
    history.replaceState(null, '', `/?s=${SESSION}&w=files&p=src%2Fa.ts`);
    try {
      session();
      await loaded();
      // Written in the file this session's pane shows.
      await waitFor(() => expect(document.querySelector('[data-line="2"]')).toBeTruthy());
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
    server.git = { repo: true, branch: 'feat/x', base: 'main', files: [{ path: 'src/a.ts', status: 'modified', added: 1 }] };
    session();
    await loaded();
    fireEvent.change(box(), { target: { value: 'First this.' } });
    fireEvent.click(screen.getByLabelText('Changes and files'));
    fireEvent.click(await screen.findByRole('button', { name: 'Create PR' }));
    await waitFor(() => expect(box().value).toMatch(/^First this\.\n\nCreate a pull request from feat\/x into main/));
    expect(server.sent).toEqual([]);
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
