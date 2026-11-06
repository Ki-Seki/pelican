import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { accessToken, cookieName, newSessionCookie } from '../src/server/auth';
import { config } from '../src/server/config';
import { startServer } from '../src/server/server';

let dir: string;
let base: string;
let port: number;
let stop: () => Promise<void>;
const saved = { ...config };

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'pelican-server-'));
  Object.assign(config, {
    host: '127.0.0.1', port: 0, auth: 'auto',
    configDir: path.join(dir, 'config'), stateDir: path.join(dir, 'state'), claudeHome: path.join(dir, 'claude'),
  });
  const started = await startServer();
  base = started.url;
  port = Number(new URL(base).port);
  stop = started.close;
});
afterAll(async () => {
  await stop();
  Object.assign(config, saved);
  await rm(dir, { recursive: true, force: true });
});

const alive = async () => (await fetch(`${base}api/info`, { headers: { 'X-Pelican': '1', authorization: `Bearer ${accessToken()}` } })).status;

/** Opens the live socket the way a browser would, with these headers; resolves to whether it opened. */
function open(headers: Record<string, string>, pathname = '/api/ws'): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${pathname}`, { headers });
    ws.on('open', () => {
      ws.close();
      resolve(true);
    });
    ws.on('error', () => resolve(false));
  });
}

const page = { host: 'localhost', origin: 'http://localhost' };

describe('the live socket', () => {
  it('opens for a signed-in browser on Pelican’s own page', async () => {
    expect(await open({ ...page, authorization: `Bearer ${accessToken()}` })).toBe(true);
    const cookie = newSessionCookie();
    expect(await open({ ...page, cookie: `${cookie.name}=${cookie.value}` })).toBe(true);
  });

  it('stays shut without a sign-in, from another site, or under a name that does not point here', async () => {
    expect(await open(page)).toBe(false);
    expect(await open({ ...page, cookie: `${cookieName()}=${Date.now() + 60_000}.forged` })).toBe(false);
    expect(await open({ host: 'localhost', origin: 'https://evil.example', authorization: `Bearer ${accessToken()}` })).toBe(false);
    expect(await open({ host: 'attacker.example', origin: 'http://attacker.example', authorization: `Bearer ${accessToken()}` })).toBe(false);
    expect(await open({ ...page, authorization: `Bearer ${accessToken()}` }, '/api/other')).toBe(false);
  });

  it('survives a request whose target cannot be parsed, and keeps answering', async () => {
    for (const target of ['http://[', '//[', 'http://a b']) {
      await new Promise<void>((resolve) => {
        const socket = net.connect(port, '127.0.0.1', () => {
          socket.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
        });
        socket.on('error', () => undefined);
        socket.on('close', () => resolve());
        setTimeout(() => socket.destroy(), 1000);
      });
      expect(await alive()).toBe(200);
    }
  }, 20_000);

  it('answers every subscribe with the run as it is, or with none, also when asked again', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, { headers: { ...page, authorization: `Bearer ${accessToken()}` } });
    const events: unknown[] = [];
    ws.on('message', (data) => events.push(JSON.parse(String(data))));
    await new Promise((resolve) => ws.on('open', resolve));
    const id = '0f0f0f0f-0000-4000-8000-0000000000aa';
    ws.send(JSON.stringify({ type: 'subscribe', sessionId: id }));
    ws.send(JSON.stringify({ type: 'subscribe', sessionId: id }));
    ws.send(JSON.stringify({ type: 'subscribe', sessionId: '../../etc' }));
    for (const start = Date.now(); events.length < 4 && Date.now() - start < 2000;) await new Promise((resolve) => setTimeout(resolve, 20));
    ws.close();
    // With the run, its ! commands running, all of them: a page that missed one ending is set right too.
    expect(events).toEqual([
      { type: 'run', sessionId: id, state: null }, { type: 'shells', sessionId: id, shells: [] },
      { type: 'run', sessionId: id, state: null }, { type: 'shells', sessionId: id, shells: [] },
    ]);
  });
});
