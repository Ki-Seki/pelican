import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { config } from './config.js';

/**
 * Who may use Pelican. Pelican runs commands as you, so nothing gets in
 * without proof, also on this computer, where every account and process can
 * reach 127.0.0.1:
 *
 * - token (the default): a random access token, kept in the config folder and
 *   printed in the link Pelican shows at start. Opening that link, or pasting
 *   the token, signs the browser in, the way Jupyter does.
 * - password: set on the computer with `pelican password` (never over the
 *   network), stored as a scrypt hash. For reaching Pelican from a phone.
 * - none: `--no-auth`, for when something in front already authenticates
 *   (a reverse proxy, a gateway), and for the demo, which holds nothing private.
 *
 * Signing in sets a cookie signed with a secret that belongs to the token or
 * the password and changes with it, so resetting either signs every browser out.
 * The running server notices a change made with `pelican token --reset` or
 * `pelican password` within a second; no restart is needed. A cookie in use is
 * renewed, so a browser stays signed in until it goes unused for 30 days. Each
 * sign-in has an id its renewed cookies keep: signing out refuses all of them,
 * kept in the state folder until the last could have expired (signOut).
 */
export type AuthMode = 'none' | 'password' | 'token';

type Password = { version: 1; salt: string; hash: string; secret: string; N: number; r: number; p: number };
type Token = { version: 1; token: string; secret: string };

const passwordFile = () => path.join(config.configDir, 'auth.json');
const tokenFile = () => path.join(config.configDir, 'token.json');
const signedOutFile = () => path.join(config.stateDir, 'signed-out.json');
const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 3600_000;
/** A cookie with less than this left is replaced by a fresh one when it is used. */
const RENEW_BELOW_MS = (SESSION_DAYS - 1) * 24 * 3600_000;
const PARAMS = { N: 16384, r: 8, p: 1 };

let password: Password | undefined;
let token: Token | undefined;
let loaded = false;
/** The two files as last read, and when they were last looked at. */
let seen: string | undefined;
let checkedAt = 0;

const signature = (file: string) => {
  try {
    const info = statSync(file);
    return `${info.ino}:${info.size}:${info.mtimeMs}`;
  } catch {
    return '-';
  }
};
const filesSignature = () => `${signature(passwordFile())}|${signature(tokenFile())}`;

const readJsonSync = <T>(file: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
};

/**
 * Reads the files again when another process changed them (`pelican token --reset`, `pelican
 * password`), at most once a second. One-time codes made under the old secret stop working too:
 * a reset is what you do when a link leaked, and a code is as good as the link for two minutes.
 */
export function refreshAuth(now = Date.now(), force = false): void {
  if (!loaded || (!force && now - checkedAt < 1000)) return;
  checkedAt = now;
  // Signed out in another Pelican that shares the state folder (and the secret): refused here too.
  const out = signature(signedOutFile());
  if (out !== signedOut.seen) {
    signedOut.seen = out;
    mergeSignedOut(readJsonSync(signedOutFile()));
  }
  const current = filesSignature();
  if (current === seen) return;
  seen = current;
  const before = secret();
  // A file that cannot be read whole is read again next time; until then nothing changes.
  const nextPassword = readJsonSync<Password>(passwordFile());
  if (nextPassword?.hash && nextPassword.secret) password = nextPassword;
  else if (signature(passwordFile()) === '-') password = undefined;
  else seen = undefined;
  if (config.auth !== 'none') {
    const next = readJsonSync<Token>(tokenFile());
    // Removed by hand: the token in use stays until a new one is made.
    if (next?.token && next.secret) token = next;
    else if (signature(tokenFile()) !== '-') seen = undefined;
  }
  if (secret() !== before) codes.clear();
}

function derive(text: string, salt: Buffer, params: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(text.normalize('NFKC'), salt, 32, { ...params, maxmem: 64 * 1024 * 1024 }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

/** Written whole or not at all: a running server reading it meanwhile never sees half of it. */
async function writePrivate(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file);
}

const readJson = async <T>(file: string): Promise<T | undefined> => {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
};

/** Reads the password and the access token, making the token on first use, and the sign-ins signed out. */
export async function loadAuth(): Promise<void> {
  if (loaded) return;
  password = await readJson<Password>(passwordFile());
  if (config.auth !== 'none') {
    token = await readJson<Token>(tokenFile());
    if (!token?.token || !token.secret) await resetToken();
  }
  signedOut.seen = signature(signedOutFile());
  mergeSignedOut(await readJson(signedOutFile()));
  seen = filesSignature();
  checkedAt = Date.now();
  loaded = true;
}

export function authMode(): AuthMode {
  if (config.auth === 'none') return 'none';
  refreshAuth();
  return password ? 'password' : 'token';
}

export function passwordSet(): boolean {
  return Boolean(password);
}

/** The access token, for the link Pelican prints; undefined when it is not in use. */
export function accessToken(): string | undefined {
  return authMode() === 'token' ? token?.token : undefined;
}

/** A new access token: links and browsers signed in with the old one stop working. */
export async function resetToken(): Promise<string> {
  token = { version: 1, token: randomBytes(24).toString('base64url'), secret: randomBytes(32).toString('base64') };
  await writePrivate(tokenFile(), token);
  return token.token;
}

export async function setPassword(text: string): Promise<void> {
  const salt = randomBytes(16);
  const hash = await derive(text, salt, PARAMS);
  password = { version: 1, salt: salt.toString('base64'), hash: hash.toString('base64'), secret: randomBytes(32).toString('base64'), ...PARAMS };
  await writePrivate(passwordFile(), password);
  loaded = true;
}

export async function clearPassword(): Promise<void> {
  await rm(passwordFile(), { force: true });
  password = undefined;
}

export async function checkPassword(text: string): Promise<boolean> {
  if (!password) return false;
  const expected = Buffer.from(password.hash, 'base64');
  const actual = await derive(text, Buffer.from(password.salt, 'base64'), password);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const same = (a: string, b: string) => {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
};

/** Whether `given` is the access token (only while the token is how Pelican signs in). */
export function checkToken(given: string | undefined): boolean {
  const current = accessToken();
  return Boolean(current && given && same(given, current));
}

/** The secret that signs cookies in the current mode. */
const secret = () => (authMode() === 'password' ? password?.secret : authMode() === 'token' ? token?.secret : undefined);

/** Cookie name: one per secret, so two Pelicans on one origin do not sign each other out. */
export function cookieName(): string {
  const value = secret();
  return `pelican_${value ? createHash('sha256').update(value).digest('hex').slice(0, 8) : 'none'}`;
}

/**
 * A cookie's signature: over when it expires and the id of the sign-in it belongs to. A cookie made
 * before sign-ins had ids (0.4) has its expiry alone signed, and its signature is its sign-in's id.
 */
function sign(expires: number, id?: string): string {
  return createHmac('sha256', Buffer.from(secret() ?? '', 'base64')).update(id === undefined ? String(expires) : `${expires}.${id}`).digest('base64url');
}

/** A sign-in's id: new for each sign-in, kept by the cookies that renew it. */
const SIGN_IN_ID = /^[A-Za-z0-9_-]{16,64}$/;

/** A cookie that signs a browser in for 30 days, for a new sign-in, or (`id`) one that goes on. */
export function newSessionCookie(now = Date.now(), id = randomBytes(16).toString('base64url')): { name: string; value: string; maxAge: number } {
  const maxAge = SESSION_DAYS * 24 * 3600;
  // Later than any cookie refused for its age alone (prune), however soon after it was said.
  const expires = Math.max(now + maxAge * 1000, signedOut.floor + 1);
  return { name: cookieName(), value: `${expires}.${id}.${sign(expires, id)}`, maxAge };
}

/**
 * How a command on this computer (`pelican phone`) proves it may ask the running Pelican for a
 * phone code: with the sign-in secret it can read in the config folder, for one request to one
 * server, good for a minute and once. Never a cookie: what it sends to the port grants nothing
 * else, nowhere else and not for long, should something other than Pelican be listening there.
 */
const PROOF_MS = 60_000;
const proofsUsed = new Map<string, number>();

function proofMac(method: string, route: string, instance: string, at: number): string {
  // Its own wording, so a proof is never a cookie's signature, nor one the other way round.
  return createHmac('sha256', Buffer.from(secret() ?? '', 'base64')).update(`pelican command\n${method}\n${route}\n${instance}\n${at}`).digest('base64url');
}

/** The proof for one request (`X-Pelican-Proof`) to the server with this id. */
export function commandProof(method: string, route: string, instance: string, now = Date.now()): string {
  return `${now}.${proofMac(method, route, instance, now)}`;
}

/** Whether a request carries a proof made for it, for this server, within the minute, not used before. */
export function proofValid(header: string | undefined, method: string, route: string, instance: string, now = Date.now()): boolean {
  if (!header || !secret()) return false;
  const [at, mac, ...rest] = header.split('.');
  const when = Number(at);
  if (!mac || rest.length > 0 || !Number.isSafeInteger(when) || Math.abs(now - when) > PROOF_MS) return false;
  const expected = Buffer.from(proofMac(method, route, instance, when));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
  for (const [used, stamp] of proofsUsed) if (Math.abs(now - stamp) > PROOF_MS) proofsUsed.delete(used);
  if (proofsUsed.has(mac)) return false;
  proofsUsed.set(mac, when);
  return true;
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

/**
 * Whether a request may use Pelican: always when nothing is required, else with a
 * valid session cookie, or (token mode) the token as `Authorization: Bearer <token>`.
 */
export function signedIn(cookieHeader: string | undefined, authorization?: string): boolean {
  const mode = authMode();
  if (mode === 'none') return true;
  if (mode === 'token' && authorization?.startsWith('Bearer ') && checkToken(authorization.slice(7).trim())) return true;
  return cookieSignIn(cookieHeader) !== undefined;
}

/**
 * The sign-in the request's cookie carries, if it is valid: signed with the secret in use, not
 * expired, and not signed out. `id`: the sign-in's, which its renewed cookies keep.
 */
function cookieSignIn(cookieHeader: string | undefined, now = Date.now()): { expires: number; id: string } | undefined {
  if (!secret()) return undefined;
  const value = cookieValue(cookieHeader, cookieName());
  if (!value) return undefined;
  const parts = value.split('.');
  if (parts.length !== 2 && parts.length !== 3) return undefined;
  const [expires, ...rest] = parts;
  const mac = rest.at(-1)!;
  const id = parts.length === 3 ? rest[0]! : undefined;
  const when = Number(expires);
  if (!/^\d{1,15}$/.test(expires!) || !mac || (id !== undefined && !SIGN_IN_ID.test(id)) || when < now) return undefined;
  const expected = Buffer.from(sign(when, id));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
  const signIn = { expires: when, id: id ?? mac };
  return isSignedOut(signIn) ? undefined : signIn;
}

/**
 * A fresh cookie for a browser whose cookie is valid but no longer new, so that using Pelican keeps
 * it signed in, as the same sign-in; undefined when there is nothing to renew.
 */
export function renewedCookie(cookieHeader: string | undefined, now = Date.now()): ReturnType<typeof newSessionCookie> | undefined {
  if (authMode() === 'none') return undefined;
  const signIn = cookieSignIn(cookieHeader, now);
  return signIn && signIn.expires - now < RENEW_BELOW_MS ? newSessionCookie(now, signIn.id) : undefined;
}

/**
 * Sign-ins signed out: each by a hash of its id (the file holds nothing that signs anyone in),
 * kept until every cookie it had could have expired, 30 days after it was signed out (or its
 * cookie's own end, should the clock have gone back meanwhile). At most MAX_SIGNED_OUT of them:
 * past that, those signed out longest ago make room, and every cookie that ends no later than
 * theirs could is refused from then on (`floor`), so none of their cookies comes back; a
 * browser in use since has a newer one. Kept in the state folder, so a restart or an update
 * keeps them refused, and read again when another Pelican there changes it.
 */
const MAX_SIGNED_OUT = 256;
const signedOut: { ids: Map<string, number>; floor: number; seen?: string } = { ids: new Map(), floor: 0 };

const signInKey = (id: string) => createHash('sha256').update(`pelican sign-in\n${id}`).digest('base64url').slice(0, 32);

function isSignedOut({ expires, id }: { expires: number; id: string }): boolean {
  return expires <= signedOut.floor || signedOut.ids.has(signInKey(id));
}

/** Takes in a signed-out list as read from the file: what either holds stays refused. */
function mergeSignedOut(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const { floor, signedOut: ids } = value as { floor?: unknown; signedOut?: unknown };
  // No cookie ends later than 30 days from now: a floor past that is no sign-out's (a file written by hand).
  if (typeof floor === 'number' && Number.isFinite(floor)) signedOut.floor = Math.max(signedOut.floor, Math.min(floor, Date.now() + SESSION_MS));
  if (!ids || typeof ids !== 'object') return;
  for (const [key, until] of Object.entries(ids)) {
    if (typeof until !== 'number' || !Number.isFinite(until)) continue;
    signedOut.ids.set(key, Math.max(signedOut.ids.get(key) ?? 0, until));
  }
  pruneSignedOut();
}

/** Lets go of sign-ins whose every cookie has expired, and keeps the list within its bound. */
function pruneSignedOut(now = Date.now()): void {
  for (const [key, until] of signedOut.ids) if (until < now) signedOut.ids.delete(key);
  if (signedOut.ids.size <= MAX_SIGNED_OUT) return;
  const oldest = [...signedOut.ids].sort((a, b) => a[1] - b[1]).slice(0, signedOut.ids.size - MAX_SIGNED_OUT);
  for (const [key, until] of oldest) {
    signedOut.ids.delete(key);
    signedOut.floor = Math.max(signedOut.floor, until);
  }
}

const signOutListeners = new Set<() => void>();

/** Called once a browser is signed out, to let go of what it has open (its sockets) at once. */
export function onSignOut(listener: () => void): () => void {
  signOutListeners.add(listener);
  return () => signOutListeners.delete(listener);
}

/**
 * Signs out the browser whose cookie this is: its cookie, and every one of the same sign-in
 * (renewed, or copied elsewhere), is refused from now on, and what it has open is let go of
 * (onSignOut). Saved before it returns; a save that fails keeps the sign-out until Pelican stops.
 * False when the cookie signs nobody in.
 */
export async function signOut(cookieHeader: string | undefined, now = Date.now()): Promise<boolean> {
  const signIn = cookieSignIn(cookieHeader, now);
  if (!signIn) return false;
  const key = signInKey(signIn.id);
  signedOut.ids.set(key, Math.max(signedOut.ids.get(key) ?? 0, now + SESSION_MS, signIn.expires));
  pruneSignedOut(now);
  for (const listener of signOutListeners) listener();
  await saveSignedOut();
  return true;
}

/** Saves of the list, one at a time, each with all that is known by then. */
let saving: Promise<void> = Promise.resolve();

function saveSignedOut(): Promise<void> {
  saving = saving.then(async () => {
    try {
      // What another Pelican added meanwhile is kept.
      mergeSignedOut(await readJson(signedOutFile()));
      await writePrivate(signedOutFile(), { version: 1, floor: signedOut.floor, signedOut: Object.fromEntries(signedOut.ids) });
      signedOut.seen = signature(signedOutFile());
    } catch (error) {
      console.warn('[pelican] could not keep the sign-out on disk; it holds until Pelican stops:', (error as Error).message);
    }
  });
  return saving;
}

// Failed sign-ins: at most 10 per client and 30 in all every 10 minutes, so neither
// a rotating client key nor many clients together can guess for long.
const WINDOW_MS = 10 * 60_000;
const PER_CLIENT = 10;
const IN_ALL = 30;
const failures = new Map<string, number[]>();
let allFailures: number[] = [];

const recent = (times: number[], now: number) => times.filter((t) => now - t < WINDOW_MS);

/** Whether this client may try to sign in now. */
export function attemptAllowed(client: string, now = Date.now()): boolean {
  allFailures = recent(allFailures, now);
  if (allFailures.length >= IN_ALL) return false;
  return recent(failures.get(client) ?? [], now).length < PER_CLIENT;
}

/** Counts a wrong password or token against the client and against everyone. */
export function noteFailure(client: string, now = Date.now()): void {
  allFailures.push(now);
  failures.set(client, [...recent(failures.get(client) ?? [], now), now]);
  // Forget clients whose failures have all expired, and never keep more than a few thousand.
  if (failures.size > 1000) {
    for (const [key, times] of failures) if (recent(times, now).length === 0) failures.delete(key);
    while (failures.size > 5000) failures.delete(failures.keys().next().value!);
  }
}

/**
 * Starts a sign-in attempt: counted as a failure at once, before the slow check, so many
 * requests sent together cannot all get past the limit. Returns undefined when the client
 * is over the limit, else a function that takes the attempt back once it succeeded.
 */
export function beginAttempt(client: string, now = Date.now()): (() => void) | undefined {
  if (!attemptAllowed(client, now)) return undefined;
  noteFailure(client, now);
  return () => {
    const drop = (times: number[] | undefined) => {
      const at = times?.lastIndexOf(now) ?? -1;
      if (times && at >= 0) times.splice(at, 1);
    };
    drop(allFailures);
    drop(failures.get(client));
  };
}

/** For tests: start counting afresh. */
export function resetAttempts(): void {
  failures.clear();
  allFailures = [];
}

// One-time sign-in codes, for the QR code that opens Pelican on a phone: the page never sees
// the access token or the password, and a photo of the code is useless after two minutes.
const CODE_MS = 2 * 60_000;
const codes = new Map<string, number>();

/** A new code that signs one browser in, once, within two minutes. */
export function issueCode(now = Date.now()): string {
  for (const [code, expires] of codes) if (expires <= now) codes.delete(code);
  while (codes.size >= 20) codes.delete(codes.keys().next().value!);
  const code = randomBytes(18).toString('base64url');
  codes.set(code, now + CODE_MS);
  return code;
}

/** Whether `given` is a live code; using it ends it. */
export function redeemCode(given: string | undefined, now = Date.now()): boolean {
  if (!given || authMode() === 'none') return false;
  for (const [code, expires] of codes) {
    if (same(code, given)) {
      codes.delete(code);
      return expires > now;
    }
  }
  return false;
}
