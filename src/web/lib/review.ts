import { createContext, useContext, useSyncExternalStore } from 'react';

import { COMMENTS_KEY, whenDraftsForgotten } from './drafts';

/** One line of a unified diff, numbered in the old file, the new one, or both. */
export type DiffLine =
  | { kind: 'hunk'; text: string }
  | { kind: 'note'; text: string }
  | { kind: 'add'; text: string; newLine: number }
  | { kind: 'del'; text: string; oldLine: number }
  | { kind: 'same'; text: string; oldLine: number; newLine: number };

export type CodeLine = Extract<DiffLine, { kind: 'add' | 'del' | 'same' }>;

/**
 * A unified diff as numbered lines. The file headers before the first hunk are left out; inside a
 * hunk a line that starts with --- or +++ is a removed or added line like any other.
 */
export function parseDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;
  const lines = diff.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      inHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      out.push({ kind: 'hunk', text: line });
    } else if (!inHunk) {
      continue;
    } else if (line.startsWith('+')) {
      out.push({ kind: 'add', text: line.slice(1), newLine: newLine++ });
    } else if (line.startsWith('-')) {
      out.push({ kind: 'del', text: line.slice(1), oldLine: oldLine++ });
    } else if (line.startsWith(' ') || line === '') {
      out.push({ kind: 'same', text: line.slice(1), oldLine: oldLine++, newLine: newLine++ });
    } else {
      // "\ No newline at end of file", or the server's word that it cut the diff short.
      out.push({ kind: 'note', text: line });
    }
  }
  return out;
}

/** A comment on one line of a diff, for Claude. */
export type LineComment = {
  id: string;
  path: string;
  kind: CodeLine['kind'];
  /** The line's number in the new file, or for a removed line, in the old one. */
  line: number;
  /** The line as it read, so the comment still says what it is about after the file changes. */
  code: string;
  note: string;
};

export const lineNumber = (line: CodeLine) => (line.kind === 'del' ? line.oldLine : line.newLine);

/** Where a line is in its file's diff; removed lines are counted in the old file, the rest in the new. */
export const lineKey = (line: CodeLine) => `${line.kind === 'del' ? '-' : '+'}${lineNumber(line)}`;
export const commentKey = (comment: LineComment) => `${comment.kind === 'del' ? '-' : '+'}${comment.line}`;

const MAX_QUOTE = 200;

/**
 * Comments as the text of a message, in file order: where each one is, the line quoted (marked
 * + or - when it was added or removed), then what was said about it. Plain text, so it reads the
 * same in every Claude Code app the session is open in.
 */
export function commentsMessage(comments: readonly LineComment[]): string {
  return [...comments]
    .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
    .map((c) => {
      const code = c.code.trim();
      const quote = code.length > MAX_QUOTE ? `${code.slice(0, MAX_QUOTE)}…` : code;
      const mark = c.kind === 'add' ? '+ ' : c.kind === 'del' ? '- ' : '';
      return `${c.path}:${c.line}${c.kind === 'del' ? ' (removed)' : ''}\n> ${mark}${quote}\n${c.note.trim()}`;
    })
    .join('\n\n');
}

/**
 * A message with line comments before it, a blank line between, as Claude Desktop sends them with
 * the next message (or alone, Send now).
 */
export function withComments(text: string, comments: readonly LineComment[]): string {
  if (comments.length === 0) return text;
  const body = text.trim();
  return body ? `${commentsMessage(comments)}\n\n${body}` : commentsMessage(comments);
}

/**
 * Comments not sent yet, by the chat they were written in (its view id: a session, or a new
 * session in a folder), as Claude Desktop keeps them per session: they go with the next message
 * sent there, or all at once with Send now, never with another session's, even in the same folder.
 * Kept with the drafts in this browser (lib/drafts), so a reload loses none, and forgotten with them
 * when it signs out.
 *
 * Stored as `{ chats: { [chat]: comments } }`. Earlier builds of 0.4.0 kept them by folder, at the
 * top level: those are dropped, since nothing says which of the folder's sessions each was written in.
 */
const KEY = COMMENTS_KEY;
const KEEP_CHATS = 50;
const KEEP_EACH = 200;
const listeners = new Set<() => void>();
const NONE: LineComment[] = [];

function isComment(value: unknown): value is LineComment {
  if (!value || typeof value !== 'object') return false;
  const { id, path, kind, line, code, note } = value as Record<string, unknown>;
  return typeof id === 'string' && typeof path === 'string' && (kind === 'add' || kind === 'del' || kind === 'same')
    && typeof line === 'number' && typeof code === 'string' && typeof note === 'string';
}

function load(): Map<string, LineComment[]> {
  try {
    const raw = localStorage.getItem(KEY);
    const stored = raw ? (JSON.parse(raw) as { chats?: unknown }) : undefined;
    const chats = stored?.chats;
    if (!chats || typeof chats !== 'object') {
      if (raw) localStorage.removeItem(KEY);
      return new Map();
    }
    return new Map(Object.entries(chats as Record<string, unknown>).flatMap(([chat, list]) => {
      const kept = Array.isArray(list) ? list.filter(isComment) : [];
      return kept.length > 0 ? [[chat, kept] as [string, LineComment[]]] : [];
    }));
  } catch {
    return new Map();
  }
}

const byChat = load();

function keep(): void {
  try {
    if (byChat.size === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify({ chats: Object.fromEntries([...byChat].slice(-KEEP_CHATS)) }));
  } catch {
    // Private mode or full: the comments live as long as the page.
  }
}

/**
 * The chat whose comments the views inside it show and add to, given by the chat (its view id). A
 * view shown on its own, outside any chat, keeps them by its folder.
 */
export const CommentsChat = createContext<string | undefined>(undefined);
export const useCommentsChat = (cwd: string): string => useContext(CommentsChat) ?? cwd;

export function useComments(chat: string): LineComment[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => byChat.get(chat) ?? NONE,
  );
}

/** The chat's comments as they are now, outside a component. */
export const commentsOf = (chat: string): LineComment[] => byChat.get(chat) ?? NONE;

export function setComments(chat: string, comments: LineComment[]): void {
  byChat.delete(chat);
  if (comments.length > 0) byChat.set(chat, comments.slice(-KEEP_EACH));
  keep();
  for (const listener of listeners) listener();
}

/**
 * Takes the chat's comments for a message on its way: they are its own from then on, so a second
 * message, or a second tap on Send now, sent before it went through carries none of them again.
 */
export function takeComments(chat: string): LineComment[] {
  const taken = commentsOf(chat);
  if (taken.length > 0) setComments(chat, []);
  return taken;
}

/** A message that did not go gives its comments back, before any written meanwhile. */
export function putBackComments(chat: string, comments: readonly LineComment[]): void {
  if (comments.length === 0) return;
  const back = new Set(comments.map((c) => c.id));
  setComments(chat, [...comments, ...commentsOf(chat).filter((c) => !back.has(c.id))]);
}

// Signing out leaves no comments behind in this browser: lib/drafts takes them out of storage.
whenDraftsForgotten(() => {
  byChat.clear();
  for (const listener of listeners) listener();
});
