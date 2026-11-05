import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { PartialBlock, RunState } from '../src/shared/protocol';

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

const { app } = await import('../src/server/app');
const { accessToken, loadAuth } = await import('../src/server/auth');
const { config } = await import('../src/server/config');
const { closeAll, runState, sendMessage } = await import('../src/server/runner');
const { PARTIAL_INPUT_MAX } = await import('../src/server/stream');

let dir: string;
const saved = { ...config };
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'pelican-detail-'));
  Object.assign(config, { configDir: path.join(dir, 'config'), stateDir: path.join(dir, 'state'), claudeHome: path.join(dir, 'claude'), auth: 'auto' });
  await loadAuth();
});
afterAll(async () => {
  closeAll();
  Object.assign(config, saved);
  await rm(dir, { recursive: true, force: true });
});

const streamed = (event: Record<string, unknown>) => ({ type: 'stream_event', uuid: crypto.randomUUID(), session_id: 's', parent_tool_use_id: null, event });

describe('a session’s detail while Claude writes a file', () => {
  it('carries the start of the call’s input, as the socket does, not the whole file being written', async () => {
    const sessionId = await sendMessage({ cwd: dir }, { text: 'Write the module', attachments: [], settings: {} });
    const claude = claudes.at(-1)!;
    claude.say(streamed({ type: 'message_start', message: {} }));
    claude.say(streamed({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Write', input: {} } }));
    const input = JSON.stringify({ file_path: `${dir}/big.ts`, content: 'export const line = 1;\n'.repeat(5_000) });
    for (let at = 0; at < input.length; at += 4000) {
      claude.say(streamed({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: input.slice(at, at + 4000) } }));
    }
    const writing = () => runState(sessionId)?.partial[0] as Extract<PartialBlock, { type: 'tool_use' }> | undefined;
    await vi.waitFor(() => expect(writing()?.inputJson).toHaveLength(input.length));

    const response = await app.request(`/api/sessions/${sessionId}`, {
      headers: { host: 'localhost:7860', 'x-pelican': '1', authorization: `Bearer ${accessToken()}` },
    });
    expect(response.status).toBe(200);
    const { run } = await response.json() as { run: RunState };
    expect(run.busy).toBe(true);
    expect(run.partial).toEqual([{ type: 'tool_use', name: 'Write', inputJson: input.slice(0, PARTIAL_INPUT_MAX) }]);
    // The run itself still has it all, for the step it becomes.
    expect(writing()?.inputJson).toHaveLength(input.length);
  });
});
