// A browser that signs out keeps no conversation pictures it could show again without asking.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { app } from '../src/server/app';
import { accessToken, loadAuth } from '../src/server/auth';
import { config } from '../src/server/config';
import { saveUpload } from '../src/server/files';
import { refreshTranscriptIndex } from '../src/server/transcripts';

const id = '0f0f0f0f-0000-4000-8000-0000000000dd';
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 7]).toString('base64');

let dir: string;
const saved = { ...config };
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'pelican-signout-'));
  Object.assign(config, { claudeHome: dir, configDir: path.join(dir, 'config'), stateDir: path.join(dir, 'state'), auth: 'auto' });
  await mkdir(path.join(dir, 'projects', '-w-app'), { recursive: true });
  const row = { type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-11-05T00:00:00.000Z', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] } };
  await writeFile(path.join(dir, 'projects', '-w-app', `${id}.jsonl`), `${JSON.stringify(row)}\n`);
  await refreshTranscriptIndex();
  await loadAuth();
});
afterAll(async () => {
  Object.assign(config, saved);
  await rm(dir, { recursive: true, force: true });
});

const request = (url: string, headers: Record<string, string> = {}, signedIn = true, method = 'GET') => app.request(url, {
  method,
  headers: { host: 'localhost:7860', 'x-pelican': '1', ...(signedIn ? { authorization: `Bearer ${accessToken()}` } : {}), ...headers },
});

describe('a picture in a conversation', () => {
  it('is checked with the server each time it is shown, so a signed-out browser gets no copy', async () => {
    const first = await request(`/api/sessions/${id}/images/u1/0`);
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('private, no-cache');
    const tag = first.headers.get('etag');
    expect(tag).toMatch(/^"[\w-]+"$/);
    // Unchanged: the browser shows what it has, without the picture being sent again.
    const again = await request(`/api/sessions/${id}/images/u1/0`, { 'if-none-match': tag! });
    expect(again.status).toBe(304);
    expect((await again.arrayBuffer()).byteLength).toBe(0);
    // Signed out, the browser asks the same way and is refused.
    expect((await request(`/api/sessions/${id}/images/u1/0`, { 'if-none-match': tag! }, false)).status).toBe(401);
    // Another picture has another tag.
    expect((await request(`/api/sessions/${id}/images/u1/1`, { 'if-none-match': tag! })).status).toBe(404);
  });

  it('that was uploaded is checked with the server each time too', async () => {
    const upload = await saveUpload(new File([Buffer.from(png, 'base64')], 'shot.png', { type: 'image/png' }));
    const response = await request(`/api/uploads/${upload.id}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-cache');
  });
});

describe('signing out', () => {
  it('asks the browser to drop what it keeps of Pelican', async () => {
    const response = await request('/api/auth/logout', { origin: 'http://localhost:7860' }, true, 'POST');
    expect(response.status).toBe(200);
    expect(response.headers.get('clear-site-data')).toBe('"cache"');
    expect(response.headers.get('set-cookie')).toMatch(/Max-Age=0/);
  });
});
