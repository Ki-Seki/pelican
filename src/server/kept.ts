import { archivedIds, setArchived } from './archive.js';
import { pinnedIds, setPinned } from './pinned.js';

/** What Pelican alone keeps of sessions, for its list: which are archived, and which pinned. */
export type Kept = { archived: Set<string>; pinned: Set<string> };

export async function kept(): Promise<Kept> {
  const [archived, pinned] = await Promise.all([archivedIds(), pinnedIds()]);
  return { archived, pinned };
}

/** Pinning or archiving a session, or bringing it back from either. */
export type Change = { pinned: boolean } | { archived: boolean };

let changing: Promise<unknown> = Promise.resolve();

/** Changes go one at a time, each with all of its writes. */
function queued(work: () => Promise<void>): Promise<void> {
  const run = changing.then(work);
  changing = run.catch(() => undefined);
  return run;
}

/**
 * Makes a change, keeping a session pinned or archived, never both: archiving unpins it, and a
 * pin brings an archived session back (Undo, after archiving a pinned one). A session archived and
 * pinned at once, as only a version without pins leaves one (0.4.0 archived a pinned session and
 * kept its pin), was archived last: unarchived, it comes back unpinned. Should the second write
 * fail, the first is taken back, so the session stays as it was.
 */
export function keep(sessionId: string, change: Change): Promise<void> {
  const pinning = 'pinned' in change;
  const on = pinning ? change.pinned : change.archived;
  const [set, unset] = pinning ? [setPinned, setArchived] : [setArchived, setPinned];
  return queued(async () => {
    const { archived, pinned } = await kept();
    const was = (pinning ? pinned : archived).has(sessionId);
    const other = (pinning ? archived : pinned).has(sessionId);
    await set(sessionId, on);
    const both = !pinning && !on && was && other;
    if (!other || (!on && !both)) return;
    try {
      await unset(sessionId, false);
    } catch (error) {
      await set(sessionId, was).catch(() => undefined);
      throw error;
    }
  });
}

/** A deleted session's pin or archive goes with it. */
export function forget(sessionId: string): Promise<void> {
  return queued(async () => {
    const { archived, pinned } = await kept();
    if (archived.has(sessionId)) await setArchived(sessionId, false);
    if (pinned.has(sessionId)) await setPinned(sessionId, false);
  });
}
