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

describe('a notification’s title, the session’s', () => {
  const titleOf = async (title: string) => {
    await notify({ title, body: 'Fixed.', sessionId: 's-1', tag: 's-1:done' });
    return (JSON.parse(sent.at(-1)!.body) as { title: string }).title;
  };

  it('leaves out what hides text or turns it around, as the text does, and keeps emoji whole', async () => {
    // A session can be called anything: by a /rename, or by the first prompt.
    expect(await titleOf('Fix the \u202elogin\u2066 test\u200b')).toBe('Fix the login test');
    expect(await titleOf('Deploy\u2028notes\u0007 \u{e0041}done')).toBe('Deploy notes done');
    expect(await titleOf('\u26a0\ufe0f Deploy \u{1f469}\u200d\u{1f4bb}')).toBe('\u26a0\ufe0f Deploy \u{1f469}\u200d\u{1f4bb}');
  });

  it('is Claude Code when nothing of it shows', async () => {
    expect(await titleOf('\u2066\u2069\u200b')).toBe('Claude Code');
  });
});
