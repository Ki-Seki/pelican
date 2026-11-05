import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { resolveSettings } from '@anthropic-ai/claude-agent-sdk';

import type { ShellResult } from '../shared/protocol.js';
import { transcriptPath } from './transcripts.js';
import { launchFor } from './trust.js';

/** What a command may print before the rest is left out; the command runs on. */
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
  /** Whether anything it started still runs (its process group; on Windows, its shell). */
  alive: () => boolean;
  /** Ends at once what is left of a command asked to stop, which did not: for when Pelican exits. */
  kill: () => void;
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
  let output = '';
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
  // stdout and stderr together, as they come, as Claude Code's bash mode keeps them. Up to the
  // limit, and nothing past it held even for a moment: a command can print gigabytes.
  const take = (text: string) => {
    if (done) return;
    const room = MAX_OUTPUT - output.length;
    if (text.length <= room) {
      output += text;
    } else {
      truncated = true;
      if (room > 0) output += text.slice(0, room);
    }
    options.onOutput?.(text);
  };
  // Decoded as a stream, so a character split between two reads stays whole.
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', take);
  child.stderr.on('data', take);
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
      output: error ? `${output}${error.message}` : output,
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
  return {
    result,
    stop: () => end('stop'),
    alive: () => (groups && child.pid !== undefined ? running(child.pid) : child.exitCode === null && child.signalCode === null),
    // Only one that was asked to end: what a finished command left in the background runs on.
    kill: () => {
      if (endedBy) signal('SIGKILL');
    },
  };
}

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const count = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
const spoken = (ms: number) => (ms >= 60_000 ? count(Math.round(ms / 60_000), 'minute') : count(Math.max(1, Math.round(ms / 1000)), 'second'));

/** What the output alone does not say: how the command ended, and whether some was left out. */
function notes(result: ShellResult, leftOut: boolean): string {
  const said = result.endedBy === 'stop' ? '(stopped)'
    : result.endedBy === 'limit' ? `(stopped after ${spoken(result.limitMs ?? MAX_RUN_MS)})`
      : result.code !== null && result.code !== 0 ? `(exit code ${result.code})`
        : result.background ? '(still running in the background)' : '';
  return [said, leftOut ? '(the rest of the output was left out)' : ''].filter(Boolean).map((note) => `\n${note}`).join('');
}

/**
 * How much of a command's output Claude gets in the conversation, as Claude Code's bash mode gives
 * it: its `bashOutputMaxChars` setting, 30,000 characters unless set, held to 4,000 to 128,000.
 */
export const INLINE_CHARS = { standard: 30_000, least: 4_000, most: 128_000 };
/** How much of an output saved to a file Claude Code shows Claude in its place. */
const PREVIEW_CHARS = 2_000;

const inlineChars = (setting: unknown) => (typeof setting === 'number' && Number.isInteger(setting) && setting > 0
  ? Math.min(INLINE_CHARS.most, Math.max(INLINE_CHARS.least, setting))
  : INLINE_CHARS.standard);

/** A command that went well, as Claude Code's bash mode tells them apart: it ended on its own, with 0. */
const succeeded = (result: ShellResult) => result.code === 0 && !result.endedBy;

/** The first `end` characters, a character Unicode writes as two kept whole. */
function head(text: string, end: number): string {
  const at = Math.min(end, text.length);
  const code = text.charCodeAt(at - 1);
  return text.slice(0, at < text.length && code >= 0xd800 && code <= 0xdbff ? at - 1 : at);
}

/** Sizes as Claude Code says them: 2KB, 97.7KB, 1.2MB, characters counted as bytes. */
function sizeText(size: number): string {
  const kb = size / 1024;
  if (kb < 1) return `${size} bytes`;
  if (kb < 1024) return `${kb.toFixed(1).replace(/\.0$/, '')}KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1).replace(/\.0$/, '')}MB`;
  return `${(mb / 1024).toFixed(1).replace(/\.0$/, '')}GB`;
}

/**
 * What Claude Code puts in the conversation in place of an output too long to go there, word for
 * word: where all of it was saved, and its start, up to 2KB, ending with a line when one ends past
 * halfway. As in Claude Code, the start is not escaped. `cut`: Pelican kept only its first part.
 */
function persistedOutput(output: string, file: string, cut: boolean): string {
  const saved = cut
    ? `Output exceeded the ${sizeText(MAX_OUTPUT)} persist limit; only the first ${sizeText(MAX_OUTPUT)} were saved to: ${file}`
    : `Output too large (${sizeText(output.length)}). Full output saved to: ${file}`;
  const more = output.length > PREVIEW_CHARS;
  const line = output.slice(0, PREVIEW_CHARS).lastIndexOf('\n');
  const preview = more ? head(output, line > PREVIEW_CHARS / 2 ? line : PREVIEW_CHARS) : output;
  return `<persisted-output>\n${saved}\n\nPreview (first ${sizeText(PREVIEW_CHARS)}):\n${preview}${more ? '\n...\n' : '\n'}</persisted-output>`;
}

/**
 * The output as Claude Code's bash mode puts it in the conversation. A command that went well: in
 * `<bash-stdout>`, blank lines at its start and space at its end trimmed, or Claude Code's word
 * that it printed nothing; longer than Claude gets inline, Claude Code's preview of the file that
 * holds all of it (`savedTo`). One that failed or was stopped: in `<bash-stderr>` as it came, cut
 * at that length. Escaped so it cannot end its tags, with Pelican's notes on how it ended after it.
 */
function outputText(result: ShellResult): string {
  const tags = (stdout: string, stderr: string) => `<bash-stdout>${stdout}</bash-stdout><bash-stderr>${stderr}</bash-stderr>`;
  if (succeeded(result) && result.savedTo) return tags(persistedOutput(result.output, result.savedTo, result.truncated === true), escape(notes(result, false)));
  const max = result.inlineMax ?? INLINE_CHARS.standard;
  const shown = head(result.output, max);
  const said = escape(notes(result, shown.length < result.output.length || result.truncated === true));
  if (succeeded(result)) return tags(escape(shown.replace(/^(\s*\n)+/, '').trimEnd() || '(Bash completed with no output)'), said);
  return tags('', escape(shown) + said);
}

/**
 * What Claude Code's bash mode puts first when Claude is not to answer, in its own words: Claude
 * keeps the command as context and does not reply to it.
 */
export const BASH_CAVEAT = '<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request, and its output goes straight to the user. It\'s recorded here as context for later messages.</local-command-caveat>';

/**
 * A command and its output as Claude Code's bash mode adds them to the conversation, so the CLI
 * and Desktop show Pelican's the same way, and the other way round: the command as typed, then
 * its output (outputText), with the caveat first when Claude is not to answer.
 */
export function bashModeMessages(result: ShellResult, respond: boolean): Array<{ text: string; meta?: true }> {
  return [
    ...(respond ? [] : [{ text: BASH_CAVEAT, meta: true as const }]),
    { text: `<bash-input>${result.command}</bash-input>` },
    { text: outputText(result) },
  ];
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_LETTERS = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * A command's result as it goes to Claude, as Claude Code's bash mode sends it: inline up to
 * `inlineMax` characters; past that, for one that went well, all of it saved where Claude Code
 * saves it, in the session's tool-results folder beside its transcript, under a name of Claude
 * Code's kind (`b` and eight letters or digits). Written once, never over a file already there;
 * when it cannot be, Claude gets the start inline and is told the rest was left out.
 */
export async function forClaude(sessionId: string, result: ShellResult, inlineMax: number): Promise<ShellResult> {
  const out: ShellResult = { ...result, inlineMax };
  if (!succeeded(result) || result.output.length <= inlineMax || !SESSION_ID.test(sessionId)) return out;
  const transcript = await transcriptPath(sessionId);
  if (!transcript) return out;
  try {
    const dir = path.join(path.dirname(transcript), sessionId, 'tool-results');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `b${[...randomBytes(8)].map((byte) => NAME_LETTERS[byte % NAME_LETTERS.length]).join('')}.txt`);
    await writeFile(file, result.output, { flag: 'wx', mode: 0o600 });
    return { ...out, savedTo: file };
  } catch {
    return out;
  }
}

/**
 * How Claude Code's bash mode treats a command in this folder, from the settings Claude Code runs
 * with there (the user's own only, where the folder's are not used): whether Claude answers it,
 * unless `respondToBashCommands` is false, and how much of its output Claude gets inline
 * (`bashOutputMaxChars`). Reading settings runs nothing.
 */
export async function bashModeSettings(cwd: string): Promise<{ respond: boolean; inlineMax: number }> {
  try {
    const { settingSources } = await launchFor(cwd);
    const dir = await realpath(cwd).catch(() => cwd);
    const { effective } = await resolveSettings({ cwd: dir, settingSources });
    return { respond: effective.respondToBashCommands !== false, inlineMax: inlineChars(effective.bashOutputMaxChars) };
  } catch {
    // Settings that cannot be read, or an SDK without the call: Claude Code's defaults.
    return { respond: true, inlineMax: INLINE_CHARS.standard };
  }
}
