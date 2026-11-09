import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { claudePath } from './claude-code.js';
import { openRegular } from './open.js';
import { limiter } from './transcripts.js';
import { inside } from './workspace.js';

/**
 * Searching the text of a session's folder, for Files. With the ripgrep Claude Code carries
 * inside it, as Claude Code runs it itself for Grep: the user's Claude Code binary (the one Pelican
 * runs), by its absolute path, started as `rg` with `--no-config` (no RIPGREP_CONFIG_PATH), an
 * empty environment and nothing from PATH. It reads files and runs nothing else: no preprocessor,
 * no git, links not followed, so it works in folders nobody trusted. Where that is no native
 * binary (a script that starts one) and so does not answer as ripgrep, or there is no Claude Code,
 * a bounded scan of the folder in Node does the same, more slowly.
 *
 * The query is a literal string (not a pattern), matched as smart case does it: case-insensitive
 * unless it has a capital letter.
 */
export type SearchResult = {
  engine: 'rg' | 'scan';
  files: Array<{ path: string; lines: Array<{ n: number; text: string }> }>;
  /** A limit was reached: there may be more. */
  truncated: boolean;
};

export const SEARCH_LIMITS = { files: 200, lines: 500, perFile: 20, text: 300, ms: 8_000, output: 4 * 1024 * 1024, scanFiles: 20_000, scanBytes: 64 * 1024 * 1024, fileBytes: 1024 * 1024 };

/**
 * Folders neither engine looks in, also where no ignore file says so (ripgrep reads those only in
 * a repository): what package managers fill. Hidden files and folders are skipped as well.
 */
const SKIP = ['node_modules', '__pycache__', 'venv'];

/** A line as it is sent: at most 300 characters of it, around what was found when that is further in. */
const clipped = (text: string, query: string) => {
  const line = text.replace(/\r?\n$/, '');
  if (line.length <= SEARCH_LIMITS.text) return line;
  const caseless = query === query.toLowerCase();
  const at = (caseless ? line.toLowerCase() : line).indexOf(caseless ? query.toLowerCase() : query);
  const from = Math.max(0, Math.min(at - 100, line.length - SEARCH_LIMITS.text));
  return `${from > 0 ? '…' : ''}${line.slice(from, from + SEARCH_LIMITS.text)}${from + SEARCH_LIMITS.text < line.length ? '…' : ''}`;
};

/** Whether a binary answers as ripgrep when started as `rg`, asked once each. */
const answers = new Map<string, Promise<boolean>>();
function answersAsRipgrep(binary: string): Promise<boolean> {
  let known = answers.get(binary);
  if (!known) {
    known = new Promise<boolean>((resolve) => {
      let out = '';
      const child = spawn(binary, ['--version'], { argv0: 'rg', env: {}, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 });
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8');
      });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0 && out.startsWith('ripgrep ')));
    });
    answers.set(binary, known);
  }
  return known;
}

/** The binary to search with: the Claude Code Pelican runs, where it is ripgrep inside. */
async function ripgrep(): Promise<string | undefined> {
  const binary = await claudePath();
  return binary && path.isAbsolute(binary) && (await answersAsRipgrep(binary)) ? binary : undefined;
}

/** A path as ripgrep prints it (`./src/a.ts`), relative to the folder, or undefined if it is not one. */
function relativePath(printed: string, cwd: string): string | undefined {
  const file = printed.replace(/^\.\//, '');
  try {
    inside(cwd, file);
    return file && !path.isAbsolute(file) ? file : undefined;
  } catch {
    return undefined;
  }
}

function withRipgrep(binary: string, cwd: string, query: string): Promise<SearchResult> {
  return new Promise((resolve) => {
    const result: SearchResult = { engine: 'rg', files: [], truncated: false };
    const byPath = new Map<string, SearchResult['files'][number]>();
    let lines = 0;
    let bytes = 0;
    let carry = '';
    const args = [
      '--no-config', '--json', '--fixed-strings', '--smart-case', '--no-messages',
      '--max-count', String(SEARCH_LIMITS.perFile), '--max-filesize', '1M',
      ...SKIP.flatMap((name) => ['--glob', `!${name}`]),
      '-e', query, '--', '.',
    ];
    const child = spawn(binary, args, { argv0: 'rg', cwd, env: {}, stdio: ['ignore', 'pipe', 'ignore'] });
    const stop = (truncated: boolean) => {
      result.truncated ||= truncated;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => stop(true), SEARCH_LIMITS.ms);
    const take = (line: string) => {
      if (!line.includes('"type":"match"')) return;
      let event: { type?: string; data?: { path?: { text?: unknown }; lines?: { text?: unknown }; line_number?: unknown } };
      try {
        event = JSON.parse(line) as typeof event;
      } catch {
        return;
      }
      const printed = event.data?.path?.text;
      const text = event.data?.lines?.text;
      const n = event.data?.line_number;
      // A name or a line that is not UTF-8 comes as bytes: left out.
      if (event.type !== 'match' || typeof printed !== 'string' || typeof text !== 'string' || typeof n !== 'number') return;
      const file = relativePath(printed, cwd);
      if (!file) return;
      let entry = byPath.get(file);
      if (!entry) {
        if (byPath.size >= SEARCH_LIMITS.files) return stop(true);
        entry = { path: file, lines: [] };
        byPath.set(file, entry);
        result.files.push(entry);
      }
      entry.lines.push({ n, text: clipped(text, query) });
      lines += 1;
      if (lines >= SEARCH_LIMITS.lines) stop(true);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > SEARCH_LIMITS.output) return stop(true);
      const text = carry + chunk.toString('utf8');
      const parts = text.split('\n');
      carry = parts.pop() ?? '';
      for (const part of parts) {
        if (lines >= SEARCH_LIMITS.lines || result.truncated) break;
        take(part);
      }
    });
    const done = () => {
      clearTimeout(timer);
      resolve(result);
    };
    child.on('error', done);
    child.on('close', done);
  });
}

/** The same search without ripgrep: the folder walked (no hidden files, no links), within the same limits. */
async function withScan(cwd: string, query: string): Promise<SearchResult> {
  const result: SearchResult = { engine: 'scan', files: [], truncated: false };
  const deadline = Date.now() + SEARCH_LIMITS.ms;
  const caseless = query === query.toLowerCase();
  const needle = caseless ? query.toLowerCase() : query;
  let lines = 0;
  let seen = 0;
  let read = 0;
  const full = () => lines >= SEARCH_LIMITS.lines || result.files.length >= SEARCH_LIMITS.files;
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > 12 || full() || Date.now() > deadline) return;
    let entries;
    try {
      entries = await readdir(path.join(cwd, dir), { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (full() || Date.now() > deadline || seen >= SEARCH_LIMITS.scanFiles || read >= SEARCH_LIMITS.scanBytes) {
        result.truncated = true;
        return;
      }
      if (entry.name.startsWith('.') || SKIP.includes(entry.name)) continue;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await visit(rel, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      seen += 1;
      const text = await readText(path.join(cwd, rel));
      if (text === undefined) continue;
      read += text.length;
      const found: Array<{ n: number; text: string }> = [];
      const all = text.split('\n');
      for (let i = 0; i < all.length && found.length < SEARCH_LIMITS.perFile; i += 1) {
        const line = all[i]!;
        if ((caseless ? line.toLowerCase() : line).includes(needle)) found.push({ n: i + 1, text: clipped(line, query) });
      }
      if (found.length === 0) continue;
      const room = SEARCH_LIMITS.lines - lines;
      result.files.push({ path: rel, lines: found.slice(0, room) });
      lines += Math.min(found.length, room);
    }
  };
  await visit('', 0);
  if (full()) result.truncated = true;
  return result;
}

/** A file's text for the scan: regular files of up to 1 MB that are not binary. */
async function readText(file: string): Promise<string | undefined> {
  try {
    const handle = await openRegular(file);
    try {
      const { size } = await handle.stat();
      if (size > SEARCH_LIMITS.fileBytes) return undefined;
      const data = Buffer.alloc(size);
      await handle.read(data, 0, size, 0);
      return data.subarray(0, 8000).includes(0) ? undefined : data.toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

/** Two searches at a time at most: a burst of them waits its turn instead of loading the computer. */
const searching = limiter(2);

/** The lines of the folder's files that hold `query`, by file. `engine: 'scan'` skips ripgrep (tests). */
export async function searchText(cwd: string, query: string, engine?: 'scan'): Promise<SearchResult> {
  return searching(async () => {
    const binary = engine === 'scan' ? undefined : await ripgrep();
    return binary ? withRipgrep(binary, cwd, query) : withScan(cwd, query);
  });
}
