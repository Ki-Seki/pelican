import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Recording a command starts no Claude here.
vi.mock('../src/server/runner', () => ({ ensureRun: async () => ({ appendShell: async () => {}, busy: false }), getRun: () => undefined }));

const { hurryShells, SHUTDOWN_GRACE_MS, startShell, stopAllShells } = await import('../src/server/shell-runs');

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
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    // Ending already.
  }
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
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(process.platform === 'win32')('! commands when Pelican shuts down', () => {
  it('get seconds to tidy up, as docker compose stopping its containers needs, and end before it settles', async () => {
    const tidy = path.join(dir, 'tidy');
    const tidied = path.join(dir, 'tidied');
    // A program that tidies up for three seconds when asked, after the shell that started it has
    // gone: longer than Claude Code's 1.5 and Stop's 2 seconds.
    startShell(SESSION, dir, `echo $$ > ${tidy}; sh -c "trap 'sleep 3; echo done > ${tidied}; exit 0' TERM; while :; do sleep 0.1; done"; true`);
    const group = await groupOf(tidy);
    await settle(200);
    const started = Date.now();
    await stopAllShells();
    expect(await exists(tidied)).toBe(true);
    expect(groupRuns(group)).toBe(false);
    expect(Date.now() - started).toBeGreaterThan(2500);
    expect(Date.now() - started).toBeLessThan(SHUTDOWN_GRACE_MS);
    expect(SHUTDOWN_GRACE_MS).toBeLessThan(20_000);
  }, 30_000);

  it('are made to end once the time is up, also one that ignores the asking', async () => {
    const stubborn = path.join(dir, 'stubborn');
    startShell(SESSION, dir, `echo $$ > ${stubborn}; trap '' TERM; sleep 60`);
    const group = await groupOf(stubborn);
    await settle(200);
    const started = Date.now();
    await stopAllShells(800);
    expect(groupRuns(group)).toBe(false);
    expect(Date.now() - started).toBeLessThan(3000);
  }, 20_000);

  it('end at once when Pelican is told again, as by a second Ctrl+C', async () => {
    const stubborn = path.join(dir, 'stubborn-again');
    startShell(SESSION, dir, `echo $$ > ${stubborn}; trap '' TERM; sleep 60`);
    const group = await groupOf(stubborn);
    await settle(200);
    const started = Date.now();
    const stopping = stopAllShells();
    await settle(300);
    hurryShells();
    await stopping;
    expect(groupRuns(group)).toBe(false);
    expect(Date.now() - started).toBeLessThan(3000);
  }, 20_000);

  it('are not asked a second time where systemd, stopping the service, asked each of them already', async () => {
    const asked = path.join(dir, 'asked');
    const ready = path.join(dir, 'ready');
    // Each request it gets is a line; docker compose takes a second one as "stop them now".
    startShell(SESSION, dir, `trap 'echo asked >> ${asked}; sleep 0.5; exit 0' TERM; echo $$ > ${ready}; while :; do sleep 0.1; done`);
    const group = await groupOf(ready);
    // systemd sends SIGTERM to every process of the service at once, the command's too.
    process.kill(-group, 'SIGTERM');
    await stopAllShells(5000, { asked: true });
    expect(groupRuns(group)).toBe(false);
    expect((await readFile(asked, 'utf8')).trim().split('\n')).toEqual(['asked']);
  }, 20_000);

  /** Pelican, started in a child, with one command running; its own SIGTERM and SIGINT handler stops it. */
  async function pelicanWith(command: string, ready: string) {
    const script = path.join(dir, `serve-${path.basename(ready)}.mts`);
    const src = path.resolve(import.meta.dirname, '../src/server');
    await writeFile(script, `
import { startServer } from ${JSON.stringify(path.join(src, 'server.ts'))};
import { startShell } from ${JSON.stringify(path.join(src, 'shell-runs.ts'))};
await startServer();
startShell(${JSON.stringify(SESSION)}, ${JSON.stringify(dir)}, ${JSON.stringify(command)});
`);
    const child = spawn(process.execPath, ['--import', 'tsx', script], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { ...process.env, PELICAN_HOST: '127.0.0.1', PELICAN_PORT: '0', SHELL: '/bin/sh' },
      stdio: 'ignore',
    });
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    const pgid = await groupOf(ready).catch((error: unknown) => {
      child.kill('SIGKILL');
      throw error;
    });
    return { child, exited, pgid };
  }

  it('end with Pelican when it is told to stop, after tidying up, before it exits', async () => {
    const ready = path.join(dir, 'served');
    const tidied = path.join(dir, 'served-tidied');
    const { child, exited, pgid } = await pelicanWith(`trap 'sleep 3; echo done > ${tidied}; exit 0' TERM; echo $$ > ${ready}; while :; do sleep 0.1; done`, ready);
    // As a service manager stops it, or Ctrl+C: its own handler takes the signal.
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    expect(await exists(tidied)).toBe(true);
    expect(groupRuns(pgid)).toBe(false);
  }, 30_000);

  it('end with Pelican at once when it is told twice, even one that ignores the asking', async () => {
    const ready = path.join(dir, 'served-stubborn');
    const { child, exited, pgid } = await pelicanWith(`echo $$ > ${ready}; trap '' TERM; sleep 60`, ready);
    const started = Date.now();
    child.kill('SIGTERM');
    await settle(500);
    child.kill('SIGINT');
    expect(await exited).toBe(0);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(groupRuns(pgid)).toBe(false);
  }, 30_000);
});
