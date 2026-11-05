import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
 * renewed, so a browser stays signed in until it goes unused for 30 days.
 */
export type AuthMode = 'none' | 'password' | 'token';

type Password = { version: 1; salt: string; hash: string; secret: string; N: number; r: number; p: number };
type Token = { version: 1; token: string; secret: string };

const passwordFile = () => path.join(config.configDir, 'auth.json');
const tokenFile = () => path.join(config.configDir, 'token.json');
const SESSION_DAYS = 30;
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
  const current = filesSignature();
  if (current === seen) return;
  seen = current;
  const before = secret();
  password = readJsonSync<Password>(passwordFile());
  if (config.auth !== 'none') {
    const next = readJsonSync<Token>(tokenFile());
    // A file being written, or removed by hand, leaves the token in use as it is.
    if (next?.token && next.secret) token = next;
  }
  if (secret() !== before) codes.clear();
}

function derive(text: string, salt: Buffer, params: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(text.normalize('NFKC'), salt, 32, { ...params, maxmem: 64 * 1024 * 1024 }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

async function writePrivate(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

const readJson = async <T>(file: string): Promise<T | undefined> => {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
};

/** Reads the password and the access token, making the token on first use. */
export async function loadAuth(): Promise<void> {
  if (loaded) return;
  password = await readJson<Password>(passwordFile());
  if (config.auth !== 'none') {
    token = await readJson<Token>(tokenFile());
    if (!token?.token || !token.secret) await resetToken();
  }
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

function sign(expires: number): string {
  return createHmac('sha256', Buffer.from(secret() ?? '', 'base64')).update(String(expires)).digest('base64url');
}

export function newSessionCookie(now = Date.now()): { name: string; value: string; maxAge: number } {
  const maxAge = SESSION_DAYS * 24 * 3600;
  const expires = now + maxAge * 1000;
  return { name: cookieName(), value: `${expires}.${sign(expires)}`, maxAge };
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
  return cookieExpiry(cookieHeader) !== undefined;
}

/** When the request's sign-in cookie expires, if it carries a valid one. */
function cookieExpiry(cookieHeader: string | undefined, now = Date.now()): number | undefined {
  if (!secret()) return undefined;
  const value = cookieValue(cookieHeader, cookieName());
  if (!value) return undefined;
  const [expires, mac, ...rest] = value.split('.');
  const when = Number(expires);
  if (!mac || rest.length > 0 || !Number.isFinite(when) || when < now) return undefined;
  const expected = Buffer.from(sign(when));
  const given = Buffer.from(mac);
  return expected.length === given.length && timingSafeEqual(expected, given) ? when : undefined;
}

/**
 * A fresh cookie for a browser whose cookie is valid but no longer new, so that using Pelican keeps
 * it signed in; undefined when there is nothing to renew.
 */
export function renewedCookie(cookieHeader: string | undefined, now = Date.now()): ReturnType<typeof newSessionCookie> | undefined {
  if (authMode() === 'none') return undefined;
  const expires = cookieExpiry(cookieHeader, now);
  return expires !== undefined && expires - now < RENEW_BELOW_MS ? newSessionCookie(now) : undefined;
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
