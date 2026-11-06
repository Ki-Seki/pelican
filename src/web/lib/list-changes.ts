import type { QueryClient } from '@tanstack/react-query';

import type { SessionSummary } from '../../shared/protocol';
import { api } from './api';

/**
 * Pinning or archiving a session, or bringing it back from either: what only Pelican keeps of a
 * session, and only the list shows.
 */
export type ListChange = { pinned: boolean } | { archived: boolean };

type Marks = Pick<SessionSummary, 'pinned' | 'archived'>;

/** The session with the pin and archive `from` has, the rest as it is. */
function marked(session: SessionSummary, from: Marks): SessionSummary {
  const { pinned: _pinned, archived: _archived, ...rest } = session;
  return { ...rest, ...(from.pinned ? { pinned: true } : {}), ...(from.archived ? { archived: true } : {}) };
}

/** The session once changed, as the server keeps it: pinned or archived, never both. */
export const changed = (session: SessionSummary, change: ListChange): SessionSummary => marked(session, 'pinned' in change
  ? { pinned: change.pinned, archived: Boolean(session.archived) && !change.pinned }
  : { archived: change.archived, pinned: Boolean(session.pinned) && !change.archived });

/** What puts a change back: a pinned session that was archived is pinned again, which brings it back too. */
export const undoOf = (before: SessionSummary, change: ListChange): ListChange => ('pinned' in change ? { pinned: !change.pinned }
  : change.archived && before.pinned ? { pinned: true } : { archived: !change.archived });

/** What a change is called, on the line that offers Undo and to a screen reader. */
export const changeWords = (change: ListChange) =>
  ('pinned' in change ? (change.pinned ? 'Pinned' : 'Unpinned') : change.archived ? 'Archived' : 'Unarchived');

/**
 * Shows a change at once, in the list and on the session's own page, then makes it on the server;
 * what was shown is put back if the server says no (and the error thrown).
 */
export async function makeChange(queryClient: QueryClient, session: SessionSummary, change: ListChange): Promise<void> {
  const detail = ['session', session.id];
  const show = (as: Marks) => {
    queryClient.setQueryData<SessionSummary[]>(['sessions'], (list) => list?.map((s) => (s.id === session.id ? marked(s, as) : s)));
    queryClient.setQueryData<{ session: SessionSummary | null }>(detail, (page) => (page?.session ? { ...page, session: marked(page.session, as) } : page));
  };
  // A list or page on its way would show it as it was.
  void queryClient.cancelQueries({ queryKey: ['sessions'] });
  void queryClient.cancelQueries({ queryKey: detail });
  show(changed(session, change));
  try {
    await ('pinned' in change ? api.pin(session.id, change.pinned) : api.archive(session.id, change.archived));
  } catch (error) {
    show(session);
    throw error;
  } finally {
    void queryClient.invalidateQueries({ queryKey: ['sessions'] });
    void queryClient.invalidateQueries({ queryKey: detail });
  }
}
