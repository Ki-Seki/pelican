import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { app } from '../src/server/app';
import { accessToken, loadAuth, resetAttempts } from '../src/server/auth';
import { config } from '../src/server/config';

let dir: string;
const saved = { ...config };
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'pelican-app-'));
  config.configDir = path.join(dir, 'config');
  config.stateDir = path.join(dir, 'state');
  config.webDir = path.join(dir, 'web');
  config.auth = 'auto';
  await mkdir(config.webDir, { recursive: true });
  await writeFile(path.join(config.webDir, 'index.html'), '<!doctype html><div id="root"></div>');
  await loadAuth();
});
afterEach(() => {
  config.demo = false;
  config.home = saved.home;
  resetAttempts();
});
afterAll(() => rm(dir, { recursive: true, force: true }));

/** A request as Pelican's own page makes it: its host, its mark, signed in with the token. */
const ask = (url: string, init: RequestInit & { headers?: Record<string, string> } = {}, signedIn = true) =>
  app.request(url, {
    ...init,
    headers: {
      host: 'localhost:7860',
      'x-pelican': '1',
      ...(signedIn ? { authorization: `Bearer ${accessToken()}` } : {}),
      ...init.headers,
    },
  });

describe('every API request', () => {
  it('needs a host name that points here (DNS rebinding)', async () => {
    expect((await ask('/api/info', { headers: { host: 'attacker.example' } })).status).toBe(403);
    expect((await ask('/api/info')).status).toBe(200);
  });

  it('needs Pelican’s mark, which another site cannot add', async () => {
    expect((await ask('/api/info', { headers: { 'x-pelican': '' } })).status).toBe(403);
  });

  it('is refused when a browser says another site sent it, reads included', async () => {
    expect((await ask('/api/git?cwd=/', { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    expect((await ask('/api/git?cwd=/', { headers: { 'sec-fetch-site': 'same-site' } })).status).toBe(403);
    expect((await ask('/api/info', { headers: { 'sec-fetch-site': 'same-origin' } })).status).toBe(200);
  });

  it('needs a signed-in browser, also on this computer', async () => {
    const response = await ask('/api/sessions', {}, false);
    expect(response.status).toBe(401);
    expect((await ask('/api/info', { headers: { authorization: 'Bearer wrong' } }, false)).status).toBe(401);
  });

  it('refuses a change from another origin', async () => {
    const response = await ask('/api/push/unsubscribe', { method: 'POST', body: '{}', headers: { origin: 'https://evil.example' } });
    expect(response.status).toBe(403);
  });

  it('reads no body larger than it needs, signed in or not', async () => {
    const big = JSON.stringify({ password: 'x'.repeat(10_000) });
    const response = await ask('/api/auth/login', { method: 'POST', body: big, headers: { 'content-type': 'application/json', 'content-length': String(big.length) } }, false);
    expect(response.status).toBe(413);
  });
});

describe('signing in', () => {
  it('with the token from the printed link: a cookie, then the address without the token', async () => {
    const response = await ask(`/?token=${accessToken()}&s=abc`, {}, false);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/?s=abc');
    expect(response.headers.get('set-cookie')).toMatch(/HttpOnly; SameSite=Strict/);
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    expect((await ask('/api/sessions', { headers: { cookie } }, false)).status).not.toBe(401);
  });

  it('a wrong token sets no cookie, and the redirect never leaves this site', async () => {
    const wrong = await ask('/?token=nope', {}, false);
    expect(wrong.status).toBe(302);
    expect(wrong.headers.get('set-cookie')).toBeNull();
    const sneaky = await ask(`http://localhost:7860//evil.example/?token=${accessToken()}`, {}, false);
    expect(sneaky.headers.get('location')).toBe('/evil.example/');
  });

  it('logs in with the token, and counts wrong ones', async () => {
    const login = (token: string) => ask('/api/auth/login', { method: 'POST', body: JSON.stringify({ token }), headers: { 'content-type': 'application/json' } }, false);
    expect((await login('wrong')).status).toBe(401);
    expect((await login(accessToken()!)).status).toBe(200);
  });
});

describe('the page', () => {
  it('may be framed only by itself, and loads images only from itself', async () => {
    const response = await ask('/', {}, false);
    const policy = response.headers.get('content-security-policy') ?? '';
    expect(policy).toContain("frame-ancestors 'self'");
    expect(policy).toContain("img-src 'self' data: blob:");
    expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN');
  });
});

describe('the demo', () => {
  it('shows only its own folders and changes nothing', async () => {
    config.demo = true;
    config.home = await mkdtemp(path.join(dir, 'demo-'));
    expect((await ask('/api/file?cwd=/etc&path=hosts')).status).toBe(404);
    expect((await ask('/api/tree?cwd=/etc')).status).toBe(404);
    expect((await ask('/api/git?cwd=/')).status).toBe(404);
    expect((await ask('/api/dirs?path=/etc')).status).toBe(404);
    const response = await ask('/api/push/subscribe', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(response.status).toBe(403);
  });
});

describe('push subscriptions', () => {
  it('take only what browsers make', async () => {
    const subscribe = (subscription: unknown) =>
      ask('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription, openUrl: 'javascript:alert(1)' }), headers: { 'content-type': 'application/json' } });
    expect((await subscribe({ endpoint: 'http://169.254.169.254/x', keys: { p256dh: 'a', auth: 'b' } })).status).toBe(400);
    expect((await subscribe(null)).status).toBe(400);
  });
});
