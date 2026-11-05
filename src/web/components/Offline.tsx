import { type QueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { api, useReachable } from '../lib/api';
import { socket } from '../lib/socket';

/** A phone waking up reconnects within this; only a longer gap is worth a word. */
const GRACE_MS = 3000;
const PROBE_MS = 5000;

/** unreachable: requests fail too (asleep, offline) · stale: requests work, live updates do not. */
export type Offline = 'unreachable' | 'stale' | undefined;

/** Whether the computer answers, and whether live updates arrive. */
export function useOffline(): Offline {
  const reachable = useReachable();
  const [connected, setConnected] = useState(socket.connected);
  const [down, setDown] = useState(false);
  useEffect(() => socket.onConnection(setConnected), []);
  useEffect(() => {
    if (connected) {
      setDown(false);
      return undefined;
    }
    const timer = setTimeout(() => setDown(true), GRACE_MS);
    return () => clearTimeout(timer);
  }, [connected]);
  // While something is down, ask the server now and then, so the words say which.
  useEffect(() => {
    if (!down && reachable) return undefined;
    void api.probe();
    const timer = setInterval(() => void api.probe(), PROBE_MS);
    return () => clearInterval(timer);
  }, [down, reachable]);
  if (!reachable) return 'unreachable';
  return down ? 'stale' : undefined;
}

/** Tries again now: the live connection, and whatever failed to load. */
export function retryNow(queryClient: QueryClient): void {
  socket.reconnect();
  void api.probe();
  void queryClient.invalidateQueries();
}

export const offlineWords = (state: NonNullable<Offline>, machine?: string) =>
  (state === 'unreachable' ? `Can’t reach ${machine || 'your computer'}.` : 'Live updates stopped.');

/** One quiet line under a header while the computer cannot be reached, with a way to try now. */
export function OfflineLine({ state, machine, onRetry }: { state: Offline; machine?: string; onRetry: () => void }) {
  if (!state) return null;
  return (
    <div className="flex shrink-0 items-center gap-2 px-4 py-1 text-[12.5px] text-muted">
      <span className="min-w-0 flex-1 truncate">{offlineWords(state, machine)} Retrying…</span>
      <button type="button" onClick={onRetry} className="relative h-7 shrink-0 rounded-full px-2.5 font-medium text-fg after:absolute after:-inset-x-1 after:-inset-y-2 hover:bg-hover">
        Retry
      </button>
    </div>
  );
}
