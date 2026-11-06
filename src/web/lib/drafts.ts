import { useEffect, useRef, useSyncExternalStore } from 'react';

import type { Attachment } from '../../shared/protocol';
import { readPrompt } from '../../shared/quoted';
import { newId } from './ids';
import type { QuoteFrom, WaitingItem } from './quote';
import { capQuote, maskSecrets } from './sanitize';

/**
 * Half-written messages, one per chat (a session, or a new session in a folder), kept in this
 * browser: looking at another session, going back to the list or reloading loses nothing. A
 * draft's words go once its message has been sent, not when the box empties, so a send that fails
 * leaves them where they were. What waits to go with the next message (quotes, notes, line
 * comments, files: lib/quote) is kept with the draft too, and leaves it as a message takes it.
 */
const KEY = 'pelican:drafts';
/** Plenty for the chats anyone is in the middle of; the oldest go first. */
const KEEP = 50;
const MAX_TEXT = 100_000;
/** More than anyone has waiting; past it, the oldest go. */
const KEEP_ITEMS = 200;

/**
 * What waits above the message box to be put back, words and files: a message that came back from
 * a send that failed but could not share the box with what was there (a `!` or `/` command, or a
 * message beside one), or, `aside`, what was in the box when Put back put one of those in its
 * place, which was never sent.
 */
export type Held = { text: string; attachments?: Attachment[]; aside?: boolean };

/** `items`: what waits above the box for the next message. `held`: what waits there to be put back. */
export type Draft = { text: string; attachments?: Attachment[]; items?: WaitingItem[]; held?: Held[]; at: number };

/**
 * Line comments waiting to go with a message were kept apart before 0.5.0, under a key of their
 * own; they move in with the drafts once. Signing out takes the key out of storage too.
 */
export const COMMENTS_KEY = 'pelican:comments';
const forgetting = new Set<() => void>();
export function whenDraftsForgotten(forget: () => void): void {
  forgetting.add(forget);
}

type Stored = Omit<Draft, 'items'> & { items?: unknown; quotes?: unknown };

function readAll(): Record<string, Stored> {
  try {
    const raw = localStorage.getItem(KEY);
    const all = raw ? (JSON.parse(raw) as unknown) : {};
    return all && typeof all === 'object' ? (all as Record<string, Stored>) : {};
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, Stored>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(Object.entries(all).sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0)).slice(0, KEEP))));
  } catch {
    // Private mode or full: the draft lives as long as the page.
  }
}

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

const WHATS = new Set<QuoteFrom['what']>(['reply', 'prompt', 'step', 'side', 'file', 'diff', 'terminal', 'earlier']);
const SIDES = new Set(['add', 'del', 'same']);
const isLines = (lines: unknown): lines is [number, number] => Array.isArray(lines) && lines.length === 2 && lines.every((n) => Number.isInteger(n) && n > 0);

/** A waiting item as kept in storage, checked field by field: anything else there is left out. */
function itemOf(value: unknown): WaitingItem | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || typeof v.text !== 'string' || !['quote', 'file', 'comment'].includes(v.kind as string)) return undefined;
  const from = v.from as Record<string, unknown> | undefined;
  const what = from && WHATS.has(from.what as QuoteFrom['what']) ? from.what as QuoteFrom['what'] : 'earlier';
  const span = from && isLines(from.span) ? from.span : Array.isArray(from?.span) && from.span.length === 2 && from.span.every((n) => Number.isInteger(n) && n >= 0) ? from.span as [number, number] : undefined;
  const item: WaitingItem = {
    id: v.id,
    kind: v.kind as WaitingItem['kind'],
    text: v.text.slice(0, MAX_TEXT),
    from: {
      what,
      ...(typeof from?.key === 'string' ? { key: from.key } : {}),
      ...(typeof from?.at === 'number' ? { at: from.at } : {}),
      ...(span ? { span } : {}),
    },
    ...(typeof v.note === 'string' && v.note ? { note: v.note.slice(0, MAX_TEXT) } : {}),
    ...(typeof v.path === 'string' ? { path: v.path } : {}),
    ...(isLines(v.lines) ? { lines: v.lines } : {}),
    ...(typeof v.side === 'string' && SIDES.has(v.side) ? { side: v.side as WaitingItem['side'] } : {}),
    ...(v.folder === true ? { folder: true } : {}),
    ...(typeof v.tab === 'string' ? { tab: v.tab } : {}),
  };
  if (item.kind !== 'quote' && !item.path) return undefined;
  if (item.kind === 'comment' && (!item.lines || !item.note?.trim())) return undefined;
  return item;
}

/**
 * A quote kept before 0.5.0, as text: `> ` lines, under `path:7-8` for lines of a file. Read
 * back as a quote of those lines, with its secrets masked and cut as one taken now would be.
 */
function olderQuote(quote: string): WaitingItem[] {
  const [part] = readPrompt(quote);
  if (!part || part.kind !== 'quote' || !part.text.trim()) return [];
  const numbered = part.label ? /^(.+):(\d+)(?:-(\d+))?$/.exec(part.label) : null;
  return [{
    id: newId(),
    kind: 'quote',
    text: capQuote(maskSecrets(numbered ? part.text.replace(/^\n+|\n+$/g, '') : part.text.trim())),
    from: { what: numbered ? 'file' : 'earlier' },
    ...(numbered ? { path: numbered[1]!, lines: [Number(numbered[2]), Number(numbered[3] ?? numbered[2])] as [number, number] } : {}),
  }];
}

/** The items a stored draft holds: its own, and any quotes it kept the older way. */
const itemsOf = (draft: Stored | undefined): WaitingItem[] => [
  ...(Array.isArray(draft?.quotes) ? draft.quotes.flatMap((q: unknown) => (typeof q === 'string' ? olderQuote(q) : [])) : []),
  ...(Array.isArray(draft?.items) ? draft.items.flatMap((item: unknown) => itemOf(item) ?? []) : []),
];

/** A line comment as kept before 0.5.0. */
type OlderComment = { id: string; path: string; kind: 'add' | 'del' | 'same'; line: number; code: string; note: string };
const isOlderComment = (value: unknown): value is OlderComment => {
  const { id, path, kind, line, code, note } = (value ?? {}) as Record<string, unknown>;
  return typeof id === 'string' && typeof path === 'string' && SIDES.has(kind as string) && Number.isInteger(line) && (line as number) > 0
    && typeof code === 'string' && typeof note === 'string' && note.trim() !== '';
};

let moved = false;
/**
 * Once in each page: the line comments of earlier builds, `{ chats: { [chat]: comments } }`, join
 * what waits in their chat's draft, and quotes kept as text become items. Builds before that kept
 * comments by folder, at the top level: those are dropped, since nothing says which of the
 * folder's sessions each was written in.
 */
function moveIn(): void {
  if (moved) return;
  moved = true;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(COMMENTS_KEY);
  } catch {
    return;
  }
  const all = readAll();
  let changed = false;
  for (const [chat, draft] of Object.entries(all)) {
    if (draft && Array.isArray(draft.quotes)) {
      const { quotes: _quotes, ...rest } = draft;
      all[chat] = { ...rest, items: itemsOf(draft) };
      changed = true;
    }
  }
  if (raw !== null) {
    try {
      const chats = (JSON.parse(raw) as { chats?: unknown } | null)?.chats;
      if (chats && typeof chats === 'object') {
        for (const [chat, list] of Object.entries(chats as Record<string, unknown>)) {
          const comments: WaitingItem[] = (Array.isArray(list) ? list.filter(isOlderComment) : []).map((c) => ({
            id: c.id, kind: 'comment', text: c.code, note: c.note, path: c.path, lines: [c.line, c.line], side: c.kind, from: { what: c.kind === 'same' ? 'file' : 'diff' },
          }));
          if (comments.length === 0) continue;
          const draft = all[chat] ?? { text: '', at: Date.now() };
          all[chat] = { ...draft, items: [...itemsOf(draft), ...comments] };
          changed = true;
        }
      }
    } catch {
      // A store that is not one: nothing to move.
    }
    try {
      localStorage.removeItem(COMMENTS_KEY);
    } catch {
      // Nothing was kept.
    }
  }
  if (changed) writeAll(all);
}

export function loadDraft(viewId: string): Draft | undefined {
  moveIn();
  const draft = readAll()[viewId];
  if (!draft || typeof draft.text !== 'string') return undefined;
  const { quotes: _quotes, items: _items, held, ...rest } = draft;
  const items = itemsOf(draft);
  const keptHeld = helds(held);
  return { ...rest, ...(items.length > 0 ? { items } : {}), ...(keptHeld.length > 0 ? { held: keptHeld } : {}) };
}

/** When a draft was last written: never twice the same, so the newest is always the newest, whatever the clock. */
let lastWrite = 0;
const stamp = () => (lastWrite = Math.max(Date.now(), lastWrite + 1));

/** A draft with all of these, or none when it holds nothing. */
function draftWith(text: string, attachments: Attachment[], items: WaitingItem[], held: Held[]): Stored | undefined {
  if (!text.trim() && attachments.length === 0 && items.length === 0 && held.length === 0) return undefined;
  return {
    text: text.slice(0, MAX_TEXT),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(items.length > 0 ? { items: items.slice(-KEEP_ITEMS) } : {}),
    ...(held.length > 0 ? { held: held.map((h) => ({ ...h, text: h.text.slice(0, MAX_TEXT) })) } : {}),
    at: stamp(),
  };
}

/** Keeps a chat's words, files and what waits to be put back; what waits for the next message stays as it is. */
export function saveDraft(viewId: string, text: string, attachments: Attachment[] = [], held: Held[] = []): void {
  moveIn();
  const all = readAll();
  const next = draftWith(text, attachments, itemsOf(all[viewId]), held);
  if (!next) {
    if (!(viewId in all)) return;
    delete all[viewId];
  } else {
    all[viewId] = next;
  }
  writeAll(all);
}

/**
 * Forgets a chat's draft once its message went through; with `sent`, only its words, and only
 * when they are still that message's (another may have been started while it was on its way).
 * What waits, to go with the next message or to be put back, stays, unless the whole draft goes
 * (`sent` left out).
 */
export function clearDraft(viewId: string, sent?: string): void {
  moveIn();
  const all = readAll();
  const draft = all[viewId];
  if (!draft) return;
  if (sent === undefined) {
    delete all[viewId];
    setItems(viewId, [], false);
  } else if (typeof draft.text === 'string' && draft.text.trim() === sent.trim()) {
    const kept = draftWith('', [], itemsOf(draft), helds(draft.held));
    if (kept) all[viewId] = { ...kept, at: draft.at };
    else delete all[viewId];
  } else {
    return;
  }
  writeAll(all);
}

/** Takes a chat's draft to another, what waits with it: a new session's, when its folder is changed before it starts, or once it has started. */
export function moveDraft(from: string, to: string): void {
  const draft = loadDraft(from);
  if (!draft || from === to) return;
  const items = waitingOf(from);
  const there = waitingOf(to);
  clearDraft(from);
  saveDraft(to, draft.text, draft.attachments, draft.held);
  if (items.length > 0) setWaiting(to, [...there.filter((item) => !items.some((moving) => moving.id === item.id)), ...items]);
}

/** Signing out leaves no prompts behind in this browser, nor anything waiting to go with one. */
export function forgetDrafts(): void {
  for (const key of [KEY, COMMENTS_KEY]) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Nothing was kept.
    }
  }
  waiting.clear();
  for (const listener of listeners) listener();
  for (const forget of forgetting) forget();
}

/* ---------- what waits for the next message ---------- */

const waiting = new Map<string, WaitingItem[]>();
const listeners = new Set<() => void>();
const additions = new Map<string, Set<(item: WaitingItem) => void>>();
const NONE: WaitingItem[] = [];

function current(chat: string): WaitingItem[] {
  let items = waiting.get(chat);
  if (!items) {
    items = loadDraft(chat)?.items ?? NONE;
    waiting.set(chat, items);
  }
  return items;
}

function setItems(chat: string, items: WaitingItem[], keep = true): void {
  waiting.set(chat, items.length > 0 ? items : NONE);
  if (keep) {
    const all = readAll();
    const draft = all[chat];
    const next = draftWith(draft?.text ?? '', Array.isArray(draft?.attachments) ? draft.attachments.filter(isAttachment) : [], items, helds(draft?.held));
    if (next) all[chat] = next;
    else delete all[chat];
    writeAll(all);
  }
  for (const listener of listeners) listener();
}

/** What waits to go with a chat's next message, in the order it was added. */
export function useWaiting(chat: string | undefined): WaitingItem[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => (chat ? current(chat) : NONE),
  );
}

/** What waits for a chat's next message now, outside a component. */
export const waitingOf = (chat: string): WaitingItem[] => current(chat);

/** What waits for a chat's next message from now on. */
export const setWaiting = (chat: string, items: readonly WaitingItem[]): void => setItems(chat, [...items]);

/** Claude Desktop's limit: a message can hold at most this many quotes with a note. */
export const MAX_REPLIES = 99;

/**
 * Adds one to what waits for a chat's next message, after the rest; false, and nothing added,
 * when it is a 100th quote with a note (Claude Desktop's limit). Whoever listens for the chat
 * (its message box) hears of it.
 */
export function addWaiting(chat: string, item: WaitingItem): boolean {
  const items = current(chat);
  const replies = items.filter((i) => i.kind === 'quote' && i.note?.trim() && !i.path).length;
  if (item.kind === 'quote' && item.note?.trim() && !item.path && replies >= MAX_REPLIES) return false;
  setItems(chat, [...items, item]);
  for (const heard of additions.get(chat) ?? []) heard(item);
  return true;
}

/** Changes one item, where it is. */
export function updateWaiting(chat: string, id: string, change: Partial<Omit<WaitingItem, 'id'>>): void {
  const items = current(chat);
  if (!items.some((item) => item.id === id)) return;
  setItems(chat, items.map((item) => {
    if (item.id !== id) return item;
    const next = { ...item, ...change };
    if (!next.note) delete next.note;
    return next;
  }));
}

export const removeWaiting = (chat: string, id: string): void => {
  const items = current(chat);
  if (items.some((item) => item.id === id)) setItems(chat, items.filter((item) => item.id !== id));
};

/**
 * Takes what waits for a chat's next message (those `which` picks, or all) for a message on its
 * way: they are its own from then on, so a second message, or a second Send now, sent before it
 * went through carries none of them again.
 */
export function takeWaiting(chat: string, which: (item: WaitingItem) => boolean = () => true): WaitingItem[] {
  const items = current(chat);
  const taken = items.filter(which);
  if (taken.length > 0) setItems(chat, items.filter((item) => !which(item)));
  return taken;
}

/** A message that did not go gives back what it took, before anything added meanwhile. */
export function putBackWaiting(chat: string, items: readonly WaitingItem[]): void {
  if (items.length === 0) return;
  const back = new Set(items.map((item) => item.id));
  setItems(chat, [...items, ...current(chat).filter((item) => !back.has(item.id))]);
}

/** Calls `heard` with each item added for `chat` from now on; returns how to stop. */
export function whenAdded(chat: string, heard: (item: WaitingItem) => void): () => void {
  const set = additions.get(chat) ?? new Set();
  set.add(heard);
  additions.set(chat, set);
  return () => {
    set.delete(heard);
    if (set.size === 0) additions.delete(chat);
  };
}

/**
 * Saves what is typed a moment after typing stops, and at once when the chat closes or the page
 * goes to the background (a phone may drop a background tab without warning). `now` saves at once:
 * a message on its way is its chat's draft until the send went through.
 */
type Saving = (text: string, attachments: Attachment[], held?: Held[]) => void;

export function useDraftSaver(viewId: string | undefined, wait = 300): { save: Saving; now: Saving } {
  const pending = useRef<{ text: string; attachments: Attachment[]; held: Held[] } | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const id = useRef(viewId);
  id.current = viewId;

  const saver = useRef({
    flush: () => {
      clearTimeout(timer.current);
      const next = pending.current;
      pending.current = undefined;
      if (next && id.current) saveDraft(id.current, next.text, next.attachments, next.held);
    },
    save: (text: string, attachments: Attachment[], held: Held[] = []) => {
      pending.current = { text, attachments, held };
      clearTimeout(timer.current);
      timer.current = setTimeout(saver.current.flush, wait);
    },
    now: (text: string, attachments: Attachment[], held: Held[] = []) => {
      pending.current = { text, attachments, held };
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
