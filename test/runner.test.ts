import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Options, PermissionResult, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage, RunState, ServerEvent } from '../src/shared/protocol';

// Nothing here may read or write the real ~/.claude or ~/.config/pelican: everything points at a
// folder of its own before any module reads its configuration.
const scratch = vi.hoisted(() => {
  const base = `${process.env.TMPDIR ?? '/tmp'}/pelican-runner-test-${process.pid}`;
  process.env.CLAUDE_CONFIG_DIR = `${base}/claude`;
  process.env.PELICAN_CONFIG_DIR = `${base}/config`;
  process.env.PELICAN_STATE_DIR = `${base}/state`;
  return base;
});

/**
 * A stand-in for Claude Code: what query() was given, the prompts it was sent, the control calls
 * it got, and the messages a test has it say.
 */
class FakeClaude {
  prompts: SDKUserMessage[] = [];
  calls: Array<{ name: string; args: unknown[] }> = [];
  private said: unknown[] = [];
  private listening?: { resolve: (result: IteratorResult<unknown>) => void; reject: (error: Error) => void };
  private ended = false;
  private failure?: Error;
  models: unknown[] = [];
  account: Record<string, unknown> = {};
  /** How long a closed process takes to exit: a real one ends its stream a while after close(). */
  static closeDelay = 0;
  /** How long control requests (settings, mode) take to be answered. */
  static controlDelay = 0;

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
      listening.resolve({ value: message, done: false });
    } else {
      this.said.push(message);
    }
  }

  end(): void {
    this.ended = true;
    this.listening?.resolve({ value: undefined, done: true });
  }

  /** The process ends on its own, as a crash or a kill ends it. */
  fail(error = new Error('Claude Code process exited with code 1')): void {
    this.failure = error;
    const listening = this.listening;
    this.listening = undefined;
    listening?.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: () => {
        if (this.said.length > 0) return Promise.resolve({ value: this.said.shift(), done: false });
        if (this.failure) return Promise.reject(this.failure);
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => {
          this.listening = { resolve, reject };
        });
      },
    };
  }

  private async record(name: string, ...args: unknown[]) {
    this.calls.push({ name, args });
    if (FakeClaude.controlDelay > 0) await new Promise((resolve) => setTimeout(resolve, FakeClaude.controlDelay));
  }

  called(name: string) {
    return this.calls.filter((c) => c.name === name).map((c) => c.args);
  }

  async interrupt() { await this.record('interrupt'); }
  async setPermissionMode(mode: string) { await this.record('setPermissionMode', mode); }
  async setModel(model?: string) { await this.record('setModel', model); }
  async applyFlagSettings(settings: unknown) { await this.record('applyFlagSettings', settings); }
  async getContextUsage(options?: unknown) {
    this.record('getContextUsage', options);
    return { percentage: 12.4, totalTokens: 24_800, maxTokens: 200_000 };
  }
  async getTaskOutput(taskId: string) {
    this.record('getTaskOutput', taskId);
    return { output: 'listening on :3000\n', total_bytes: 19, truncated: false };
  }
  async supportedCommands() { return [{ name: 'compact', description: '', argumentHint: '' }, { name: 'statusline', description: '', argumentHint: '' }]; }
  async supportedAgents() { return []; }
  async stopTask(taskId: string) { this.record('stopTask', taskId); }
  async initializationResult() { return { models: this.models, account: this.account, commands: [], agents: [], claude_code_version: '2.1.318' }; }
  close() {
    this.calls.push({ name: 'close', args: [] });
    if (FakeClaude.closeDelay > 0) setTimeout(() => this.end(), FakeClaude.closeDelay);
    else this.end();
  }
}

const claudes: FakeClaude[] = [];
let nextModels: unknown[] = [];
let nextAccount: Record<string, unknown> = {};

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: ({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage> | string; options: Options }) => {
    const claude = new FakeClaude(prompt, options);
    claude.models = nextModels;
    claude.account = nextAccount;
    claudes.push(claude);
    return claude;
  },
}));

const notices: Array<{ title: string; body: string; tag: string }> = [];
vi.mock('../src/server/push', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/server/push')>()),
  notify: async (payload: { title: string; body: string; tag: string }) => {
    notices.push(payload);
  },
}));

const { closeAll, closeIdle, getRun, sendMessage, replaceLastTurn, askedFor, oneLine, runTasks } = await import('../src/server/runner');
const { connect, feedFor } = await import('../src/server/feed');
const { listModels } = await import('../src/server/models');
const { config } = await import('../src/server/config');

const folder = process.cwd();
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

/** A session started here with a first prompt, with what its feed carries. */
async function start(text = 'Fix the login test', settings = {}) {
  const sessionId = await sendMessage({ cwd: folder }, { text, attachments: [], settings });
  const claude = claudes.at(-1)!;
  const events: ServerEvent[] = [];
  feedFor(sessionId).listeners.add((event) => events.push(event));
  const run = getRun(sessionId)!;
  const state = () => run.state();
  const messages = () => events.flatMap((e) => (e.type === 'message' ? [e.message] : []));
  const runs = () => events.flatMap((e) => (e.type === 'run' && e.state ? [e.state] : []));
  return { sessionId, claude, run, state, messages, runs, events };
}

const init = (extra: Record<string, unknown> = {}) => ({
  type: 'system', subtype: 'init', uuid: crypto.randomUUID(), session_id: 's', apiKeySource: 'none', claude_code_version: '2.1.318',
  cwd: folder, tools: [], mcp_servers: [], model: 'claude-opus-5-5', permissionMode: 'default', slash_commands: [], output_style: 'default', skills: [], plugins: [],
  ...extra,
});
const result = (extra: Record<string, unknown> = {}) => ({
  type: 'result', subtype: 'success', is_error: false, duration_ms: 1200, duration_api_ms: 900, num_turns: 1, result: 'Done.', stop_reason: 'end_turn',
  total_cost_usd: 0.5, usage: { input_tokens: 10, output_tokens: 42 }, modelUsage: {}, permission_denials: [], uuid: crypto.randomUUID(), session_id: 's',
  ...extra,
});
const reply = (text: string, extra: Record<string, unknown> = {}) => ({
  type: 'assistant', uuid: crypto.randomUUID(), session_id: 's', parent_tool_use_id: null,
  message: { id: `msg_${crypto.randomUUID().slice(0, 8)}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }] },
  ...extra,
});
const toolCall = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'assistant', uuid: crypto.randomUUID(), session_id: 's', parent_tool_use_id: null,
  message: { id: `msg_${id}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name, input }] },
});
const toolResult = (id: string, output: unknown, text = 'ok') => ({
  type: 'user', uuid: crypto.randomUUID(), session_id: 's', parent_tool_use_id: null, tool_use_result: output,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
});
const system = (subtype: string, extra: Record<string, unknown> = {}) => ({ type: 'system', subtype, uuid: crypto.randomUUID(), session_id: 's', ...extra });

const textOf = (message: SDKUserMessage) => {
  const content = message.message.content;
  return typeof content === 'string' ? content : content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
};

/** Asks the way Claude Code asks for an approval; resolves with what Pelican answered. */
function ask(claude: FakeClaude, toolName: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const controller = new AbortController();
  const answer = claude.options.canUseTool!(toolName, input, { signal: controller.signal, toolUseID: crypto.randomUUID(), requestId: 'r', ...extra }) as Promise<PermissionResult>;
  return { answer, controller };
}

beforeEach(() => {
  notices.length = 0;
  nextModels = [];
  nextAccount = {};
  FakeClaude.closeDelay = 0;
  FakeClaude.controlDelay = 0;
});
afterEach(async () => {
  closeAll();
  await settle();
  // A process that takes a while to exit ends here, not in the next test.
  if (FakeClaude.closeDelay > 0) await new Promise((resolve) => setTimeout(resolve, FakeClaude.closeDelay + 5));
});
afterAll(() => rm(scratch, { recursive: true, force: true }));

describe('starting Claude', () => {
  it('asks for what Claude Code offers hosts like Pelican, in the mode picked', async () => {
    const { claude, sessionId, messages } = await start('Fix the login test', { permissionMode: 'acceptEdits' });
    expect(claude.options).toMatchObject({
      sessionId,
      permissionMode: 'acceptEdits',
      perTaskStopAffordance: true,
      agentProgressSummaries: true,
      toolConfig: { askUserQuestion: { previewFormat: 'markdown' } },
    });
    expect(typeof claude.options.onElicitation).toBe('function');
    await settle();
    expect(claude.prompts).toHaveLength(1);
    expect(textOf(claude.prompts[0]!)).toBe('Fix the login test');
    expect(claude.prompts[0]!.priority).toBeUndefined();
    expect(getRun(sessionId)!.busy).toBe(true);
    // Published once, before the transcript has it, for pages watching from the start.
    expect(messages()).toHaveLength(0);
  });

  it('turns /clear away: in the same process it would carry on under another id', async () => {
    await expect(sendMessage({ cwd: folder }, { text: '/clear', attachments: [], settings: {} })).rejects.toThrow(/new session/);
    const { run } = await start();
    await expect(run.send({ text: '/reset now', attachments: [], settings: {} })).rejects.toThrow(/new session/);
  });
});

describe('a message while Claude works', () => {
  it('steers: Claude gets it at its next step, and it is in the conversation at once', async () => {
    const { run, claude, messages } = await start();
    await run.send({ text: 'Use vitest, not jest', attachments: [], settings: {}, mode: 'steer', uuid: '00000000-0000-4000-8000-000000000001' });
    await settle();
    expect(claude.prompts).toHaveLength(2);
    expect(claude.prompts[1]!.priority).toBe('next');
    expect(messages().map((m) => m.uuid)).toContain('00000000-0000-4000-8000-000000000001');
  });

  it('queues: Pelican holds it, out of the conversation, and Claude gets each prompt as typed when the turn ends', async () => {
    const { run, claude, messages, state, runs } = await start();
    const firstTurn = state().startedAt!;
    await run.send({ text: 'Then run the tests', attachments: [], settings: {}, mode: 'queue', uuid: '00000000-0000-4000-8000-000000000002' });
    await run.send({ text: 'And update the changelog', attachments: [], settings: {}, mode: 'queue', uuid: '00000000-0000-4000-8000-000000000003' });
    await settle();
    expect(claude.prompts).toHaveLength(1);
    expect(messages()).toHaveLength(0);
    expect(state().queued).toEqual([
      { uuid: '00000000-0000-4000-8000-000000000002', text: 'Then run the tests' },
      { uuid: '00000000-0000-4000-8000-000000000003', text: 'And update the changelog' },
    ]);

    await new Promise((resolve) => setTimeout(resolve, 20));
    claude.say(reply('Fixed.'));
    claude.say(result());
    // Claude Code says the turn is over after the result; the queued prompts are already on their way.
    claude.say(system('session_state_changed', { state: 'idle' }));
    await vi.waitFor(() => expect(claude.prompts).toHaveLength(3));
    await settle();
    // Each as it was typed, with its own id: Claude Code takes plain prompts together itself.
    expect(claude.prompts.slice(1).map((p) => [p.uuid, textOf(p), p.priority])).toEqual([
      ['00000000-0000-4000-8000-000000000002', 'Then run the tests', undefined],
      ['00000000-0000-4000-8000-000000000003', 'And update the changelog', undefined],
    ]);
    expect(state().queued).toBeUndefined();
    expect(messages().filter((m) => m.role === 'user').map((m) => m.uuid)).toEqual(['00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003']);
    // Claude carries on: never idle in between, and no "Finished" for a turn that is not the last.
    expect(runs().filter((s) => !s.busy)).toHaveLength(0);
    expect(run.busy).toBe(true);
    expect(notices).toHaveLength(0);
    // It is a turn of its own: its time counts from when Claude got the prompts.
    expect(state().startedAt).toBeGreaterThan(firstTurn);
    expect(runs().at(-1)!.startedAt).toBe(state().startedAt);
  });

  it('a queued command runs as a command, not with the prompt after it, and the turn goes on until Claude answered both', async () => {
    const { run, claude, state, runs } = await start();
    await run.send({ text: '/compact', attachments: [], settings: {}, mode: 'queue', uuid: '00000000-0000-4000-8000-000000000005' });
    await run.send({ text: 'Then carry on with step 2', attachments: [], settings: {}, mode: 'queue', uuid: '00000000-0000-4000-8000-000000000006' });
    claude.say(reply('Step 1 done.'));
    claude.say(result());
    await vi.waitFor(() => expect(claude.prompts).toHaveLength(3));
    expect(claude.prompts.slice(1).map(textOf)).toEqual(['/compact', 'Then carry on with step 2']);
    // Claude Code answers a command on its own: that is not the end of what it was given.
    claude.say(result({ local_command: '/compact', user_message_uuid: '00000000-0000-4000-8000-000000000005', user_message_uuids: ['00000000-0000-4000-8000-000000000005'] }));
    await settle();
    expect(run.busy).toBe(true);
    expect(runs().filter((s) => !s.busy)).toHaveLength(0);
    expect(notices).toHaveLength(0);
    claude.say(reply('Step 2 done.'));
    claude.say(result({ user_message_uuid: '00000000-0000-4000-8000-000000000006', user_message_uuids: ['00000000-0000-4000-8000-000000000006'] }));
    await vi.waitFor(() => expect(run.busy).toBe(false));
    expect(state().startedAt).toBeUndefined();
    expect(notices.map((n) => n.body)).toEqual(['Step 2 done.']);
  });

  it('a queued prompt taken back is never sent', async () => {
    const { run, claude, state } = await start();
    await run.send({ text: 'Never mind', attachments: [], settings: {}, mode: 'queue', uuid: '00000000-0000-4000-8000-000000000004' });
    expect(run.unqueue('00000000-0000-4000-8000-000000000004')).toBe(true);
    expect(run.unqueue('00000000-0000-4000-8000-000000000004')).toBe(false);
    expect(state().queued).toBeUndefined();
    claude.say(reply('All done.\nThe test passes now.'));
    claude.say(result());
    await vi.waitFor(() => expect(run.busy).toBe(false));
    expect(claude.prompts).toHaveLength(1);
    // The notification says what Claude said, not just that it finished.
    expect(notices.map((n) => n.body)).toEqual(['All done.']);
  });
});

describe('Stop', () => {
  it('ends the turn without an error or a notice; queued prompts still go, as after Esc', async () => {
    const { run, claude, state } = await start();
    await run.send({ text: 'Afterwards, summarize', attachments: [], settings: {}, mode: 'queue' });
    await run.interrupt();
    expect(claude.called('interrupt')).toHaveLength(1);
    expect(state().stopping).toBe(true);
    claude.say(result({ subtype: 'error_during_execution', is_error: true, errors: ['Request was aborted.'] }));
    await vi.waitFor(() => expect(claude.prompts).toHaveLength(2));
    expect(run.error).toBeUndefined();
    expect(state().stopping).toBeUndefined();
    expect(notices).toHaveLength(0);
  });

  it('after the turn ended stops nothing, and the next turn still says how it went', async () => {
    const { run, claude } = await start();
    claude.say(result());
    await vi.waitFor(() => expect(run.busy).toBe(false));
    notices.length = 0;
    await run.interrupt();
    expect(claude.called('interrupt')).toHaveLength(0);
    await run.send({ text: 'Again', attachments: [], settings: {} });
    claude.say(result({ is_error: true, result: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' }));
    await vi.waitFor(() => expect(run.busy).toBe(false));
    expect(run.error).toBe('Anthropic’s API is overloaded. Try again in a moment.');
    expect(notices.map((n) => n.body)).toEqual(['Stopped: Anthropic’s API is overloaded. Try again in a moment.']);
  });
});

describe('approvals', () => {
  it('say what "always" saves, and save exactly that', async () => {
    const { claude, state, run } = await start();
    const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' }];
    const { answer } = ask(claude, 'Bash', { command: 'npm test', description: 'Run the test suite' }, { suggestions, title: 'Claude wants to run npm test', defaultToNo: true });
    await settle();
    const request = state().permissions[0]!;
    expect(request).toMatchObject({ always: 'Always allow npm test * in this project', title: 'Claude wants to run npm test', defaultToNo: true });
    expect(run.status()).toBe('waiting');
    expect(notices.at(-1)!.body).toBe('Run the test suite');
    expect(run.decide(request.id, { behavior: 'allow', remember: true })).toBe(true);
    expect(await answer).toEqual({ behavior: 'allow', updatedInput: { command: 'npm test', description: 'Run the test suite' }, updatedPermissions: suggestions, decisionClassification: 'user_permanent' });
    expect(run.decide(request.id, { behavior: 'allow' })).toBe(false);
  });

  it('offer no "always" where Claude Code says not to, and allow once otherwise', async () => {
    const { claude, state, run } = await start();
    const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'localSettings' }];
    const { answer } = ask(claude, 'Bash', { command: 'rm -rf build' }, { suggestions, suppressAlwaysAllowRule: true });
    await settle();
    const request = state().permissions[0]!;
    expect(request.always).toBeUndefined();
    run.decide(request.id, { behavior: 'allow', remember: true });
    expect(await answer).toEqual({ behavior: 'allow', updatedInput: { command: 'rm -rf build' }, decisionClassification: 'user_temporary' });
  });

  it('allowing all edits switches the session to Accept edits, and the chip says so without a notice', async () => {
    const { claude, state, run } = await start();
    const { answer } = ask(claude, 'Edit', { file_path: `${folder}/src/a.ts`, old_string: 'a', new_string: 'b' }, {
      suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    });
    await settle();
    const request = state().permissions[0]!;
    expect(request.always).toBe('Allow all edits this session');
    expect(notices.at(-1)!.body).toBe('Edit src/a.ts');
    run.decide(request.id, { behavior: 'allow', remember: true });
    expect((await answer).behavior).toBe('allow');
    expect(state().settings.permissionMode).toBe('acceptEdits');
    // Claude Code's own report of the switch is no news.
    claude.say(system('status', { status: null, permissionMode: 'acceptEdits' }));
    await settle();
    expect(state().modeChanged).toBeUndefined();
  });

  it('Deny is Claude Code’s No: without a note the turn stops; with one Claude goes on with it', async () => {
    const { claude, state, run } = await start();
    const first = ask(claude, 'Bash', { command: 'git push --force' });
    await settle();
    run.decide(state().permissions[0]!.id, { behavior: 'deny', message: '  ' });
    expect(await first.answer).toEqual({
      behavior: 'deny',
      message: 'The user doesn\'t want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.',
      interrupt: true,
      decisionClassification: 'user_reject',
    });

    const second = ask(claude, 'Bash', { command: 'npm install' });
    await settle();
    run.decide(state().permissions[0]!.id, { behavior: 'deny', message: 'Use pnpm' });
    const noted = await second.answer;
    expect(noted).toMatchObject({ behavior: 'deny', decisionClassification: 'user_reject' });
    expect((noted as { message: string }).message).toMatch(/To tell you how to proceed, the user said:\nUse pnpm$/);
    expect(noted).not.toHaveProperty('interrupt');

    // The turn the plain Deny stopped ends quietly, like Stop.
    claude.say(result({ subtype: 'error_during_execution', is_error: true, errors: ['interrupted'] }));
    await vi.waitFor(() => expect(run.busy).toBe(false));
    expect(run.error).toBeUndefined();
    expect(notices.filter((n) => n.tag.endsWith(':done'))).toHaveLength(0);
  });

  it('a subagent’s request names the agent, and its Deny ends only the agent’s step', async () => {
    const { claude, state, run } = await start();
    claude.say(system('task_started', { task_id: 'agent-1', tool_use_id: 'tool-1', description: 'Look through auth', subagent_type: 'Explore' }));
    await settle();
    const { answer } = ask(claude, 'Bash', { command: 'ls' }, { agentID: 'agent-1' });
    await settle();
    expect(state().permissions[0]!.agent).toBe('Explore');
    run.decide(state().permissions[0]!.id, { behavior: 'deny' });
    expect(await answer).not.toHaveProperty('interrupt');
  });

  it('an MCP tool’s request names its server as configured', async () => {
    const { claude, state } = await start();
    void ask(claude, 'mcp__linear__create_issue', { title: 'Flaky test' }, { mcpServer: { name: 'linear', source: 'user' } });
    await settle();
    expect(state().permissions[0]!.server).toBe('linear');
  });

  it('a request Claude Code withdraws goes away', async () => {
    const { claude, state, run } = await start();
    const { answer, controller } = ask(claude, 'Bash', { command: 'make' });
    await settle();
    controller.abort();
    expect(await answer).toEqual({ behavior: 'deny', message: 'Cancelled.' });
    expect(state().permissions).toHaveLength(0);
    expect(run.status()).toBe('running');
  });

  it('a plan approved into a mode switches with the approval, and remembers the mode it came from', async () => {
    const { claude, state, run } = await start('Plan it', { permissionMode: 'auto' });
    claude.say(system('status', { status: null, permissionMode: 'plan' }));
    await settle();
    expect(state().settings.permissionMode).toBe('plan');
    const { answer } = ask(claude, 'ExitPlanMode', { plan: '1. Do it' });
    await settle();
    expect(state().permissions[0]!.plan).toEqual({ before: 'auto', auto: false });
    run.decide(state().permissions[0]!.id, { behavior: 'allow', permissionMode: 'acceptEdits' });
    expect(await answer).toMatchObject({ behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] });
    expect(state().settings.permissionMode).toBe('acceptEdits');
    // Sent back with feedback, a plan is an answer, not a refusal.
    const again = ask(claude, 'ExitPlanMode', { plan: '2.' });
    await settle();
    run.decide(state().permissions[0]!.id, { behavior: 'deny', message: 'Add tests first' });
    expect(await again.answer).toEqual({ behavior: 'deny', message: 'Add tests first', decisionClassification: 'user_reject' });
  });
});

describe('an MCP server asking for input', () => {
  it('waits for an answer here instead of being declined', async () => {
    const { claude, state, run } = await start();
    const asking = claude.options.onElicitation!({
      serverName: 'linear', message: 'Which team?', mode: 'form',
      requestedSchema: { type: 'object', properties: { team: { type: 'string' }, count: { type: 'integer' } }, required: ['team'] },
    }, { signal: new AbortController().signal, requestId: 'e1' });
    await settle();
    const request = state().permissions[0]!;
    expect(request.elicitation).toMatchObject({ server: 'linear', message: 'Which team?', mode: 'form' });
    expect(run.status()).toBe('waiting');
    expect(notices.at(-1)!.body).toBe('linear: Which team?');
    run.decide(request.id, { behavior: 'allow', updatedInput: { team: 'Web', count: 2, nested: { no: 1 } } });
    expect(await asking).toEqual({ action: 'accept', content: { team: 'Web', count: 2 } });

    const link = claude.options.onElicitation!({ serverName: 'x', message: 'Sign in', mode: 'url', url: 'javascript:alert(1)' }, { signal: new AbortController().signal, requestId: 'e2' });
    await settle();
    expect(state().permissions[0]!.elicitation!.url).toBeUndefined();
    run.decide(state().permissions[0]!.id, { behavior: 'deny' });
    expect(await link).toEqual({ action: 'decline' });
  });
});

describe('settings', () => {
  it('picked mid-turn reach Claude at once, effort and ultracode together', async () => {
    const { run, claude } = await start('Go', { model: 'default', effort: 'high' });
    await run.updateSettings({ model: 'sonnet', effort: 'max', ultracode: true, fast: true, permissionMode: 'plan' });
    expect(claude.called('setModel')).toEqual([['sonnet']]);
    expect(claude.called('applyFlagSettings')).toEqual([[{ effortLevel: 'max', ultracode: true, enableWorkflows: true }], [{ fastMode: true }]]);
    expect(claude.called('setPermissionMode')).toEqual([['plan']]);
    // Unchanged settings send nothing again.
    await run.updateSettings({ model: 'sonnet', effort: 'max', ultracode: true, fast: true, permissionMode: 'plan' });
    expect(claude.called('setModel')).toHaveLength(1);
    expect(claude.called('applyFlagSettings')).toHaveLength(2);
    expect(claude.called('setPermissionMode')).toHaveLength(1);
  });

  it('Default effort picked mid-turn reaches Claude at once, and the run says Default too', async () => {
    const { run, claude, state } = await start('Go', { model: 'default', effort: 'high' });
    // The page sends all its settings: Default effort is no effort at all.
    const picked = { model: 'default', fast: false, ultracode: false, permissionMode: 'default' as const };
    await run.updateSettings(picked);
    expect(claude.called('applyFlagSettings')).toEqual([[{ effortLevel: null, ultracode: false }]]);
    expect(state().settings).toEqual(picked);
    // The next message carries the same: nothing to apply again.
    await run.send({ text: 'More', attachments: [], settings: picked });
    expect(claude.called('applyFlagSettings')).toHaveLength(1);
    expect(state().settings.effort).toBeUndefined();
  });

  it('follow Claude Code: a mode it switched to shows, said once, and picking Manual again reaches it', async () => {
    const { run, claude, state } = await start();
    claude.say(system('status', { status: null, permissionMode: 'acceptEdits' }));
    await vi.waitFor(() => expect(state().settings.permissionMode).toBe('acceptEdits'));
    expect(state().modeChanged).toBe('acceptEdits');
    await run.setPermissionMode('default');
    expect(claude.called('setPermissionMode')).toEqual([['default']]);
    expect(state().settings.permissionMode).toBe('default');
    expect(state().modeChanged).toBeUndefined();
    // A mode picked here is sent even when Pelican thinks Claude is in it already.
    await run.setPermissionMode('default');
    expect(claude.called('setPermissionMode')).toEqual([['default'], ['default']]);
  });

  it('read back each turn’s model, effort and speed, named as the picker names them', async () => {
    nextModels = [
      { value: 'default', displayName: 'Default', description: '', resolvedModel: 'claude-opus-5-5' },
      { value: 'sonnet', displayName: 'Sonnet', description: '', resolvedModel: 'claude-sonnet-5-5' },
    ];
    await listModels();
    const { claude, state } = await start('Go', { model: 'default', effort: 'high', fast: false });
    claude.say(init({ model: 'claude-opus-5-5', effort: 'high', fast_mode_state: 'off' }));
    await settle();
    expect(state().settings).toMatchObject({ model: 'default', effort: 'high', fast: false });
    // /model and /effort typed in the conversation, /fast on.
    claude.say(init({ model: 'claude-sonnet-5-5', effort: 'max', fast_mode_state: 'on', permissionMode: 'plan', terminal_slash_commands: ['statusline'] }));
    await vi.waitFor(() => expect(state().settings).toMatchObject({ model: 'sonnet', effort: 'max', fast: true, permissionMode: 'plan' }));
    // An id the picker does not know is not shown raw: the chip keeps its name.
    claude.say(init({ model: 'claude-next-9', permissionMode: 'plan' }));
    await settle();
    expect(state().settings.model).toBe('sonnet');
  });
});

describe('a turn’s cost', () => {
  it('is the turn’s own, not the session’s running total', async () => {
    const { run, claude, state } = await start();
    claude.say(result({ total_cost_usd: 0.5 }));
    await vi.waitFor(() => expect(run.busy).toBe(false));
    expect(state().lastTurn).toEqual({ durationMs: 1200, costUsd: 0.5, outputTokens: 42 });
    await run.send({ text: 'More', attachments: [], settings: {} });
    claude.say(result({ total_cost_usd: 0.8 }));
    await vi.waitFor(() => expect(run.busy).toBe(false));
    expect(state().lastTurn!.costUsd).toBeCloseTo(0.3);
  });

  it('is left out where a subscription pays', async () => {
    nextAccount = { email: 'me@example.com', subscriptionType: 'max' };
    nextModels = [{ value: 'default', displayName: 'Default', description: '' }];
    config.claudeExecutable = undefined;
    // The model list is cached; read it afresh with this account.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    await listModels();
    vi.useRealTimers();
    const { run, claude, state } = await start();
    claude.say(result({ total_cost_usd: 0.5 }));
    await vi.waitFor(() => expect(run.busy).toBe(false));
    expect(state().lastTurn).toEqual({ durationMs: 1200, outputTokens: 42 });
  });
});

describe('work that runs on its own', () => {
  it('keeps Claude running past the idle time: background tasks, watchers included, wake-ups and crons', async () => {
    const { run, claude, state } = await start();
    claude.say(result());
    await vi.waitFor(() => expect(run.busy).toBe(false));
    claude.say(system('background_tasks_changed', { tasks: [{ task_id: 'w1', task_type: 'local_bash', description: 'watch logs', ambient: true }] }));
    await settle();
    expect(state().tasks).toBeUndefined();
    closeIdle(Date.now() + config.idleCloseMs + 60_000);
    expect(run.closed).toBe(false);

    claude.say(system('background_tasks_changed', { tasks: [] }));
    claude.say(toolCall('c1', 'CronCreate', { cron: '*/5 * * * *', prompt: 'check the deploy' }));
    claude.say(toolResult('c1', { id: 'job-1', humanSchedule: 'every 5 minutes', recurring: true, nextFireAt: Date.now() + 300_000 }));
    await settle();
    expect(state().scheduled).toEqual([expect.objectContaining({ id: 'job-1', what: 'every 5 minutes: check the deploy', repeats: true })]);
    closeIdle(Date.now() + config.idleCloseMs + 60_000);
    expect(run.closed).toBe(false);

    claude.say(toolCall('c2', 'CronDelete', { id: 'job-1' }));
    claude.say(toolResult('c2', { id: 'job-1' }));
    claude.say(toolCall('c3', 'ScheduleWakeup', { delaySeconds: 1200, reason: 'Check the build', prompt: '/loop check' }));
    claude.say(toolResult('c3', { scheduledFor: Date.now() + 1_200_000, clampedDelaySeconds: 1200, wasClamped: false }));
    await settle();
    expect(state().scheduled).toEqual([expect.objectContaining({ id: 'wakeup', what: 'Check the build' })]);
    closeIdle(Date.now() + config.idleCloseMs + 60_000);
    expect(run.closed).toBe(false);

    claude.say(toolCall('c4', 'ScheduleWakeup', { stop: true }));
    claude.say(toolResult('c4', { stopped: true }));
    await settle();
    expect(state().scheduled).toBeUndefined();
    closeIdle(Date.now() + config.idleCloseMs + 60_000);
    expect(run.closed).toBe(true);
  });

  it('a recurring check shows no time gone by, and is let go a week on, as Claude Code lets it go', async () => {
    const { run, claude, state } = await start();
    const firstDue = Date.now() + 60_000;
    claude.say(toolCall('c1', 'CronCreate', { cron: '* * * * *', prompt: 'check the deploy' }));
    claude.say(toolResult('c1', { id: 'job-1', humanSchedule: 'every minute', recurring: true, nextFireAt: firstDue }));
    claude.say(result());
    await vi.waitFor(() => expect(run.busy).toBe(false));
    expect(state().scheduled).toEqual([{ id: 'job-1', what: 'every minute: check the deploy', next: firstDue, repeats: true }]);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // It fired: when it comes next, Claude Code works out as it goes. Still there, and Claude stays for it.
      vi.setSystemTime(firstDue + 30_000);
      expect(state().scheduled).toEqual([{ id: 'job-1', what: 'every minute: check the deploy', repeats: true }]);
      closeIdle(Date.now() + config.idleCloseMs + 60_000);
      expect(run.closed).toBe(false);
      // A week after it was made, Claude Code has let it go: nothing keeps Claude running for it.
      vi.setSystemTime(Date.now() + 7 * 24 * 3600_000);
      expect(state().scheduled).toBeUndefined();
      closeIdle(Date.now() + config.idleCloseMs + 60_000);
      expect(run.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports what subagents and background tasks are doing, and what a command printed', async () => {
    const { run, claude, state } = await start();
    claude.say(system('task_started', { task_id: 'a1', tool_use_id: 'toolu_1', description: 'Find the flaky test', subagent_type: 'Explore' }));
    claude.say(system('task_progress', { task_id: 'a1', tool_use_id: 'toolu_1', description: 'Find the flaky test', usage: { total_tokens: 900, tool_uses: 12, duration_ms: 100_000 }, last_tool_name: 'Read', summary: 'Reading auth.ts' }));
    claude.say(system('background_tasks_changed', { tasks: [
      { task_id: 'a1', task_type: 'local_agent', subagent_type: 'Explore', description: 'Find the flaky test' },
      { task_id: 'b1', task_type: 'local_bash', description: 'npm run dev' },
    ] }));
    await vi.waitFor(() => expect(state().progress).toEqual({ toolu_1: { summary: 'Reading auth.ts', lastTool: 'Read', toolUses: 12, durationMs: 100_000 } }));
    expect(state().tasks).toEqual([
      { id: 'a1', description: 'Find the flaky test', type: 'Explore', summary: 'Reading auth.ts' },
      { id: 'b1', description: 'npm run dev', type: 'local_bash', output: true },
    ]);
    expect(await run.taskOutput('b1')).toEqual({ output: 'listening on :3000\n', truncated: false });
    claude.say(system('task_notification', { task_id: 'a1', status: 'completed', output_file: '', summary: 'done' }));
    await vi.waitFor(() => expect(state().progress).toBeUndefined());
  });

  it('counts what runs on between turns for the session list, and tells every list when that changes', async () => {
    const heard: ServerEvent[] = [];
    const stop = connect((event) => heard.push(event));
    const { sessionId, run, claude } = await start();
    claude.say(system('background_tasks_changed', { tasks: [
      { task_id: 'a1', task_type: 'local_agent', subagent_type: 'Explore', description: 'Find the flaky test' },
      { task_id: 'b1', task_type: 'local_bash', description: 'npm run dev' },
      { task_id: 'w1', task_type: 'monitor_mcp', description: 'watch logs', ambient: true },
    ] }));
    claude.say(result());
    await vi.waitFor(() => expect(run.busy).toBe(false));
    // Watchers are no activity, as Claude Code says; the agent and the command are.
    expect(runTasks(sessionId)).toBe(2);
    expect(heard.filter((e) => e.type === 'status').at(-1)).toEqual({ type: 'status', sessionId, status: 'idle', tasks: 2 });
    // A scheduled check keeps Claude running too: it counts.
    claude.say(toolCall('c1', 'CronCreate', { cron: '0 * * * *', prompt: 'check the deploy' }));
    claude.say(toolResult('c1', { id: 'job-1', humanSchedule: 'every hour', recurring: true, nextFireAt: Date.now() + 3600_000 }));
    await vi.waitFor(() => expect(runTasks(sessionId)).toBe(3));
    claude.say(system('background_tasks_changed', { tasks: [] }));
    await vi.waitFor(() => expect(runTasks(sessionId)).toBe(1));
    expect(heard.filter((e) => e.type === 'status').at(-1)).toEqual({ type: 'status', sessionId, status: 'idle', tasks: 1 });
    // The process ends, and its work with it.
    claude.end();
    await vi.waitFor(() => expect(heard.filter((e) => e.type === 'status').at(-1)).toEqual({ type: 'status', sessionId, status: 'idle' }));
    expect(runTasks(sessionId)).toBe(0);
    stop();
  });

  it('measures the context from the last response, without counting every category after each turn', async () => {
    const { run, claude, state } = await start();
    claude.say(result());
    await vi.waitFor(() => expect(state().context).toEqual({ percent: 12, tokens: 24_800, max: 200_000 }));
    expect(claude.called('getContextUsage')).toEqual([[{ detail: 'summary' }]]);
    expect(run.busy).toBe(false);
  });
});

describe('a message sent while its Claude closes', () => {
  // Claude idle for a while: the idle close may come while a message to it is on its way.
  async function idle() {
    const started = await start();
    started.claude.say(init());
    started.claude.say(result());
    await vi.waitFor(() => expect(started.run.busy).toBe(false));
    // Its transcript, where the session's folder is found when it is resumed.
    const dir = path.join(scratch, 'claude', 'projects', folder.replace(/[^a-zA-Z0-9]/g, '-'));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${started.sessionId}.jsonl`), `${JSON.stringify({
      type: 'user', uuid: crypto.randomUUID(), parentUuid: null, sessionId: started.sessionId, cwd: folder,
      timestamp: new Date(Date.now() - 60_000).toISOString(), message: { role: 'user', content: 'Fix the login test' },
    })}\n`);
    return started;
  }

  async function reachedAgain(sessionId: string, claude: FakeClaude, messages: () => ChatMessage[], uuid: string) {
    await vi.waitFor(() => expect(claudes.at(-1)).not.toBe(claude));
    const resumed = claudes.at(-1)!;
    expect(resumed.options).toMatchObject({ resume: sessionId });
    await vi.waitFor(() => expect(resumed.prompts.map((p) => p.uuid)).toEqual([uuid]));
    expect(claude.prompts.map(textOf)).toEqual(['Fix the login test']);
    // Shown once, as sent, and Claude is at work on it.
    expect(messages().filter((m) => m.uuid === uuid)).toHaveLength(1);
    expect(getRun(sessionId)?.busy).toBe(true);
  }

  it('closed while Pelican looks whether it is still current, goes to Claude resumed', async () => {
    const { sessionId, claude, run, messages } = await idle();
    const uuid = '00000000-0000-4000-8000-0000000000c1';
    const sending = sendMessage({ sessionId }, { text: 'Are you there?', attachments: [], settings: {}, uuid });
    run.close();
    expect(await sending).toBe(sessionId);
    await reachedAgain(sessionId, claude, messages, uuid);
  });

  it('closed while its settings are being applied, goes to Claude resumed', async () => {
    FakeClaude.controlDelay = 100;
    const { sessionId, claude, run, messages } = await idle();
    const uuid = '00000000-0000-4000-8000-0000000000c2';
    const sending = sendMessage({ sessionId }, { text: 'Are you there?', attachments: [], settings: { model: 'sonnet' }, uuid });
    await vi.waitFor(() => expect(claude.called('setModel')).toHaveLength(1), { interval: 2 });
    run.close();
    expect(await sending).toBe(sessionId);
    await reachedAgain(sessionId, claude, messages, uuid);
  });
});

describe('the last prompt edited in place', () => {
  it('into /clear is turned away before the running Claude is touched, and the next message carries on the whole conversation', async () => {
    const { sessionId, claude, run } = await start();
    claude.say(result());
    await vi.waitFor(() => expect(run.busy).toBe(false));
    const before = claudes.length;
    await expect(replaceLastTurn(sessionId, folder, 'entry-before', 'prompt', { text: '/clear', attachments: [], settings: {} })).rejects.toThrow(/new session/);
    // No Claude resumed from before the last turn is left to take the next message.
    expect(claudes).toHaveLength(before);
    expect(claude.called('close')).toHaveLength(0);
    expect(getRun(sessionId)).toBe(run);
    await sendMessage({ sessionId }, { text: 'Carry on', attachments: [], settings: {} });
    await settle();
    expect(claude.prompts.map(textOf)).toEqual(['Fix the login test', 'Carry on']);
  });
});

describe('when Claude Code ends', () => {
  it('a run replaced by a newer one says nothing after it: the page keeps the newer one, at work', async () => {
    // A real process exits a while after it is closed, after the newer run has started.
    FakeClaude.closeDelay = 30;
    const { sessionId, claude, run, events } = await start();
    claude.say(result());
    await vi.waitFor(() => expect(run.busy).toBe(false));
    const heard: ServerEvent[] = [];
    const stop = connect((event) => heard.push(event));
    // The last prompt edited in place: Claude resumed from before it, with the new text.
    await replaceLastTurn(sessionId, folder, 'entry-before', 'prompt', { text: 'Edited prompt', attachments: [], settings: {} });
    const fresh = getRun(sessionId)!;
    expect(fresh).not.toBe(run);
    const from = events.length;
    await vi.waitFor(() => expect(run.closed).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(fresh.busy).toBe(true);
    // Nothing from the old run after the new one spoke: no idle state, no idle status for the lists.
    expect(events.slice(from).filter((e) => e.type === 'run' && !e.state?.busy)).toEqual([]);
    expect(events.filter((e) => e.type === 'run').at(-1)).toMatchObject({ state: { busy: true } });
    expect(heard.filter((e) => e.type === 'status' && e.sessionId === sessionId).at(-1)).toMatchObject({ status: 'running' });
    expect(getRun(sessionId)).toBe(fresh);
    stop();
  });

  it('pages watching a run that ended are cleared, as a page opened now would find it', async () => {
    const { sessionId, claude, run, events } = await start();
    claude.say(system('task_started', { task_id: 'a1', tool_use_id: 'toolu_1', description: 'Find the flaky test', subagent_type: 'Explore' }));
    claude.say(system('task_progress', { task_id: 'a1', tool_use_id: 'toolu_1', description: 'Find the flaky test', usage: { total_tokens: 9, tool_uses: 1, duration_ms: 10 }, summary: 'Reading' }));
    claude.say(system('background_tasks_changed', { tasks: [{ task_id: 'b1', task_type: 'local_bash', description: 'npm run dev' }] }));
    claude.say(reply('Started.'));
    claude.say(result());
    await vi.waitFor(() => expect(run.state().tasks).toHaveLength(1));
    // The process ends: with nothing to say why, the pages forget the run, its tasks with it.
    claude.end();
    await vi.waitFor(() => expect(getRun(sessionId)).toBeUndefined());
    await settle();
    expect(events.filter((e) => e.type === 'run').at(-1)).toEqual({ type: 'run', sessionId, state: null });
  });

  it('prompts queued for a turn whose Claude Code ended part way go to it resumed, as when a turn ends', async () => {
    const { sessionId, claude, run, messages } = await start();
    claude.say(init());
    await run.send({ text: 'Then run the tests', attachments: [], settings: {}, mode: 'queue', uuid: '00000000-0000-4000-8000-0000000000e1' });
    await run.send({ text: 'And update the changelog', attachments: [], settings: {}, mode: 'queue', uuid: '00000000-0000-4000-8000-0000000000e2' });
    // Killed, or crashed, mid-turn.
    claude.fail(new Error('Claude Code process exited with code 137'));
    await vi.waitFor(() => expect(claudes.at(-1)).not.toBe(claude));
    const resumed = claudes.at(-1)!;
    expect(resumed.options).toMatchObject({ resume: sessionId, cwd: folder });
    await vi.waitFor(() => expect(resumed.prompts).toHaveLength(1));
    expect(resumed.prompts.map((p) => [p.uuid, textOf(p)])).toEqual([['00000000-0000-4000-8000-0000000000e1', 'Then run the tests']]);
    // The first is in the conversation; the next waits its turn, still listed and still yours to take back.
    expect(messages().filter((m) => m.role === 'user').map((m) => m.uuid)).toEqual(['00000000-0000-4000-8000-0000000000e1']);
    const fresh = getRun(sessionId)!;
    expect(fresh).not.toBe(run);
    expect(fresh.state()).toMatchObject({ busy: true, queued: [{ uuid: '00000000-0000-4000-8000-0000000000e2', text: 'And update the changelog' }] });
  });

  it('what was queued for a Claude closed here, or one that never started, starts nothing', async () => {
    const shutDown = await start();
    shutDown.claude.say(init());
    await shutDown.run.send({ text: 'Then run the tests', attachments: [], settings: {}, mode: 'queue' });
    const neverStarted = await start();
    await neverStarted.run.send({ text: 'Then run the tests', attachments: [], settings: {}, mode: 'queue' });
    const before = claudes.length;
    // Pelican shutting down closes every Claude; one that cannot start would only fail again.
    closeAll();
    neverStarted.claude.fail(new Error('Claude Code is not signed in'));
    await vi.waitFor(() => expect(getRun(shutDown.sessionId) ?? getRun(neverStarted.sessionId)).toBeUndefined());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(claudes).toHaveLength(before);
  });

  it('a run that ended on an error says why, and nothing more of what it was doing', async () => {
    const { sessionId, claude, events } = await start();
    claude.say(system('task_started', { task_id: 'a1', tool_use_id: 'toolu_1', description: 'Find the flaky test', subagent_type: 'Explore' }));
    claude.say(system('task_progress', { task_id: 'a1', tool_use_id: 'toolu_1', description: 'Find the flaky test', usage: { total_tokens: 9, tool_uses: 1, duration_ms: 10 }, summary: 'Reading' }));
    claude.say(system('background_tasks_changed', { tasks: [{ task_id: 'a1', task_type: 'local_agent', subagent_type: 'Explore', description: 'Find the flaky test' }] }));
    await vi.waitFor(() => expect(getRun(sessionId)!.state().progress).toBeDefined());
    claude.fail(new Error('Claude Code process exited with code 137'));
    await vi.waitFor(() => expect(getRun(sessionId)).toBeUndefined());
    await settle();
    const last = events.filter((e) => e.type === 'run').at(-1) as Extract<ServerEvent, { type: 'run' }>;
    expect(last.state).toMatchObject({ busy: false, error: expect.stringContaining('137') });
    expect(last.state).not.toHaveProperty('tasks');
    expect(last.state).not.toHaveProperty('progress');
    expect(last.state).not.toHaveProperty('startedAt');
  });
});

describe('what Claude Code says besides replies', () => {
  it('shows hook feedback and a command’s output as notes, and leaves the terminal’s own lines out', async () => {
    const { claude, messages } = await start();
    claude.say(system('informational', { content: 'UserPromptSubmit hook blocked the prompt: no secrets', level: 'warning' }));
    claude.say(system('informational', { content: 'Loaded 3 skills', level: 'info' }));
    claude.say(system('local_command_output', { content: 'Total cost: $0.12' }));
    await vi.waitFor(() => expect(messages()).toHaveLength(2));
    expect(messages().map((m: ChatMessage) => [m.role, m.blocks[0]])).toEqual([
      ['system', { type: 'text', text: 'UserPromptSubmit hook blocked the prompt: no secrets' }],
      ['system', { type: 'text', text: '<local-command-stdout>Total cost: $0.12</local-command-stdout>' }],
    ]);
  });

  it('keeps the commands list to what a phone can run, from the session itself', async () => {
    const { run } = await start();
    expect((await run.completions()).commands.map((c) => c.name)).toEqual(['compact']);
  });
});

describe('notifications', () => {
  it('say what Claude wants, on one line a lock screen can show', () => {
    const base = { id: 'x', sessionId: 's', createdAt: 0 };
    expect(askedFor({ ...base, toolName: 'Bash', input: { command: 'npm test -- --watch=false\necho done' } }, '/w')).toBe('Run npm test -- --watch=false');
    expect(askedFor({ ...base, toolName: 'Write', input: { file_path: '/w/src/new.ts' } }, '/w')).toBe('Write src/new.ts');
    expect(askedFor({ ...base, toolName: 'WebFetch', input: { url: 'https://docs.example.com/a?b' } }, '/w')).toBe('Fetch docs.example.com');
    expect(askedFor({ ...base, toolName: 'AskUserQuestion', input: { questions: [{ question: 'Which database?' }] } }, '/w')).toBe('Which database?');
    expect(askedFor({ ...base, toolName: 'mcp__github__create_issue', input: {} }, '/w')).toBe('Use github · create_issue');
    expect(oneLine('echo "\u202e\u2066hidden\u2069"\nrm -rf /', 30)).toBe('echo " hidden " rm -rf /');
    expect(oneLine('x'.repeat(200), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});

// The run state a page gets matches what the run says it is.
it('broadcasts its state to the session’s pages', async () => {
  const { runs, run } = await start();
  await run.send({ text: 'Queued', attachments: [], settings: {}, mode: 'queue' });
  const last: RunState = runs().at(-1)!;
  expect(last.queued?.[0]?.text).toBe('Queued');
});
