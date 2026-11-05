import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ChatMessage, RunState, ServerInfo } from '../src/shared/protocol';

// The page's own address, as in a browser.
Object.assign(globalThis, { location: new URL('http://localhost:7860/') });
const { advance, DEMO_REPLY, rewindPreview, startDemo } = await import('../src/web/lib/demo');
const { api, isDemoNote } = await import('../src/web/lib/api');
const { addLocalMessage, getView, setRun } = await import('../src/web/lib/store');
const { DEMO_NOTE } = await import('../src/web/lib/static-demo');

const CWD = '/demo/code/acme-web';
const SESSION = 'a3f1c2d4-1111-4a1b-8c3d-000000000001';
const todo = (content: string, status: 'pending' | 'in_progress' | 'completed') => ({ content, status, activeForm: `${content}ing` });
const tasks = [todo('Add dark colors', 'completed'), todo('Add the toggle', 'in_progress'), todo('Remember the choice', 'pending'), todo('Run the tests', 'pending')];

const waiting: RunState = {
  sessionId: SESSION,
  cwd: CWD,
  busy: true,
  settings: { model: 'default' },
  partial: [],
  permissions: [{
    id: 'demo-permission', sessionId: SESSION, toolName: 'Edit', always: 'Allow all edits this session', createdAt: 0,
    input: { file_path: `${CWD}/src/settings/Settings.tsx`, old_string: 'a\nb', new_string: 'a\nb\nc' },
  }],
};

const message = (uuid: string, role: ChatMessage['role'], blocks: ChatMessage['blocks']): ChatMessage => ({ uuid, role, blocks, timestamp: 1 });

beforeAll(() => {
  vi.useFakeTimers();
  startDemo({ machine: 'laptop', home: '/demo', version: '0', auth: false, demo: true } satisfies ServerInfo);
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

  it('shows what Rewind would put back, from the conversation', () => {
    expect(rewindPreview(getView(SESSION).messages, 'm1')).toMatchObject({ canRewind: true, files: [`${CWD}/theme.css`, `${CWD}/src/settings/Settings.tsx`] });
    expect(rewindPreview(getView(SESSION).messages, 'mine')).toEqual({ canRewind: false });
  });

  it('starts a new session in the page, which the list and the chat then show', async () => {
    const { sessionId } = await api.create({ cwd: CWD, text: 'Add a footer', attachments: [], settings: {}, uuid: 'first' });
    vi.runAllTimers();
    const detail = await api.session(sessionId);
    expect(detail.session).toMatchObject({ title: 'Add a footer', cwd: CWD, project: 'acme-web', status: 'idle' });
    const page = await api.messages(sessionId);
    expect(page.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('stops when asked, as Claude would', async () => {
    setRun(SESSION, waiting);
    await api.interrupt(SESSION);
    expect(getView(SESSION).run).toMatchObject({ busy: false, permissions: [] });
    expect(getView(SESSION).messages.at(-1)?.blocks[0]).toEqual({ type: 'text', text: '[Request interrupted by user]' });
  });
});

describe('advance', () => {
  it('finishes the task under way and starts the next', () => {
    expect(advance(tasks)?.map((t) => t.status)).toEqual(['completed', 'completed', 'in_progress', 'pending']);
    expect(advance([todo('Only', 'pending')])).toBeUndefined();
  });
});
