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

/**
 * What waits above the message box to be put back, words and files: a message that came back from
 * a send that failed but could not share the box with what was there (a `!` or `/` command, or a
 * message beside one), or, `aside`, what was in the box when Put back put one of those in its
 * place, which was never sent.
 */
export type Held = { text: string; attachments?: Attachment[]; aside?: boolean };

/**
 * `quotes`: those waiting above the message box (lib/quote), which go above the words when sent.
 * `held`: what waits above the box to be put back.
 */
export type Draft = { text: string; attachments?: Attachment[]; quotes?: string[]; held?: Held[]; at: number };

/**
 * A message with its quotes above the words, as Claude reads it: each block apart from the next.
 * Here, with the drafts, which load with the first screen, rather than with the rest of lib/quote.
 */
export function messageWithQuotes(quotes: readonly string[], text: string): string {
  return [...quotes.map((q) => q.trim()), text.trim()].filter(Boolean).join('\n\n');
}

/**
 * The line comments waiting to go with a message (lib/review) are kept with the drafts, under a key
 * of their own: signing out takes them out of storage with the drafts, also in a page where
 * lib/review has not loaded, and lib/review, once loaded, forgets its copy in memory then too.
 */
export const COMMENTS_KEY = 'pelican:comments';
const forgetting = new Set<() => void>();
export function whenDraftsForgotten(forget: () => void): void {
  forgetting.add(forget);
}

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

/** The texts of a list kept in storage, without anything else that may be there. */
const texts = (list: unknown): string[] => (Array.isArray(list) ? list.filter((q): q is string => typeof q === 'string' && q.trim().length > 0) : []);

const isAttachment = (a: unknown): a is Attachment =>
  Boolean(a) && typeof a === 'object' && ['id', 'name', 'mime', 'path'].every((key) => typeof (a as Record<string, unknown>)[key] === 'string') && typeof (a as Attachment).size === 'number';

/**
 * What waits to be put back, as kept in storage, without anything else that may be there: words,
 * files, or both. A text alone is one kept by Pelican before waiting messages kept their files.
 */
const helds = (list: unknown): Held[] => (Array.isArray(list) ? list.flatMap((h: unknown) => {
  const entry = typeof h === 'string' ? { text: h } : h as Partial<Held> | null;
  if (!entry || typeof entry.text !== 'string') return [];
  const attachments = Array.isArray(entry.attachments) ? entry.attachments.filter(isAttachment) : [];
  if (!entry.text.trim() && attachments.length === 0) return [];
  return [{ text: entry.text, ...(attachments.length > 0 ? { attachments } : {}), ...(entry.aside === true ? { aside: true } : {}) }];
}) : []);

export function loadDraft(viewId: string): Draft | undefined {
  const draft = readAll()[viewId];
  if (!draft || typeof draft.text !== 'string') return undefined;
  const { quotes, held, ...rest } = draft;
  const keptQuotes = texts(quotes);
  const keptHeld = helds(held);
  return { ...rest, ...(keptQuotes.length > 0 ? { quotes: keptQuotes } : {}), ...(keptHeld.length > 0 ? { held: keptHeld } : {}) };
}

export function saveDraft(viewId: string, text: string, attachments: Attachment[] = [], quotes: string[] = [], held: Held[] = []): void {
  const all = readAll();
  if (!text.trim() && attachments.length === 0 && quotes.length === 0 && held.length === 0) {
    if (!(viewId in all)) return;
    delete all[viewId];
  } else {
    all[viewId] = {
      text: text.slice(0, MAX_TEXT),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(quotes.length > 0 ? { quotes: quotes.map((q) => q.slice(0, MAX_TEXT)) } : {}),
      ...(held.length > 0 ? { held: held.map((h) => ({ ...h, text: h.text.slice(0, MAX_TEXT) })) } : {}),
      at: Date.now(),
    };
  }
  writeAll(Object.fromEntries(Object.entries(all).sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0)).slice(0, KEEP)));
}

/**
 * Forgets a chat's draft once its message went through; with `sent`, only when the draft is still
 * that message, its quotes above its words (another may have been started while it was on its
 * way). A `!` command takes only the words: the quotes wait for a message. What waits to be put
 * back stays, unless the whole draft goes (`sent` left out).
 */
export function clearDraft(viewId: string, sent?: string): void {
  const all = readAll();
  const draft = all[viewId];
  if (!draft) return;
  const quotes = Array.isArray(draft.quotes) ? draft.quotes : [];
  const held = helds(draft.held);
  if (sent === undefined || messageWithQuotes(quotes, draft.text) === sent.trim()) {
    if (sent !== undefined && held.length > 0) all[viewId] = { text: '', held, at: draft.at };
    else delete all[viewId];
  } else if (quotes.length > 0 && draft.text.trim() === sent.trim()) all[viewId] = { ...draft, text: '' };
  else return;
  writeAll(all);
}

/** Takes a chat's draft to another: a new session's, when its folder is changed before it starts. */
export function moveDraft(from: string, to: string): void {
  const draft = loadDraft(from);
  if (!draft || from === to) return;
  clearDraft(from);
  saveDraft(to, draft.text, draft.attachments, draft.quotes, draft.held);
}

/** Signing out leaves no prompts behind in this browser, nor line comments waiting to go with one. */
export function forgetDrafts(): void {
  for (const key of [KEY, COMMENTS_KEY]) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Nothing was kept.
    }
  }
  for (const forget of forgetting) forget();
}

/**
 * Saves what is typed a moment after typing stops, and at once when the chat closes or the page
 * goes to the background (a phone may drop a background tab without warning). `now` saves at once:
 * a message on its way is its chat's draft until the send went through.
 */
type Saving = (text: string, attachments: Attachment[], quotes?: string[], held?: Held[]) => void;

export function useDraftSaver(viewId: string | undefined, wait = 300): { save: Saving; now: Saving } {
  const pending = useRef<{ text: string; attachments: Attachment[]; quotes: string[]; held: Held[] } | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const id = useRef(viewId);
  id.current = viewId;

  const saver = useRef({
    flush: () => {
      clearTimeout(timer.current);
      const next = pending.current;
      pending.current = undefined;
      if (next && id.current) saveDraft(id.current, next.text, next.attachments, next.quotes, next.held);
    },
    save: (text: string, attachments: Attachment[], quotes: string[] = [], held: Held[] = []) => {
      pending.current = { text, attachments, quotes, held };
      clearTimeout(timer.current);
      timer.current = setTimeout(saver.current.flush, wait);
    },
    now: (text: string, attachments: Attachment[], quotes: string[] = [], held: Held[] = []) => {
      pending.current = { text, attachments, quotes, held };
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
