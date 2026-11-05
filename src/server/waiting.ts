import { config } from './config.js';
import { sessionsChanged } from './feed.js';
import { type LiveProcess, liveProcesses, registry } from './live.js';
import { notify } from './push.js';
import { sessionInfo, sessionTitle } from './sessions.js';

/**
 * How long Claude waits in another app before the phone hears of it. Someone at the keyboard
 * usually answers first; Claude Code itself waits a few seconds before its own notification.
 */
export const NOTIFY_AFTER_MS = 20_000;
const POLL_MS = 5_000;

/** Sessions waiting for an answer in another app, from when, and whether the phone was told. */
const waits = new Map<string, { since: number; told: boolean }>();

/** Claude Code's words for what it waits for, said the way a notification says it. */
function what(waiting: string): string {
  if (/permission|sandbox|worker/.test(waiting)) return 'is asking for permission';
  if (/input/.test(waiting)) return 'needs your input';
  return 'is waiting for you';
}

async function tell(sessionId: string, process: LiveProcess): Promise<void> {
  const info = await sessionInfo(sessionId).catch(() => undefined);
  await notify({
    title: (info && sessionTitle(info)) || 'Claude Code',
    body: `Claude ${what(process.waiting ?? '')} in ${process.app ?? 'another app'}`,
    sessionId,
    // The same tag as this app's own questions: one notification per session, the latest.
    tag: `${sessionId}:ask`,
  });
}

/**
 * Looks at what other apps' sessions are doing: one that starts or stops waiting for an answer
 * changes the lists at once, and one still waiting after a while sends one notification.
 */
export async function checkWaiting(now = Date.now()): Promise<void> {
  // Reading the registry is cheap; asking which processes are whose (ps) only when something waits.
  if (waits.size === 0 && !(await registry()).some((entry) => entry.status === 'waiting')) return;
  const live = await liveProcesses();
  let changed = false;
  for (const [sessionId, process] of live) {
    if (!process.waiting) continue;
    let wait = waits.get(sessionId);
    if (!wait) {
      wait = { since: Math.min(process.waitingSince ?? now, now), told: false };
      waits.set(sessionId, wait);
      changed = true;
    }
    if (!wait.told && now - wait.since >= NOTIFY_AFTER_MS) {
      wait.told = true;
      void tell(sessionId, process).catch((error: Error) => console.warn('[pelican] could not notify', error.message));
    }
  }
  for (const sessionId of [...waits.keys()]) {
    if (live.get(sessionId)?.waiting) continue;
    // Answered, or the app closed: the next wait is told of again.
    waits.delete(sessionId);
    changed = true;
  }
  if (changed) sessionsChanged();
}

/** Keeps looking every few seconds while the server runs; returns how to stop. */
export function watchWaiting(): () => void {
  if (config.demo) return () => {};
  let checking = false;
  const timer = setInterval(() => {
    if (checking) return;
    checking = true;
    void checkWaiting().catch(() => undefined).finally(() => {
      checking = false;
    });
  }, POLL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
