import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { config } from '../src/server/config';
import { liveProcesses } from '../src/server/live';
import { notify } from '../src/server/push';
import { listSummaries } from '../src/server/sessions';
import { checkWaiting, NOTIFY_AFTER_MS } from '../src/server/waiting';

vi.mock('../src/server/push', () => ({ notify: vi.fn(async () => undefined) }));

const id = '0f0f0f0f-0000-4000-8000-0000000000bb';
let dir: string;
let pid: number;
const saved = { claudeHome: config.claudeHome, env: process.env.CLAUDE_CONFIG_DIR };

/** A Claude Code process of another app: not started by this one (its parent has exited). */
function otherProcess(): number {
  const out = spawnSync('sh', ['-c', `"${process.execPath}" -e "setTimeout(() => {}, 60000)" >/dev/null 2>&1 & echo $!`], { encoding: 'utf8' });
  return Number(out.stdout.trim());
}

const register = (entry: Record<string, unknown>) =>
  writeFile(path.join(dir, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId: id, entrypoint: 'cli', ...entry }));

/** The registry is read at most every 1.5 s. */
const later = () => new Promise((resolve) => setTimeout(resolve, 1600));

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'pelican-waiting-'));
  config.claudeHome = dir;
  process.env.CLAUDE_CONFIG_DIR = dir;
  await mkdir(path.join(dir, 'sessions'), { recursive: true });
  await mkdir(path.join(dir, 'projects', '-w-app'), { recursive: true });
  const at = new Date(Date.now() - 60_000).toISOString();
  await writeFile(path.join(dir, 'projects', '-w-app', `${id}.jsonl`), `${[
    { type: 'user', uuid: 'u1', parentUuid: null, sessionId: id, cwd: '/w/app', timestamp: at, message: { role: 'user', content: 'Deploy it' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: id, cwd: '/w/app', timestamp: at, message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'make deploy' } }] } },
  ].map((row) => JSON.stringify(row)).join('\n')}\n`);
  pid = otherProcess();
});
afterAll(async () => {
  if (pid) process.kill(pid);
  config.claudeHome = saved.claudeHome;
  if (saved.env === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved.env;
  await rm(dir, { recursive: true, force: true });
});

describe('a session waiting for an answer in another app', () => {
  it('shows as needing you there, and tells the phone once, after a while', async () => {
    await register({ status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: Date.now() - 30_000 });
    expect((await liveProcesses()).get(id)).toMatchObject({ app: 'the terminal', busy: true, waiting: 'permission prompt' });
    const [summary] = await listSummaries(() => undefined);
    expect(summary).toMatchObject({ id, status: 'waiting', runningIn: 'the terminal' });

    await checkWaiting();
    await checkWaiting();
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: id, tag: `${id}:ask`, body: 'Claude is asking for permission in the terminal',
    })), { timeout: 5_000 });
    expect(notify).toHaveBeenCalledTimes(1);

    // Answered there: working again. A new wait is told of once it has lasted a while.
    await register({ status: 'busy', statusUpdatedAt: Date.now() });
    await later();
    await checkWaiting();
    expect((await listSummaries(() => undefined))[0]).toMatchObject({ status: 'live', runningIn: 'the terminal' });
    await register({ status: 'waiting', waitingFor: 'input needed', statusUpdatedAt: Date.now() });
    await later();
    await checkWaiting();
    expect(notify).toHaveBeenCalledTimes(1);
    await checkWaiting(Date.now() + NOTIFY_AFTER_MS);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(2), { timeout: 5_000 });
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ body: 'Claude needs your input in the terminal' }));
  }, 20_000);
});
