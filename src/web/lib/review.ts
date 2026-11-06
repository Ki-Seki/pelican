import { createContext, useContext } from 'react';

import { setWaiting, useWaiting, waitingOf } from './drafts';
import type { WaitingItem } from './quote';
import { defuseMentions, dropPrivate, fenceFor, maskSecrets, plainControls } from './sanitize';

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

/** A comment as it goes to Claude: where it is, the code it is about, what was said. */
export type CommentBlock = { path: string; lines: [number, number]; removed?: boolean; code?: string; note: string };

/** A comment on a line of a diff, as one goes to Claude. */
export const commentBlock = (comment: LineComment): CommentBlock => ({
  path: comment.path, lines: [comment.line, comment.line], removed: comment.kind === 'del', code: comment.code, note: comment.note,
});

/** What starts a line Claude Desktop would read as a header of its own, after any space: those lines of a snippet are quoted. */
const SPACE = String.raw`[\t\v\f\p{Zs}\p{Cf}\p{Default_Ignorable_Code_Point}\u2800]`;
const HEADER_LIKE = new RegExp(String.raw`^${SPACE}*(?=In\b[^\n]*\bat lines? \d|Reply\b[^\n]*:${SPACE}*$|<!-- attach)`, 'gmu');
const UNSEEN = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;

/** A path as a comment names it: on one line, its backticks made quotes, an @ defused; `-` for none. */
const commentPath = (path: string) => defuseMentions(plainControls(dropPrivate(path).replace(/[\r\n\u2028\u2029]+/g, ' ')).replace(/[`\uFF40]/g, "'")) || '-';

/**
 * Code as a comment quotes it, Desktop's way: line breaks made plain, secrets masked, an @
 * defused, and a line that would read as a comment's header, a reply or an attach block marked
 * as a quote, so it stays code.
 */
function snippet(code: string): string {
  const lines = plainControls(dropPrivate(code).replace(/\r(?!\n)/g, '\n').replace(/\r\n/g, '\n')).split('\n').map((line) => {
    const seen = line.replace(UNSEEN, '');
    return seen.search(HEADER_LIKE) === 0 || seen.trim() === '' ? seen : line;
  });
  return defuseMentions(maskSecrets(lines.join('\n'))).replace(HEADER_LIKE, '> ');
}

/** Blank lines in a note: never more than one in a row, outside its code. */
function oneBlankLine(note: string): string {
  return note.split(/(^```[\s\S]*?^```)/m).map((part, i) => (i % 2 === 1 ? part : part.replace(/\n{3,}/g, '\n\n'))).join('');
}

/** A code block's language, from its file's name: `css`, `tsx`, `py`. */
const languageOf = (path: string) => /\.([A-Za-z0-9+]{1,10})$/.exec(path)?.[1]?.toLowerCase() ?? '';

/**
 * Comments as Claude Desktop sends them, before `text` (the rest of the message), three line
 * breaks apart: by file, each file's in line order, each "In `path` at line N:" (or "at lines
 * A-B", and " (before changes)" for removed lines), the code fenced in one backtick more than any
 * run in it, then what was said. One blank line between comments. `text` alone, trimmed, without any.
 */
export function commentsMessage(comments: readonly CommentBlock[], text = ''): string {
  const byFile = new Map<string, CommentBlock[]>();
  for (const comment of comments) byFile.set(comment.path, [...(byFile.get(comment.path) ?? []), comment]);
  const blocks: string[] = [];
  for (const [path, list] of byFile) {
    for (const comment of [...list].sort((a, b) => a.lines[0] - b.lines[0])) {
      const [first, last] = comment.lines;
      const out = [`In \`${commentPath(path)}\` at ${first === last ? `line ${first}` : `lines ${first}-${last}`}${comment.removed ? ' (before changes)' : ''}:`];
      if (comment.code !== undefined) {
        const code = snippet(comment.code);
        const fence = fenceFor(code);
        out.push(`${fence}${languageOf(path)}`, code, fence);
      }
      out.push(oneBlankLine(comment.note.trim()));
      blocks.push(out.join('\n'));
    }
  }
  const rest = text.trim();
  if (blocks.length === 0) return rest;
  return rest ? `${blocks.join('\n\n')}\n\n\n${rest}` : blocks.join('\n\n');
}

/** A message with line comments before it, as Claude Desktop sends them with the next message (or alone, Send now). */
export const withComments = (text: string, comments: readonly LineComment[]): string => commentsMessage(comments.map(commentBlock), text);

/*
 * Comments not sent yet wait with everything else that goes with a chat's next message (lib/drafts):
 * by the chat they were written in (its view id: a session, or a new session in a folder), as
 * Claude Desktop keeps them per session, never with another session's, even in the same folder.
 * The views that show them under their lines see them as LineComments.
 */

const asItem = (comment: LineComment): WaitingItem => ({
  id: comment.id, kind: 'comment', text: comment.code, note: comment.note, path: comment.path,
  lines: [comment.line, comment.line], side: comment.kind, from: { what: comment.kind === 'same' ? 'file' : 'diff' },
});

const asComment = (item: WaitingItem): LineComment => ({
  id: item.id, path: item.path ?? '', kind: item.side ?? 'same', line: item.lines?.[0] ?? 0, code: item.text, note: item.note ?? '',
});

const seen = new WeakMap<readonly WaitingItem[], LineComment[]>();
const commentsIn = (items: readonly WaitingItem[]): LineComment[] => {
  let comments = seen.get(items);
  if (!comments) {
    comments = items.filter((item) => item.kind === 'comment').map(asComment);
    seen.set(items, comments);
  }
  return comments;
};

/**
 * The chat whose comments the views inside it show and add to, given by the chat (its view id). A
 * view shown on its own, outside any chat, keeps them by its folder.
 */
export const CommentsChat = createContext<string | undefined>(undefined);
export const useCommentsChat = (cwd: string): string => useContext(CommentsChat) ?? cwd;

export const useComments = (chat: string): LineComment[] => commentsIn(useWaiting(chat));

/** The chat's comments as they are now, outside a component. */
export const commentsOf = (chat: string): LineComment[] => commentsIn(waitingOf(chat));

/**
 * The chat's comments from now on: those kept change where they are among what waits, those gone
 * go, and new ones wait after everything else.
 */
export function setComments(chat: string, comments: readonly LineComment[]): void {
  const current = waitingOf(chat);
  const next = new Map(comments.map((comment) => [comment.id, comment]));
  const kept = current.flatMap((item) => {
    if (item.kind !== 'comment') return [item];
    const comment = next.get(item.id);
    return comment ? [{ ...asItem(comment), from: item.from }] : [];
  });
  const known = new Set(current.map((item) => item.id));
  setWaiting(chat, [...kept, ...comments.filter((comment) => !known.has(comment.id)).map(asItem)]);
}
