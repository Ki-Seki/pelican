import { spawn } from 'node:child_process';

import type { ShellResult } from '../shared/protocol.js';

const MAX_OUTPUT = 200_000;
const TIMEOUT_MS = 2 * 60_000;

/**
 * Runs one `!` command in a session's folder through the user's login shell,
 * like Claude Code's bash mode: no terminal, output captured up to a limit,
 * stopped after two minutes.
 */
export function runCommand(cwd: string, command: string): Promise<ShellResult> {
  const shell = process.env.SHELL || '/bin/bash';
  const started = Date.now();
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let truncated = false;
    const child = spawn(shell, ['-lc', command], { cwd, env: { ...process.env, PAGER: 'cat', GIT_PAGER: 'cat', TERM: 'dumb' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const take = (current: string, chunk: Buffer) => {
      if (current.length >= MAX_OUTPUT) {
        truncated = true;
        return current;
      }
      const next = current + chunk.toString('utf8');
      if (next.length > MAX_OUTPUT) truncated = true;
      return next.slice(0, MAX_OUTPUT);
    };
    child.stdout.on('data', (chunk: Buffer) => { stdout = take(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = take(stderr, chunk); });
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    const finish = (code: number | null, error?: Error) => {
      clearTimeout(timer);
      resolve({
        command,
        stdout,
        stderr: error ? `${stderr}${error.message}` : stderr,
        code,
        durationMs: Date.now() - started,
        ...(truncated ? { truncated: true } : {}),
      });
    };
    child.on('error', (error) => finish(null, error));
    child.on('close', (code, signal) => finish(signal ? null : code));
  });
}

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The command and its output the way Claude Code's bash mode writes them into the conversation. */
export function bashModeText(result: ShellResult): string {
  const note = result.code === null ? '\n(stopped after two minutes)' : result.code !== 0 ? `\n(exit code ${result.code})` : '';
  return `<bash-input>${escape(result.command)}</bash-input><bash-stdout>${escape(result.stdout)}</bash-stdout><bash-stderr>${escape(result.stderr + note)}</bash-stderr>`;
}
