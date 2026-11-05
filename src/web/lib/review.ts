import { useSyncExternalStore } from 'react';

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
 * Comments not sent yet, by folder: the changes are the folder's, whichever of its sessions is
 * open. Kept in this page only, until they go into a message.
 */
const byFolder = new Map<string, LineComment[]>();
const listeners = new Set<() => void>();
const NONE: LineComment[] = [];

export function useComments(cwd: string): LineComment[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => byFolder.get(cwd) ?? NONE,
  );
}

export function setComments(cwd: string, comments: LineComment[]): void {
  if (comments.length > 0) byFolder.set(cwd, comments);
  else byFolder.delete(cwd);
  for (const listener of listeners) listener();
}
