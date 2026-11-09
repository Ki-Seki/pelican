// Claude Code that stops as it starts (a flag it does not know, a configuration it refuses, a
// crash) says why on the page, as it would in a terminal: what it printed. Stand-ins for Claude
// Code stop at each moment, run through the Agent SDK as Pelican runs Claude Code.
import { randomUUID } from 'node:crypto';
import { access, chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { RunState, ServerEvent } from '../src/shared/protocol';
import { app } from '../src/server/app';
import { INSTALL_COMMAND } from '../src/server/claude-code';
import { config } from '../src/server/config';
import { feedFor } from '../src/server/feed';
import { closeAll, getRun, runState, SessionRun, starter } from '../src/server/runner';

let root: string;
const saved = { ...config };
const savedClaude = process.env.CLAUDE_CONFIG_DIR;

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pelican-stops-')));
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
  config.claudeHome = path.join(root, 'claude');
  config.stateDir = path.join(root, 'state');
  config.configDir = path.join(root, 'config');
  config.auth = 'none';
});

afterEach(() => closeAll());

afterAll(async () => {
  Object.assign(config, saved);
  if (savedClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedClaude;
  await rm(root, { recursive: true, force: true });
});

/** What Claude Code prints, and exits 1 on, given a flag it does not know. */
const UNKNOWN_FLAG = 'error: unknown option \'--bad-flag\'';
/** What it prints, and exits 1 on, given an MCP configuration it refuses: two lines. */
const BAD_MCP = 'Error: Invalid MCP configuration:\nmcpServers: Invalid input: expected record, received number';
const printing = (words: string) => words.split('\n').map((line) => `echo "${line}" >&2`).join('\n');
/** Reads what the Agent SDK sends it until the first message comes, then runs `then`. */
const onFirstMessage = (then: string) => `while read -r line; do case $line in *'"type":"user"'*) ${then};; esac; done\nexit 1`;

/** A stand-in for Claude Code, made of a shell script: Pelican runs it in Claude Code's place. */
async function standIn(name: string, script: string): Promise<void> {
  const file = path.join(root, name);
  await writeFile(file, `#!/bin/sh\n${script}\n`);
  await chmod(file, 0o755);
  config.claudeExecutable = file;
}

const request = (url: string, init: RequestInit = {}) => app.request(url, {
  ...init,
  headers: { host: 'localhost:7860', 'x-pelican': '1', 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) },
});

/** Starts a session in a folder of its own with its first message, as the page does. */
async function startSession(): Promise<{ status: number; sessionId?: string; error?: string }> {
  const cwd = await mkdtemp(path.join(root, 'project-'));
  const answer = await request('/api/sessions', { method: 'POST', body: JSON.stringify({ cwd, text: 'Fix the login test', trust: 'trusted' }) });
  return { status: answer.status, ...((await answer.json()) as { sessionId?: string; error?: string }) };
}

/**
 * The session's run once its Claude Code has stopped, as its page finds it on opening: loaded, and
 * as the socket says it to a page that subscribes (runState). None, when the page finds no run.
 */
async function foundOnceStopped(sessionId: string): Promise<RunState | undefined> {
  await vi.waitFor(() => expect(getRun(sessionId)).toBeUndefined());
  const { run } = (await (await request(`/api/sessions/${sessionId}`)).json()) as { run?: RunState | null };
  expect(runState(sessionId)).toEqual(run ?? undefined);
  return run ?? undefined;
}

/**
 * What the page learns of a session whose Claude Code stopped as it started. On a busy computer
 * Claude Code ends before the message goes, and starting the session fails, saying why; on an idle
 * one the message goes first, and the session's page, once it opens, finds why.
 */
async function told(started: { status: number; sessionId?: string; error?: string }): Promise<string | undefined> {
  expect([200, 500]).toContain(started.status);
  return started.status === 200 ? (await foundOnceStopped(started.sessionId!))?.error : started.error;
}

/** A Claude of a session of its own, started as a message would start it. */
async function startedRun(): Promise<SessionRun> {
  const run = new SessionRun(randomUUID(), await mkdtemp(path.join(root, 'project-')), {}, false);
  run.start(await starter());
  return run;
}

const message = { text: 'Fix the login test', attachments: [], settings: {} };

describe('Claude Code that stops before the first message reaches it', () => {
  it('says why to the message, in its words', async () => {
    await standIn('unknown-flag', `${printing(UNKNOWN_FLAG)}\nexit 1`);
    const run = await startedRun();
    await run.ended;
    await expect(run.send(message)).rejects.toMatchObject({ message: UNKNOWN_FLAG });
  });

  it('says why to the request that starts the session or, when the message went first, on the session’s page: whichever came first', async () => {
    await standIn('unknown-flag', `${printing(UNKNOWN_FLAG)}\nexit 1`);
    expect(await told(await startSession())).toBe(UNKNOWN_FLAG);
  });

  it('that is not there says so, in Pelican’s words with what to do, as Claude Code never ran to say anything', async () => {
    const missing = path.join(root, 'missing');
    config.claudeExecutable = missing;
    expect(await told(await startSession())).toBe(`Pelican could not find Claude Code at ${missing}. Set PELICAN_CLAUDE_PATH to the claude program on ${config.machine}, or install Claude Code there with\n${INSTALL_COMMAND}`);
  });
});

describe('Claude Code that stops just after the first message reached it', () => {
  it('says why on the session’s page, which asks only once starting the session has answered, line for line', async () => {
    await standIn('bad-mcp', onFirstMessage(`${printing(BAD_MCP)}; exit 1`));
    const started = await startSession();
    expect(started.status).toBe(200);
    expect(await foundOnceStopped(started.sessionId!)).toMatchObject({ busy: false, error: BAD_MCP });
  });

  it('as the message goes, too soon after it ended for the Agent SDK to read how, still says why', async () => {
    // Something it started holds its stderr a while after it ended: the Agent SDK waits up to
    // 200 ms for it before it reads how Claude Code ended, and a message that goes meanwhile cannot
    // be written. The SDK then aborts, with no word of why.
    const ended = path.join(root, 'ended');
    await standIn('holds-stderr', `sleep 1 >/dev/null </dev/null &\n${printing(UNKNOWN_FLAG)}\n: > '${ended}'\nexit 1`);
    const run = await startedRun();
    await vi.waitFor(() => access(ended), { interval: 5 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // It goes, as far as Pelican can tell; on a busy computer it may be told why at once instead.
    const refused = await run.send(message).then(() => undefined, (error: Error) => error.message);
    await run.ended;
    expect(refused ?? run.error).toBe(UNKNOWN_FLAG);
  });
});

describe('Claude Code stopped or closed here', () => {
  it('is no error, whatever it prints meanwhile: Stop ends the turn, closing ends Claude Code, and nothing is left for a page', async () => {
    // It answers Stop as Claude Code does, with the turn's end, and ends on an error of its own once
    // its input closes.
    await standIn('obliging', String.raw`while read -r line; do
  case $line in
    *'"subtype":"interrupt"'*)
      id=$(printf '%s\n' "$line" | sed 's/.*"request_id":"\([^"]*\)".*/\1/')
      printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{}}}\n' "$id"
      echo 'Request interrupted by user' >&2
      echo '{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["Request was aborted."],"duration_ms":1,"duration_api_ms":0,"num_turns":1,"stop_reason":null,"total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0},"modelUsage":{},"permission_denials":[],"uuid":"00000000-0000-4000-8000-000000000001","session_id":"s"}';;
  esac
done
echo 'error: its input closed' >&2
exit 1`);
    const started = await startSession();
    expect(started.status).toBe(200);
    const sessionId = started.sessionId!;
    const run = getRun(sessionId)!;
    const events: ServerEvent[] = [];
    feedFor(sessionId).listeners.add((event) => events.push(event));
    expect(run.busy).toBe(true);
    await run.interrupt();
    await vi.waitFor(() => expect(run.busy).toBe(false));
    expect(run.error).toBeUndefined();
    run.close();
    await run.ended;
    expect(run.error).toBeUndefined();
    expect(events.filter((e) => e.type === 'run').at(-1)).toEqual({ type: 'run', sessionId, state: null });
    expect(runState(sessionId)).toBeUndefined();
  });
});
