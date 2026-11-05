import type { SessionSummary } from '../../shared/protocol';

/** Where a new session runs: a folder, or a new one in ~/scratch, made when the first message is sent. */
export type Start = { cwd: string } | { scratch: true };

/** The route of a new session; without a place, the page that asks for one. */
export function newSessionQuery(start?: Start): string {
  if (!start) return '?new';
  return 'scratch' in start ? '?new&scratch' : `?new&cwd=${encodeURIComponent(start.cwd)}`;
}

/**
 * Where + starts a session, so it opens ready to type: the folder of the newest session in the
 * project the list is showing, else of the newest session anywhere. Scratch, temporary and
 * archived sessions do not count. Nothing before the first session: then the folder is asked for.
 */
export function defaultStart(sessions: readonly SessionSummary[], project?: string): Start | undefined {
  let newest: SessionSummary | undefined;
  let newestInProject: SessionSummary | undefined;
  for (const s of sessions) {
    if (!s.cwd || s.scratch || s.temp || s.archived) continue;
    if (!newest || s.lastActivity > newest.lastActivity) newest = s;
    if (project && s.project === project && (!newestInProject || s.lastActivity > newestInProject.lastActivity)) newestInProject = s;
  }
  const found = newestInProject ?? newest;
  return found ? { cwd: found.cwd } : undefined;
}
