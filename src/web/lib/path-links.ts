import { createContext, type MouseEvent, useContext, useEffect, useSyncExternalStore } from 'react';

import type { TurnChanges } from '../../shared/protocol';
import { api } from './api';
import { withStep } from './workspace-route';

/**
 * Paths named in the conversation as links that open the file in Changes and files, at its line,
 * as clicking a path does in Claude Desktop: the file names in Claude's steps, and the
 * `path:line` references Claude writes in its replies. Only a file that is in the session's
 * folder becomes a link, which a batched look at the folder decides (no file, no link).
 */
export type PathRef = { path: string; line?: number; end?: number };

/** What a session's conversation can open, provided by its chat. */
export type PathLinks = {
  cwd: string;
  openFile: (path: string, line?: number) => void;
  /** Opens a file's diff in Changes. */
  openChanges?: (path: string) => void;
  /** The files git has changes in, from the session's folder. */
  changed?: ReadonlySet<string>;
  /** Opens a new terminal in a folder of the session's (from its folder: relative, or '' for the folder itself). */
  openTerminal?: (folder: string) => void;
  /** Opens one turn's changes, by its prompt's id. */
  openTurn?: (uuid: string) => void;
  /** The turns that changed files (T1, T2…), for the line under each in the conversation. */
  turns?: TurnChanges[];
  /** The line each edit's change starts at, by its tool call's id. */
  lines?: Record<string, number>;
};

export const PathLinksContext = createContext<PathLinks | undefined>(undefined);
export const usePathLinks = () => useContext(PathLinksContext);

/** Extensions that mark a word in prose as a file's name; in code any extension does. */
const CODE_EXTENSIONS = new Set([
  'c', 'cc', 'cfg', 'cjs', 'conf', 'cpp', 'cs', 'css', 'csv', 'dart', 'ex', 'exs', 'go', 'gradle', 'h', 'hpp', 'html', 'ini', 'java', 'js',
  'json', 'jsonl', 'jsx', 'kt', 'less', 'lock', 'lua', 'md', 'mdx', 'mjs', 'php', 'pl', 'proto', 'py', 'rb', 'rs', 'sass', 'scss', 'sh', 'sql',
  'svelte', 'swift', 'toml', 'ts', 'tsx', 'txt', 'vue', 'xml', 'yaml', 'yml', 'zsh',
]);

/** A path, then maybe `:line`, `:line-end`, `:line:column` or GitHub's `#Lline-Lend`. */
const REF = /^((?:\.\.?\/|\/)?[\w@~+.-]+(?:\/[\w@~+. -]*[\w@~+.-])*\/?)(?::(\d{1,7})(?:[-–](\d{1,7})|:\d{1,5})?|#L(\d{1,7})(?:-L?(\d{1,7}))?)?$/;

/**
 * A reference to a file as Claude writes it: `src/app.ts`, `src/app.ts:42`, `app.ts:7-8`. In
 * prose (`code` false) it must look more surely like a path: a folder in it, a line after it, or
 * the extension of a source file.
 */
export function parseRef(text: string, code = true): PathRef | undefined {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 300 || /\s{2,}|^-|:\/\/|[*?<>|"`]/.test(trimmed)) return undefined;
  const match = REF.exec(trimmed);
  if (!match) return undefined;
  const file = match[1]!.replace(/\/$/, '');
  const line = Number(match[2] ?? match[4]) || undefined;
  const end = Number(match[3] ?? match[5]) || undefined;
  const base = file.slice(file.lastIndexOf('/') + 1);
  const ext = /\.([A-Za-z][\w-]{0,9})$/.exec(base)?.[1]?.toLowerCase();
  const hasFolder = file.includes('/');
  if (!/[A-Za-z]/.test(base) || base === '.' || base === '..') return undefined;
  // A word with a space in it is a path only in code, and only with a folder.
  if (file.includes(' ') && !(code && hasFolder)) return undefined;
  if (code ? !(hasFolder || ext || line) : !((hasFolder && ext) || (line && ext) || (ext && CODE_EXTENSIONS.has(ext)))) return undefined;
  return { path: file, ...(line ? { line } : {}), ...(end && line && end > line ? { end } : {}) };
}

/** The path relative to the session's folder, or undefined when it is not in it. */
export function inFolder(file: string, cwd: string): string | undefined {
  let relative = file;
  if (file.startsWith('/')) {
    if (!file.startsWith(`${cwd.replace(/\/$/, '')}/`)) return undefined;
    relative = file.slice(cwd.replace(/\/$/, '').length + 1);
  }
  relative = relative.replace(/^(?:\.\/)+/, '');
  if (!relative || relative.startsWith('~') || relative.split('/').includes('..')) return undefined;
  return relative;
}

/**
 * Whether files are there, asked of the computer in batches of up to 50: a reply that names 30
 * files costs one request. Answers are kept a while: a file that is there for 5 minutes, one that
 * is not for 20 seconds (Claude may be about to write it).
 */
const BATCH = 50;
const KEEP_FOUND_MS = 5 * 60_000;
const KEEP_MISSING_MS = 20_000;
const known = new Map<string, Map<string, { found: boolean; at: number }>>();
const queued = new Map<string, Set<string>>();
let flushing: ReturnType<typeof setTimeout> | undefined;
let version = 0;
/** Counts forgets: an answer to a question asked before the last one is not kept. */
let asked = 0;
const listeners = new Set<() => void>();

function answer(cwd: string, paths: readonly string[], found: ReadonlySet<string>): void {
  const folder = known.get(cwd) ?? new Map();
  known.set(cwd, folder);
  const at = Date.now();
  for (const file of paths) folder.set(file, { found: found.has(file), at });
  version += 1;
  for (const listener of listeners) listener();
}

function flush(): void {
  flushing = undefined;
  const now = asked;
  for (const [cwd, set] of queued) {
    queued.delete(cwd);
    const paths = [...set];
    for (let i = 0; i < paths.length; i += BATCH) {
      const batch = paths.slice(i, i + BATCH);
      const keep = (found: Iterable<string>) => {
        if (now === asked) answer(cwd, batch, new Set(found));
      };
      void api.exists(cwd, batch).then(keep, () => keep([]));
    }
  }
}

const fresh = (cwd: string, file: string) => {
  const entry = known.get(cwd)?.get(file);
  return Boolean(entry && Date.now() - entry.at < (entry.found ? KEEP_FOUND_MS : KEEP_MISSING_MS));
};

function ask(cwd: string, file: string): void {
  if (fresh(cwd, file) || queued.get(cwd)?.has(file)) return;
  queued.set(cwd, (queued.get(cwd) ?? new Set()).add(file));
  flushing ??= setTimeout(flush, 30);
}

/**
 * Forgets what was found, and what is still being asked: the next look asks again (the tests,
 * each a page of its own; a folder that changed a lot).
 */
export function forgetFound(): void {
  known.clear();
  queued.clear();
  clearTimeout(flushing);
  flushing = undefined;
  asked += 1;
  version += 1;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether `file` (relative) is a file in `cwd`, once the computer has said so. */
export function useFileExists(cwd: string | undefined, file: string | undefined): boolean {
  useSyncExternalStore(subscribe, () => version);
  useEffect(() => {
    if (cwd && file) ask(cwd, file);
  }, [cwd, file]);
  return Boolean(cwd && file && known.get(cwd)?.get(file)?.found);
}

export type FileLink = {
  path: string;
  /** Where the link leads: this page with the file open, so it can also open in a tab of its own. */
  href: string;
  /** A plain click opens it here; one with a key held (a new tab, a new window) is the browser's. */
  onClick: (e: MouseEvent) => void;
};

/**
 * What opens a path named in the conversation: undefined while it is not known to be a file of
 * the session's folder, and outside a conversation that can open files.
 */
export function useFileLink(file: string | undefined, line?: number): FileLink | undefined {
  const links = usePathLinks();
  const relative = links && file ? inFolder(file, links.cwd) : undefined;
  const exists = useFileExists(links?.cwd, relative);
  if (!links || !relative || !exists) return undefined;
  return {
    path: relative,
    href: withStep(location.search, { tab: 'files', path: relative, ...(line ? { line } : {}) }) || '?',
    onClick: (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      links.openFile(relative, line);
    },
  };
}
