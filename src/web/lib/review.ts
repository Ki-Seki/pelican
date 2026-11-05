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

/** A message with line comments after it, as they go with the next message (or alone, Send now). */
export function withComments(text: string, comments: readonly LineComment[]): string {
  if (comments.length === 0) return text;
  const body = text.replace(/\s+$/, '');
  return body ? `${body}\n\n${commentsMessage(comments)}` : commentsMessage(comments);
}

/**
 * Comments not sent yet, by folder: the changes are the folder's, whichever of its sessions is
 * open. As in Claude Desktop they go with the next message sent from it, or all at once with
 * Send now. Kept with the drafts in this browser, so a reload loses none, and forgotten with
 * them when it signs out.
 */
const KEY = 'pelican:comments';
const KEEP_FOLDERS = 20;
const KEEP_EACH = 200;
const listeners = new Set<() => void>();
const NONE: LineComment[] = [];

function load(): Map<string, LineComment[]> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown;
    if (!raw || typeof raw !== 'object') return new Map();
    return new Map(Object.entries(raw as Record<string, unknown>).filter((entry): entry is [string, LineComment[]] => Array.isArray(entry[1])));
  } catch {
    return new Map();
  }
}

const byFolder = load();

function keep(): void {
  try {
    if (byFolder.size === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(Object.fromEntries([...byFolder].slice(-KEEP_FOLDERS))));
  } catch {
    // Private mode or full: the comments live as long as the page.
  }
}

export function useComments(cwd: string): LineComment[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => byFolder.get(cwd) ?? NONE,
  );
}

/** The folder's comments as they are now, outside a component. */
export const commentsOf = (cwd: string): LineComment[] => byFolder.get(cwd) ?? NONE;

export function setComments(cwd: string, comments: LineComment[]): void {
  byFolder.delete(cwd);
  if (comments.length > 0) byFolder.set(cwd, comments.slice(-KEEP_EACH));
  keep();
  for (const listener of listeners) listener();
}

/** Takes away comments that went with a message (others may have been added meanwhile). */
export function dropComments(cwd: string, sent: readonly LineComment[]): void {
  const gone = new Set(sent.map((c) => c.id));
  setComments(cwd, commentsOf(cwd).filter((c) => !gone.has(c.id)));
}

/** Signing out leaves no comments behind in this browser. */
export function forgetComments(): void {
  byFolder.clear();
  keep();
  for (const listener of listeners) listener();
}
