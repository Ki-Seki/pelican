// A message goes to a session's Claude one at a time with everything else that changes it
// (runner.ts, oneAtATime), after Claude Code has taken the settings it goes with. A Claude that
// does not answer as it is given them (stuck, or stopped) held that turn until it ended, so every
// message from another page waited behind it. Now the wait is bounded: past it the message does not
// go, and the page is told so, plainly. Claude Code stands in here, its answers held at will.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/** Claude Code as the run sees it: it takes the messages it is sent, and answers settings, or holds them while stuck. */
class StandInClaude {
  readonly prompts: string[] = [];
  readonly asked: string[] = [];
  stuck = false;
  private held: Array<() => void> = [];

  constructor(prompt: AsyncIterable<SDKUserMessage> | string, readonly options: Options) {
    if (typeof prompt !== 'string') {
      void (async () => {
        for await (const message of prompt) {
          const content = message.message.content;
          this.prompts.push(typeof content === 'string' ? content : content.map((block) => ('text' in block ? block.text : '')).join(''));
        }
      })();
    }
  }

  private answer(what: string): Promise<void> {
    this.asked.push(what);
    return this.stuck ? new Promise<void>((resolve) => this.held.push(resolve)) : Promise.resolve();
  }

  /** Answers again, what it held too. */
  unstick(): void {
    this.stuck = false;
    for (const answer of this.held.splice(0)) answer();
  }

  setPermissionMode(mode: string) { return this.answer(`mode ${mode}`); }
  setModel(model?: string) { return this.answer(`model ${model ?? 'default'}`); }
  applyFlagSettings(flags: Record<string, unknown>) { return this.answer(`flags ${JSON.stringify(flags)}`); }
  async interrupt() {}
  async getContextUsage() { return { percentage: 1, totalTokens: 2_000, maxTokens: 200_000 }; }
  async initializationResult() { return { models: [], account: {}, commands: [], agents: [] }; }
  close() {}
  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return { next: () => new Promise(() => undefined) };
  }
}

const claudes: StandInClaude[] = [];
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: ({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage> | string; options: Options }) => {
    const claude = new StandInClaude(prompt, options);
    claudes.push(claude);
    return claude;
  },
}));
vi.mock('../src/server/push', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/server/push')>()),
  notify: async () => undefined,
}));

const { app } = await import('../src/server/app');
const { config } = await import('../src/server/config');
const { ClaudeNotAnswering, closeAll, runTiming, sendMessage } = await import('../src/server/runner');

let dir: string;
const saved = { ...config };
const timing = { ...runTiming };

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'pelican-send-wait-'));
  Object.assign(config, { auth: 'none', configDir: path.join(dir, 'config'), stateDir: path.join(dir, 'state'), claudeHome: path.join(dir, 'claude') });
  runTiming.settingsMs = 400;
});
afterAll(async () => {
  closeAll();
  Object.assign(config, saved);
  Object.assign(runTiming, timing);
  await rm(dir, { recursive: true, force: true });
});

async function until(check: () => boolean, what: string): Promise<void> {
  for (const start = Date.now(); !check();) {
    if (Date.now() - start > 10_000) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const send = (sessionId: string, text: string, settings: Record<string, unknown> = {}) =>
  sendMessage({ sessionId }, { text, attachments: [], settings }).then(() => 'sent' as const, (error: unknown) => error);

describe('a message whose settings Claude Code does not take', () => {
  it('does not go once the wait is up, says so, and holds up no message from another page until that Claude ends', async () => {
    const id = await sendMessage({ cwd: dir }, { text: 'First', attachments: [], settings: {} });
    const claude = claudes.at(-1)!;
    await until(() => claude.prompts.includes('First'), 'the first message');
    // Claude stops answering (stopped, as with SIGSTOP, or stuck): a page sends with Plan picked,
    // and another page sends meanwhile.
    claude.stuck = true;
    const start = Date.now();
    const [held, other] = await Promise.all([send(id, 'Held', { permissionMode: 'plan' }), send(id, 'From another page')]);
    expect(Date.now() - start).toBeLessThan(5000);
    expect(held).toBeInstanceOf(ClaudeNotAnswering);
    expect((held as Error).message).toBe('Claude Code did not answer for a second as it was given this message’s settings, so the message was not sent. Send it again once Claude answers; if it never does, it may be stuck.');
    // Claude may still take Plan later: the other page's message sends all its settings again,
    // which Claude does not answer either, so it does not go either, and says so.
    expect(other).toBeInstanceOf(ClaudeNotAnswering);
    expect(claude.prompts).toEqual(['First']);
    // Through the page's route: said as it is, not as a failure of Pelican's own.
    const answer = await app.request(`/api/sessions/${id}/messages`, {
      method: 'POST', headers: { host: 'localhost:7860', 'x-pelican': '1', 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Again', settings: {} }),
    });
    expect(answer.status).toBe(504);
    expect(((await answer.json()) as { error: string }).error).toMatch(/^Claude Code did not answer for a second/);
    // Claude answers again: the next message goes, after every setting went to it again.
    claude.unstick();
    claude.asked.length = 0;
    expect(await send(id, 'Later')).toBe('sent');
    await until(() => claude.prompts.includes('Later'), 'the message after');
    expect(claude.asked).toEqual(expect.arrayContaining(['model default', 'flags {"fastMode":false}']));
    // Taken, the settings go only as they change again.
    claude.asked.length = 0;
    expect(await send(id, 'And on')).toBe('sent');
    expect(claude.asked).toEqual([]);
  }, 20_000);
});
