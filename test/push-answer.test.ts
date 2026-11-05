import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const sent = vi.hoisted(() => [] as Array<{ endpoint: string; body: string }>);
vi.mock('web-push', () => ({
  default: {
    generateVAPIDKeys: () => ({ publicKey: 'public', privateKey: 'private' }),
    setVapidDetails: () => {},
    sendNotification: async (subscription: { endpoint: string }, body: string) => {
      sent.push({ endpoint: subscription.endpoint, body });
    },
  },
}));

const { loadAuth } = await import('../src/server/auth');
const { config } = await import('../src/server/config');
const { addSubscription, initPush, notify } = await import('../src/server/push');

let dir: string;
const saved = { ...config };
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'pelican-push-answer-'));
  config.configDir = path.join(dir, 'config');
  config.stateDir = path.join(dir, 'state');
  config.sessionUrl = undefined;
  await loadAuth();
  await initPush();
  await addSubscription({ endpoint: 'https://push.example/phone', keys: { p256dh: 'p', auth: 'a' }, openUrl: 'https://laptop.example.ts.net/?s=' });
});
afterAll(async () => {
  Object.assign(config, saved);
  await rm(dir, { recursive: true, force: true });
});

describe('a notification of a request Claude waits on', () => {
  it('carries the request, for Allow and Deny on the device', async () => {
    await notify({ title: 'Fix the login test', body: 'Run npm test', sessionId: 's-1', tag: 's-1:ask', request: 'req-1' });
    expect(JSON.parse(sent.at(-1)!.body)).toEqual({
      title: 'Fix the login test', body: 'Run npm test', sessionId: 's-1', tag: 's-1:ask', request: 'req-1', url: 'https://laptop.example.ts.net/?s=s-1',
    });
  });

  it('and one of a finished turn carries none', async () => {
    await notify({ title: 'Fix the login test', body: 'Fixed.', sessionId: 's-1', tag: 's-1:done' });
    expect(JSON.parse(sent.at(-1)!.body)).not.toHaveProperty('request');
  });
});
