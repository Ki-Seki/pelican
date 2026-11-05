// `pelican phone` asks the running Pelican for a phone code with a proof for that one request,
// and only after making sure the server is the Pelican this account started.
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { app } from '../src/server/app';
import { commandProof, cookieName, loadAuth, newSessionCookie, proofValid } from '../src/server/auth';
import { config } from '../src/server/config';
import { thisPelican } from '../src/server/local';
import { instance, recordRunning } from '../src/server/running';

let dir: string;
const saved = { ...config };
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'pelican-proof-'));
  Object.assign(config, { configDir: path.join(dir, 'config'), stateDir: path.join(dir, 'state'), auth: 'auto' });
  await loadAuth();
});
afterAll(async () => {
  Object.assign(config, saved);
  await rm(dir, { recursive: true, force: true });
});

const ask = (route: string, headers: Record<string, string>, method = 'POST') => app.request(route, { method, headers: { host: 'localhost:7860', 'x-pelican': '1', ...headers } });

describe('a command’s proof', () => {
  it('gets a phone code, once, without a cookie for anything else', async () => {
    const proof = commandProof('POST', '/api/access/code', instance);
    const response = await ask('/api/access/code', { 'x-pelican-proof': proof });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { code: string }).code).toMatch(/^[\w-]{24}$/);
    expect(response.headers.get('set-cookie')).toBeNull();
    // The same proof again, sent by whoever saw it, gets nothing.
    expect((await ask('/api/access/code', { 'x-pelican-proof': proof })).status).toBe(401);
  });

  it('is good for that request only, to this server only, and for a minute only', async () => {
    expect((await ask('/api/sessions', { 'x-pelican-proof': commandProof('GET', '/api/sessions', instance) }, 'GET')).status).toBe(401);
    expect((await ask('/api/access/code', { 'x-pelican-proof': commandProof('POST', '/api/access/code', 'another-server') })).status).toBe(401);
    expect((await ask('/api/access/code', { 'x-pelican-proof': commandProof('POST', '/api/access/code', instance, Date.now() - 61_000) })).status).toBe(401);
    expect(proofValid(commandProof('POST', '/api/access/code', instance), 'POST', '/api/info', instance)).toBe(false);
    expect(proofValid('1.2.3', 'POST', '/api/access/code', instance)).toBe(false);
  });

  it('is no cookie, and a cookie is no proof', async () => {
    const cookie = newSessionCookie();
    expect((await ask('/api/access/code', { 'x-pelican-proof': cookie.value })).status).toBe(401);
    const proof = commandProof('POST', '/api/access/code', instance);
    expect((await ask('/api/info', { cookie: `${cookieName()}=${proof}` }, 'GET')).status).toBe(401);
  });
});

describe('the Pelican a command talks to', () => {
  let server: Server;
  let port: number;
  const seen: IncomingHttpHeaders[] = [];
  let answer = {};
  beforeAll(async () => {
    // Whatever listens on the port: answers as a Pelican would, and notes what it was sent.
    server = createServer((req, res) => {
      seen.push(req.headers);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => server.close());

  it('is the one its note names, by its id: anything else on the port is not it', async () => {
    // No note: nothing is ours, whatever answers.
    answer = { mode: 'token' };
    expect(await thisPelican(port)).toBeUndefined();
    await recordRunning({ port, host: '127.0.0.1', url: `http://127.0.0.1:${port}/`, version: '0' });
    // A note, but the server there gives no id, or another's.
    expect(await thisPelican(port)).toBeUndefined();
    answer = { mode: 'token', instance: 'someone-else' };
    expect(await thisPelican(port)).toBeUndefined();
    // The very one.
    answer = { mode: 'token', instance };
    expect(await thisPelican(port)).toMatchObject({ mode: 'token', running: { port, instance, pid: process.pid } });
    expect(await thisPelican(port + 1)).toBeUndefined();
    // A note of a process that is gone is no one's.
    await writeFile(path.join(config.stateDir, 'server.json'), JSON.stringify({ pid: 999_999_999, port, host: '127.0.0.1', url: `http://127.0.0.1:${port}/`, instance }));
    expect(await thisPelican(port)).toBeUndefined();
    // Only its public sign-in state was asked for: no cookie, no proof.
    expect(seen.every((headers) => !headers.cookie && !headers['x-pelican-proof'] && !headers.authorization)).toBe(true);
  });
});
