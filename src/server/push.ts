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
 * Text every notification shows as it is, in any system font: printable ASCII, one space between
 * words. Any other character may be drawn wider than counted (an emoji, CJK), blank (a Braille
 * blank, U+FFFC), joined to its neighbours, or not at all, and a command could then read as one
 * thing and run as another.
 */
const PLAIN = /^[!-~]+(?: [!-~]+)*$/;

/**
 * How wide each printable ASCII character may be drawn, in tenths of an em: the widest of SF Pro
 * (macOS), Helvetica and Arial (as Roboto, on Android) and Tahoma (as Segoe UI, on Windows), as
 * Chrome measures them, rounded up.
 */
const WIDTHS: ReadonlyArray<readonly [number, string]> = [
  [3, "'ijl"],
  [4, ' !(),./:;I[\\]frt|'],
  [5, '"-{}'],
  [6, '*127?JL_`acehknosuvxyz'],
  [7, '$0345689ABEFKPSTVXYZbdgpq'],
  [8, '#&+<=>CDGHNOQRU^w~'],
  [9, 'Mm'],
  [10, '%W'],
  [11, '@'],
];
const tenths = new Map(WIDTHS.flatMap(([width, chars]) => [...chars].map((char) => [char, width] as const)));
const widthOf = (text: string) => [...text].reduce((sum, char) => sum + tenths.get(char)!, 0);

/**
 * The narrowest notification body, in tenths of an em, and the lines of it every notification
 * shows: a macOS banner beside the site's icon has about 220 px of 13 px text (17 em) on two
 * lines, and 16.5 em leaves a margin. Windows' toasts and GNOME's banners are wider, and Android
 * shows more lines once a notification is expanded.
 */
const LINE = 165;
const LINES = 2;

/**
 * Whether a line may break at the space between two words on every device. Unicode's line
 * breaking (UAX #14, rules LB13 to LB15) never breaks before ) ] } ! ? , . : ; or /, after ( [ or
 * {, or between a quote and an opening bracket, even at a space.
 */
const breaksBetween = (before: string, after: string) => {
  const last = before.at(-1)!;
  const first = after[0]!;
  return !')]}!?,.:;/'.includes(first) && !'([{'.includes(last) && !('"\''.includes(last) && '([{'.includes(first));
};

/**
 * Whether plain text shows whole in any notification: within two lines at the narrowest, wrapped
 * only where every device may break a line, which takes the most lines, and with no word wider
 * than a line, since devices cut those in different places.
 */
function fitsTwoLines(text: string): boolean {
  const words = text.split(' ');
  const space = tenths.get(' ')!;
  // The widths of what no device breaks: words, joined across a space no line breaks at.
  const pieces = [widthOf(words[0]!)];
  for (let i = 1; i < words.length; i += 1) {
    const width = widthOf(words[i]!);
    pieces.push(breaksBetween(words[i - 1]!, words[i]!) ? width : pieces.pop()! + space + width);
  }
  let lines = 0;
  let room = 0;
  for (const width of pieces) {
    if (width > LINE) return false;
    if (lines > 0 && space + width <= room) {
      room -= space + width;
    } else {
      lines += 1;
      room = LINE - width;
    }
  }
  return lines <= LINES;
}

/** What a Bash or PowerShell request may hold besides its command, none of which changes what runs. */
const BESIDES_COMMAND = new Set(['description', 'timeout', 'run_in_background']);

/**
 * The command of a request, when a notification surely shows all that Allow would approve: Bash
 * or PowerShell with nothing more that changes how it runs (such as leaving the sandbox), in
 * printable ASCII with one space between words, short enough to show whole in two lines of the
 * narrowest notification. Never Claude's own description of it.
 */
function shownWhole(request: PermissionRequest): string | undefined {
  if (request.toolName !== 'Bash' && request.toolName !== 'PowerShell') return undefined;
  const { command, ...rest } = request.input;
  if (typeof command !== 'string' || !PLAIN.test(command) || !fitsTwoLines(command)) return undefined;
  const more = Object.entries(rest).some(([key, value]) => !BESIDES_COMMAND.has(key) && value !== undefined && value !== null && value !== false);
  return more ? undefined : command;
}

/**
 * What a notification for a request may answer, Allow and Deny, and the body it then has: a
 * command Claude wants to run, shown whole, since only then does the notification show all that
 * Allow approves. Anything else opens the session: an edit, an MCP tool or another tool whose
 * input it does not show, a command too long or with other characters, a question or a plan, and
 * a request Claude Code says must not be allowed by a stray tap. Not even Deny is offered there:
 * it would answer, unseen, a request the page shows in full, and one rule for when a notification
 * answers stays clear.
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
