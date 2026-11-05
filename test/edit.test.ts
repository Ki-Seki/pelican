import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Claude itself is not started here: the runner's calls are stand-ins that record what they got.
const calls = vi.hoisted(() => ({ replace: [] as string[], send: [] as string[], modes: [] as Array<string | undefined>, fork: [] as string[], remove: [] as string[], failSend: false }));
vi.mock('../src/server/runner', async (original) => ({
  ...(await original<typeof import('../src/server/runner')>()),
  getRun: () => undefined,
  replaceLastTurn: async (sessionId: string, _cwd: string, entry: string) => {
    calls.replace.push(entry);
    return sessionId;
  },
  sendMessage: async (target: { sessionId?: string; cwd?: string }, input: { settings: { permissionMode?: string } }) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    calls.send.push(target.sessionId ?? 'new session');
    calls.modes.push(input.settings.permissionMode);
    if (calls.failSend) throw new Error('Claude Code process exited with code 1');
    return target.sessionId ?? '99999999-9999-4999-8999-999999999999';
  },
}));
vi.mock('../src/server/actions', async (original) => ({
  ...(await original<typeof import('../src/server/actions')>()),
  fork: async (_id: string, upTo: string) => {
    calls.fork.push(upTo);
    return '88888888-8888-4888-8888-888888888888';
  },
  remove: async (id: string) => {
    calls.remove.push(id);
  },
}));

let root: string;
let cwd: string;
const SESSION = '11111111-2222-4333-8444-555555555555';
const BRANCH = '88888888-8888-4888-8888-888888888888';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const key = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const saved = { ...process.env };

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'pelican-edit-'));
  cwd = path.join(root, 'project');
  await mkdir(cwd);
  const claude = path.join(root, 'claude');
  const dir = path.join(claude, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  await mkdir(dir, { recursive: true });
  // Three turns: prompts 1, 3 and 5, each with its reply.
  const row = (n: number, type: 'user' | 'assistant', text: string) => JSON.stringify({
    parentUuid: n === 1 ? null : uuid(n - 1), isSidechain: false, userType: 'external', cwd, sessionId: SESSION, version: '2.1.318',
    type, uuid: uuid(n), timestamp: new Date(Date.UTC(2026, 10, 5, 6, 0, n)).toISOString(),
    message: type === 'user' ? { role: 'user', content: text } : { id: `msg_${n}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }] },
  });
  const rows = [row(1, 'user', 'first'), row(2, 'assistant', 'one'), row(3, 'user', 'second'), row(4, 'assistant', 'two'), row(5, 'user', 'third'), row(6, 'assistant', 'three')];
  await writeFile(path.join(dir, `${SESSION}.jsonl`), `${rows.join('\n')}\n`);
  Object.assign(process.env, { CLAUDE_CONFIG_DIR: claude, PELICAN_AUTH: 'none', PELICAN_STATE_DIR: path.join(root, 'state'), PELICAN_CONFIG_DIR: path.join(root, 'config') });
});
afterAll(async () => {
  process.env = { ...saved };
  await rm(root, { recursive: true, force: true });
});
beforeEach(() => {
  Object.assign(calls, { replace: [], send: [], modes: [], fork: [], remove: [], failSend: false });
});

const edit = async (before: number, id: string, extra: Record<string, unknown> = {}) => {
  const { app } = await import('../src/server/app');
  const response = await app.request(`/api/sessions/${SESSION}/edit`, {
    method: 'POST',
    headers: { host: 'localhost:7860', 'x-pelican': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ before: uuid(before), text: 'changed', settings: {}, uuid: id, keepImages: [], ...extra }),
  });
  return { status: response.status, body: await response.json() as { sessionId?: string; inPlace?: boolean; error?: string } };
};

describe('editing a prompt', () => {
  it('replaces the last prompt in this session, going on from the row before it', async () => {
    const { status, body } = await edit(5, key(1));
    expect(status).toBe(200);
    expect(body).toEqual({ sessionId: SESSION, inPlace: true });
    expect(calls.replace).toEqual([uuid(4)]);
    expect(calls.fork).toEqual([]);
  });

  it('branches for an earlier prompt, and requests sent together make one branch', async () => {
    const [first, second] = await Promise.all([edit(3, key(2)), edit(3, key(2))]);
    expect(first).toEqual({ status: 200, body: { sessionId: BRANCH, inPlace: false } });
    expect(second).toEqual(first);
    expect(calls.fork).toEqual([uuid(2)]);
    expect(calls.send).toEqual([BRANCH]);
    expect((await edit(3, key(2))).body).toEqual(first.body);
    expect(calls.send).toHaveLength(1);
  });

  it('starts a new session for the first prompt', async () => {
    const { body } = await edit(1, key(3));
    expect(body.inPlace).toBe(false);
    expect(calls.fork).toEqual([]);
    expect(calls.send).toEqual(['new session']);
  });

  it('starts a branch of a session in Bypass in the mode a new session would, never in Bypass', async () => {
    const bypass = { settings: { permissionMode: 'bypassPermissions' } };
    await edit(3, key(5), bypass);
    // No mode picked in Settings and none in Claude Code's settings: Auto.
    expect(calls.modes).toEqual(['auto']);
    await edit(3, key(6), { ...bypass, startMode: 'plan' });
    expect(calls.modes.at(-1)).toBe('plan');
    // A pick of Bypass is no pick.
    await edit(3, key(7), { ...bypass, startMode: 'bypassPermissions' });
    expect(calls.modes.at(-1)).toBe('auto');
    await writeFile(path.join(root, 'claude', 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'acceptEdits' } }));
    await edit(3, key(8), bypass);
    expect(calls.modes.at(-1)).toBe('acceptEdits');
    // Another mode is the session's own: the branch goes on in it.
    await edit(3, key(9), { settings: { permissionMode: 'plan' }, startMode: 'auto' });
    expect(calls.modes.at(-1)).toBe('plan');
  });

  it('leaves no branch behind when Claude cannot start', async () => {
    calls.failSend = true;
    const { status } = await edit(3, key(4));
    expect(status).toBe(500);
    expect(calls.remove).toEqual([BRANCH]);
  });
});
