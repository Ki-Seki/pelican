import { spawn } from 'node:child_process';

import type { ShellResult } from '../shared/protocol.js';

const MAX_OUTPUT = 200_000;
const TIMEOUT_MS = 2 * 60_000;
/** After the shell exits, how long output still on its way may take to arrive. */
const DRAIN_MS = 200;

/** On Windows there are no process groups to start or stop. */
const groups = process.platform !== 'win32';

/** Whether anything of the process group `pgid` is still running. */
function running(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs one `!` command in a session's folder through the user's login shell,
 * like Claude Code's bash mode: no terminal, output captured up to a limit,
 * stopped after two minutes.
 *
 * The command gets a process group of its own. It is done when its shell is: a
 * process it left in the background (`npm run dev &`) keeps running, and the
 * result says so, instead of holding the request open for its whole life by
 * keeping the output pipes. Stopping it stops everything it started, not just
 * the shell, whose children would otherwise run on.
 */
export function runCommand(cwd: string, command: string, timeoutMs = TIMEOUT_MS): Promise<ShellResult> {
  const shell = process.env.SHELL || '/bin/bash';
  const started = Date.now();
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let done = false;
    let stopped = false;
    const child = spawn(shell, ['-lc', command], {
      cwd,
      env: { ...process.env, PAGER: 'cat', GIT_PAGER: 'cat', TERM: 'dumb' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: groups,
    });
    const take = (current: string, chunk: Buffer) => {
      if (current.length >= MAX_OUTPUT) {
        truncated = true;
        return current;
      }
      const next = current + chunk.toString('utf8');
      if (next.length > MAX_OUTPUT) truncated = true;
      return next.slice(0, MAX_OUTPUT);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      if (!done) stdout = take(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (!done) stderr = take(stderr, chunk);
    });
    const timer = setTimeout(() => {
      stopped = true;
      try {
        if (groups && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }, timeoutMs);
    let drain: NodeJS.Timeout | undefined;
    const finish = (code: number | null, error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(drain);
      const background = groups && !stopped && child.pid !== undefined && running(child.pid);
      resolve({
        command,
        stdout,
        stderr: error ? `${stderr}${error.message}` : stderr,
        code: stopped ? null : code,
        durationMs: Date.now() - started,
        ...(truncated ? { truncated: true } : {}),
        ...(background ? { background: true } : {}),
      });
    };
    child.on('error', (error) => finish(null, error));
    // 'close' waits for every process holding the pipes; 'exit' is the shell itself.
    child.on('close', (code, signal) => finish(signal ? null : code));
    child.on('exit', (code, signal) => {
      drain = setTimeout(() => finish(signal ? null : code), DRAIN_MS);
    });
    // Not waited for: what it left running exits on its own, or with the server.
    child.unref();
  });
}

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The command and its output the way Claude Code's bash mode writes them into the conversation. */
export function bashModeText(result: ShellResult): string {
  const note = result.code === null ? '\n(stopped after two minutes)'
    : result.code !== 0 ? `\n(exit code ${result.code})`
      : result.background ? '\n(still running in the background)' : '';
  return `<bash-input>${escape(result.command)}</bash-input><bash-stdout>${escape(result.stdout)}</bash-stdout><bash-stderr>${escape(result.stderr + note)}</bash-stderr>`;
}
