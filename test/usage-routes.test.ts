import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { app } from '../src/server/app';
import { accessToken, loadAuth } from '../src/server/auth';
import { config } from '../src/server/config';
import { resetUsage } from '../src/server/stats';

const ID = '55555555-5555-4555-8555-555555555555';
const ask = (url: string, headers: Record<string, string> = {}) =>
  app.request(url, { headers: { host: 'localhost:7860', 'x-pelican': '1', authorization: `Bearer ${accessToken()}`, ...headers } });

beforeAll(async () => {
  config.auth = 'auto';
  await loadAuth();
  resetUsage();
  const dir = path.join(config.claudeHome, 'projects', '-work-app');
  await mkdir(dir, { recursive: true });
  const time = new Date(Date.now() - 3_600_000).toISOString();
  await writeFile(path.join(dir, `${ID}.jsonl`), `${[
    JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, isSidechain: false, timestamp: time, cwd: '/work/app', sessionId: ID, message: { role: 'user', content: 'Add a footer' } }),
    JSON.stringify({
      parentUuid: 'u1', isSidechain: false, type: 'assistant', uuid: 'a1', timestamp: time, cwd: '/work/app', sessionId: ID, requestId: 'req_1', entrypoint: 'claude-vscode',
      message: { id: 'msg_1', model: 'claude-sonnet-4-5-20250929', role: 'assistant', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 3, output_tokens: 40, cache_read_input_tokens: 900, cache_creation_input_tokens: 100 } },
    }),
  ].join('\n')}\n`);
});
afterAll(() => rm(config.claudeHome, { recursive: true, force: true }));

describe('the usage routes', () => {
  it('are behind the same sign-in and mark as every other route', async () => {
    expect((await ask('/api/usage/stats', { authorization: '' })).status).toBe(401);
    expect((await ask('/api/usage/stats', { 'x-pelican': '' })).status).toBe(403);
    expect((await ask(`/api/sessions/${ID}/usage`, { authorization: '' })).status).toBe(401);
  });

  it('answer with every session’s usage, read before the first answer when there is little', async () => {
    const { summary } = await (await ask('/api/usage/stats?range=30d')).json() as { summary: Record<string, unknown> };
    expect(summary).toMatchObject({
      range: '30d',
      tokens: { input: 3, output: 40, cacheRead: 900, cacheWrite: 100 },
      models: [{ model: 'claude-sonnet-4-5-20250929', name: 'Sonnet 4.5', tokens: 1043 }],
      apps: [{ app: 'VS Code', tokens: 1043, sessions: 1 }],
      sessions: [{ id: ID, title: 'Add a footer', project: 'app' }],
      progress: { files: 1, read: 1, ready: true },
    });
    // A period it does not know is the last 7 days.
    expect(((await (await ask('/api/usage/stats?range=forever')).json()) as { summary: { range: string } }).summary.range).toBe('7d');
  });

  it('answer for one session, and for a name that is not a session id with nothing', async () => {
    const { usage } = await (await ask(`/api/sessions/${ID}/usage`)).json() as { usage: Record<string, unknown> };
    expect(usage).toMatchObject({ tokens: { output: 40 }, models: [{ name: 'Sonnet 4.5' }], compactions: 0 });
    expect(await (await ask('/api/sessions/..%2F..%2Fetc/usage')).json()).toEqual({ usage: null });
    expect(await (await ask('/api/sessions/66666666-6666-4666-8666-666666666666/usage')).json()).toEqual({ usage: null });
  });
});
