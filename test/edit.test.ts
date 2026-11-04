import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let root: string;
let cwd: string;
const SESSION = '11111111-2222-4333-8444-555555555555';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const saved = { ...process.env };

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'pelican-edit-'));
  cwd = path.join(root, 'project');
  await mkdir(cwd);
  const claude = path.join(root, 'claude');
  const dir = path.join(claude, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  await mkdir(dir, { recursive: true });
  // Two turns: prompt 1 / reply 2, prompt 3 / reply 4.
  const row = (n: number, parent: number | null, type: 'user' | 'assistant', text: string) => JSON.stringify({
    parentUuid: parent === null ? null : uuid(parent), isSidechain: false, userType: 'external', cwd, sessionId: SESSION, version: '2.1.318',
    type, uuid: uuid(n), timestamp: new Date(Date.UTC(2026, 10, 5, 6, 0, n)).toISOString(),
    message: type === 'user' ? { role: 'user', content: text } : { id: `msg_${n}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }] },
  });
  await writeFile(path.join(dir, `${SESSION}.jsonl`), [row(1, null, 'user', 'first'), row(2, 1, 'assistant', 'one'), row(3, 2, 'user', 'second'), row(4, 3, 'assistant', 'two')].join('\n') + '\n');
  // A Claude that exits at once: nothing here needs a real one.
  const fake = path.join(root, 'fake-claude');
  await writeFile(fake, '#!/bin/sh\nexit 1\n');
  await chmod(fake, 0o755);
  Object.assign(process.env, { CLAUDE_CONFIG_DIR: claude, PELICAN_CLAUDE_PATH: fake, PELICAN_AUTH: 'none', PELICAN_STATE_DIR: path.join(root, 'state'), PELICAN_CONFIG_DIR: path.join(root, 'config') });
});
afterAll(async () => {
  process.env = { ...saved };
  await rm(root, { recursive: true, force: true });
});

const edit = async (before: number, key: string) => {
  const { app } = await import('../src/server/app');
  const response = await app.request(`/api/sessions/${SESSION}/edit`, {
    method: 'POST',
    headers: { host: 'localhost:7860', 'x-pelican': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ before: uuid(before), text: 'changed', settings: { permissionMode: 'bypassPermissions' }, uuid: key, keepImages: [] }),
  });
  return { status: response.status, body: await response.json() as { sessionId?: string; inPlace?: boolean; error?: string } };
};

describe('editing a prompt', () => {
  it('replaces the last prompt in this session', async () => {
    const { status, body } = await edit(3, 'aaaaaaaa-0000-4000-8000-000000000001');
    expect(status).toBe(200);
    expect(body).toEqual({ sessionId: SESSION, inPlace: true });
  });

  it('branches for an earlier prompt, and a retry gets the same answer', async () => {
    // The replaced turn's Claude (a fake one here) has to finish first, as for any edit.
    const { getRun } = await import('../src/server/runner');
    for (let i = 0; i < 100 && getRun(SESSION); i += 1) await new Promise((r) => setTimeout(r, 50));
    const files = async () => readdir(path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-')));
    const before = (await files()).length;
    const first = await edit(1, 'aaaaaaaa-0000-4000-8000-000000000002');
    // The first prompt has nothing before it: a new session in the same folder, not this one.
    expect(first.body.error ?? first.status).toBe(200);
    expect(first.body.inPlace).toBe(false);
    expect(first.body.sessionId).not.toBe(SESSION);
    const again = await edit(1, 'aaaaaaaa-0000-4000-8000-000000000002');
    expect(again.body).toEqual(first.body);
    expect((await files()).length).toBeLessThanOrEqual(before + 1);
  });
});
