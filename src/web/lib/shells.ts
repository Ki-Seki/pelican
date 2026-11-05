import { useSyncExternalStore } from 'react';

import type { LiveShell, ServerEvent } from '../../shared/protocol';
import { socket } from './socket';

/**
 * The `!` commands running in each session, as the server tells of them: the whole list when one
 * starts, stops or ends (and on every subscribe), and what they print as it comes.
 */
const bySession = new Map<string, LiveShell[]>();
/** Commands seen to end: a late answer from starting one must not bring it back. */
const ended = new Set<string>();
const listeners = new Set<() => void>();
const NONE: LiveShell[] = [];

function set(sessionId: string, shells: LiveShell[]): void {
  if (shells.length > 0) bySession.set(sessionId, shells);
  else bySession.delete(sessionId);
  for (const listener of listeners) listener();
}

function noteEnded(before: LiveShell[], after: LiveShell[]): void {
  for (const shell of before) if (!after.some((s) => s.id === shell.id)) ended.add(shell.id);
  // A few hundred are plenty to outlast any answer still on its way.
  for (const id of ended) {
    if (ended.size <= 200) break;
    ended.delete(id);
  }
}

export function handleShellEvent(event: ServerEvent): void {
  if (event.type === 'shells') {
    noteEnded(bySession.get(event.sessionId) ?? NONE, event.shells);
    set(event.sessionId, event.shells);
  } else if (event.type === 'shell_output') {
    const shells = bySession.get(event.sessionId);
    const shell = shells?.find((s) => s.id === event.id);
    // A copy that does not end where this goes missed something: the whole list again.
    if (!shells || !shell || shell.output.length !== event.from) {
      socket.refresh(event.sessionId);
      return;
    }
    set(event.sessionId, shells.map((s) => (s === shell ? { ...s, output: s.output + event.text } : s)));
  }
}

/** A command this page just started: shown before the server's own word on it arrives. */
export function addShell(sessionId: string, shell: LiveShell): void {
  const shells = bySession.get(sessionId) ?? NONE;
  if (ended.has(shell.id) || shells.some((s) => s.id === shell.id)) return;
  set(sessionId, [...shells, shell]);
}

/** Stop was asked for here: the command says so at once. */
export function markStopping(sessionId: string, id: string): void {
  const shells = bySession.get(sessionId);
  if (shells?.some((s) => s.id === id)) set(sessionId, shells.map((s) => (s.id === id ? { ...s, stopping: true } : s)));
}

export function useLiveShells(sessionId: string | undefined): LiveShell[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => (sessionId ? bySession.get(sessionId) ?? NONE : NONE),
  );
}

socket.on(handleShellEvent);
