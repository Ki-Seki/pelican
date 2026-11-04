import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { config } from './config.js';

/**
 * The optional login: one password, set on the machine with `pelican password`
 * (never over the network), stored as a scrypt hash. Signing in sets a cookie
 * signed with a secret that changes with the password, so changing or
 * removing the password signs every browser out.
 */
type Stored = { version: 1; salt: string; hash: string; secret: string; N: number; r: number; p: number };

const file = () => path.join(config.configDir, 'auth.json');
const SESSION_DAYS = 30;
const PARAMS = { N: 16384, r: 8, p: 1 };

let stored: Stored | undefined;
let loaded = false;

function derive(password: string, salt: Buffer, params: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, 32, { ...params, maxmem: 64 * 1024 * 1024 }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export async function loadAuth(): Promise<Stored | undefined> {
  if (loaded) return stored;
  try {
    stored = JSON.parse(await readFile(file(), 'utf8')) as Stored;
  } catch {
    stored = undefined;
  }
  loaded = true;
  return stored;
}

export function passwordSet(): boolean {
  return Boolean(stored);
}

export async function setPassword(password: string): Promise<void> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, PARAMS);
  const next: Stored = { version: 1, salt: salt.toString('base64'), hash: hash.toString('base64'), secret: randomBytes(32).toString('base64'), ...PARAMS };
  await mkdir(path.dirname(file()), { recursive: true, mode: 0o700 });
  await writeFile(file(), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  stored = next;
  loaded = true;
}

export async function clearPassword(): Promise<void> {
  await rm(file(), { force: true });
  stored = undefined;
  loaded = true;
}

export async function checkPassword(password: string): Promise<boolean> {
  if (!stored) return false;
  const expected = Buffer.from(stored.hash, 'base64');
  const actual = await derive(password, Buffer.from(stored.salt, 'base64'), stored);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Cookie name: one per password, so two Pelicans on one origin do not sign each other out. */
export function cookieName(): string {
  const id = stored ? createHash('sha256').update(stored.secret).digest('hex').slice(0, 8) : 'none';
  return `pelican_${id}`;
}

function sign(expires: number): string {
  return createHmac('sha256', Buffer.from(stored!.secret, 'base64')).update(String(expires)).digest('base64url');
}

export function newSessionCookie(): { name: string; value: string; maxAge: number } {
  const maxAge = SESSION_DAYS * 24 * 3600;
  const expires = Date.now() + maxAge * 1000;
  return { name: cookieName(), value: `${expires}.${sign(expires)}`, maxAge };
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

/** True when no password is set, or the request carries a valid session cookie. */
export function signedIn(cookieHeader: string | undefined): boolean {
  if (!stored) return true;
  const value = cookieValue(cookieHeader, cookieName());
  if (!value) return false;
  const [expires, mac] = value.split('.');
  const when = Number(expires);
  if (!mac || !Number.isFinite(when) || when < Date.now()) return false;
  const expected = Buffer.from(sign(when));
  const given = Buffer.from(mac);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

const attempts = new Map<string, { count: number; resetAt: number }>();

/** At most 10 password attempts per client every 10 minutes. */
export function allowAttempt(client: string): boolean {
  const now = Date.now();
  const entry = attempts.get(client);
  if (!entry || entry.resetAt < now) {
    attempts.set(client, { count: 1, resetAt: now + 10 * 60_000 });
    return true;
  }
  entry.count += 1;
  return entry.count <= 10;
}
