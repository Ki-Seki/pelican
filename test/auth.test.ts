import { createHmac, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  accessToken, attemptAllowed, authMode, beginAttempt, checkPassword, checkToken, clearPassword, cookieName, issueCode, loadAuth,
  newSessionCookie, noteFailure, onSignOut, passwordSet, redeemCode, refreshAuth, renewedCookie, resetAttempts, resetToken, setPassword, signedIn,
  signOut,
} from '../src/server/auth';
import { config } from '../src/server/config';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'pelican-auth-'));
  config.configDir = dir;
  config.auth = 'auto';
  await loadAuth();
});
afterAll(async () => {
  config.auth = 'auto';
  await rm(dir, { recursive: true, force: true });
});
// Each test starts with the token in use, whichever ran before it.
beforeEach(async () => {
  if (passwordSet()) await clearPassword();
});

/**
 * A moment at least a second after every look at the files so far, real or made up, so a look then
 * reads them again: they are read at most once a second, whatever order the tests run in.
 */
let clock = 0;
const aSecondLater = () => (clock = Math.max(clock, Date.now()) + 1500);

const cookieOf = () => {
  const cookie = newSessionCookie();
  return `${cookie.name}=${cookie.value}`;
};

describe('access token (the default)', () => {
  it('is made on first start, kept for the owner alone, and asked for on every request', async () => {
    expect(authMode()).toBe('token');
    const token = accessToken();
    expect(token).toMatch(/^[\w-]{32}$/);
    expect((await stat(path.join(dir, 'token.json'))).mode & 0o777).toBe(0o600);
    expect(signedIn(undefined)).toBe(false);
    expect(signedIn('pelican_x=1.2')).toBe(false);
  });

  it('signs in with the token, as a header or through the cookie it is exchanged for', () => {
    const token = accessToken()!;
    expect(checkToken(token)).toBe(true);
    expect(checkToken(`${token}x`)).toBe(false);
    expect(checkToken('')).toBe(false);
    expect(checkToken(undefined)).toBe(false);
    expect(signedIn(undefined, `Bearer ${token}`)).toBe(true);
    expect(signedIn(undefined, 'Bearer nope')).toBe(false);
    expect(signedIn(cookieOf())).toBe(true);
  });

  it('a new token signs out every browser and retires the old link', async () => {
    const old = accessToken()!;
    const cookie = cookieOf();
    await resetToken();
    expect(accessToken()).not.toBe(old);
    expect(checkToken(old)).toBe(false);
    expect(signedIn(cookie)).toBe(false);
  });
});

describe('password', () => {
  it('replaces the token while set, and keeps only a hash', async () => {
    const token = accessToken()!;
    await setPassword('correct horse battery');
    expect(passwordSet()).toBe(true);
    expect(authMode()).toBe('password');
    expect(accessToken()).toBeUndefined();
    expect(checkToken(token)).toBe(false);
    expect(signedIn(undefined, `Bearer ${token}`)).toBe(false);
    expect(await checkPassword('correct horse battery')).toBe(true);
    expect(await checkPassword('wrong')).toBe(false);
    expect((await stat(path.join(dir, 'auth.json'))).mode & 0o777).toBe(0o600);
  });

  it('signs in with the cookie it issued, and not with a forged or old one', async () => {
    const cookie = newSessionCookie();
    expect(signedIn(`${cookie.name}=${cookie.value}`)).toBe(true);
    expect(signedIn(undefined)).toBe(false);
    const [expires] = cookie.value.split('.');
    expect(signedIn(`${cookie.name}=${expires}.forged`)).toBe(false);
    expect(signedIn(`${cookie.name}=${Date.now() - 1000}.${cookie.value.split('.')[1]}`)).toBe(false);
    // A new password rotates the secret: old cookies stop working.
    await setPassword('second password');
    expect(cookieName()).not.toBe(cookie.name);
    expect(signedIn(`${cookieName()}=${cookie.value}`)).toBe(false);
  });

  it('removing it brings the token back', async () => {
    await clearPassword();
    expect(authMode()).toBe('token');
    expect(checkToken(accessToken())).toBe(true);
  });
});

describe('--no-auth', () => {
  it('signs every request in, and offers no token', () => {
    config.auth = 'none';
    try {
      expect(authMode()).toBe('none');
      expect(signedIn(undefined)).toBe(true);
      expect(accessToken()).toBeUndefined();
      expect(checkToken('anything')).toBe(false);
    } finally {
      config.auth = 'auto';
    }
  });
});

describe('failed sign-ins', () => {
  beforeEach(() => resetAttempts());

  it('allow 10 per client in 10 minutes', () => {
    const now = 1_000_000;
    for (let i = 0; i < 10; i += 1) {
      expect(attemptAllowed('1.2.3.4', now)).toBe(true);
      noteFailure('1.2.3.4', now);
    }
    expect(attemptAllowed('1.2.3.4', now)).toBe(false);
    expect(attemptAllowed('5.6.7.8', now)).toBe(true);
    expect(attemptAllowed('1.2.3.4', now + 10 * 60_000 + 1)).toBe(true);
  });

  it('allow 30 in all, however many clients they come from', () => {
    const now = 1_000_000;
    for (let i = 0; i < 30; i += 1) noteFailure(`10.0.0.${i}`, now);
    expect(attemptAllowed('192.168.1.1', now)).toBe(false);
    expect(attemptAllowed('192.168.1.1', now + 10 * 60_000 + 1)).toBe(true);
  });
});

describe('attempts counted before the check', () => {
  beforeEach(() => resetAttempts());

  it('many sent at once cannot all get past the limit, and a success is not counted', () => {
    const now = 2_000_000;
    const started = Array.from({ length: 50 }, () => beginAttempt('9.9.9.9', now));
    expect(started.filter(Boolean)).toHaveLength(10);
    resetAttempts();
    const ok = beginAttempt('9.9.9.9', now)!;
    ok();
    for (let i = 0; i < 10; i += 1) expect(beginAttempt('9.9.9.9', now)).toBeTruthy();
    expect(beginAttempt('9.9.9.9', now)).toBeUndefined();
  });
});

describe('one-time codes', () => {
  it('work once, and only for two minutes', () => {
    const code = issueCode(1_000);
    expect(redeemCode(code, 2_000)).toBe(true);
    expect(redeemCode(code, 2_000)).toBe(false);
    const late = issueCode(1_000);
    expect(redeemCode(late, 1_000 + 2 * 60_000 + 1)).toBe(false);
    expect(redeemCode('made-up', 1_000)).toBe(false);
    expect(redeemCode(undefined)).toBe(false);
  });
});

describe('a change made by another process (`pelican token --reset`, `pelican password`)', () => {
  it('applies within a second, without a restart, and retires the codes made before it', async () => {
    const old = accessToken()!;
    const cookie = cookieOf();
    const code = issueCode();
    // What `pelican token --reset` writes, from another process.
    await writeFile(path.join(dir, 'token.json'), JSON.stringify({ version: 1, token: 'a-new-token-from-the-cli-0000000', secret: randomBytes(32).toString('base64') }));
    refreshAuth(aSecondLater());
    expect(accessToken()).toBe('a-new-token-from-the-cli-0000000');
    expect(checkToken(old)).toBe(false);
    expect(signedIn(cookie)).toBe(false);
    expect(redeemCode(code)).toBe(false);
  });

  it('a password set or removed elsewhere applies too', async () => {
    const written = path.join(dir, 'auth.json');
    await setPassword('from the terminal');
    const saved = await import('node:fs/promises').then((fs) => fs.readFile(written, 'utf8'));
    await clearPassword();
    expect(authMode()).toBe('token');
    await writeFile(written, saved);
    refreshAuth(aSecondLater());
    expect(authMode()).toBe('password');
    await rm(written);
    refreshAuth(aSecondLater());
    expect(authMode()).toBe('token');
  });
});

describe('a file caught half-written', () => {
  it('changes nothing until it can be read whole', async () => {
    await setPassword('a good password');
    const written = path.join(dir, 'auth.json');
    await writeFile(written, '{"version": 1, "salt": "');
    refreshAuth(aSecondLater());
    expect(authMode()).toBe('password');
    expect(await checkPassword('a good password')).toBe(true);
    await clearPassword();
  });
});

describe('a sign-in in use', () => {
  it('is renewed, at most once a day, so only 30 days without use sign a browser out', () => {
    const now = Date.now();
    const fresh = newSessionCookie(now);
    expect(renewedCookie(`${fresh.name}=${fresh.value}`, now)).toBeUndefined();
    const older = newSessionCookie(now - 2 * 86_400_000);
    const renewed = renewedCookie(`${older.name}=${older.value}`, now);
    expect(renewed?.maxAge).toBe(30 * 86_400);
    expect(signedIn(`${renewed!.name}=${renewed!.value}`)).toBe(true);
    expect(renewedCookie(`${older.name}=${older.value}.forged`, now)).toBeUndefined();
    expect(renewedCookie(undefined, now)).toBeUndefined();
  });
});

describe('signing out', () => {
  const header = (cookie: { name: string; value: string }) => `${cookie.name}=${cookie.value}`;
  const signedOutFile = () => path.join(config.stateDir, 'signed-out.json');

  it('refuses that cookie from then on, and every renewal of it, while other browsers stay signed in', async () => {
    const now = Date.now();
    const browser = newSessionCookie(now - 2 * 86_400_000);
    const renewed = renewedCookie(header(browser), now)!;
    const other = newSessionCookie(now);
    expect(signedIn(header(browser))).toBe(true);
    expect(signedIn(header(renewed))).toBe(true);
    // Signed out with the newer cookie: the older one, which a page's socket may have opened with, goes too.
    expect(await signOut(header(renewed))).toBe(true);
    expect(signedIn(header(renewed))).toBe(false);
    expect(signedIn(header(browser))).toBe(false);
    expect(renewedCookie(header(browser), now)).toBeUndefined();
    expect(signedIn(header(other))).toBe(true);
    // Nothing to sign out: no cookie, a forged one, one already signed out.
    expect(await signOut(undefined)).toBe(false);
    expect(await signOut(`${other.name}=${other.value.slice(0, -2)}xx`)).toBe(false);
    expect(await signOut(header(renewed))).toBe(false);
    // Signing in again is a new sign-in.
    expect(signedIn(header(newSessionCookie()))).toBe(true);
  });

  it('is kept in the state folder, without anything that signs a browser in, and holds after a restart and in another Pelican', async () => {
    const browser = newSessionCookie();
    const later = newSessionCookie();
    await signOut(header(browser));
    const file = await readFile(signedOutFile(), 'utf8');
    expect((await stat(signedOutFile())).mode & 0o777).toBe(0o600);
    // Its id and signature: when it ends is no secret.
    for (const part of browser.value.split('.').slice(1)) expect(file).not.toContain(part);
    // Pelican started again: what it reads at start.
    const restarted = await freshAuth();
    expect(restarted.signedIn(header(browser))).toBe(false);
    expect(restarted.signedIn(header(later))).toBe(true);
    // Signed out in this one, while the other runs: it reads the folder again within a second.
    await signOut(header(later));
    restarted.refreshAuth(aSecondLater(), true);
    expect(restarted.signedIn(header(later))).toBe(false);
  });

  it('closes what the browser has open at once', async () => {
    const heard = vi.fn();
    const stop = onSignOut(heard);
    await signOut(header(newSessionCookie()));
    expect(heard).toHaveBeenCalledTimes(1);
    stop();
    await signOut(header(newSessionCookie()));
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('signs out a cookie made before sign-ins had ids (0.4), and the renewal that took its place', async () => {
    const { secret } = JSON.parse(await readFile(path.join(dir, 'token.json'), 'utf8')) as { secret: string };
    const now = Date.now();
    const expires = now + 20 * 86_400_000;
    const old = `${cookieName()}=${expires}.${createHmac('sha256', Buffer.from(secret, 'base64')).update(String(expires)).digest('base64url')}`;
    expect(signedIn(old)).toBe(true);
    const renewed = renewedCookie(old, now)!;
    expect(await signOut(header(renewed))).toBe(true);
    expect(signedIn(old)).toBe(false);
  });

  it('keeps at most 256 sign-ins, and past that refuses every cookie as old as those it lets go of', async () => {
    // A Pelican of its own state folder, so that what it refuses for age stays its own.
    const own = await freshAuth(await mkdtemp(path.join(dir, 'state-')));
    const now = Date.now();
    // Signed in 20 days ago, and not used since: older than every sign-in signed out below.
    const idle = own.newSessionCookie(now - 20 * 86_400_000);
    const first = own.newSessionCookie(now - 1000);
    await own.signOut(header(first), now - 1000);
    for (let i = 0; i < 256; i += 1) await own.signOut(header(own.newSessionCookie(now)), now);
    const kept = JSON.parse(await readFile(path.join(own.stateDir, 'signed-out.json'), 'utf8')) as { floor: number; signedOut: Record<string, number> };
    expect(Object.keys(kept.signedOut)).toHaveLength(256);
    expect(own.signedIn(header(first))).toBe(false);
    expect(own.signedIn(header(idle))).toBe(false);
    // A browser in use has a newer cookie, and one signing in now gets one.
    expect(own.signedIn(header(own.newSessionCookie(now)))).toBe(true);
    expect(own.signedIn(header(own.newSessionCookie()))).toBe(true);
  });

  it('lets go of sign-ins whose cookies have all expired', async () => {
    // As a Pelican that signed out before left it, whichever test ran first (none may have made the folder).
    await mkdir(path.dirname(signedOutFile()), { recursive: true });
    await writeFile(signedOutFile(), JSON.stringify({ version: 1, floor: 0, signedOut: { gone: Date.now() - 1000, kept: Date.now() + 86_400_000 } }));
    const restarted = await freshAuth();
    await restarted.signOut(header(newSessionCookie()));
    const kept = JSON.parse(await readFile(signedOutFile(), 'utf8')) as { signedOut: Record<string, number> };
    expect(Object.keys(kept.signedOut)).toContain('kept');
    expect(Object.keys(kept.signedOut)).not.toContain('gone');
    expect(Object.keys(kept.signedOut)).toHaveLength(2);
  });
});

/** auth.ts as a Pelican started now loads it, with this test's folders (or a state folder of its own). */
async function freshAuth(stateDir = config.stateDir): Promise<typeof import('../src/server/auth') & { stateDir: string }> {
  vi.resetModules();
  const [fresh, { config: freshConfig }] = await Promise.all([import('../src/server/auth'), import('../src/server/config')]);
  Object.assign(freshConfig, { configDir: config.configDir, stateDir, auth: 'auto' });
  await fresh.loadAuth();
  return { ...fresh, stateDir };
}
