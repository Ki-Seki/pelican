import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import webpush from 'web-push';

import { config } from './config.js';

type Subscription = webpush.PushSubscription & { openUrl?: string };

const keysFile = () => path.join(config.stateDir, 'vapid.json');
const subsFile = () => path.join(config.stateDir, 'push-subscriptions.json');

let keys: { publicKey: string; privateKey: string } | undefined;
let subscriptions: Subscription[] = [];

async function save(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(value, null, 2), { mode: 0o600 });
}

/** Loads this machine's VAPID keys (created on first start) and the saved subscriptions. */
export async function initPush(): Promise<void> {
  try {
    keys = JSON.parse(await readFile(keysFile(), 'utf8'));
  } catch {
    keys = webpush.generateVAPIDKeys();
    await save(keysFile(), keys);
  }
  webpush.setVapidDetails('https://github.com/Ki-Seki/pelican', keys!.publicKey, keys!.privateKey);
  try {
    subscriptions = JSON.parse(await readFile(subsFile(), 'utf8'));
  } catch {
    subscriptions = [];
  }
}

export function pushKey(): string | undefined {
  return keys?.publicKey;
}

export async function addSubscription(subscription: Subscription): Promise<void> {
  subscriptions = subscriptions.filter((s) => s.endpoint !== subscription.endpoint);
  subscriptions.push(subscription);
  await save(subsFile(), subscriptions);
}

export async function removeSubscription(endpoint: string): Promise<void> {
  subscriptions = subscriptions.filter((s) => s.endpoint !== endpoint);
  await save(subsFile(), subscriptions);
}

export type PushPayload = { title: string; body: string; sessionId: string; tag: string };

/** Sends a notification to every subscribed device; drops subscriptions the push service rejects. */
export async function notify(payload: PushPayload): Promise<void> {
  if (!keys || subscriptions.length === 0) return;
  const gone: string[] = [];
  await Promise.all(subscriptions.map(async (subscription) => {
    // PELICAN_SESSION_URL wins (for a page that embeds Pelican); otherwise the page that subscribed.
    const id = encodeURIComponent(payload.sessionId);
    const url = config.sessionUrl ? config.sessionUrl.replaceAll('{id}', id)
      : subscription.openUrl ? `${subscription.openUrl}${id}` : undefined;
    const body = JSON.stringify({ ...payload, url });
    try {
      await webpush.sendNotification(subscription, body, { TTL: 3600, urgency: 'high' });
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) gone.push(subscription.endpoint);
      else console.warn('[pelican] push failed', status ?? (error as Error).message);
    }
  }));
  if (gone.length > 0) {
    subscriptions = subscriptions.filter((s) => !gone.includes(s.endpoint));
    // Callers do not wait for a notification: a failed save is said here, not left to reject.
    await save(subsFile(), subscriptions).catch((error: Error) => console.warn('[pelican] could not save push subscriptions', error.message));
  }
}
