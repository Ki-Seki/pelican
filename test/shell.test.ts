import os from 'node:os';

import { describe, expect, it } from 'vitest';

import { bashModeText, runCommand } from '../src/server/shell';

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
    expect(bashModeText(result)).toContain('(stopped after two minutes)');
  });

  it('says nothing more of a command that simply ends', async () => {
    const result = await runCommand(os.tmpdir(), 'echo done');
    expect(result).toMatchObject({ stdout: 'done\n', code: 0 });
    expect(result.background).toBeUndefined();
  });
});
