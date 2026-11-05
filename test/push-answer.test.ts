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

describe('a push', () => {
  const last = () => sent.at(-1)!.body;

  it('stays within what push services carry, link and all, whatever one character of its words holds', async () => {
    // A letter and its marks, joined emoji, the quotes and backslashes JSON doubles, halves of characters.
    for (const text of [`Z${'\u0336\u0301'.repeat(2400)}`, '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}'.repeat(500), '"\\'.repeat(3000), '\ud800'.repeat(3000)]) {
      await notify({ title: text, body: text, sessionId: 's-1', tag: 's-1:ask', request: 'req-1' });
      expect(Buffer.byteLength(last()), JSON.stringify(text.slice(0, 4))).toBeLessThanOrEqual(4096 - 103);
      expect(JSON.parse(last())).toMatchObject({ sessionId: 's-1', request: 'req-1', url: 'https://laptop.example.ts.net/?s=s-1' });
    }
  });

  it('leaves out a link too long to go with it, rather than the notification', async () => {
    config.sessionUrl = `https://laptop.example.ts.net/${'a'.repeat(4000)}?s={id}`;
    try {
      await notify({ title: 'Fix the login test', body: 'Run npm test', sessionId: 's-1', tag: 's-1:ask', request: 'req-1' });
    } finally {
      config.sessionUrl = undefined;
    }
    expect(JSON.parse(last())).toEqual({ title: 'Fix the login test', body: 'Run npm test', sessionId: 's-1', tag: 's-1:ask', request: 'req-1' });
  });
});
