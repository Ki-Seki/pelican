import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { app } from '../src/server/app';
import { accessToken, issueCode, loadAuth, newSessionCookie, resetAttempts } from '../src/server/auth';
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
    expect(response.headers.get('location')).toBe('./?s=abc');
    expect(response.headers.get('set-cookie')).toMatch(/HttpOnly; SameSite=Strict/);
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    expect((await ask('/api/sessions', { headers: { cookie } }, false)).status).not.toBe(401);
  });

  it('a wrong token sets no cookie, and the redirect never leaves this site', async () => {
    const wrong = await ask('/?token=nope', {}, false);
    expect(wrong.status).toBe(302);
    expect(wrong.headers.get('set-cookie')).toBeNull();
    const sneaky = await ask(`http://localhost:7860//evil.example/?token=${accessToken()}`, {}, false);
    expect(sneaky.headers.get('location')).toBe('./');
    // Under a proxy's path prefix, the redirect stays under it.
    const prefixed = await ask(`/pelican/?token=${accessToken()}`, {}, false);
    expect(prefixed.headers.get('location')).toBe('./');
  });

  it('an old link or a used code says why on the sign-in page, and only there', async () => {
    expect((await ask('/?token=nope&s=abc', {}, false)).headers.get('location')).toBe('./?s=abc&signin=link');
    const { code } = await (await ask('/api/access/code', { method: 'POST' })).json() as { code: string };
    await ask(`/?code=${code}`, {}, false);
    expect((await ask(`/?code=${code}`, {}, false)).headers.get('location')).toBe('./?signin=code');
    const cookie = newSessionCookie();
    expect((await ask('/?token=nope', { headers: { cookie: `${cookie.name}=${cookie.value}` } }, false)).headers.get('location')).toBe('./');
  });

  it('use keeps a browser signed in: an older cookie is renewed', async () => {
    const old = newSessionCookie(Date.now() - 3 * 86_400_000);
    const response = await ask('/api/info', { headers: { cookie: `${old.name}=${old.value}` } }, false);
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toMatch(new RegExp(`^${old.name}=\\d+\\.[\\w-]+; Path=/; Max-Age=2592000; HttpOnly; SameSite=Strict`));
    const fresh = newSessionCookie();
    expect((await ask('/api/info', { headers: { cookie: `${fresh.name}=${fresh.value}` } }, false)).headers.get('set-cookie')).toBeNull();
  });

  it('logs in with the token, and counts wrong ones', async () => {
    const login = (token: string) => ask('/api/auth/login', { method: 'POST', body: JSON.stringify({ token }), headers: { 'content-type': 'application/json' } }, false);
    expect((await login('wrong')).status).toBe(401);
    expect((await login(accessToken()!)).status).toBe(200);
  });
});

describe('one-time codes (the phone QR code)', () => {
  it('sign a browser in once, and are asked for only by a signed-in page', async () => {
    expect((await ask('/api/access/code', { method: 'POST' }, false)).status).toBe(401);
    const { code } = await (await ask('/api/access/code', { method: 'POST' })).json() as { code: string };
    expect(code).toMatch(/^[\w-]{24}$/);
    const first = await ask(`/?code=${code}`, {}, false);
    expect(first.headers.get('set-cookie')).toMatch(/HttpOnly/);
    const again = await ask(`/?code=${code}`, {}, false);
    expect(again.headers.get('set-cookie')).toBeNull();
    expect((await ask(`/?code=${issueCode(Date.now() - 3 * 60_000)}`, {}, false)).headers.get('set-cookie')).toBeNull();
  });

  it('the page never gets the access token itself', async () => {
    expect((await ask('/api/access')).status).toBe(404);
  });
});

describe('what a request may carry', () => {
  it('settings for a running Claude, only of the right shape', async () => {
    expect((await ask('/api/sessions/abc/settings', { method: 'POST', body: JSON.stringify({}), headers: { 'content-type': 'application/json' } })).status).toBe(400);
    expect((await ask('/api/sessions/abc/settings', { method: 'POST', body: JSON.stringify({ settings: { effort: 'high' } }), headers: { 'content-type': 'application/json' } })).status).toBe(200);
  });

  it('only the permission modes there are', async () => {
    const response = await ask('/api/sessions/abc/mode', { method: 'POST', body: JSON.stringify({ permissionMode: 'yolo' }), headers: { 'content-type': 'application/json' } });
    expect(response.status).toBe(400);
  });

  it('a new session only in a folder that exists', async () => {
    const response = await ask('/api/sessions', { method: 'POST', body: JSON.stringify({ cwd: 'relative/path', text: 'hi' }), headers: { 'content-type': 'application/json' } });
    expect(response.status).toBe(400);
  });

  it('a rewind only with the message and what to restore; editing a prompt is Rewind to here now', async () => {
    const rewind = (body: unknown) => ask('/api/sessions/abc/rewind', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    expect((await rewind({})).status).toBe(400);
    expect((await rewind({ uuid: 'abc', restore: 'both' })).status).toBe(400);
    expect((await rewind({ uuid: '4e05eb31-6d40-4b57-93dd-bf4aeb9374cf', restore: 'all' })).status).toBe(400);
    const edit = await ask('/api/sessions/abc/edit', { method: 'POST', body: JSON.stringify({ text: 'hi' }), headers: { 'content-type': 'application/json' } });
    expect(edit.status).toBe(404);
  });

  it('a side question only with a question, about a session there is', async () => {
    const side = (sessionId: string, body: unknown) => ask(`/api/sessions/${sessionId}/side`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    expect((await side('4e05eb31-6d40-4b57-93dd-bf4aeb9374cf', {})).status).toBe(400);
    expect((await side('4e05eb31-6d40-4b57-93dd-bf4aeb9374cf', { question: '   ' })).status).toBe(400);
    expect((await side('4e05eb31-6d40-4b57-93dd-bf4aeb9374cf', { question: 7 })).status).toBe(400);
    expect((await side('not-a-session', { question: 'Why?' })).status).toBe(404);
    expect((await side('4e05eb31-6d40-4b57-93dd-bf4aeb9374cf', { question: 'Why?' })).status).toBe(404);
  });

  it('nothing large before signing in: an upload is refused before its body is read', async () => {
    const response = await ask('/api/uploads', { method: 'POST', body: 'x'.repeat(1000), headers: { 'content-type': 'application/octet-stream', 'content-length': String(30 * 1024 * 1024) } }, false);
    expect(response.status).toBe(401);
  });
});

describe('archive', () => {
  it('puts a session away and back, and takes nothing else', async () => {
    const id = '4e05eb31-6d40-4b57-93dd-bf4aeb9374cf';
    const post = (body: unknown, sessionId = id) => ask(`/api/sessions/${sessionId}/archive`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    expect((await post({ archived: 'yes' })).status).toBe(400);
    expect((await post({ archived: true }, 'not-a-session')).status).toBe(400);
    expect((await post({ archived: true })).status).toBe(200);
    const { archivedIds } = await import('../src/server/archive');
    expect((await archivedIds()).has(id)).toBe(true);
    expect((await post({ archived: false })).status).toBe(200);
    expect((await archivedIds()).has(id)).toBe(false);
  });
});

describe('pin', () => {
  const id = '6d1c8a52-3f0e-4b7a-9c21-5e8f0a4b2d17';
  const json = { 'content-type': 'application/json' };
  const pin = (body: unknown, sessionId = id, headers: Record<string, string> = {}, signedIn = true) =>
    ask(`/api/sessions/${sessionId}/pin`, { method: 'POST', body: JSON.stringify(body), headers: { ...json, ...headers } }, signedIn);

  it('keeps a session at the top and lets it go, in Pelican’s own pins', async () => {
    const { pinnedIds } = await import('../src/server/pinned');
    expect((await pin({ pinned: 'yes' })).status).toBe(400);
    expect((await pin({})).status).toBe(400);
    expect((await pin({ pinned: true }, 'not-a-session')).status).toBe(400);
    expect((await pin({ pinned: true })).status).toBe(200);
    expect((await pinnedIds()).has(id)).toBe(true);
    expect((await pin({ pinned: false })).status).toBe(200);
    expect((await pinnedIds()).has(id)).toBe(false);
  });

  it('stands behind the same gates as archive: signed in, from Pelican’s page, never in the demo', async () => {
    const { pinnedIds } = await import('../src/server/pinned');
    expect((await pin({ pinned: true }, id, {}, false)).status).toBe(401);
    expect((await pin({ pinned: true }, id, { 'x-pelican': '' })).status).toBe(403);
    expect((await pin({ pinned: true }, id, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await pin({ pinned: true }, id, { origin: 'https://evil.example' })).status).toBe(403);
    config.demo = true;
    expect((await pin({ pinned: true })).status).toBe(403);
    expect((await pinnedIds()).has(id)).toBe(false);
  });

  it('is never together with archived: archiving unpins, and a pin brings an archived session back', async () => {
    const { pinnedIds } = await import('../src/server/pinned');
    const { archivedIds } = await import('../src/server/archive');
    const archive = (archived: boolean) => ask(`/api/sessions/${id}/archive`, { method: 'POST', body: JSON.stringify({ archived }), headers: json });
    await pin({ pinned: true });
    expect((await archive(true)).status).toBe(200);
    expect([(await archivedIds()).has(id), (await pinnedIds()).has(id)]).toEqual([true, false]);
    expect((await pin({ pinned: true })).status).toBe(200);
    expect([(await archivedIds()).has(id), (await pinnedIds()).has(id)]).toEqual([false, true]);
    // Unpinning or unarchiving leaves the other as it is.
    expect((await archive(false)).status).toBe(200);
    expect((await pinnedIds()).has(id)).toBe(true);
    await archive(true);
    expect((await pin({ pinned: false })).status).toBe(200);
    expect((await archivedIds()).has(id)).toBe(true);
    await archive(false);
  });

  it('goes with a session that is deleted', async () => {
    const { pinnedIds } = await import('../src/server/pinned');
    const gone = '0d0d0d0d-0000-4000-8000-000000000001';
    const project = path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', '-w-gone');
    await mkdir(project, { recursive: true });
    const row = { type: 'user', uuid: 'u1', parentUuid: null, sessionId: gone, cwd: '/w/gone', timestamp: new Date().toISOString(), message: { role: 'user', content: 'Tidy up' } };
    await writeFile(path.join(project, `${gone}.jsonl`), `${JSON.stringify(row)}\n`);
    expect((await pin({ pinned: true }, gone)).status).toBe(200);
    expect((await ask(`/api/sessions/${gone}`, { method: 'DELETE' })).status).toBe(200);
    expect((await pinnedIds()).has(gone)).toBe(false);
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

  it('runs scripts only from Pelican and talks only to Pelican, its WebSocket included', async () => {
    const policy = (await ask('/', {}, false)).headers.get('content-security-policy') ?? '';
    expect(policy).toContain("script-src 'self';");
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("connect-src 'self' ws://localhost:7860 wss://localhost:7860;");
    expect(policy).toContain("frame-src 'self';");
    expect(policy).toContain("object-src 'none'");
    // A host name that would end the directive is left out.
    const odd = (await ask('/', { headers: { 'x-forwarded-host': 'x.example; script-src *' } }, false)).headers.get('content-security-policy') ?? '';
    expect(odd).not.toContain('script-src *');
  });

  it('runs a preview’s scripts in a document of its own, under the preview policy', async () => {
    await writeFile(path.join(config.webDir!, 'preview.html'), '<!doctype html><script>1</script>');
    const response = await ask('/preview.html', {}, false);
    const policy = response.headers.get('content-security-policy') ?? '';
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("connect-src https://cdnjs.cloudflare.com");
    expect(policy).toContain("frame-ancestors 'self'");
    expect(policy).not.toContain("script-src 'self'");
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
    const side = await ask('/api/sessions/4e05eb31-6d40-4b57-93dd-bf4aeb9374cf/side', { method: 'POST', body: JSON.stringify({ question: 'Why?' }), headers: { 'content-type': 'application/json' } });
    expect(side.status).toBe(403);
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

describe('making a folder for a new session', () => {
  it('makes it where asked, refuses a bad request, and changes nothing in the demo', async () => {
    const parent = await mkdtemp(path.join(dir, 'browse-'));
    const made = await ask('/api/dirs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ parent, name: 'fresh' }) });
    expect(made.status).toBe(200);
    expect(((await made.json()) as { path: string }).path.endsWith(`${path.sep}fresh`)).toBe(true);
    const again = await ask('/api/dirs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ parent, name: 'fresh' }) });
    expect(again.status).toBe(409);
    const relative = await ask('/api/dirs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ parent: 'code', name: 'x' }) });
    expect(relative.status).toBe(400);
    config.demo = true;
    const demo = await ask('/api/dirs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ parent, name: 'demo' }) });
    expect(demo.ok).toBe(false);
  });
});

describe('what new sessions start with', () => {
  const json = { 'content-type': 'application/json' };
  const settingsFile = () => path.join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json');
  const save = (body: unknown, headers: Record<string, string> = {}, signedIn = true) =>
    ask('/api/defaults', { method: 'POST', body: JSON.stringify(body), headers: { ...json, ...headers } }, signedIn);
  // Claude Code's folder, there whichever of these runs first.
  beforeAll(async () => {
    await mkdir(process.env.CLAUDE_CONFIG_DIR!, { recursive: true });
  });

  it('changes Claude Code’s user settings only for a signed-in request from Pelican’s page, and never in the demo', async () => {
    await writeFile(settingsFile(), '{"theme":"dark"}');
    expect((await save({ permissionMode: 'plan' }, {}, false)).status).toBe(401);
    expect((await save({ permissionMode: 'plan' }, { 'x-pelican': '' })).status).toBe(403);
    expect((await save({ permissionMode: 'plan' }, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await save({ permissionMode: 'plan' }, { origin: 'https://evil.example' })).status).toBe(403);
    config.demo = true;
    expect((await save({ permissionMode: 'plan' })).status).toBe(403);
    // The demo's are its own, Claude Code's defaults from no file: the user's file is not read.
    expect(await (await ask('/api/defaults')).json()).toMatchObject({ model: { value: 'default', source: 'built-in' }, permissionMode: { value: 'auto', source: 'built-in' } });
    config.demo = false;
    expect(await readFile(settingsFile(), 'utf8')).toBe('{"theme":"dark"}');
    expect(await (await ask('/api/defaults')).json()).toMatchObject({ file: { path: settingsFile(), state: 'ok' } });
    const saved = await save({ permissionMode: 'plan' });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ permissionMode: { value: 'plan', source: 'user' } });
    expect(await readFile(settingsFile(), 'utf8')).toBe(`${JSON.stringify({ theme: 'dark', permissions: { defaultMode: 'plan' } }, null, 2)}\n`);
  });

  it('refuses Bypass, more than one change at a time, and changes it does not make', async () => {
    expect((await save({ permissionMode: 'bypassPermissions' })).status).toBe(400);
    expect((await save({ fast: true, permissionMode: 'plan' })).status).toBe(400);
    expect((await save({ hooks: { Stop: [] } })).status).toBe(400);
    expect((await save({ effort: { model: 'default', level: 'max' } })).status).toBe(400);
    expect((await save({ permissionMode: 'plan', cwd: '/no/such/folder' })).status).toBe(404);
  });

  it('leaves a file that does not parse as it is, and says why', async () => {
    await writeFile(settingsFile(), '{ nope');
    const response = await save({ fast: true });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toMatch(/as it is: It is not valid JSON/);
    expect(await readFile(settingsFile(), 'utf8')).toBe('{ nope');
    await rm(settingsFile());
  });
});
