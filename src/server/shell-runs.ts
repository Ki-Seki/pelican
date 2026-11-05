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

type Entry = { shell: LiveShell; run: CommandRun; pending: string; flush?: NodeJS.Timeout };

const bySession = new Map<string, Map<string, Entry>>();

/** The session's commands still on show, oldest first, as they are now. */
export function liveShells(sessionId: string): LiveShell[] {
  return [...(bySession.get(sessionId)?.values() ?? [])].map((entry) => ({ ...entry.shell }));
}

/** What a page subscribing to the session is told of its commands: all of them, as they are now. */
export const shellsEvent = (sessionId: string): ServerEvent => ({ type: 'shells', sessionId, shells: liveShells(sessionId) });

const tell = (sessionId: string) => feedFor(sessionId).broadcast(shellsEvent(sessionId));

/** What came since the last look goes out in one piece, up to what the page keeps. */
function flush(sessionId: string, entry: Entry): void {
  clearTimeout(entry.flush);
  entry.flush = undefined;
  if (!entry.pending) return;
  const room = MAX_OUTPUT - entry.shell.output.length;
  const text = entry.pending.slice(0, Math.max(0, room));
  const cut = text.length < entry.pending.length;
  entry.pending = '';
  if (text) {
    const from = entry.shell.output.length;
    entry.shell.output += text;
    feedFor(sessionId).broadcast({ type: 'shell_output', sessionId, id: entry.shell.id, from, text });
  }
  if (cut && !entry.shell.truncated) {
    entry.shell.truncated = true;
    tell(sessionId);
  }
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
 * Starts a `!` command in the session's folder. Its pages see it at once and its output as it
 * comes; once done it goes into the conversation under the command's id.
 */
export function startShell(sessionId: string, cwd: string, command: string): LiveShell {
  const id = randomUUID();
  const shell: LiveShell = { id, command, startedAt: Date.now(), output: '' };
  let entry: Entry | undefined;
  const run = startCommand(cwd, command, {
    onOutput: (text) => {
      if (!entry) return;
      entry.pending += text;
      const current = entry;
      current.flush ??= setTimeout(() => flush(sessionId, current), FLUSH_MS);
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
