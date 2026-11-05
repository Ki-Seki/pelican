import type { SessionSummary } from '../../shared/protocol';

/** One row in the session list: a session, with the earlier ones folded into it. */
export type Entry = { session: SessionSummary; earlier: SessionSummary[] };

export const single = (session: SessionSummary): Entry => ({ session, earlier: [] });

/** Working, waiting, or between turns with background tasks still running: the list's Active group. */
export const isActive = (s: SessionSummary): boolean => s.status !== 'idle' || (s.tasks ?? 0) > 0;
export const foldKey = (s: SessionSummary) => `${s.cwd}\u0000${s.title.trim()}`;

/**
 * Sessions in the same folder with the same title fold into the newest: a scheduled task's
 * runs, or the branches of a session named once, are one row with the earlier ones a tap
 * away. One that is active (working, waiting, or with background tasks) is never folded.
 * Expects the newest first.
 */
export function fold(sessions: SessionSummary[]): Entry[] {
  const out: Entry[] = [];
  const byKey = new Map<string, Entry>();
  for (const s of sessions) {
    if (isActive(s)) {
      out.push(single(s));
      continue;
    }
    const entry = byKey.get(foldKey(s));
    if (entry) {
      entry.earlier.push(s);
      continue;
    }
    const fresh = single(s);
    byKey.set(foldKey(s), fresh);
    out.push(fresh);
  }
  return out;
}
