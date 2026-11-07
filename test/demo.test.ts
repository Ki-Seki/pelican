import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage, RunState, ServerInfo } from '../src/shared/protocol';

// The page's own address, as in a browser.
Object.assign(globalThis, { location: new URL('http://localhost:7860/') });
const { advance, DEMO_REPLY, DEMO_SIDE_REPLY, rewindPreview, startDemo } = await import('../src/web/lib/demo');
const { api, isDemoNote } = await import('../src/web/lib/api');
const { addLocalMessage, getView, setRun } = await import('../src/web/lib/store');
const { DEMO_NOTE } = await import('../src/web/lib/static-demo');
const { FIRST_MESSAGE, NOTHING_TO_UNDO } = await import('../src/shared/rewind');

const CWD = '/demo/code/acme-web';
const todo = (content: string, status: 'pending' | 'in_progress' | 'completed') => ({ content, status, activeForm: `${content}ing` });
const tasks = [todo('Add dark colors', 'completed'), todo('Add the toggle', 'in_progress'), todo('Remember the choice', 'pending'), todo('Run the tests', 'pending')];

/** Claude waiting to edit a file, as a run of the session's. */
const waitingIn = (sessionId: string): RunState => ({
  sessionId,
  cwd: CWD,
  busy: true,
  settings: { model: 'default' },
  partial: [],
  permissions: [{
    id: 'demo-permission', sessionId, toolName: 'Edit', always: 'Allow all edits this session', createdAt: 0,
    input: { file_path: `${CWD}/src/settings/Settings.tsx`, old_string: 'a\nb', new_string: 'a\nb\nc' },
  }],
});

const message = (uuid: string, role: ChatMessage['role'], blocks: ChatMessage['blocks']): ChatMessage => ({ uuid, role, blocks, timestamp: 1 });

beforeAll(() => {
  vi.useFakeTimers();
  startDemo({ machine: 'laptop', home: '/demo', version: '0', auth: false, demo: true } satisfies ServerInfo);
});

// Each test has a session of its own, at the same place: a dark theme under way, an edit to allow.
let made = 0;
let SESSION: string;
let waiting: RunState;
beforeEach(() => {
  made += 1;
  SESSION = `a3f1c2d4-1111-4a1b-8c3d-${String(made).padStart(12, '0')}`;
  waiting = waitingIn(SESSION);
  addLocalMessage(SESSION, message('m1', 'user', [{ type: 'text', text: 'Add a dark theme' }]));
  addLocalMessage(SESSION, message('m2', 'assistant', [{ type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: tasks } }]));
  addLocalMessage(SESSION, message('m3', 'assistant', [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: `${CWD}/theme.css`, old_string: 'x', new_string: 'x\ny\nz' } }]));
  setRun(SESSION, waiting);
});
afterEach(() => vi.runAllTimers());

describe('the demo', () => {
  it('plays Allow out: the edit lands, the next task starts, Claude says what it did, the turn ends', async () => {
    await expect(api.decide(SESSION, 'demo-permission', { behavior: 'allow' })).resolves.toEqual({ ok: true });
    expect(getView(SESSION).run).toMatchObject({ busy: true, permissions: [] });
    vi.runAllTimers();
    const view = getView(SESSION);
    const blocks = view.messages.flatMap((m) => m.blocks);
    expect(blocks).toContainEqual(expect.objectContaining({ type: 'tool_use', name: 'Edit', input: waiting.permissions[0]!.input }));
    expect(blocks).toContainEqual(expect.objectContaining({ type: 'tool_result', content: `The file ${CWD}/src/settings/Settings.tsx has been updated successfully.` }));
    const update = blocks.findLast((b) => b.type === 'tool_use' && b.name === 'TodoWrite');
    expect(update?.type === 'tool_use' && update.input.todos).toEqual(advance(tasks));
    expect(view.messages.at(-1)?.blocks[0]).toMatchObject({ type: 'text', text: expect.stringContaining('The toggle is in place') });
    expect(view.run).toMatchObject({ busy: false, permissions: [] });
  });

  it('answers a message with what Claude would do, and keeps it when the page is read again', async () => {
    // Once the turn under way has ended.
    await api.decide(SESSION, 'demo-permission', { behavior: 'allow' });
    vi.runAllTimers();
    await api.send(SESSION, { text: 'Use the system setting', attachments: [], settings: {}, uuid: 'mine' });
    vi.runAllTimers();
    const messages = getView(SESSION).messages;
    expect(messages.find((m) => m.uuid === 'mine')).toMatchObject({ role: 'user', blocks: [{ type: 'text', text: 'Use the system setting' }] });
    expect(messages.at(-1)?.blocks[0]).toEqual({ type: 'text', text: DEMO_REPLY });
    expect(getView(SESSION).run?.busy).toBe(false);
  });

  it('says calmly, in one wording, what it does not act out', async () => {
    const refused = await api.fork(SESSION).catch((error: unknown) => error);
    expect(isDemoNote(refused)).toBe(true);
    expect((refused as Error).message).toBe(DEMO_NOTE);
    const upload = await api.upload(new File(['x'], 'a.txt')).catch((error: unknown) => error);
    expect(isDemoNote(upload)).toBe(true);
  });

  it('shows what Rewind would put back, from the conversation', async () => {
    // The edit allowed, then a prompt that edits nothing.
    await api.decide(SESSION, 'demo-permission', { behavior: 'allow' });
    vi.runAllTimers();
    await api.send(SESSION, { text: 'Use the system setting', attachments: [], settings: {}, uuid: 'mine' });
    vi.runAllTimers();
    // The first message: only its code can go back, as nothing comes before it to start again from.
    expect(rewindPreview(getView(SESSION).messages, 'm1')).toMatchObject({ files: [`${CWD}/theme.css`, `${CWD}/src/settings/Settings.tsx`], conversationStays: FIRST_MESSAGE });
    expect(rewindPreview(getView(SESSION).messages, 'mine')).toEqual({ files: [], insertions: 0, deletions: 0 });
    // An edit's lines count as they change back: the lines its old and new text share stay.
    const edit: ChatMessage = { uuid: 'e1', role: 'assistant', blocks: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: `${CWD}/tests/login.spec.ts`, old_string: "  await page.click('text=Sign in');\n  await page.waitForTimeout(500);", new_string: "  await page.click('text=Sign in');\n  await expect(page).toHaveURL('/home');" } }] };
    expect(rewindPreview([{ uuid: 'p1', role: 'user', blocks: [{ type: 'text', text: 'Fix it' }] }, edit], 'p1')).toMatchObject({ insertions: 1, deletions: 1 });
  });

  it('rewinds the conversation in the page: back to before the prompt, its words for the box, until Undo rewind or the next message', async () => {
    const { sessionId } = await api.create({ cwd: CWD, text: 'Add a footer', attachments: [], settings: {}, uuid: 'first' });
    vi.runAllTimers();
    await api.send(sessionId, { text: 'Make it dark', attachments: [], settings: {}, uuid: 'second' });
    vi.runAllTimers();
    expect(await api.rewindCheck(sessionId, 'second')).toEqual({ files: [], insertions: 0, deletions: 0 });
    await expect(api.rewind(sessionId, 'second', 'conversation')).resolves.toEqual({ prompt: { text: 'Make it dark', attachments: [] } });
    const rewound = await api.messages(sessionId);
    expect(rewound.messages.map((m) => m.uuid)).not.toContain('second');
    expect(rewound.rewound).toEqual({ prompt: 'second', at: expect.any(Number) });
    await expect(api.undoRewind(sessionId)).resolves.toEqual({ ok: true });
    expect((await api.messages(sessionId)).messages.map((m) => m.uuid)).toContain('second');
    // Rewound again, then a message: it goes after the cut, and Undo is over.
    await api.rewind(sessionId, 'second', 'conversation');
    await api.send(sessionId, { text: 'Make it blue', attachments: [], settings: {}, uuid: 'third' });
    vi.runAllTimers();
    const after = await api.messages(sessionId);
    expect(after.messages.map((m) => m.uuid)).toEqual(expect.arrayContaining(['first', 'third']));
    expect(after.messages.map((m) => m.uuid)).not.toContain('second');
    expect(after.rewound).toBeUndefined();
    const undo = await api.undoRewind(sessionId).catch((error: unknown) => error);
    expect((undo as Error).message).toBe(NOTHING_TO_UNDO);
    // The first message has nothing before it to start again from.
    const first = await api.rewind(sessionId, 'first', 'conversation').catch((error: unknown) => error);
    expect((first as Error).message).toBe(FIRST_MESSAGE);
  });

  it('starts a new session in the page, which the list and the chat then show', async () => {
    const { sessionId } = await api.create({ cwd: CWD, text: 'Add a footer', attachments: [], settings: {}, uuid: 'first' });
    vi.runAllTimers();
    const detail = await api.session(sessionId);
    expect(detail.session).toMatchObject({ title: 'Add a footer', cwd: CWD, project: 'acme-web', status: 'idle' });
    const page = await api.messages(sessionId);
    expect(page.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('asks a side question in a side chat of the session’s, listed under it, and says what Claude would do there', async () => {
    const { sessionId } = await api.side(SESSION, { question: 'Why CSS variables?', settings: { permissionMode: 'bypassPermissions' }, uuid: 'side-q' });
    expect(sessionId).not.toBe(SESSION);
    vi.runAllTimers();
    const messages = getView(sessionId).messages;
    expect(messages.map((m) => m.uuid)[0]).toBe('side-q');
    expect(messages.at(-1)?.blocks[0]).toEqual({ type: 'text', text: DEMO_SIDE_REPLY });
    expect(getView(sessionId).run?.settings.permissionMode).toBe('dontAsk');
    expect((await api.session(sessionId)).session).toMatchObject({ title: 'Side chat', sideChatOf: SESSION });
    // A later question goes to the same side chat.
    await api.send(sessionId, { text: 'And the toggle?', attachments: [], settings: {}, uuid: 'side-q2' });
    vi.runAllTimers();
    expect(getView(sessionId).messages.at(-1)?.blocks[0]).toEqual({ type: 'text', text: DEMO_SIDE_REPLY });
  });

  it('stops when asked, as Claude would', async () => {
    setRun(SESSION, waiting);
    await api.interrupt(SESSION);
    expect(getView(SESSION).run).toMatchObject({ busy: false, permissions: [] });
    expect(getView(SESSION).messages.at(-1)?.blocks[0]).toEqual({ type: 'text', text: '[Request interrupted by user]' });
  });
});

describe('the demo, a message queued while Claude works', () => {
  const queue = (uuid: string, text: string) => api.send(SESSION, { text, attachments: [], settings: {}, uuid, mode: 'queue' });
  const said = (uuid: string) => getView(SESSION).messages.find((m) => m.uuid === uuid);

  it('waits above the composer, not in the conversation, then goes when the turn ends, with any other, as one message', async () => {
    setRun(SESSION, waiting);
    await queue('q1', 'Also add a test for the toggle');
    await queue('q2', 'And mention it in the README');
    expect(getView(SESSION).run?.queued).toEqual([{ uuid: 'q1', text: 'Also add a test for the toggle' }, { uuid: 'q2', text: 'And mention it in the README' }]);
    expect(said('q1')).toBeUndefined();
    await api.decide(SESSION, 'demo-permission', { behavior: 'allow' });
    vi.runAllTimers();
    expect(said('q1')).toMatchObject({ role: 'user', blocks: [{ type: 'text', text: 'Also add a test for the toggle\n\nAnd mention it in the README' }] });
    expect(said('q2')).toBeUndefined();
    expect(getView(SESSION).messages.at(-1)?.blocks[0]).toEqual({ type: 'text', text: DEMO_REPLY });
    expect(getView(SESSION).run).toMatchObject({ busy: false });
    expect(getView(SESSION).run?.queued).toBeUndefined();
  });

  it('still goes after Stop, as in your own Pelican', async () => {
    setRun(SESSION, waiting);
    await queue('q3', 'Then run the tests');
    await api.interrupt(SESSION);
    const messages = getView(SESSION).messages;
    expect(messages.at(-2)?.blocks[0]).toEqual({ type: 'text', text: '[Request interrupted by user]' });
    expect(messages.at(-1)).toMatchObject({ uuid: 'q3', blocks: [{ type: 'text', text: 'Then run the tests' }] });
    expect(getView(SESSION).run).toMatchObject({ busy: true });
    expect(getView(SESSION).run?.queued).toBeUndefined();
    vi.runAllTimers();
    expect(getView(SESSION).messages.at(-1)?.blocks[0]).toEqual({ type: 'text', text: DEMO_REPLY });
    expect(getView(SESSION).run?.busy).toBe(false);
  });

  it('can be taken back before Claude gets it, once', async () => {
    setRun(SESSION, waiting);
    await queue('q4', 'Never mind the README');
    await queue('q5', 'Keep the old toggle label');
    await expect(api.unqueue(SESSION, 'q4')).resolves.toEqual({ ok: true });
    expect(getView(SESSION).run?.queued).toEqual([{ uuid: 'q5', text: 'Keep the old toggle label' }]);
    const again = await api.unqueue(SESSION, 'q4').catch((error: unknown) => error);
    expect(again).toMatchObject({ status: 409, message: 'That message is no longer waiting' });
    expect(isDemoNote(again)).toBe(false);
    await api.unqueue(SESSION, 'q5');
    expect(getView(SESSION).run?.queued).toBeUndefined();
    await api.interrupt(SESSION);
    vi.runAllTimers();
    expect(said('q4')).toBeUndefined();
    expect(said('q5')).toBeUndefined();
    expect(getView(SESSION).run?.busy).toBe(false);
  });
});

describe('advance', () => {
  it('finishes the task under way and starts the next', () => {
    expect(advance(tasks)?.map((t) => t.status)).toEqual(['completed', 'completed', 'in_progress', 'pending']);
    expect(advance([todo('Only', 'pending')])).toBeUndefined();
  });
});

describe('what new sessions start with, in the demo', () => {
  it('is the demo server’s answer, Claude Code’s defaults from no file, changed in the page alone', async () => {
    const { BUILT_IN } = await import('./start-defaults');
    const fetched: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      fetched.push(`${init?.method ?? 'GET'} ${url}`);
      return new Response(JSON.stringify(BUILT_IN), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    try {
      expect(await api.defaults()).toMatchObject({ model: { value: 'default', source: 'built-in' }, permissionMode: { value: 'auto' } });
      expect(await api.saveDefault({ model: 'sonnet' })).toMatchObject({ model: { value: 'sonnet', source: 'user' } });
      expect(await api.saveDefault({ effort: { model: 'sonnet', level: 'high' } })).toMatchObject({ effort: { byModel: { sonnet: { level: 'high', source: 'user' } } } });
      expect(await api.saveDefault({ permissionMode: 'plan' })).toMatchObject({ permissionMode: { value: 'plan', source: 'user' } });
      // A new session's folder gets the same, from the page.
      expect(await api.defaults(CWD)).toMatchObject({ model: { value: 'sonnet' }, permissionMode: { value: 'plan' } });
      const bypass = await api.saveDefault({ permissionMode: 'bypassPermissions' }).catch((error: unknown) => error);
      expect(isDemoNote(bypass)).toBe(true);
      // The demo's server was asked once, to read; nothing was sent to change anything.
      expect(fetched).toEqual(['GET http://localhost:7860/api/defaults']);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
