import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const cache = new Map<string, { at: number; files: string[] }>();
const TTL_MS = 30_000;
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.venv', 'venv', '__pycache__', 'target', '.cache']);
const MAX_FILES = 20_000;

/** Files of a folder as `git ls-files` sees them (ignored ones left out), or by walking it. */
async function projectFiles(cwd: string): Promise<string[]> {
  const cached = cache.get(cwd);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.files;
  let files: string[];
  try {
    const { stdout } = await run('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd, maxBuffer: 32 * 1024 * 1024, timeout: 5000 });
    files = stdout.split('\n').filter(Boolean).slice(0, MAX_FILES);
  } catch {
    files = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 8 || files.length >= MAX_FILES) return;
      let entries;
      try {
        entries = await readdir(path.join(cwd, dir), { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (files.length >= MAX_FILES) return;
        if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(rel, depth + 1);
        else files.push(rel);
      }
    };
    await walk('', 0);
  }
  cache.set(cwd, { at: Date.now(), files });
  return files;
}

/** How well `query` matches `file`: higher is better, -1 for no match. */
function score(file: string, query: string): number {
  const f = file.toLowerCase();
  const q = query.toLowerCase();
  const base = f.slice(f.lastIndexOf('/') + 1);
  if (base === q) return 1000;
  if (base.startsWith(q)) return 800 - base.length;
  if (base.includes(q)) return 600 - base.length;
  if (f.includes(q)) return 400 - f.length / 10;
  // Every character in order: "stset" finds "src/settings/Settings.tsx".
  let at = 0;
  for (const char of q) {
    at = f.indexOf(char, at);
    if (at === -1) return -1;
    at += 1;
  }
  return 100 - f.length / 10;
}

/** Files and folders matching a query, for `@` mentions in the composer. */
export async function searchFiles(cwd: string, query: string, limit = 30): Promise<string[]> {
  const files = await projectFiles(cwd);
  const dirs = new Set<string>();
  for (const file of files) {
    let cut = file.lastIndexOf('/');
    while (cut > 0) {
      dirs.add(`${file.slice(0, cut)}/`);
      cut = file.lastIndexOf('/', cut - 1);
    }
  }
  const candidates = [...files, ...dirs];
  if (!query) return files.slice().sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b)).slice(0, limit);
  return candidates
    .map((file) => ({ file, score: score(file, query) }))
    .filter((m) => m.score >= 0)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, limit)
    .map((m) => m.file);
}
