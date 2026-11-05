import { mkdtemp, rm } from 'node:fs/promises';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { accessToken } from '../src/server/auth';
import { config } from '../src/server/config';
import { feedFor } from '../src/server/feed';
import { startServer } from '../src/server/server';

/** How often the server pings each socket (server.ts). */
const HEARTBEAT_MS = 25_000;

let dir: string;
let port: number;
let stop: () => Promise<void>;
const saved = { ...config };

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'pelican-heartbeat-'));
  Object.assign(config, {
    host: '127.0.0.1', port: 0, auth: 'auto',
    configDir: path.join(dir, 'config'), stateDir: path.join(dir, 'state'), claudeHome: path.join(dir, 'claude'),
  });
  const started = await startServer();
  port = Number(new URL(started.url).port);
  stop = started.close;
});
afterEach(() => {
  vi.useRealTimers();
});
afterAll(async () => {
  await stop();
  Object.assign(config, saved);
  await rm(dir, { recursive: true, force: true });
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, ms = 5000): Promise<void> {
  for (const start = Date.now(); !check();) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await pause(10);
  }
}

/**
 * A page on a slow link: subscribed to a session, it reads from its socket only when told to.
 * The server's pings are fake intervals here, so each heartbeat is one step of the test.
 */
async function slowPage(sessionId: string) {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, {
    headers: { host: 'localhost', origin: 'http://localhost', authorization: `Bearer ${accessToken()}` },
    perMessageDeflate: false,
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  let pings = 0;
  ws.on('ping', () => {
    pings += 1;
  });
  ws.send(JSON.stringify({ type: 'subscribe', sessionId }));
  await until(() => feedFor(sessionId).listeners.size === 1);
  await pause(50);
  const socket = (ws as unknown as { _socket: net.Socket })._socket;
  let read = 0;
  let goal = 0;
  socket.on('data', (chunk: Buffer) => {
    read += chunk.length;
    if (read >= goal) socket.pause();
  });
  socket.pause();
  return {
    ws,
    pings: () => pings,
    /** Reads this many more bytes, then stops reading again. */
    async read(bytes: number) {
      goal = read + bytes;
      socket.resume();
      await until(() => read >= goal, 10_000);
    },
    readAll: () => {
      goal = Infinity;
      socket.resume();
    },
  };
}

/** Claude's step with a picture in it, as a run publishes it: megabytes of data. */
const big = (n: number) => ({ uuid: crypto.randomUUID(), role: 'user' as const, blocks: [{ type: 'text' as const, text: `${n}`.repeat(2_000_000) }], timestamp: Date.now() });

/** Whether the server still has the socket: it drops a socket's subscriptions with it. */
const subscribed = (sessionId: string) => feedFor(sessionId).listeners.size > 0;

describe('the heartbeat', () => {
  it('keeps a socket that is still reading what it was sent, whose answer to the ping waits behind it', async () => {
    const id = '0f0f0f0f-0000-4000-8000-0000000000b1';
    const page = await slowPage(id);
    // More than the computer's own buffers take: the rest waits in the server, and the ping behind it.
    for (let n = 0; n < 12; n += 1) await feedFor(id).publish(big(n));
    await pause(100);
    vi.advanceTimersByTime(HEARTBEAT_MS);
    // A phone on a slow link: it reads on, but has not reached the ping by the next heartbeat.
    await page.read(5 * 1024 * 1024);
    await pause(100);
    vi.advanceTimersByTime(HEARTBEAT_MS);
    await pause(200);
    expect(page.pings()).toBe(0);
    expect(subscribed(id)).toBe(true);
    // Once it has read the backlog it answers, and is kept from then on.
    page.readAll();
    await until(() => page.pings() === 1, 10_000);
    await pause(100);
    vi.advanceTimersByTime(HEARTBEAT_MS);
    await until(() => page.pings() === 2);
    await pause(100);
    vi.advanceTimersByTime(HEARTBEAT_MS);
    await pause(200);
    expect(subscribed(id)).toBe(true);
    page.ws.terminate();
  }, 30_000);

  it('still drops a socket that took nothing since the ping went out, after one more heartbeat for a large message', async () => {
    const id = '0f0f0f0f-0000-4000-8000-0000000000b2';
    const page = await slowPage(id);
    for (let n = 0; n < 12; n += 1) await feedFor(id).publish(big(n));
    await pause(100);
    vi.advanceTimersByTime(HEARTBEAT_MS);
    await pause(200);
    // Its backlog did not go down: one large message may still be on its way over a slow link.
    vi.advanceTimersByTime(HEARTBEAT_MS);
    await pause(200);
    expect(subscribed(id)).toBe(true);
    vi.advanceTimersByTime(HEARTBEAT_MS);
    await until(() => !subscribed(id));
    page.ws.terminate();
  }, 30_000);

  it('drops an idle socket that does not answer the ping', async () => {
    const id = '0f0f0f0f-0000-4000-8000-0000000000b3';
    const page = await slowPage(id);
    vi.advanceTimersByTime(HEARTBEAT_MS);
    await pause(200);
    expect(subscribed(id)).toBe(true);
    vi.advanceTimersByTime(HEARTBEAT_MS);
    await until(() => !subscribed(id));
    page.ws.terminate();
  }, 30_000);
});
