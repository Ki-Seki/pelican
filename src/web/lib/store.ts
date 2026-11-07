import { useCallback, useSyncExternalStore } from 'react';

import type { ChatMessage, PartialAppend, PartialBlock, Rewound, RunState, ServerEvent } from '../../shared/protocol';
import { api, onReachable } from './api';
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
  /** The conversation was rewound here (Rewind to here) and ends before that prompt, until the next message. */
  rewound?: Rewound;
};

const EMPTY: SessionView = { messages: [], offset: 0, total: 0, loaded: false, loadingOlder: false };

const views = new Map<string, SessionView>();
const listeners = new Map<string, Set<() => void>>();

/** Sessions shown before, newest last: their views stay, so going back is instant; older ones go. */
const KEEP_VIEWS = 5;
const left: string[] = [];

/** A session no longer on screen keeps its view for a while; views beyond the last few are let go. */
function leave(sessionId: string): void {
  // Unsubscribed with it: until the socket answers again, a page load says what runs.
  heard.delete(sessionId);
  const at = left.indexOf(sessionId);
  if (at >= 0) left.splice(at, 1);
  left.push(sessionId);
  while (left.length > KEEP_VIEWS) {
    const old = left.shift()!;
    if ((listeners.get(old)?.size ?? 0) === 0) views.delete(old);
  }
}

function update(sessionId: string, change: (view: SessionView) => SessionView): void {
  views.set(sessionId, change(views.get(sessionId) ?? EMPTY));
  for (const listener of listeners.get(sessionId) ?? []) listener();
}

export function getView(sessionId: string): SessionView {
  return views.get(sessionId) ?? EMPTY;
}

export function useSessionView(sessionId: string | undefined): SessionView {
  // The same function while the session is the same: React subscribes again whenever it changes.
  const subscribe = useCallback((listener: () => void) => {
    if (!sessionId) return () => {};
    let set = listeners.get(sessionId);
    if (!set) {
      set = new Set();
      listeners.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) leave(sessionId);
    };
  }, [sessionId]);
  return useSyncExternalStore(subscribe, () => (sessionId ? getView(sessionId) : EMPTY));
}

/**
 * Adds messages that are new, and replaces local copies the server confirmed. A
 * message can come back under a new id with the sender's in `sourceUuid` (one
 * read mid-turn); it replaces the copy with that id. A local copy never
 * replaces a confirmed one.
 */
export function merge(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
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

/**
 * The messages before the prompt a rewind went back to before: those from it on are out of the
 * conversation. A prompt the page has not loaded is older than all it holds (it loaded the newest
 * page), which then all goes, but what it sent that the server has not confirmed: the page is read
 * again.
 */
function beforeCut(messages: ChatMessage[], rewound: Rewound | undefined): ChatMessage[] {
  if (!rewound) return messages;
  const at = messages.findIndex((m) => m.uuid === rewound.prompt || m.sourceUuid === rewound.prompt);
  return at < 0 ? messages.filter((m) => m.pending) : messages.slice(0, at);
}

/** Loads (or reloads) the newest page; local messages the server has not confirmed yet stay. */
export async function loadLatest(sessionId: string): Promise<void> {
  try {
    const page = await api.messages(sessionId);
    update(sessionId, (current) => {
      // Rewound: what the page held from the prompt on is out of the conversation, not news to keep.
      const view = page.rewound ? { ...current, messages: beforeCut(current.messages, page.rewound) } : current;
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
        rewound: page.rewound,
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

/**
 * The conversation was rewound (Rewind to here), or is not any more (`undefined`: Undo rewind, the
 * next message): the view shows it up to the prompt it went back to before, at once, and reads it
 * again; after Undo the messages come back.
 */
export function setRewound(sessionId: string, rewound: Rewound | undefined): Promise<void> {
  update(sessionId, (view) => {
    const messages = beforeCut(view.messages, rewound);
    return { ...view, messages, total: Math.max(0, view.total - (view.messages.length - messages.length)), rewound };
  });
  return loadLatest(sessionId);
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

/**
 * Sessions whose run the live socket has answered for since it connected. From then on the socket
 * says what runs; a page load read earlier could bring back a run that has ended since.
 */
const heard = new Set<string>();

export function setRun(sessionId: string, run: RunState | undefined): void {
  const view = views.get(sessionId);
  if (!run && !view?.run) return;
  const wasBusy = Boolean(view?.run?.busy);
  // What the server queued for the end of the turn waits above the message box, not in the
  // conversation: a copy this page showed as sent, Claude seeming idle to it, goes until Claude gets it.
  const queued = new Set(run?.queued?.map((prompt) => prompt.uuid));
  update(sessionId, (v) => ({ ...v, run, ...(v.messages.some((m) => m.pending && queued.has(m.uuid)) ? { messages: v.messages.filter((m) => !(m.pending && queued.has(m.uuid))) } : {}) }));
  // A finished turn, or a run that is gone: re-read the transcript, so anything published before
  // this page subscribed (the first prompt of a new session) is confirmed too.
  if (wasBusy && !run?.busy) void loadLatest(sessionId);
}

/** The run as loading the session saw it (null: none). Used only until the socket has answered. */
export function syncRun(sessionId: string, run: RunState | null): void {
  if (!heard.has(sessionId)) setRun(sessionId, run ?? undefined);
}

const textOf = (block: PartialBlock) => (block.type === 'text' ? block.text : block.type === 'thinking' ? block.thinking : block.inputJson);

function appended(block: PartialBlock, text: string): PartialBlock {
  if (block.type === 'text') return { ...block, text: block.text + text };
  if (block.type === 'thinking') return { ...block, thinking: block.thinking + text };
  return { ...block, inputJson: block.inputJson + text };
}

/** Streamed text added to the run's blocks; a copy that does not match asks for the whole run again. */
function applyAppends(sessionId: string, appends: PartialAppend[]): void {
  const run = views.get(sessionId)?.run;
  const partial = run?.partial.slice();
  for (const { index, from, text } of appends) {
    const block = partial?.[index];
    if (!partial || !block || textOf(block).length !== from) {
      socket.refresh(sessionId);
      return;
    }
    partial[index] = appended(block, text);
  }
  if (run && partial) update(sessionId, (view) => ({ ...view, run: { ...run, partial } }));
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
        // One the page read from the transcript already stays: a copy sent again (to a page that
        // subscribed late) would bring its pictures back as data, or as not shown, and count it twice.
        update(event.sessionId, (view) => (view.messages.some((m) => m.uuid === event.message.uuid && !m.pending)
          ? view
          : { ...view, messages: merge(view.messages, [event.message]), total: view.total + 1 }));
      }
      break;
    case 'run': {
      const sessionId = event.state?.sessionId ?? event.sessionId;
      if (!sessionId) break;
      heard.add(sessionId);
      setRun(sessionId, event.state ?? undefined);
      break;
    }
    case 'partial':
      applyAppends(event.sessionId, event.appends);
      break;
    case 'reload':
      void loadLatest(event.sessionId);
      break;
    case 'rewound':
      if (views.has(event.sessionId)) void setRewound(event.sessionId, event.rewound ?? undefined);
      break;
    default:
      break;
  }
}

socket.on(handleEvent);

// A new connection answers for every session again.
socket.onConnection(() => heard.clear());

/** After connecting, and on coming back to the page, catch up on whatever was missed. */
socket.onResync(() => {
  for (const sessionId of listeners.keys()) {
    if ((listeners.get(sessionId)?.size ?? 0) > 0) void loadLatest(sessionId);
  }
});

/**
 * Back in reach after requests failed while the socket stayed up (a proxy's 502, 503 or 504 for
 * one slow request): a conversation that could not load then loads now, as no resync comes.
 */
onReachable((reachable) => {
  if (!reachable) return;
  for (const sessionId of listeners.keys()) {
    if ((listeners.get(sessionId)?.size ?? 0) > 0 && getView(sessionId).error) void loadLatest(sessionId);
  }
});
