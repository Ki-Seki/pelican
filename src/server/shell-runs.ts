import { randomUUID } from 'node:crypto';

import type { LiveShell, ServerEvent, ShellResult } from '../shared/protocol.js';
import { feedFor } from './feed.js';
import { ensureRun, getRun } from './runner.js';
import { MAX_OUTPUT, respondsToBashCommands, startCommand, type CommandRun } from './shell.js';

/**
 * The `!` commands running in each session, shown to its pages as their output comes, and added to
 * the conversation once done, as Claude Code's bash mode adds them. Then Claude answers, as in the
 * CLI, unless the user's settings say not to (`respondToBashCommands: false`), or the command did
 * not finish on its own (Stop, the time limit).
 */

/** Output goes to the pages at most this often. */
const FLUSH_MS = 100;
/** While Claude is in a turn, a finished command waits for it to end; this is how often it looks. */
const WAIT_MS = 500;
/** A command whose record could not be written stays on show this long, saying why. */
const FAILED_SHOWN_MS = 2 * 60_000;

/** `pending`: output not sent to the pages yet; `cut`: some went past what they keep. */
type Entry = { shell: LiveShell; run: CommandRun; pending: string; cut?: boolean; flush?: NodeJS.Timeout };

const bySession = new Map<string, Map<string, Entry>>();

/** The session's commands still on show, oldest first, as they are now. */
export function liveShells(sessionId: string): LiveShell[] {
  return [...(bySession.get(sessionId)?.values() ?? [])].map((entry) => ({ ...entry.shell }));
}

/** What a page subscribing to the session is told of its commands: all of them, as they are now. */
export const shellsEvent = (sessionId: string): ServerEvent => ({ type: 'shells', sessionId, shells: liveShells(sessionId) });

const tell = (sessionId: string) => feedFor(sessionId).broadcast(shellsEvent(sessionId));

/** What came since the last look goes out in one piece; once some was left out, the pages are told. */
function flush(sessionId: string, entry: Entry): void {
  clearTimeout(entry.flush);
  entry.flush = undefined;
  if (entry.pending) {
    const from = entry.shell.output.length;
    entry.shell.output += entry.pending;
    feedFor(sessionId).broadcast({ type: 'shell_output', sessionId, id: entry.shell.id, from, text: entry.pending });
    entry.pending = '';
  }
  if (entry.cut && !entry.shell.truncated) {
    entry.shell.truncated = true;
    tell(sessionId);
  }
}

/**
 * Output as it comes, held until the next look only up to what the page keeps: past that it is
 * let go as it comes, since a command can print gigabytes (`!yes`) and keep at it for its half hour.
 */
function take(sessionId: string, entry: Entry, text: string): void {
  const room = MAX_OUTPUT - entry.shell.output.length - entry.pending.length;
  if (text.length > room) entry.cut = true;
  if (room > 0) entry.pending += text.length > room ? text.slice(0, room) : text;
  else if (entry.shell.truncated) return;
  entry.flush ??= setTimeout(() => flush(sessionId, entry), FLUSH_MS);
}

function forget(sessionId: string, id: string): void {
  const entries = bySession.get(sessionId);
  entries?.delete(id);
  if (entries?.size === 0) bySession.delete(sessionId);
  tell(sessionId);
}

/** Claude's turn there is over, or there is none: its record can go in, and Claude may answer it. */
async function turnOver(sessionId: string): Promise<void> {
  while (getRun(sessionId)?.busy) await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
}

/**
 * Adds a finished command to the conversation. While Claude is in a turn it waits for the turn to
 * end, as a `!` command queued in the CLI does, so the conversation holds it where Claude Code
 * writes it, and Claude answers it then.
 */
async function record(sessionId: string, cwd: string, id: string, result: ShellResult): Promise<void> {
  await turnOver(sessionId);
  // Pelican is closing its Claude processes: none is started again for this.
  if (shuttingDown) return;
  const respond = result.endedBy === undefined && (await respondsToBashCommands(cwd));
  const run = await ensureRun(sessionId);
  // It may have started a turn while the settings were read: then the record waits no more, and Claude reads it later.
  await run.appendShell(result, respond && !run.busy, id);
}

/**
 * Starts a `!` command in the session's folder, with the environment Claude Code gets there
 * (`env`, from launchFor). Its pages see it at once and its output as it comes; once done it goes
 * into the conversation under the command's id.
 */
export function startShell(sessionId: string, cwd: string, command: string, env?: Record<string, string>): LiveShell {
  const id = randomUUID();
  const shell: LiveShell = { id, command, startedAt: Date.now(), output: '' };
  let entry: Entry | undefined;
  const run = startCommand(cwd, command, {
    ...(env ? { env } : {}),
    onOutput: (text) => {
      if (entry) take(sessionId, entry, text);
    },
  });
  entry = { shell, run, pending: '' };
  let entries = bySession.get(sessionId);
  if (!entries) {
    entries = new Map();
    bySession.set(sessionId, entries);
  }
  entries.set(id, entry);
  tell(sessionId);
  const started = entry;
  void run.result.then(async (result) => {
    flush(sessionId, started);
    started.shell.done = { code: result.code, ...(getRun(sessionId)?.busy ? { waiting: true } : {}) };
    tell(sessionId);
    try {
      await record(sessionId, cwd, id, result);
      forget(sessionId, id);
    } catch (error) {
      started.shell.error = `Could not add it to the conversation: ${(error as Error).message}`;
      tell(sessionId);
      setTimeout(() => forget(sessionId, id), FAILED_SHOWN_MS).unref();
    }
  });
  return shell;
}

/** Stop: ends the command and everything it started. False when it is not running (any more). */
export function stopShell(sessionId: string, id: string): boolean {
  const entry = bySession.get(sessionId)?.get(id);
  if (!entry || entry.shell.done) return false;
  entry.run.stop();
  entry.shell.stopping = true;
  tell(sessionId);
  return true;
}

let shuttingDown = false;

/** Pelican is shutting down: what still runs ends with it, as a `!` command ends with the CLI. */
export function stopAllShells(): void {
  shuttingDown = true;
  for (const entries of bySession.values()) for (const entry of entries.values()) if (!entry.shell.done) entry.run.stop();
}
