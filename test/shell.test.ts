import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { ShellResult } from '../src/shared/protocol';
import { BASH_CAVEAT, bashModeMessages, bashModeText, MAX_RUN_MS, respondsToBashCommands, runCommand, startCommand } from '../src/server/shell';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 40 && alive(pid); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  return !alive(pid);
}

describe.skipIf(process.platform === 'win32')('a ! command', () => {
  it('returns when its shell is done, leaving what it started in the background running', async () => {
    const result = await runCommand(os.tmpdir(), 'sleep 30 & echo $!');
    const pid = Number(result.stdout.trim());
    try {
      expect(result.durationMs).toBeLessThan(2000);
      expect(result.code).toBe(0);
      expect(result.background).toBe(true);
      expect(alive(pid)).toBe(true);
      expect(bashModeText(result)).toContain('(still running in the background)');
    } finally {
      process.kill(pid, 'SIGKILL');
    }
  });

  it('stops everything it started when it takes too long, not just its shell', async () => {
    const result = await runCommand(os.tmpdir(), 'sleep 30 & echo $!; wait', 700);
    const pid = Number(result.stdout.trim());
    expect(result.code).toBeNull();
    expect(result.background).toBeUndefined();
    expect(await gone(pid)).toBe(true);
    expect(result.endedBy).toBe('limit');
    expect(bashModeText(result)).toContain('(stopped after 1 second)');
  }, 15_000);

  it('says nothing more of a command that simply ends', async () => {
    const result = await runCommand(os.tmpdir(), 'echo done');
    expect(result).toMatchObject({ stdout: 'done\n', code: 0 });
    expect(result.background).toBeUndefined();
  });
});

describe.skipIf(process.platform === 'win32')('a live ! command', () => {
  it('hands on its output as it comes, before it ends', async () => {
    const seen: Array<{ text: string; at: number }> = [];
    const run = startCommand(os.tmpdir(), 'echo first; sleep 1; echo second', { onOutput: (text) => seen.push({ text, at: Date.now() }) });
    const result = await run.result;
    const ended = Date.now();
    expect(seen.map((s) => s.text).join('')).toBe('first\nsecond\n');
    expect(ended - seen[0]!.at).toBeGreaterThan(500);
    expect(result).toMatchObject({ stdout: 'first\nsecond\n', code: 0 });
  });

  it('has no wall at two minutes, only a generous one', () => {
    expect(MAX_RUN_MS).toBeGreaterThanOrEqual(30 * 60_000);
  });

  it('Stop ends it and everything it started, and the record says so', async () => {
    let pid = 0;
    const run = startCommand(os.tmpdir(), 'sleep 30 & echo $!; wait', { onOutput: (text) => { pid = Number(text.trim()) || pid; } });
    for (let i = 0; i < 40 && !pid; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(alive(pid)).toBe(true);
    run.stop();
    const result = await run.result;
    expect(result).toMatchObject({ code: null, endedBy: 'stop' });
    expect(result.background).toBeUndefined();
    expect(await gone(pid)).toBe(true);
    expect(bashModeText(result)).toContain('(stopped)');
  });

  it('ends what ignores the polite request too', async () => {
    let pid = 0;
    const run = startCommand(os.tmpdir(), "sh -c 'trap \"\" TERM; echo $$; sleep 30'", { onOutput: (text) => { pid = Number(text.trim()) || pid; } });
    for (let i = 0; i < 40 && !pid; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    run.stop();
    await run.result;
    for (let i = 0; i < 80 && alive(pid); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(alive(pid)).toBe(false);
  });
});

describe('the record of a ! command', () => {
  const result: ShellResult = { command: 'npm test -- --grep "<b>"', stdout: 'ok & done', stderr: '', code: 0, durationMs: 5 };

  it('is the command, then its output, as Claude Code writes them', () => {
    expect(bashModeMessages(result, true)).toEqual([
      { text: '<bash-input>npm test -- --grep "<b>"</bash-input>' },
      { text: '<bash-stdout>ok &amp; done</bash-stdout><bash-stderr></bash-stderr>' },
    ]);
  });

  it('starts with Claude Code’s caveat when Claude is not to answer', () => {
    const [caveat, ...rest] = bashModeMessages(result, false);
    expect(caveat).toEqual({ text: BASH_CAVEAT, meta: true });
    expect(rest).toHaveLength(2);
  });

  it('says how it ended when the output does not', () => {
    const text = (extra: Partial<ShellResult>) => bashModeMessages({ ...result, ...extra }, true)[1]!.text;
    expect(text({ code: 2 })).toContain('(exit code 2)');
    expect(text({ code: null, endedBy: 'limit', limitMs: 30 * 60_000 })).toContain('(stopped after 30 minutes)');
    expect(text({ background: true })).toContain('(still running in the background)');
    expect(text({ truncated: true })).toContain('(the rest of the output was left out)');
  });
});

describe('whether Claude answers a ! command', () => {
  let project: string;
  const settings = path.join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json');
  beforeAll(async () => {
    project = await mkdtemp(path.join(os.tmpdir(), 'pelican-respond-'));
  });
  afterEach(() => rm(settings, { force: true }));
  afterAll(() => rm(project, { recursive: true, force: true }));

  it('is yes unless the settings say respondToBashCommands: false, as in the CLI', async () => {
    expect(await respondsToBashCommands(project)).toBe(true);
    await mkdir(path.dirname(settings), { recursive: true });
    await writeFile(settings, JSON.stringify({ respondToBashCommands: false }));
    expect(await respondsToBashCommands(project)).toBe(false);
  });

  it('reads the folder’s own settings too', async () => {
    await mkdir(path.join(project, '.claude'), { recursive: true });
    await writeFile(path.join(project, '.claude', 'settings.json'), JSON.stringify({ respondToBashCommands: false }));
    try {
      expect(await respondsToBashCommands(project)).toBe(false);
    } finally {
      await rm(path.join(project, '.claude'), { recursive: true, force: true });
    }
  });
});
