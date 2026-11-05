import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadAuth, refreshAuth, resetToken } from '../src/server/auth';
import { config } from '../src/server/config';
import { addSubscription, initPush, notify, subscribedEndpoints } from '../src/server/push';

let dir: string;
const saved = { ...config };
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'pelican-push-'));
  config.configDir = path.join(dir, 'config');
  config.stateDir = path.join(dir, 'state');
  config.auth = 'auto';
  await loadAuth();
  await initPush();
});
afterAll(async () => {
  Object.assign(config, saved);
  await rm(dir, { recursive: true, force: true });
});

const subscription = { endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } };

describe('notifications', () => {
  it('stop for every device once a new token signs browsers out, and are forgotten', async () => {
    await addSubscription(subscription);
    expect(subscribedEndpoints()).toEqual([subscription.endpoint]);
    await resetToken();
    refreshAuth(Date.now() + 1500, true);
    expect(subscribedEndpoints()).toEqual([]);
    // Nothing is sent to it, and it is dropped from the saved list.
    await notify({ title: 't', body: 'b', sessionId: 's', tag: 'x' });
    const stored = JSON.parse(await readFile(path.join(config.stateDir, 'push-subscriptions.json'), 'utf8')) as unknown[];
    expect(stored).toEqual([]);
  });
});
