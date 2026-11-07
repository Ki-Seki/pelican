import { randomUUID } from 'node:crypto';

import type { LiveShell, ServerEvent } from '../shared/protocol.js';
import { feedFor } from './feed.js';
import { ensureRun, getRun, oneAtATime } from './runner.js';
import { bashModeSettings, type CommandRun, forClaude, MAX_OUTPUT, type ShellResult, startCommand } from './shell.js';

/**
 * The `!` commands running in each session, shown to its pages as their output comes, and added to
 * the conversation once done, as Claude Code's bash mode adds them: inline up to its limit, past it
 * saved to a file Claude gets the start of. Then Claude answers, as in the CLI, unless the user's
 * settings say not to (`respondToBashCommands: false`), or the command did not finish on its own
 * (Stop, the time limit).
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
  try {
    await turnOver(sessionId);
    // Pelican is closing its Claude processes: none is started again for this.
    if (shuttingDown) return;
    const settings = await bashModeSettings(cwd);
    const respond = result.endedBy === undefined && settings.respond;
    const toClaude = await forClaude(sessionId, result, settings);
    // As a message goes: never to a Claude a rewind is replacing.
    await oneAtATime(sessionId, async () => {
      const run = await ensureRun(sessionId);
      // It may have started a turn while the settings were read: then the record waits no more, and Claude reads it later.
      await run.appendShell(toClaude, respond && !run.busy, id);
    });
  } finally {
    // What was kept of its output past the start (a file with no name) goes once it is recorded.
    result.output.release();
  }
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
/** Pelican was told twice to stop (a second Ctrl+C): what still runs ends now. */
let hurried = false;

/**
 * How long the `!` commands still running get to tidy up when Pelican shuts down, before they are
 * made to end: 15 seconds. docker compose gives its containers 10 to stop (Claude Code's own bash
 * mode gives a command 1.5). Under systemd that is well inside the 90 seconds it waits for a
 * service (TimeoutStopSec), and past them it ends every process of the service itself. launchd
 * waits only as long as the job says (ExitTimeOut: 20 for Pelican's login item, 5 where unset),
 * then ends Pelican alone, and once Pelican has gone nothing would end them: see shutdownGrace.
 */
export const SHUTDOWN_GRACE_MS = 15_000;

/**
 * The time to tidy up, inside what launchd allows when it stops Pelican (`exitTimeoutS`, see
 * launchdExitTimeout): a second and a half before its end, for Pelican to end what is left and exit.
 */
export const shutdownGrace = (exitTimeoutS?: number) => (exitTimeoutS === undefined
  ? SHUTDOWN_GRACE_MS
  : Math.max(1000, Math.min(SHUTDOWN_GRACE_MS, exitTimeoutS * 1000 - 1500)));
/** How often it looks whether they have. */
const SHUTDOWN_LOOK_MS = 50;

const running = () => [...bySession.values()].flatMap((entries) => [...entries.values()]).filter((entry) => !entry.shell.done);

/** How many `!` commands are running now, in every session. */
export const runningShells = () => running().length;

/** The `!` commands running now, in every session, for what an update would end (update.ts). */
export const runningShellList = () => [...bySession].flatMap(([sessionId, entries]) => [...entries.values()]
  .filter((entry) => !entry.shell.done)
  .map((entry) => ({ sessionId, command: entry.shell.command, startedAt: entry.shell.startedAt })));

/** Ends at once what stopAllShells still gives time to: Pelican was told to stop again. */
export function hurryShells(): void {
  hurried = true;
}

/**
 * Pelican is shutting down: what still runs ends with it, as a `!` command ends with the CLI. Each
 * is asked to end (SIGTERM: a dev server or docker compose tidies up), unless it has been already
 * (`asked`: systemd stopping the service asks every process of it at once, and a second request
 * makes docker compose stop its containers in a hurry), and given time; then what is left of any
 * of them is made to (SIGKILL), while Pelican is still there to do it. Settles once nothing of
 * them runs.
 */
export async function stopAllShells(graceMs = SHUTDOWN_GRACE_MS, { asked = false } = {}): Promise<void> {
  shuttingDown = true;
  hurried = false;
  const entries = running();
  for (const entry of entries) entry.run.ask(!asked);
  const until = Date.now() + graceMs;
  const left = () => entries.some((entry) => entry.run.alive());
  while (!hurried && left() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, SHUTDOWN_LOOK_MS));
  for (const entry of entries) entry.run.kill();
  // Made to end, they are gone in a moment; that moment is waited for.
  const gone = Date.now() + 1000;
  while (left() && Date.now() < gone) await new Promise((resolve) => setTimeout(resolve, SHUTDOWN_LOOK_MS));
}
