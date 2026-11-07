import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let dir: string;

beforeAll(async () => {
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pelican-terminal-shutdown-')));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(process.platform === 'win32')('terminals when Pelican stops', () => {
  it('end with it: their shells are hung up, and the jobs they started with them', async () => {
    const pids = path.join(dir, 'pids');
    const script = path.join(dir, 'serve.mts');
    const src = path.resolve(import.meta.dirname, '../src/server');
    // Pelican in a child, with a terminal whose shell starts a job in the background.
    await writeFile(script, `
import { startServer } from ${JSON.stringify(path.join(src, 'server.ts'))};
import { openTerminal, testShell } from ${JSON.stringify(path.join(src, 'terminals.ts'))};
Object.assign(testShell, { file: '/bin/bash', args: ['--noprofile', '--norc', '-i'] });
await startServer();
await openTerminal(${JSON.stringify(dir)}, { cols: 80, rows: 24 }, { command: ${JSON.stringify(`sleep 300 & echo "$$ $(jobs -p)" > ${pids}`)} });
`);
    const { XPC_SERVICE_NAME: _job, ...env } = process.env;
    const child = spawn(process.execPath, ['--import', 'tsx', script], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { ...env, PELICAN_HOST: '127.0.0.1', PELICAN_PORT: '0', PS1: '$ ', BASH_SILENCE_DEPRECATION_WARNING: '1' },
      stdio: 'ignore',
    });
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    let written = '';
    for (let i = 0; i < 400 && !/^\d+ \d+$/.test(written.trim()); i += 1) {
      written = await readFile(pids, 'utf8').catch(() => '');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const [shell, job] = written.trim().split(' ').map(Number);
    try {
      expect(alive(shell!) && alive(job!)).toBe(true);
      // As a service manager stops it, or Ctrl+C.
      child.kill('SIGTERM');
      expect(await exited).toBe(0);
      for (let i = 0; i < 100 && (alive(shell!) || alive(job!)); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(alive(shell!)).toBe(false);
      expect(alive(job!)).toBe(false);
    } finally {
      child.kill('SIGKILL');
      for (const pid of [shell, job]) {
        try {
          if (pid) process.kill(pid, 'SIGKILL');
        } catch {
          // Gone, as it should be.
        }
      }
    }
  }, 30_000);
});
