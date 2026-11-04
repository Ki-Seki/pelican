import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { allowAttempt, checkPassword, clearPassword, cookieName, newSessionCookie, passwordSet, setPassword, signedIn } from '../src/server/auth';
import { config } from '../src/server/config';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'pelican-auth-'));
  config.configDir = dir;
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe('password', () => {
  it('without one, every request is signed in', async () => {
    await clearPassword();
    expect(passwordSet()).toBe(false);
    expect(signedIn(undefined)).toBe(true);
  });

  it('checks the password and keeps only a hash, readable by the owner alone', async () => {
    await setPassword('correct horse battery');
    expect(passwordSet()).toBe(true);
    expect(await checkPassword('correct horse battery')).toBe(true);
    expect(await checkPassword('wrong')).toBe(false);
    const file = path.join(dir, 'auth.json');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('signs in with the cookie it issued, and not with a forged or old one', async () => {
    await setPassword('first password');
    const cookie = newSessionCookie();
    expect(signedIn(`${cookie.name}=${cookie.value}`)).toBe(true);
    expect(signedIn(undefined)).toBe(false);
    const [expires] = cookie.value.split('.');
    expect(signedIn(`${cookie.name}=${expires}.forged`)).toBe(false);
    // A new password rotates the secret: old cookies stop working.
    await setPassword('second password');
    expect(cookieName()).not.toBe(cookie.name);
    expect(signedIn(`${cookieName()}=${cookie.value}`)).toBe(false);
  });

  it('limits attempts per client', () => {
    for (let i = 0; i < 10; i += 1) expect(allowAttempt('1.2.3.4')).toBe(true);
    expect(allowAttempt('1.2.3.4')).toBe(false);
    expect(allowAttempt('5.6.7.8')).toBe(true);
  });
});
