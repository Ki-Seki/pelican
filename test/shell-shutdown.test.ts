import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Recording a command starts no Claude here.
vi.mock('../src/server/runner', () => ({ ensureRun: async () => ({ appendShell: async () => {}, busy: false }), getRun: () => undefined }));

const { startShell, stopAllShells } = await import('../src/server/shell-runs');

const SESSION = '00000000-0000-4000-8000-00000000d00d';
let dir: string;
const shell = process.env.SHELL;

beforeAll(async () => {
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pelican-shutdown-')));
  // A plain shell: nothing of the developer's login profile runs.
  process.env.SHELL = '/bin/sh';
});
afterAll(async () => {
  process.env.SHELL = shell;
  await rm(dir, { recursive: true, force: true });
});

/** Whether anything of a process group still runs; what is left is ended, so no test leaves it behind. */
function groupRuns(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
  } catch {
    return false;
  }
  process.kill(-pgid, 'SIGKILL');
  return true;
}

/** The process group a command wrote down (its shell's own id, `$$`), once it has. */
async function groupOf(file: string): Promise<number> {
  for (let i = 0; i < 200; i += 1) {
    const text = await readFile(file, 'utf8').catch(() => '');
    if (text.trim()) return Number(text);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${file} was never written`);
}

const exists = (file: string) => stat(file).then(() => true, () => false);

describe.skipIf(process.platform === 'win32')('! commands when Pelican shuts down', () => {
  it('end before it settles: asked first, given a moment to tidy up, then made to', async () => {
    const stubborn = path.join(dir, 'stubborn');
    const tidy = path.join(dir, 'tidy');
    const tidied = path.join(dir, 'tidied');
    // One that ignores the asking; one whose program tidies up for half a second when asked,
    // after the shell that started it has already gone.
    startShell(SESSION, dir, `echo $$ > ${stubborn}; trap '' TERM; sleep 60`);
    startShell(SESSION, dir, `echo $$ > ${tidy}; sh -c "trap 'sleep 0.5; echo done > ${tidied}; exit 0' TERM; while :; do sleep 0.1; done"; true`);
    const groups = [await groupOf(stubborn), await groupOf(tidy)];
    await new Promise((resolve) => setTimeout(resolve, 200));
    const started = Date.now();
    await stopAllShells();
    expect(groups.map(groupRuns)).toEqual([false, false]);
    expect(await exists(tidied)).toBe(true);
    expect(Date.now() - started).toBeLessThan(4000);
  }, 20_000);

  it('end with Pelican when it is told to stop, before it exits', async () => {
    const pgidFile = path.join(dir, 'served');
    const script = path.join(dir, 'serve.mts');
    const src = path.resolve(import.meta.dirname, '../src/server');
    await writeFile(script, `
import { startServer } from ${JSON.stringify(path.join(src, 'server.ts'))};
import { startShell } from ${JSON.stringify(path.join(src, 'shell-runs.ts'))};
await startServer();
startShell(${JSON.stringify(SESSION)}, ${JSON.stringify(dir)}, ${JSON.stringify(`echo $$ > ${pgidFile}; trap '' TERM; sleep 60`)});
`);
    // Pelican as a service manager or Ctrl+C stops it: with SIGTERM, which its own handler takes.
    const child = spawn(process.execPath, ['--import', 'tsx', script], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { ...process.env, PELICAN_HOST: '127.0.0.1', PELICAN_PORT: '0', SHELL: '/bin/sh' },
      stdio: 'ignore',
    });
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    const pgid = await groupOf(pgidFile).catch((error: unknown) => {
      child.kill('SIGKILL');
      throw error;
    });
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    expect(groupRuns(pgid)).toBe(false);
  }, 30_000);
});
