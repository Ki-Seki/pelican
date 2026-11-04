import { useSyncExternalStore } from 'react';

import type { ChatMessage, RunState, ServerEvent } from '../../shared/protocol';
import { api } from './api';
import { socket } from './socket';

export type SessionView = {
  messages: ChatMessage[];
  /** Index of `messages[0]` in the whole conversation; older pages load from here. */
  offset: number;
  total: number;
  loaded: boolean;
  loadingOlder: boolean;
  run?: RunState;
  error?: string;
};

const EMPTY: SessionView = { messages: [], offset: 0, total: 0, loaded: false, loadingOlder: false };

const views = new Map<string, SessionView>();
const listeners = new Map<string, Set<() => void>>();

function update(sessionId: string, change: (view: SessionView) => SessionView): void {
  views.set(sessionId, change(views.get(sessionId) ?? EMPTY));
  for (const listener of listeners.get(sessionId) ?? []) listener();
}

export function getView(sessionId: string): SessionView {
  return views.get(sessionId) ?? EMPTY;
}

export function useSessionView(sessionId: string | undefined): SessionView {
  return useSyncExternalStore(
    (listener) => {
      if (!sessionId) return () => {};
      let set = listeners.get(sessionId);
      if (!set) {
        set = new Set();
        listeners.set(sessionId, set);
      }
      set.add(listener);
      return () => set.delete(listener);
    },
    () => (sessionId ? getView(sessionId) : EMPTY),
  );
}

/**
 * Adds messages that are new, and replaces local copies the server confirmed. A
 * message can come back under a new id with the sender's in `sourceUuid` (one
 * read mid-turn); it replaces the copy with that id. A local copy never
 * replaces a confirmed one.
 */
function merge(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const index = new Map<string, number>();
  const note = (message: ChatMessage, at: number) => {
    index.set(message.uuid, at);
    if (message.sourceUuid) index.set(message.sourceUuid, at);
  };
  existing.forEach(note);
  const next = existing.slice();
  for (const message of incoming) {
    const at = index.get(message.uuid) ?? (message.sourceUuid ? index.get(message.sourceUuid) : undefined);
    if (at === undefined) {
      note(message, next.length);
      next.push(message);
    } else if (!(message.pending && !next[at]!.pending)) {
      next[at] = message;
      note(message, at);
    }
  }
  return next;
}

/** Loads (or reloads) the newest page; local messages the server has not confirmed yet stay. */
export async function loadLatest(sessionId: string): Promise<void> {
  try {
    const page = await api.messages(sessionId);
    update(sessionId, (view) => {
      // Keep what the page cannot know yet: messages that arrived over the socket
      // after the page was read, and local copies the server has not confirmed.
      const inPage = new Set(page.messages.flatMap((m) => (m.sourceUuid ? [m.uuid, m.sourceUuid] : [m.uuid])));
      const lastInPage = page.messages.at(-1)?.timestamp ?? 0;
      const pending = view.messages.filter((m) => m.pending && !inPage.has(m.uuid));
      const newer = view.messages.filter((m) => !m.pending && !inPage.has(m.uuid) && (m.timestamp ?? 0) > lastInPage);
      // Older pages already scrolled through stay, when they join up with this one.
      const joinsAt = page.messages[0] ? view.messages.findIndex((m) => m.uuid === page.messages[0]!.uuid) : -1;
      const head = joinsAt > 0 ? view.messages.slice(0, joinsAt).filter((m) => !m.pending) : [];
      return {
        ...view,
        messages: merge(merge([...head, ...page.messages], newer), pending),
        offset: Math.max(0, page.offset - head.length),
        total: page.total,
        loaded: true,
        error: undefined,
      };
    });
  } catch (error) {
    update(sessionId, (view) => ({ ...view, loaded: true, error: (error as Error).message }));
  }
}

export async function loadOlder(sessionId: string): Promise<void> {
  const view = getView(sessionId);
  if (view.loadingOlder || view.offset === 0) return;
  update(sessionId, (v) => ({ ...v, loadingOlder: true }));
  try {
    const page = await api.messages(sessionId, view.offset);
    update(sessionId, (v) => ({
      ...v,
      messages: merge(page.messages, v.messages),
      offset: page.offset,
      loadingOlder: false,
    }));
  } catch {
    update(sessionId, (v) => ({ ...v, loadingOlder: false }));
  }
}

export function addLocalMessage(sessionId: string, message: ChatMessage): void {
  update(sessionId, (view) => ({ ...view, messages: merge(view.messages, [message]), loaded: true }));
}

/** Drops a local message the server never accepted. */
export function removeLocalMessage(sessionId: string, uuid: string): void {
  update(sessionId, (view) => ({ ...view, messages: view.messages.filter((m) => !(m.pending && m.uuid === uuid)) }));
}

export type Draft = { text: string; note?: string };
const drafts = new Map<string, Draft>();

/** Text for the composer of a chat about to open, such as a prompt being edited. */
export function setDraft(viewId: string, draft: Draft): void {
  drafts.set(viewId, draft);
}

export function getDraft(viewId: string): Draft | undefined {
  return drafts.get(viewId);
}

export function clearDraft(viewId: string): void {
  drafts.delete(viewId);
}

export function setRun(sessionId: string, run: RunState | undefined): void {
  update(sessionId, (view) => ({ ...view, run }));
}

/** Moves the optimistic first message of a new session to the id the server gave it. */
export function adoptView(fromId: string, toId: string): void {
  const view = views.get(fromId);
  if (!view) return;
  update(toId, (target) => ({ ...target, messages: merge(target.messages, view.messages), loaded: true }));
  views.delete(fromId);
}

export function handleEvent(event: ServerEvent): void {
  switch (event.type) {
    case 'message':
      if (views.has(event.sessionId)) {
        update(event.sessionId, (view) => ({ ...view, messages: merge(view.messages, [event.message]), total: view.total + 1 }));
      }
      break;
    case 'run': {
      const wasBusy = Boolean(views.get(event.state.sessionId)?.run?.busy);
      update(event.state.sessionId, (view) => ({ ...view, run: event.state }));
      // A finished turn: re-read the transcript, so anything published before this
      // page subscribed (the first prompt of a new session) is confirmed too.
      if (wasBusy && !event.state.busy) void loadLatest(event.state.sessionId);
      break;
    }
    case 'reload':
      void loadLatest(event.sessionId);
      break;
    default:
      break;
  }
}

socket.on(handleEvent);

/** After a reconnect, catch up on whatever was missed while offline. */
socket.onConnection((connected) => {
  if (!connected) return;
  for (const sessionId of listeners.keys()) {
    if ((listeners.get(sessionId)?.size ?? 0) > 0) void loadLatest(sessionId);
  }
});
