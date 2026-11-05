import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import type { PartialAppend, ServerEvent } from '../src/shared/protocol';

// The page's store reads the address it was served from when it loads; this is that page.
vi.hoisted(() => {
  (globalThis as { location?: unknown }).location = new URL('http://localhost/');
});

/** Claude Code as the run sees it: whatever a test has it say, in order. */
class FakeClaude {
  private said: unknown[] = [];
  private listening?: (result: IteratorResult<unknown>) => void;
  private ended = false;

  constructor(prompt: AsyncIterable<SDKUserMessage> | string, readonly options: Options) {
    if (typeof prompt !== 'string') {
      void (async () => {
        for await (const _message of prompt) {
          // Taken, as Claude Code takes each prompt.
        }
      })();
    }
  }

  say(message: unknown): void {
    if (this.listening) {
      const listening = this.listening;
      this.listening = undefined;
      listening({ value: message, done: false });
    } else {
      this.said.push(message);
    }
  }

  end(): void {
    this.ended = true;
    this.listening?.({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: () => {
        if (this.said.length > 0) return Promise.resolve({ value: this.said.shift(), done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.listening = resolve;
        });
      },
    };
  }

  async interrupt() {}
  async setPermissionMode() {}
  async setModel() {}
  async applyFlagSettings() {}
  async getContextUsage() { return { percentage: 1, totalTokens: 2_000, maxTokens: 200_000 }; }
  async initializationResult() { return { models: [], account: {}, commands: [], agents: [] }; }
  close() { this.end(); }
}

const claudes: FakeClaude[] = [];
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: ({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage> | string; options: Options }) => {
    const claude = new FakeClaude(prompt, options);
    claudes.push(claude);
    return claude;
  },
}));
vi.mock('../src/server/push', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/server/push')>()),
  notify: async () => undefined,
}));

const { accessToken } = await import('../src/server/auth');
const { config } = await import('../src/server/config');
const { closeAll, sendMessage } = await import('../src/server/runner');
const { startServer } = await import('../src/server/server');
const { socket } = await import('../src/web/lib/socket');
const { getView, handleEvent } = await import('../src/web/lib/store');

let dir: string;
let port: number;
let stop: () => Promise<void>;
const saved = { ...config };

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'pelican-live-stream-'));
  Object.assign(config, {
    host: '127.0.0.1', port: 0, auth: 'auto',
    configDir: path.join(dir, 'config'), stateDir: path.join(dir, 'state'), claudeHome: path.join(dir, 'claude'),
  });
  const started = await startServer();
  port = Number(new URL(started.url).port);
  stop = started.close;
});
afterAll(async () => {
  closeAll();
  await stop();
  Object.assign(config, saved);
  await rm(dir, { recursive: true, force: true });
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const streamed = (event: Record<string, unknown>) => ({ type: 'stream_event', uuid: crypto.randomUUID(), session_id: 's', parent_tool_use_id: null, event });

describe('a reply Claude is writing', () => {
  it('reaches the page as it is written: one whole state, then appends from its start to its end', async () => {
    const sessionId = await sendMessage({ cwd: dir }, { text: 'Explain the build', attachments: [], settings: {} });
    const claude = claudes.at(-1)!;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, { headers: { host: 'localhost', origin: 'http://localhost', authorization: `Bearer ${accessToken()}` } });
    const events: ServerEvent[] = [];
    // What the page does with each frame: the store the chat reads from.
    ws.on('message', (data) => {
      const event = JSON.parse(String(data)) as ServerEvent;
      if (event.type === 'tick') return;
      events.push(event);
      handleEvent(event);
    });
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    const refresh = vi.spyOn(socket, 'refresh');
    ws.send(JSON.stringify({ type: 'subscribe', sessionId }));
    await vi.waitFor(() => expect(getView(sessionId).run?.busy).toBe(true));

    claude.say(streamed({ type: 'message_start', message: {} }));
    claude.say(streamed({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
    const pieces = Array.from({ length: 12 }, (_, i) => `${`Part ${i + 1} of the answer, said plainly. `.repeat(12)}\n\n`);
    let written = '';
    const shown = () => {
      const block = getView(sessionId).run?.partial[0];
      return block?.type === 'text' ? block.text : '';
    };
    for (const piece of pieces) {
      claude.say(streamed({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } }));
      written += piece;
      // The run sends what it has every 80 ms while Claude writes: by then the page has it all.
      await vi.waitFor(() => expect(shown()).toBe(written), { timeout: 1000, interval: 10 });
    }
    expect(written.length).toBeGreaterThan(5000);

    // Every step after the first whole state was only the text added, in order and without a gap.
    const first = events.findIndex((e) => e.type === 'run' && e.state?.partial.length === 1);
    expect(first).toBeGreaterThanOrEqual(0);
    const start = events[first]!.type === 'run' ? (events[first] as Extract<ServerEvent, { type: 'run' }>).state!.partial[0] : undefined;
    let length = start?.type === 'text' ? start.text.length : -1;
    const appends = events.slice(first + 1).flatMap((e) => (e.type === 'partial' ? e.appends : []));
    expect(events.slice(first + 1).every((e) => e.type === 'partial')).toBe(true);
    expect(appends.length).toBeGreaterThanOrEqual(pieces.length - 1);
    for (const append of appends as PartialAppend[]) {
      expect(append).toMatchObject({ index: 0, from: length });
      length += append.text.length;
    }
    expect(length).toBe(written.length);
    expect(refresh).not.toHaveBeenCalled();
    ws.close();
  }, 20_000);
});
