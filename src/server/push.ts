import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import webpush from 'web-push';

import type { PermissionRequest } from '../shared/protocol.js';
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

export type PushPayload = {
  title: string;
  body: string;
  sessionId: string;
  tag: string;
  /** A request the notification can answer: Allow and Deny, where the device shows buttons. */
  request?: string;
};

/**
 * Characters a notification would not show as they are: controls and line breaks, invisible and
 * direction-changing ones, private and unassigned ones, and spaces other than a plain one. With
 * any of them, a command can read as one thing and run as another.
 */
const UNSHOWN = /[\p{C}\p{Z}\p{Default_Ignorable_Code_Point}]/u;

/** The longest command a notification offers to allow: about two lines, all a computer's notification may show. */
export const ALLOWED_COMMAND_MAX = 80;

/** What a Bash or PowerShell request may hold besides its command, none of which changes what runs. */
const BESIDES_COMMAND = new Set(['description', 'timeout', 'run_in_background']);

/**
 * The command of a request, when a notification can show all that Allow would approve: Bash or
 * PowerShell with nothing more that changes how it runs (such as leaving the sandbox), on one line
 * that shows uncut, only characters that show as they are, a single space between words. Never
 * Claude's own description of it.
 */
function shownWhole(request: PermissionRequest): string | undefined {
  if (request.toolName !== 'Bash' && request.toolName !== 'PowerShell') return undefined;
  const { command, ...rest } = request.input;
  if (typeof command !== 'string' || !command || [...command].length > ALLOWED_COMMAND_MAX) return undefined;
  if (UNSHOWN.test(command.replaceAll(' ', '')) || command !== command.trim() || command.includes('  ')) return undefined;
  const more = Object.entries(rest).some(([key, value]) => !BESIDES_COMMAND.has(key) && value !== undefined && value !== null && value !== false);
  return more ? undefined : command;
}

/**
 * What a notification for a request may answer, Allow and Deny, and the body it then has: a
 * command Claude wants to run, shown whole, since only then does the notification show all that
 * Allow approves. Anything else opens the session: an edit, an MCP tool or another tool whose
 * input it does not show, a longer command, a question or a plan, and a request Claude Code says
 * must not be allowed by a stray tap. Not even Deny is offered there: it would answer, unseen,
 * a request the page shows in full, and one rule for when a notification answers stays clear.
 */
export function answerable(request: PermissionRequest): Partial<Pick<PushPayload, 'body' | 'request'>> {
  const command = request.elicitation || request.defaultToNo ? undefined : shownWhole(request);
  return command === undefined ? {} : { body: command, request: request.id };
}

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
