import { useEffect, useRef } from 'react';

import type { Attachment } from '../../shared/protocol';

/**
 * Half-written messages, one per chat (a session, or a new session in a folder), kept in this
 * browser: looking at another session, going back to the list or reloading loses nothing. A
 * draft goes once its message has been sent, not when the box empties, so a send that fails
 * leaves it where it was.
 */
const KEY = 'pelican:drafts';
/** Plenty for the chats anyone is in the middle of; the oldest go first. */
const KEEP = 50;
const MAX_TEXT = 100_000;

export type Draft = { text: string; attachments?: Attachment[]; at: number };

function readAll(): Record<string, Draft> {
  try {
    const raw = localStorage.getItem(KEY);
    const all = raw ? (JSON.parse(raw) as unknown) : {};
    return all && typeof all === 'object' ? (all as Record<string, Draft>) : {};
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, Draft>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Private mode or full: the draft lives as long as the page.
  }
}

export function loadDraft(viewId: string): Draft | undefined {
  const draft = readAll()[viewId];
  return draft && typeof draft.text === 'string' ? draft : undefined;
}

export function saveDraft(viewId: string, text: string, attachments: Attachment[] = []): void {
  const all = readAll();
  if (!text.trim() && attachments.length === 0) {
    if (!(viewId in all)) return;
    delete all[viewId];
  } else {
    all[viewId] = { text: text.slice(0, MAX_TEXT), ...(attachments.length > 0 ? { attachments } : {}), at: Date.now() };
  }
  writeAll(Object.fromEntries(Object.entries(all).sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0)).slice(0, KEEP)));
}

/**
 * Forgets a chat's draft once its message went through; with `sent`, only when the draft is still
 * that message (another may have been started while it was on its way).
 */
export function clearDraft(viewId: string, sent?: string): void {
  const all = readAll();
  const draft = all[viewId];
  if (!draft || (sent !== undefined && draft.text.trim() !== sent.trim())) return;
  delete all[viewId];
  writeAll(all);
}

/** Signing out leaves no prompts behind in this browser. */
export function forgetDrafts(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing was kept.
  }
}

/**
 * Saves what is typed a moment after typing stops, and at once when the chat closes or the page
 * goes to the background (a phone may drop a background tab without warning). `now` saves at once:
 * a message on its way is its chat's draft until the send went through.
 */
export function useDraftSaver(viewId: string | undefined, wait = 300): { save: (text: string, attachments: Attachment[]) => void; now: (text: string, attachments: Attachment[]) => void } {
  const pending = useRef<{ text: string; attachments: Attachment[] } | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const id = useRef(viewId);
  id.current = viewId;

  const saver = useRef({
    flush: () => {
      clearTimeout(timer.current);
      const next = pending.current;
      pending.current = undefined;
      if (next && id.current) saveDraft(id.current, next.text, next.attachments);
    },
    save: (text: string, attachments: Attachment[]) => {
      pending.current = { text, attachments };
      clearTimeout(timer.current);
      timer.current = setTimeout(saver.current.flush, wait);
    },
    now: (text: string, attachments: Attachment[]) => {
      pending.current = { text, attachments };
      saver.current.flush();
    },
  });

  useEffect(() => {
    const { flush } = saver.current;
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, []);

  return saver.current;
}
