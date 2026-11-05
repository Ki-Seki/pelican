import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { RunState, ServerEvent } from '../src/shared/protocol';
import { config } from '../src/server/config';
import { feedFor } from '../src/server/feed';
import { runState } from '../src/server/runner';
import { startServer } from '../src/server/server';

vi.mock('../src/server/runner', async (original) => ({ ...(await original<typeof import('../src/server/runner')>()), runState: vi.fn() }));

let dir: string;
let port: number;
let stop: () => Promise<void>;
const saved = { ...config };

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'pelican-backpressure-'));
  Object.assign(config, {
    host: '127.0.0.1', port: 0, auth: 'none',
    configDir: path.join(dir, 'config'), stateDir: path.join(dir, 'state'), claudeHome: path.join(dir, 'claude'),
  });
  const started = await startServer();
  port = Number(new URL(started.url).port);
  stop = started.close;
});
afterAll(async () => {
  await stop();
  Object.assign(config, saved);
  await rm(dir, { recursive: true, force: true });
});

/** The server's frames, as text: unmasked, single-frame text messages, without compression (not asked for). */
function frames(data: Buffer): string[] {
  const out: string[] = [];
  for (let at = 0; at + 2 <= data.length;) {
    let length = data[at + 1]! & 0x7f;
    let start = at + 2;
    if (length === 126) {
      length = data.readUInt16BE(at + 2);
      start = at + 4;
    } else if (length === 127) {
      length = Number(data.readBigUInt64BE(at + 2));
      start = at + 10;
    }
    if (start + length > data.length) break;
    if ((data[at]! & 0x0f) === 1) out.push(data.toString('utf8', start, start + length));
    at = start + length;
  }
  return out;
}

const state = (sessionId: string, text: string): RunState => ({ sessionId, cwd: '/w', busy: true, settings: {}, permissions: [], partial: [{ type: 'text', text }] });

describe('a socket that falls behind', () => {
  it('gets no run updates while its backlog is large, then the newest one', async () => {
    const id = '0f0f0f0f-0000-4000-8000-0000000000dd';
    vi.mocked(runState).mockReturnValue(undefined);
    const socket = net.connect(port, '127.0.0.1');
    const received: Buffer[] = [];
    await new Promise<void>((resolve) => {
      socket.once('connect', () => {
        socket.write(`GET /api/ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      socket.once('data', (head) => {
        received.push(head.subarray(head.indexOf('\r\n\r\n') + 4));
        resolve();
      });
    });
    const payload = Buffer.from(JSON.stringify({ type: 'subscribe', sessionId: id }));
    const mask = Buffer.from([1, 2, 3, 4]);
    socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, Buffer.from(payload.map((b, i) => b ^ mask[i % 4]!))]));
    socket.on('data', (chunk) => received.push(chunk));
    await new Promise((resolve) => setTimeout(resolve, 200));
    // A phone on a slow link: it stops reading while Claude writes on.
    socket.pause();
    let text = '';
    const sent = 80;
    for (let i = 0; i < sent; i += 1) {
      text += randomBytes(48 * 1024).toString('base64');
      feedFor(id).broadcast({ type: 'run', state: state(id, text) });
      await new Promise((resolve) => setImmediate(resolve));
    }
    const latest = state(id, `${text}!`);
    vi.mocked(runState).mockReturnValue(latest);
    socket.resume();
    await vi.waitFor(() => expect(frames(Buffer.concat(received)).at(-1)).toContain('"text":"'), { timeout: 10_000, interval: 100 });
    await new Promise((resolve) => setTimeout(resolve, 600));
    socket.destroy();
    const events = frames(Buffer.concat(received)).map((frame) => JSON.parse(frame) as ServerEvent);
    const updates = events.filter((e) => e.type === 'run' || e.type === 'partial');
    // Fewer updates than were sent: those that would only have been replaced were never queued.
    expect(updates.length).toBeLessThan(sent);
    expect(updates.at(-1)).toEqual({ type: 'run', sessionId: id, state: latest });
  }, 20_000);
});
