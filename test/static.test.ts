import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { app } from '../src/server/app';
import { accessToken, loadAuth } from '../src/server/auth';
import { config } from '../src/server/config';

let dir: string;
const saved = { ...config };
const script = 'export const x = 1;\n'.repeat(200);

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'pelican-static-'));
  Object.assign(config, { configDir: path.join(dir, 'config'), stateDir: path.join(dir, 'state'), webDir: path.join(dir, 'web'), auth: 'auto' });
  await mkdir(path.join(config.webDir!, 'assets'), { recursive: true });
  await writeFile(path.join(config.webDir!, 'index.html'), '<!doctype html><div id="root"></div>');
  const asset = path.join(config.webDir!, 'assets', 'index-abc123.js');
  await writeFile(asset, script);
  await writeFile(`${asset}.br`, zlib.brotliCompressSync(script));
  await writeFile(`${asset}.gz`, zlib.gzipSync(script));
  await loadAuth();
});
afterAll(async () => {
  Object.assign(config, saved);
  await rm(dir, { recursive: true, force: true });
});

const get = (url: string, encoding?: string) => app.request(url, { headers: { host: 'localhost:7860', ...(encoding ? { 'accept-encoding': encoding } : {}) } });

describe('the web app’s files', () => {
  it('go out compressed when the browser takes it, best first, and say so', async () => {
    const br = await get('/assets/index-abc123.js', 'gzip, deflate, br');
    expect(br.headers.get('content-encoding')).toBe('br');
    expect(br.headers.get('vary')).toBe('Accept-Encoding');
    expect(br.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(zlib.brotliDecompressSync(Buffer.from(await br.arrayBuffer())).toString()).toBe(script);

    const gz = await get('/assets/index-abc123.js', 'gzip, br;q=0');
    expect(gz.headers.get('content-encoding')).toBe('gzip');
    expect(zlib.gunzipSync(Buffer.from(await gz.arrayBuffer())).toString()).toBe(script);

    const plain = await get('/assets/index-abc123.js');
    expect(plain.headers.get('content-encoding')).toBeNull();
    expect(await plain.text()).toBe(script);
    expect(plain.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
  });

  it('send a page as it is when there is no compressed copy', async () => {
    const page = await get('/?s=abc', 'br, gzip');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-encoding')).toBeNull();
    expect(page.headers.get('cache-control')).toBe('no-cache');
    expect((await get('/assets/missing-1.js', 'br')).status).toBe(404);
  });
});

describe('API answers', () => {
  it('are compressed for browsers that take gzip', async () => {
    const response = await app.request('/api/info', {
      headers: { host: 'localhost:7860', 'x-pelican': '1', authorization: `Bearer ${accessToken()}`, 'accept-encoding': 'gzip, br' },
    });
    expect(response.headers.get('content-encoding')).toBe('gzip');
    const info = JSON.parse(zlib.gunzipSync(Buffer.from(await response.arrayBuffer())).toString()) as { machine: string };
    expect(info.machine).toBe(config.machine);
  });
});
