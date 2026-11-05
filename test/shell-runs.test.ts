import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LiveShell, ServerEvent } from '../src/shared/protocol';

// Nothing here may read or write the real ~/.claude or ~/.config/pelican.
const scratch = vi.hoisted(() => {
  const base = `${process.env.TMPDIR ?? '/tmp'}/pelican-shell-runs-test-${process.pid}`;
  process.env.CLAUDE_CONFIG_DIR = `${base}/claude`;
  process.env.PELICAN_CONFIG_DIR = `${base}/config`;
  process.env.PELICAN_STATE_DIR = `${base}/state`;
  return base;
});

/** A stand-in for Claude Code: the prompts it was sent, and the messages a test has it say. */
class FakeClaude {
  prompts: SDKUserMessage[] = [];
  private said: unknown[] = [];
  private listening?: (result: IteratorResult<unknown>) => void;
  private ended = false;

  constructor(prompt: AsyncIterable<SDKUserMessage> | string, readonly options: Options) {
    if (typeof prompt !== 'string') {
      void (async () => {
        for await (const message of prompt) this.prompts.push(message);
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
  async getContextUsage() {
    return { percentage: 10, totalTokens: 1000, maxTokens: 200_000 };
  }
  async supportedCommands() { return []; }
  async supportedAgents() { return []; }
  static account: Record<string, unknown> = {};
  async initializationResult() {
    return { models: [{ value: 'default', displayName: 'Default', description: '' }], account: FakeClaude.account, commands: [], agents: [] };
  }
  close() {
    this.ended = true;
    this.listening?.({ value: undefined, done: true });
  }
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
  notify: async () => {},
}));

const { closeAll, getRun, sendMessage } = await import('../src/server/runner');
const { listModels } = await import('../src/server/models');
const { feedFor } = await import('../src/server/feed');
const { BASH_CAVEAT } = await import('../src/server/shell');
const { liveShells, shellsEvent, startShell, stopShell } = await import('../src/server/shell-runs');

const folder = process.cwd();
const settle = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
const result = () => ({
  type: 'result', subtype: 'success', is_error: false, duration_ms: 10, duration_api_ms: 5, num_turns: 1, result: 'Done.', stop_reason: 'end_turn',
  total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [], uuid: crypto.randomUUID(), session_id: 's',
});
const textOf = (message: SDKUserMessage) => (typeof message.message.content === 'string' ? message.message.content : '');

/** A session whose first turn has ended, with what its feed carries. */
async function idleSession() {
  const sessionId = await sendMessage({ cwd: folder }, { text: 'Look at the tests', attachments: [], settings: {} });
  const claude = claudes.at(-1)!;
  claude.say(result());
  await settle(20);
  expect(getRun(sessionId)!.busy).toBe(false);
  const events: ServerEvent[] = [];
  feedFor(sessionId).listeners.add((event) => events.push(event));
  return { sessionId, claude, events };
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  for (let waited = 0; !check(); waited += 20) {
    if (waited > ms) throw new Error('timed out');
    await settle(20);
  }
}

const settingsFile = path.join(scratch, 'claude', 'settings.json');
beforeEach(() => {
  claudes.length = 0;
});
afterEach(async () => {
  closeAll();
  await rm(settingsFile, { force: true });
  await settle();
});
afterAll(() => rm(scratch, { recursive: true, force: true }));

describe.skipIf(process.platform === 'win32')('a ! command in a session', () => {
  it('shows at once and as its output comes, then goes into the conversation, and Claude answers it', async () => {
    const { sessionId, claude, events } = await idleSession();
    const shell = startShell(sessionId, folder, 'echo first; sleep 0.3; echo second >&2');
    expect(liveShells(sessionId).map((s) => s.id)).toEqual([shell.id]);
    await until(() => liveShells(sessionId).length === 0);

    const lists = events.flatMap((e) => (e.type === 'shells' ? [e.shells] : []));
    expect(lists[0]).toMatchObject([{ id: shell.id, command: 'echo first; sleep 0.3; echo second >&2', output: '' }]);
    expect(lists.at(-1)).toEqual([]);
    const output = events.flatMap((e) => (e.type === 'shell_output' && e.id === shell.id ? [e.text] : [])).join('');
    expect(output).toBe('first\nsecond\n');

    // As Claude Code's bash mode writes it: the command under the live command's id, then its
    // output, which asks Claude to answer; typed text, so nothing in it is expanded.
    const [input, out] = claude.prompts.slice(-2);
    expect(input).toMatchObject({ uuid: shell.id, shouldQuery: false, client_composed: true });
    expect(textOf(input!)).toBe('<bash-input>echo first; sleep 0.3; echo second >&2</bash-input>');
    expect(out).toMatchObject({ shouldQuery: true, client_composed: true });
    expect(textOf(out!)).toBe('<bash-stdout>first\n</bash-stdout><bash-stderr>second\n</bash-stderr>');
    expect(claude.prompts.some((p) => textOf(p) === BASH_CAVEAT)).toBe(false);
    expect(getRun(sessionId)!.busy).toBe(true);

    // The pages had the record before the command left the list.
    const recordAt = events.findIndex((e) => e.type === 'message' && e.message.uuid === shell.id);
    const goneAt = events.findIndex((e) => e.type === 'shells' && e.shells.length === 0);
    expect(recordAt).toBeGreaterThan(-1);
    expect(recordAt).toBeLessThan(goneAt);
  });

  it('is kept for later, with Claude Code’s caveat, where the settings say respondToBashCommands: false', async () => {
    await mkdir(path.dirname(settingsFile), { recursive: true });
    await writeFile(settingsFile, JSON.stringify({ respondToBashCommands: false }));
    const { sessionId, claude } = await idleSession();
    startShell(sessionId, folder, 'echo quiet');
    await until(() => liveShells(sessionId).length === 0);
    const [caveat, input, out] = claude.prompts.slice(-3);
    expect(caveat).toMatchObject({ isSynthetic: true, shouldQuery: false });
    expect(textOf(caveat!)).toBe(BASH_CAVEAT);
    expect(textOf(input!)).toBe('<bash-input>echo quiet</bash-input>');
    expect(out).toMatchObject({ shouldQuery: false });
    expect(getRun(sessionId)!.busy).toBe(false);
  });

  it('Stop ends it; it goes in with what it printed, and Claude does not answer', async () => {
    const { sessionId, claude, events } = await idleSession();
    const shell = startShell(sessionId, folder, 'echo started; sleep 30');
    await until(() => events.some((e) => e.type === 'shell_output'));
    expect(stopShell(sessionId, shell.id)).toBe(true);
    expect(liveShells(sessionId)[0]).toMatchObject({ stopping: true });
    await until(() => liveShells(sessionId).length === 0);
    const out = claude.prompts.at(-1)!;
    expect(textOf(out)).toBe('<bash-stdout>started\n</bash-stdout><bash-stderr>\n(stopped)</bash-stderr>');
    expect(out.shouldQuery).toBe(false);
    expect(claude.prompts.some((p) => textOf(p) === BASH_CAVEAT)).toBe(true);
    expect(getRun(sessionId)!.busy).toBe(false);
    // Stopping it again stops nothing.
    expect(stopShell(sessionId, shell.id)).toBe(false);
  });

  it('done while Claude is in a turn waits for the turn to end, then goes in and is answered', async () => {
    const { sessionId, claude } = await idleSession();
    await sendMessage({ sessionId }, { text: 'Now fix them', attachments: [], settings: {} });
    expect(getRun(sessionId)!.busy).toBe(true);
    const before = claude.prompts.length;
    const shell = startShell(sessionId, folder, 'echo meanwhile');
    await until(() => Boolean(liveShells(sessionId)[0]?.done));
    expect(liveShells(sessionId)[0]).toMatchObject({ id: shell.id, done: { code: 0, waiting: true }, output: 'meanwhile\n' });
    await settle(600);
    expect(claude.prompts.length).toBe(before);

    claude.say(result());
    await until(() => liveShells(sessionId).length === 0);
    expect(textOf(claude.prompts.at(-2)!)).toBe('<bash-input>echo meanwhile</bash-input>');
    expect(claude.prompts.at(-1)!.shouldQuery).toBe(true);
  });

  it('a page that subscribes is told of the commands running there, all of them', async () => {
    const { sessionId } = await idleSession();
    const shell = startShell(sessionId, folder, 'sleep 30');
    const told = shellsEvent(sessionId) as Extract<ServerEvent, { type: 'shells' }>;
    expect(told.shells.map((s: LiveShell) => s.id)).toEqual([shell.id]);
    stopShell(sessionId, shell.id);
    await until(() => liveShells(sessionId).length === 0);
    expect(shellsEvent('other')).toEqual({ type: 'shells', sessionId: 'other', shells: [] });
  });
});

describe('what a turn has cost', () => {
  it('is its share of Claude Code’s running total, on an API key or a provider', async () => {
    const { sessionId, claude } = await idleSession();
    await sendMessage({ sessionId }, { text: 'More', attachments: [], settings: {} });
    claude.say({ ...result(), total_cost_usd: 0.25 });
    await until(() => !getRun(sessionId)!.busy);
    expect(getRun(sessionId)!.state().lastTurn?.costUsd).toBeCloseTo(0.24);
  });

  it('is not said where a subscription pays', async () => {
    FakeClaude.account = { email: 'me@example.com', subscriptionType: 'max' };
    try {
      // The model list is kept a while; read it afresh with this account.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 11 * 60_000);
      await listModels();
      vi.useRealTimers();
      const { sessionId } = await idleSession();
      expect(getRun(sessionId)!.state().lastTurn).not.toHaveProperty('costUsd');
    } finally {
      FakeClaude.account = {};
      vi.useRealTimers();
    }
  });
});
