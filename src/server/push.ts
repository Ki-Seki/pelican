import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import webpush from 'web-push';

import { cookieName } from './auth.js';
import { config } from './config.js';

/**
 * A device that asked for notifications, and under which sign-in: `signer` names the secret that
 * signed browsers in then (the cookie's name, which is derived from it). A new token or password
 * signs every browser out, and so stops their notifications too.
 */
type Subscription = webpush.PushSubscription & { openUrl?: string; signer?: string };

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
  // Saved before subscriptions knew their sign-in: they belong to the current one.
  if (subscriptions.some((s) => !s.signer)) {
    subscriptions = subscriptions.map((s) => ({ ...s, signer: s.signer ?? cookieName() }));
    await save(subsFile(), subscriptions);
  }
}

export function pushKey(): string | undefined {
  return keys?.publicKey;
}

export async function addSubscription(subscription: Subscription): Promise<void> {
  subscriptions = subscriptions.filter((s) => s.endpoint !== subscription.endpoint);
  subscriptions.push({ ...subscription, signer: cookieName() });
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
  // Devices signed out by a new token or password get nothing more, and are forgotten.
  const signer = cookieName();
  const gone = subscriptions.filter((s) => s.signer !== signer).map((s) => s.endpoint);
  await Promise.all(subscriptions.filter((s) => s.signer === signer).map(async (subscription) => {
    // PELICAN_SESSION_URL wins (for a page that embeds Pelican); otherwise the page that subscribed.
    const id = encodeURIComponent(payload.sessionId);
    const url = config.sessionUrl ? config.sessionUrl.replaceAll('{id}', id)
      : subscription.openUrl ? `${subscription.openUrl}${id}` : undefined;
    const body = JSON.stringify({ ...payload, url });
    try {
      await webpush.sendNotification({ endpoint: subscription.endpoint, keys: subscription.keys }, body, { TTL: 3600, urgency: 'high' });
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

/** For tests: the endpoints notifications would go to now. */
export function subscribedEndpoints(): string[] {
  const signer = cookieName();
  return subscriptions.filter((s) => s.signer === signer).map((s) => s.endpoint);
}
