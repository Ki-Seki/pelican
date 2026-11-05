import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';

import { resolveSettings } from '@anthropic-ai/claude-agent-sdk';

import type { ShellResult } from '../shared/protocol.js';
import { launchFor } from './trust.js';

/** What a command may print, per stream, before the rest is left out; the command runs on. */
export const MAX_OUTPUT = 200_000;
/**
 * How long a command may run. Its output shows as it comes and Stop ends it, so this only ends
 * one nobody came back to: longer than a build or a test run takes, and said when it is hit.
 */
export const MAX_RUN_MS = 30 * 60_000;
/** After the shell exits, how long output still on its way may take to arrive. */
const DRAIN_MS = 200;
/** Ending a command asks first (SIGTERM: a test runner can tidy up), then insists. */
const KILL_AFTER_MS = 2000;

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

/** A `!` command under way. */
export type CommandRun = {
  /** Settles when the command's shell is done: on its own, by Stop, or at the limit. */
  readonly result: Promise<ShellResult>;
  /** Ends it and everything it started, the whole process group, not just the shell. */
  stop: () => void;
};

/**
 * Runs one `!` command in a session's folder through the user's login shell, like Claude Code's
 * bash mode: no terminal, output handed on as it comes (`onOutput`, stdout and stderr together)
 * and kept up to a limit, ended by Stop or after `limitMs`. `env` is what Claude Code itself gets
 * in the folder (trust.ts, launchFor): in one kept to the user's settings only, git runs none of
 * the repository's own programs, for a `!` command as for Claude's.
 *
 * The command gets a process group of its own. It is done when its shell is: a process it left in
 * the background (`npm run dev &`) keeps running, and the result says so, instead of holding the
 * command open for its whole life by keeping the output pipes. Ending it ends everything it
 * started, not just the shell, whose children would otherwise run on.
 */
export function startCommand(cwd: string, command: string, options: { limitMs?: number; onOutput?: (text: string) => void; env?: Record<string, string> } = {}): CommandRun {
  const limitMs = options.limitMs ?? MAX_RUN_MS;
  const shell = process.env.SHELL || '/bin/bash';
  const started = Date.now();
  let stdout = '';
  let stderr = '';
  let truncated = false;
  let done = false;
  let endedBy: ShellResult['endedBy'];
  let settle!: (result: ShellResult) => void;
  const result = new Promise<ShellResult>((resolve) => {
    settle = resolve;
  });
  const child = spawn(shell, ['-lc', command], {
    cwd,
    env: { ...process.env, ...options.env, PAGER: 'cat', GIT_PAGER: 'cat', TERM: 'dumb' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: groups,
  });
  const signal = (name: NodeJS.Signals) => {
    try {
      if (groups && child.pid) process.kill(-child.pid, name);
      else child.kill(name);
    } catch {
      // Already gone.
    }
  };
  const end = (by: NonNullable<ShellResult['endedBy']>) => {
    // Once its shell has exited it is done: what it left in the background is meant to run on.
    if (done || endedBy || child.exitCode !== null || child.signalCode !== null) return;
    endedBy = by;
    signal('SIGTERM');
    // What ignores the request still goes, also once the shell itself has exited.
    setTimeout(() => signal('SIGKILL'), KILL_AFTER_MS).unref();
  };
  // Up to the limit, and nothing past it held even for a moment: a command can print gigabytes.
  const keep = (current: string, text: string) => {
    const room = MAX_OUTPUT - current.length;
    if (text.length <= room) return current + text;
    truncated = true;
    return room > 0 ? current + text.slice(0, room) : current;
  };
  // Decoded as a stream, so a character split between two reads stays whole.
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (text: string) => {
    if (done) return;
    stdout = keep(stdout, text);
    options.onOutput?.(text);
  });
  child.stderr.on('data', (text: string) => {
    if (done) return;
    stderr = keep(stderr, text);
    options.onOutput?.(text);
  });
  const timer = setTimeout(() => end('limit'), limitMs);
  let drain: NodeJS.Timeout | undefined;
  const finish = (code: number | null, error?: Error) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    clearTimeout(drain);
    const background = groups && !endedBy && child.pid !== undefined && running(child.pid);
    settle({
      command,
      stdout,
      stderr: error ? `${stderr}${error.message}` : stderr,
      code: endedBy ? null : code,
      durationMs: Date.now() - started,
      ...(truncated ? { truncated: true } : {}),
      ...(background ? { background: true } : {}),
      ...(endedBy ? { endedBy, ...(endedBy === 'limit' ? { limitMs } : {}) } : {}),
    });
  };
  child.on('error', (error) => finish(null, error));
  // 'close' waits for every process holding the pipes; 'exit' is the shell itself.
  child.on('close', (code, sig) => finish(sig ? null : code));
  child.on('exit', (code, sig) => {
    drain = setTimeout(() => finish(sig ? null : code), DRAIN_MS);
  });
  // Not waited for: what it left running exits on its own, or with the server.
  child.unref();
  return { result, stop: () => end('stop') };
}

/** A command run to its end, for callers that only need the result. */
export const runCommand = (cwd: string, command: string, limitMs?: number): Promise<ShellResult> =>
  startCommand(cwd, command, limitMs === undefined ? {} : { limitMs }).result;

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const count = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
const spoken = (ms: number) => (ms >= 60_000 ? count(Math.round(ms / 60_000), 'minute') : count(Math.max(1, Math.round(ms / 1000)), 'second'));

/** What the output alone does not say: how the command ended, and whether some was left out. */
function notes(result: ShellResult): string {
  const said = result.endedBy === 'stop' ? '(stopped)'
    : result.endedBy === 'limit' ? `(stopped after ${spoken(result.limitMs ?? MAX_RUN_MS)})`
      : result.code !== null && result.code !== 0 ? `(exit code ${result.code})`
        : result.background ? '(still running in the background)' : '';
  return [said, result.truncated ? '(the rest of the output was left out)' : ''].filter(Boolean).map((note) => `\n${note}`).join('');
}

/**
 * What Claude Code's bash mode puts first when Claude is not to answer, in its own words: Claude
 * keeps the command as context and does not reply to it.
 */
export const BASH_CAVEAT = '<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request, and its output goes straight to the user. It\'s recorded here as context for later messages.</local-command-caveat>';

/**
 * A command and its output as Claude Code's bash mode adds them to the conversation, so the CLI
 * and Desktop show Pelican's the same way, and the other way round: the command as typed, then
 * its output, escaped so it cannot end its tags, with the caveat first when Claude is not to answer.
 */
export function bashModeMessages(result: ShellResult, respond: boolean): Array<{ text: string; meta?: true }> {
  return [
    ...(respond ? [] : [{ text: BASH_CAVEAT, meta: true as const }]),
    { text: `<bash-input>${result.command}</bash-input>` },
    { text: `<bash-stdout>${escape(result.stdout)}</bash-stdout><bash-stderr>${escape(result.stderr + notes(result))}</bash-stderr>` },
  ];
}

/** The command and its output as one text. */
export const bashModeText = (result: ShellResult): string => bashModeMessages(result, true).map((message) => message.text).join('');

/**
 * Whether Claude answers a `!` command, as the CLI decides it: unless `respondToBashCommands` is
 * false in the settings Claude Code runs with in this folder (the user's own only, where the
 * folder's are not used). Reading settings runs nothing.
 */
export async function respondsToBashCommands(cwd: string): Promise<boolean> {
  try {
    const { settingSources } = await launchFor(cwd);
    const dir = await realpath(cwd).catch(() => cwd);
    const { effective } = await resolveSettings({ cwd: dir, settingSources });
    return effective.respondToBashCommands !== false;
  } catch {
    // Settings that cannot be read, or an SDK without the call: Claude Code's default.
    return true;
  }
}
