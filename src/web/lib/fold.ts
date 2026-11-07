import type { SessionSummary } from '../../shared/protocol';

/** One row in the session list: a session, with the earlier ones folded into it. */
export type Entry = { session: SessionSummary; earlier: SessionSummary[] };

export const single = (session: SessionSummary): Entry => ({ session, earlier: [] });
export const foldKey = (s: SessionSummary) => `${s.cwd}\u0000${s.title.trim()}`;

/** Working, waiting, or between turns with background tasks still running: the list's Active group. */
export const isActive = (s: SessionSummary): boolean => s.status !== 'idle' || (s.tasks ?? 0) > 0;

/**
 * Sessions in the same folder with the same title fold into the newest: a scheduled task's
 * runs, or the branches of a session named once, are one row with the earlier ones a tap
 * away. One that is active (working, waiting, or with background tasks) is never folded, and
 * takes none of the earlier ones. One that is pinned is never folded into another either: it
 * leads a row of its own, at the top of the list, and the earlier ones fold into it, whatever
 * its status. Expects the newest first.
 */
export function fold(sessions: SessionSummary[]): Entry[] {
  const out: Entry[] = [];
  const byKey = new Map<string, Entry>();
  for (const s of sessions) {
    const active = isActive(s);
    const entry = byKey.get(foldKey(s));
    if (entry && !active && !s.pinned) {
      entry.earlier.push(s);
      continue;
    }
    const fresh = single(s);
    if (!active || s.pinned) byKey.set(foldKey(s), fresh);
    out.push(fresh);
  }
  return out;
}
