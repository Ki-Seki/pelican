import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync, openSync, read, unlinkSync, writeSync } from 'node:fs';
import { mkdir, open, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';

import { resolveSettings } from '@anthropic-ai/claude-agent-sdk';

import type { SavedOutputPage } from '../shared/protocol.js';
import { openRegular } from './open.js';
import { transcriptPath } from './transcripts.js';
import { launchFor } from './trust.js';

/** What the pages keep of a running command's output, in characters, before the rest is left out of them; the command runs on. */
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

/**
 * How much of a command's output Claude gets in the conversation, in bytes as Claude Code's bash
 * mode measures it: its `bashOutputMaxChars` setting, 30,000 unless set, held to 4,000 to 128,000.
 */
export const INLINE_BYTES = { standard: 30_000, least: 4_000, most: 128_000 };
/** How much of a longer output Claude Code saves to a file: 64 MB, from which on it says it cut it. */
export const SAVED_BYTES = 64 * 1024 * 1024;
/** How much of an output saved to a file Claude Code shows Claude in its place, in characters. */
const PREVIEW_CHARS = 2_000;

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

const readAt = promisify(read);

/**
 * What a `!` command printed, stdout and stderr together in the order it wrote them, kept as
 * Claude Code keeps it: its start at hand, as much as Claude ever gets inline, and when there is
 * more, all of it, up to the 64 MB Claude Code saves of one, written to a file as it comes rather
 * than held. The file has no name once open (it goes with Pelican, whatever happens).
 */
export class CommandOutput {
  /** All it printed, in bytes, also past what is kept. */
  bytes = 0;
  private head: Buffer[] = [];
  private held = 0;
  private spill: { fd: number; written: number; name?: string } | undefined;
  /** The file could not be written: only the start is kept. */
  private lost = false;

  add(chunk: Buffer): void {
    const before = this.bytes;
    this.bytes += chunk.length;
    if (this.held < INLINE_BYTES.most) {
      const part = chunk.subarray(0, INLINE_BYTES.most - this.held);
      this.head.push(part);
      this.held += part.length;
    }
    if (this.bytes <= INLINE_BYTES.most || this.lost) return;
    if (this.spill) {
      this.write(chunk);
      return;
    }
    // The first bytes past the start: the file gets the start, then the rest as it comes.
    try {
      const name = path.join(os.tmpdir(), `pelican-${randomUUID()}.out`);
      const fd = openSync(name, 'wx+', 0o600);
      this.spill = { fd, written: 0, name };
      unlinkSync(name);
      delete this.spill.name;
    } catch {
      if (!this.spill) {
        this.lost = true;
        return;
      }
    }
    this.write(Buffer.concat(this.head));
    this.write(chunk.subarray(INLINE_BYTES.most - before));
  }

  private write(data: Buffer): void {
    const spill = this.spill;
    if (!spill) return;
    const part = data.subarray(0, Math.max(0, SAVED_BYTES - spill.written));
    if (part.length === 0) return;
    try {
      for (let at = 0; at < part.length;) at += writeSync(spill.fd, part, at, part.length - at, spill.written + at);
      spill.written += part.length;
    } catch {
      this.lost = true;
      this.release();
    }
  }

  /** Its first `max` bytes as text; a character cut in two at the end reads as U+FFFD, as in Claude Code. */
  text(max: number): string {
    return Buffer.concat(this.head).subarray(0, max).toString('utf8');
  }

  /** All of it, up to Claude Code's 64 MB, written to `file`, which must not exist yet; readable only by you. */
  async saveTo(file: string): Promise<void> {
    if (this.bytes <= INLINE_BYTES.most) {
      await writeFile(file, Buffer.concat(this.head), { flag: 'wx', mode: 0o600 });
      return;
    }
    if (!this.spill || this.lost) throw new Error('The output could not be kept');
    const { fd, written } = this.spill;
    const target = await open(file, 'wx', 0o600);
    try {
      const buffer = Buffer.alloc(1024 * 1024);
      for (let at = 0; at < written;) {
        const { bytesRead } = await readAt(fd, buffer, 0, Math.min(buffer.length, written - at), at);
        if (bytesRead === 0) throw new Error('The output file came up short');
        await target.write(buffer, 0, bytesRead, at);
        at += bytesRead;
      }
    } finally {
      await target.close();
    }
  }

  /** Lets go of the file it went to: done with, once in the conversation. */
  release(): void {
    const spill = this.spill;
    if (!spill) return;
    this.spill = undefined;
    this.lost = true;
    try {
      closeSync(spill.fd);
    } catch {
      // Closed already.
    }
    if (spill.name) {
      try {
        unlinkSync(spill.name);
      } catch {
        // Gone already.
      }
    }
  }
}

/** A `!` command run in the session's folder, once it is done; it goes into the conversation as Claude Code's bash mode writes it. */
export type ShellResult = {
  command: string;
  /** What it printed, stdout and stderr together as it wrote them. */
  output: CommandOutput;
  /** Exit code; null when it did not finish on its own (see `endedBy`). */
  code: number | null;
  durationMs: number;
  /** Ended by Stop, or by Pelican once it ran past the limit (`limitMs`), rather than on its own. */
  endedBy?: 'stop' | 'limit';
  /** The limit it ran under, for saying it when it was hit. */
  limitMs?: number;
};

/** A `!` command under way. */
export type CommandRun = {
  /** Settles when the command's shell is done: on its own, by Stop, or at the limit. */
  readonly result: Promise<ShellResult>;
  /** Ends it and everything it started, the whole process group, not just the shell: asked, then made to. */
  stop: () => void;
  /**
   * Asks it to end, as Pelican does when it shuts down, with no timer of its own to insist: `kill`
   * does that, when the time to tidy up is over. `signal: false`: it was asked already (by systemd).
   */
  ask: (signal: boolean) => void;
  /** Whether anything it started still runs (its process group; on Windows, its shell). */
  alive: () => boolean;
  /** Ends at once what is left of a command asked to stop, which did not: for when Pelican exits. */
  kill: () => void;
};

/**
 * Runs one `!` command in a session's folder through the user's login shell, like Claude Code's
 * bash mode: no terminal, stdout and stderr into one pipe, so they stay in the order the command
 * wrote them, as in the file Claude Code gives both; the output handed on as it comes
 * (`onOutput`) and kept as Claude Code keeps it (CommandOutput); ended by Stop or after `limitMs`.
 * `env` is what Claude Code itself gets in the folder (trust.ts, launchFor): in one kept to the
 * user's settings only, git runs none of the repository's own programs, for a `!` command as for
 * Claude's.
 *
 * The command gets a process group of its own. It is done when its shell is: a process it left in
 * the background (`npm run dev &`) keeps running, instead of holding the command open for its
 * whole life by keeping the output pipe. Ending it ends everything it started, not just the shell,
 * whose children would otherwise run on.
 */
export function startCommand(cwd: string, command: string, options: { limitMs?: number; onOutput?: (text: string) => void; env?: Record<string, string> } = {}): CommandRun {
  const limitMs = options.limitMs ?? MAX_RUN_MS;
  const shell = process.env.SHELL || '/bin/bash';
  const started = Date.now();
  const output = new CommandOutput();
  const decoder = new StringDecoder('utf8');
  let done = false;
  let endedBy: ShellResult['endedBy'];
  let settle!: (result: ShellResult) => void;
  const result = new Promise<ShellResult>((resolve) => {
    settle = resolve;
  });
  // The login shell is started by sh with its stderr on its stdout: one pipe for both.
  const child = spawn(groups ? '/bin/sh' : shell, groups ? ['-c', 'exec "$0" -lc "$1" 2>&1', shell, command] : ['-lc', command], {
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
  const end = (by: NonNullable<ShellResult['endedBy']>, { ask = true, insist = true } = {}) => {
    // Once its shell has exited it is done: what it left in the background is meant to run on.
    if (done || endedBy || child.exitCode !== null || child.signalCode !== null) return;
    endedBy = by;
    if (ask) signal('SIGTERM');
    // What ignores the request still goes, also once the shell itself has exited.
    if (insist) setTimeout(() => signal('SIGKILL'), KILL_AFTER_MS).unref();
  };
  // Kept as Claude Code keeps it, and handed on as text, a character split between two reads kept whole.
  const take = (chunk: Buffer) => {
    if (done) return;
    output.add(chunk);
    const text = decoder.write(chunk);
    if (text) options.onOutput?.(text);
  };
  child.stdout.on('data', take);
  // Only sh's own word, should it fail to start the shell (on Windows, the shell's stderr).
  child.stderr.on('data', take);
  const timer = setTimeout(() => end('limit'), limitMs);
  let drain: NodeJS.Timeout | undefined;
  const finish = (code: number | null, error?: Error) => {
    if (done) return;
    if (error) take(Buffer.from(error.message));
    const rest = decoder.end();
    if (rest) options.onOutput?.(rest);
    done = true;
    clearTimeout(timer);
    clearTimeout(drain);
    settle({
      command,
      output,
      code: endedBy ? null : code,
      durationMs: Date.now() - started,
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
    ask: (asking) => end('stop', { ask: asking, insist: false }),
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

/** How a command Pelican ended says so, where Claude Code has no word for it: Stop, the time limit. */
function ending(result: ShellResult): string {
  if (result.endedBy === 'stop') return '\n(stopped)';
  if (result.endedBy === 'limit') return `\n(stopped after ${spoken(result.limitMs ?? MAX_RUN_MS)})`;
  return '';
}

const inlineBytes = (setting: unknown) => (typeof setting === 'number' && Number.isInteger(setting) && setting > 0
  ? Math.min(INLINE_BYTES.most, Math.max(INLINE_BYTES.least, setting))
  : INLINE_BYTES.standard);

/** Commands whose exit code 1 is an answer, not a failure, as Claude Code reads them: no match, files differ, false. */
const ANSWERS = new Set(['grep', 'rg', 'egrep', 'fgrep', 'find', 'diff', 'test', '[']);

/** The last simple command of a command line, as Claude Code reads one for what its exit code means. */
function lastCommand(line: string): string {
  let last = '';
  let part = '';
  let quote: string | undefined;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = undefined;
      else if (c === '\\' && quote === '"') {
        part += c + (line[i + 1] ?? '');
        i += 1;
        continue;
      }
      part += c;
    } else if (c === '\\') {
      part += c + (line[i + 1] ?? '');
      i += 1;
    } else if (c === '\'' || c === '"') {
      quote = c;
      part += c;
    } else if (c === ';' || c === '\n' || c === '|' || (c === '&' && line[i - 1] !== '>' && line[i - 1] !== '<' && line[i + 1] !== '>')) {
      if (part.trim()) last = part;
      part = '';
    } else {
      part += c;
    }
  }
  if (part.trim()) last = part;
  return last.trim().replace(/^[({]\s*/, '');
}

/**
 * Whether a command that ended on its own failed, as Claude Code's bash mode decides it: a code
 * other than 0, except 1 from a command for which 1 is an answer (grep finding nothing, diff
 * finding files differ, test being false, also `git diff` and `git grep`), which went well.
 */
function failed(command: string, code: number): boolean {
  const words = lastCommand(command).split(/\s+/);
  const answers = words[0] === 'git' ? ['diff', 'grep'].includes(gitCommand(words) ?? '') : ANSWERS.has(words[0] ?? '');
  return answers ? code >= 2 : code !== 0;
}

/** The git command a command line runs (`diff` in `git -C app diff --stat`). */
function gitCommand(words: readonly string[]): string | undefined {
  for (let i = 1; i < words.length; i += 1) {
    const word = words[i]!;
    if (word === '-C' || word === '-c') i += 1;
    else if (!word.startsWith('-')) return word;
  }
  return undefined;
}

/** A command that went well, as Claude Code's bash mode tells them apart: it ended on its own, and did not fail. */
const succeeded = (result: ShellResult) => !result.endedBy && result.code !== null && !failed(result.command, result.code);

/** The first `end` characters, a character Unicode writes as two kept whole. */
function head(text: string, end: number): string {
  const at = Math.min(end, text.length);
  const code = text.charCodeAt(at - 1);
  return text.slice(0, at < text.length && code >= 0xd800 && code <= 0xdbff ? at - 1 : at);
}

/** Sizes as Claude Code says them: 2KB, 97.7KB, 1.2MB, in bytes. */
function sizeText(size: number): string {
  const kb = size / 1024;
  if (kb < 1) return `${size} bytes`;
  if (kb < 1024) return `${kb.toFixed(1).replace(/\.0$/, '')}KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1).replace(/\.0$/, '')}MB`;
  return `${(mb / 1024).toFixed(1).replace(/\.0$/, '')}GB`;
}

/**
 * The output of a command that went well as Claude Code's bash mode gives it to Claude: blank lines
 * at its start and space at its end trimmed, and the hints some programs print for Claude Code
 * (`<claude-code-hint … />` on a line of its own) taken out.
 */
function trimmed(text: string): string {
  const lines = `${text.trimEnd()}\n`.split('\n');
  let from = 0;
  while (from < lines.length && lines[from]!.trim() === '') from += 1;
  let to = lines.length - 1;
  while (to >= from && lines[to]!.trim() === '') to -= 1;
  let out = lines.slice(from, to + 1).join('\n');
  if (out.includes('<claude-code-hint')) {
    const stripped = out.replace(/^[ \t]*<claude-code-hint[ \t][^>\r\n]*\/>[ \t]*(?=\r|\n|$)/gm, '');
    if (stripped !== out) out = stripped.replace(/\n{3,}/g, '\n\n');
  }
  return out.replace(/^(\s*\n)+/, '').trimEnd();
}

/**
 * What Claude Code puts in the conversation in place of an output too long to go there, word for
 * word: where all of it was saved and how big it is (from 64 MB on, that only the first 64 MB were
 * saved), then its start as Claude would have had it, up to 2KB, ending with a line when one ends
 * past halfway. As in Claude Code, the start is not escaped.
 */
function persistedOutput(text: string, file: string, size: number): string {
  const saved = size >= SAVED_BYTES
    ? `Output exceeded the ${sizeText(SAVED_BYTES)} persist limit; only the first ${sizeText(SAVED_BYTES)} were saved to: ${file}`
    : `Output too large (${sizeText(size)}). Full output saved to: ${file}`;
  const more = text.length > PREVIEW_CHARS;
  const line = text.slice(0, PREVIEW_CHARS).lastIndexOf('\n');
  const preview = more ? head(text, line > PREVIEW_CHARS / 2 ? line : PREVIEW_CHARS) : text;
  return `<persisted-output>\n${saved}\n\nPreview (first ${sizeText(PREVIEW_CHARS)}):\n${preview}${more ? '\n...\n' : '\n'}</persisted-output>`;
}

/** A command's result as it goes to Claude: how much goes inline, and where all of it was saved when more. */
export type ForClaude = ShellResult & {
  /** How much of the output Claude gets in the conversation, in bytes: Claude Code's `bashOutputMaxChars`. */
  inlineMax?: number;
  /** Where all of the output was saved when it was more than that, as Claude Code saves it (the session's tool-results folder). */
  savedTo?: string;
};

/**
 * The output as Claude Code's bash mode puts it in the conversation, measured in bytes as it
 * measures it. A command that went well: in `<bash-stdout>`, trimmed (see trimmed), or Claude
 * Code's word that it printed nothing; longer than Claude gets inline, Claude Code's preview of the
 * file that holds all of it (`savedTo`). One that failed: in `<bash-stderr>` as it came, cut at that
 * length. Escaped so it cannot end its tags. One Pelican ended (Stop, the time limit), which Claude
 * Code has no record of its own for, as one that failed, with a word on how it ended.
 */
function outputText(result: ForClaude): string {
  const tags = (stdout: string, stderr: string) => `<bash-stdout>${stdout}</bash-stdout><bash-stderr>${stderr}</bash-stderr>`;
  const start = result.output.text(result.inlineMax ?? INLINE_BYTES.standard);
  if (!succeeded(result)) return tags('', escape(start + ending(result)));
  const text = trimmed(start);
  if (result.savedTo) return tags(persistedOutput(text, result.savedTo, result.output.bytes), '');
  return tags(escape(text || '(Bash completed with no output)'), '');
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
export function bashModeMessages(result: ForClaude, respond: boolean): Array<{ text: string; meta?: true }> {
  return [
    ...(respond ? [] : [{ text: BASH_CAVEAT, meta: true as const }]),
    { text: `<bash-input>${result.command}</bash-input>` },
    { text: outputText(result) },
  ];
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_LETTERS = '0123456789abcdefghijklmnopqrstuvwxyz';

/** A session's tool-results folder, where Claude Code saves what is too long for the conversation: beside its transcript. */
async function toolResultsFolder(sessionId: string): Promise<string | undefined> {
  if (!SESSION_ID.test(sessionId)) return undefined;
  const transcript = await transcriptPath(sessionId);
  return transcript ? path.join(path.dirname(transcript), sessionId, 'tool-results') : undefined;
}

/** A file Claude Code names in a session's tool-results folder: `b` and eight letters for a `!` command's, a tool call's id for others'. */
const SAVED_NAME = /^[A-Za-z0-9_-]{1,128}\.(?:txt|json)$/;
/** How much of a saved output one read gives: a page a phone takes in, the next a tap away. */
export const SAVED_PAGE_BYTES = 256 * 1024;

/**
 * One page of an output Claude Code saved in place of one too long for the conversation (a long
 * `!` command's, as its record names it), from `from` bytes in, whole lines where it can, whole
 * characters always: read by its
 * name alone, from that session's own tool-results folder, a regular file reached through no link.
 * Undefined for anything else, or once Claude Code has let it go.
 */
export async function savedOutputPage(sessionId: string, name: string, from: number): Promise<SavedOutputPage | undefined> {
  if (!SAVED_NAME.test(name) || !Number.isSafeInteger(from) || from < 0) return undefined;
  const folder = await toolResultsFolder(sessionId);
  if (!folder) return undefined;
  try {
    // Where it must be, with only the projects' own folders resolved: a link on the way leads elsewhere.
    const expected = path.join(await realpath(path.dirname(path.dirname(folder))), sessionId, 'tool-results', name);
    if (await realpath(path.join(folder, name)) !== expected) return undefined;
    const handle = await openRegular(expected);
    try {
      const { size } = await handle.stat();
      const start = Math.min(from, size);
      const buffer = Buffer.alloc(Math.min(SAVED_PAGE_BYTES, size - start));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      let begin = 0;
      // Asked for from inside a character: from the next whole one.
      while (start > 0 && begin < bytesRead && (buffer[begin]! & 0xc0) === 0x80) begin += 1;
      let end = bytesRead;
      if (start + bytesRead < size) {
        // A page ends with a line, where one ends in its second half, and never inside a character.
        const line = buffer.subarray(0, end).lastIndexOf(0x0a);
        if (line >= begin + (end - begin) / 2) end = line + 1;
        else {
          let lead = end - 1;
          while (lead > begin && (buffer[lead]! & 0xc0) === 0x80) lead -= 1;
          const byte = buffer[lead]!;
          const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
          if (lead + length > end) end = lead;
        }
      }
      const next = start + end;
      return { text: buffer.toString('utf8', begin, end), from: start + begin, size, ...(next < size ? { next } : {}) };
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

/**
 * A command's result as it goes to Claude, as Claude Code's bash mode sends it: inline up to
 * `inlineMax` bytes; past that, for one that went well, all of it saved where Claude Code saves it,
 * in the session's tool-results folder beside its transcript, under a name of Claude Code's kind
 * (`b` and eight letters or digits). Written once, never over a file already there, readable only
 * by you; when it cannot be, Claude gets the start inline, as from Claude Code when its copy fails.
 */
export async function forClaude(sessionId: string, result: ShellResult, inlineMax: number): Promise<ForClaude> {
  const out: ForClaude = { ...result, inlineMax };
  if (!succeeded(result) || result.output.bytes <= inlineMax) return out;
  const dir = await toolResultsFolder(sessionId);
  if (!dir) return out;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `b${[...randomBytes(8)].map((byte) => NAME_LETTERS[byte % NAME_LETTERS.length]).join('')}.txt`);
    await result.output.saveTo(file);
    return { ...out, savedTo: file };
  } catch {
    return out;
  }
}

/**
 * How Claude Code's bash mode treats a command in this folder, from the settings Claude Code runs
 * with there (the user's own only, where the folder's are not used): whether Claude answers it,
 * unless `respondToBashCommands` is false, and how much of its output Claude gets inline
 * (`bashOutputMaxChars`, in bytes). Reading settings runs nothing.
 */
export async function bashModeSettings(cwd: string): Promise<{ respond: boolean; inlineMax: number }> {
  try {
    const { settingSources } = await launchFor(cwd);
    const dir = await realpath(cwd).catch(() => cwd);
    const { effective } = await resolveSettings({ cwd: dir, settingSources });
    return { respond: effective.respondToBashCommands !== false, inlineMax: inlineBytes(effective.bashOutputMaxChars) };
  } catch {
    // Settings that cannot be read, or an SDK without the call: Claude Code's defaults.
    return { respond: true, inlineMax: INLINE_BYTES.standard };
  }
}
