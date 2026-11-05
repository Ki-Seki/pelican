import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  accessToken, attemptAllowed, authMode, beginAttempt, checkPassword, checkToken, clearPassword, cookieName, issueCode, loadAuth,
  newSessionCookie, noteFailure, passwordSet, redeemCode, refreshAuth, renewedCookie, resetAttempts, resetToken, setPassword, signedIn,
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
    await writeFile(path.join(dir, 'token.json'), JSON.stringify({ version: 1, token: 'a-new-token-from-the-cli-000000', secret: randomBytes(32).toString('base64') }));
    refreshAuth(Date.now() + 1500);
    expect(accessToken()).toBe('a-new-token-from-the-cli-000000');
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
    refreshAuth(Date.now() + 3000);
    expect(authMode()).toBe('password');
    await rm(written);
    refreshAuth(Date.now() + 4500);
    expect(authMode()).toBe('token');
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
