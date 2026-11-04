import { execFile } from 'node:child_process';
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { FileContent, GitFile, GitStatus, TreeEntry } from '../shared/protocol.js';

const run = promisify(execFile);
const MAX_FILE = 512 * 1024;
const MAX_DIFF = 400_000;

const git = async (cwd: string, args: string[]) =>
  (await run('git', ['-c', 'core.quotepath=off', ...args], { cwd, maxBuffer: 32 * 1024 * 1024, timeout: 15_000 })).stdout;

/** A path inside the session's folder, or an error: the panels never reach outside it. */
export function inside(cwd: string, relative: string): string {
  const root = path.resolve(cwd);
  const full = path.resolve(root, relative || '.');
  if (full !== root && !full.startsWith(`${root}${path.sep}`)) throw new Error('That path is outside the session’s folder');
  return full;
}

const KIND: Record<string, GitFile['status']> = { M: 'modified', T: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'added', U: 'conflicted' };

/** What changed in the session's folder since the last commit, with line counts. */
export async function gitStatus(cwd: string): Promise<GitStatus> {
  let raw: string;
  try {
    raw = await git(cwd, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
  } catch {
    return { repo: false };
  }
  const out: { repo: true; branch?: string; ahead?: number; behind?: number; files: GitFile[] } = { repo: true, files: [] };
  const entries = raw.split('\0');
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    if (entry.startsWith('# branch.head ')) {
      const head = entry.slice(14);
      if (head !== '(detached)') out.branch = head;
    } else if (entry.startsWith('# branch.ab ')) {
      const [ahead, behind] = entry.slice(12).split(' ');
      out.ahead = Number(ahead?.slice(1)) || 0;
      out.behind = Number(behind?.slice(1)) || 0;
    } else if (entry.startsWith('1 ') || entry.startsWith('2 ') || entry.startsWith('u ')) {
      const parts = entry.split(' ');
      const xy = parts[1] ?? '..';
      const code = xy[0] !== '.' ? xy[0]! : xy[1]!;
      const file = entry.startsWith('1 ') ? parts.slice(8).join(' ') : entry.startsWith('2 ') ? parts.slice(9).join(' ') : parts.slice(10).join(' ');
      const status = entry.startsWith('u ') ? 'conflicted' : KIND[code] ?? 'modified';
      const item: GitFile = { path: file, status };
      if (entry.startsWith('2 ')) {
        item.from = entries[i + 1];
        i += 1;
      }
      out.files.push(item);
    } else if (entry.startsWith('? ')) {
      out.files.push({ path: entry.slice(2), status: 'untracked' });
    }
  }
  // Line counts against the last commit (or the empty tree before the first one).
  try {
    const base = await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']).then(() => 'HEAD', () => '4b825dc642cb6eb9a060e54bf8d69288fbee4904');
    const numstat = await git(cwd, ['diff', '--numstat', '-z', base]);
    const counts = new Map<string, { added?: number; removed?: number }>();
    const fields = numstat.split('\0');
    for (let i = 0; i < fields.length; i += 1) {
      const field = fields[i]!;
      if (!field) continue;
      const [added, removed, name] = field.split('\t');
      // A rename lists its old and new paths in the next two fields.
      const file = name === '' ? fields[(i += 2)] : name;
      if (!file) continue;
      counts.set(file, { ...(added !== '-' ? { added: Number(added) } : {}), ...(removed !== '-' ? { removed: Number(removed) } : {}) });
    }
    for (const file of out.files) Object.assign(file, counts.get(file.path) ?? {});
  } catch {
    // Counts are a nicety.
  }
  // A new file is all added lines; git does not count those for files it does not track yet.
  await Promise.all(out.files.filter((f) => f.status === 'untracked').slice(0, 200).map(async (file) => {
    try {
      const content = await readProjectFile(cwd, file.path);
      if (content.text !== undefined) file.added = content.text.split('\n').length - (content.text.endsWith('\n') ? 1 : 0);
    } catch {
      // Unreadable; no count.
    }
  }));
  return out;
}

/** The diff of one file against the last commit; an untracked file shows as all added. */
export async function gitDiff(cwd: string, file: string): Promise<string> {
  inside(cwd, file);
  let diff = '';
  try {
    diff = await git(cwd, ['diff', 'HEAD', '--', file]);
  } catch {
    diff = '';
  }
  if (!diff) {
    // Untracked (or no commits yet): git diff --no-index exits with 1 when the files differ.
    diff = await run('git', ['diff', '--no-index', '--', '/dev/null', file], { cwd, maxBuffer: 32 * 1024 * 1024, timeout: 15_000 })
      .then((r) => r.stdout, (error: { stdout?: string }) => error.stdout ?? '');
  }
  return diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n… (diff cut short)` : diff;
}

const HIDDEN = new Set(['.git', 'node_modules', '.DS_Store']);

/** One folder of the session's tree: folders first, then files. */
export async function listTree(cwd: string, relative: string): Promise<TreeEntry[]> {
  const dir = inside(cwd, relative);
  const names = await readdir(dir, { withFileTypes: true });
  const entries: TreeEntry[] = [];
  for (const entry of names) {
    if (HIDDEN.has(entry.name)) continue;
    const rel = path.relative(cwd, path.join(dir, entry.name));
    if (entry.isDirectory()) entries.push({ name: entry.name, path: rel, dir: true });
    else if (entry.isFile() || entry.isSymbolicLink()) {
      const size = await stat(path.join(dir, entry.name)).then((s) => (s.isDirectory() ? -1 : s.size), () => undefined);
      if (size === -1) entries.push({ name: entry.name, path: rel, dir: true });
      else entries.push({ name: entry.name, path: rel, dir: false, ...(size !== undefined ? { size } : {}) });
    }
  }
  return entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

const IMAGE: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };

/** A file to read on the phone: text up to half a megabyte, images as data, other binaries named only. */
export async function readProjectFile(cwd: string, relative: string): Promise<FileContent> {
  const full = inside(cwd, relative);
  const info = await stat(full);
  const ext = path.extname(full).slice(1).toLowerCase();
  const handle = await open(full, 'r');
  try {
    if (IMAGE[ext] && info.size <= 4 * 1024 * 1024) {
      const data = Buffer.alloc(info.size);
      await handle.read(data, 0, info.size, 0);
      return { path: relative, size: info.size, image: `data:${IMAGE[ext]};base64,${data.toString('base64')}` };
    }
    const length = Math.min(info.size, MAX_FILE);
    const data = Buffer.alloc(length);
    await handle.read(data, 0, length, 0);
    if (data.subarray(0, 8000).includes(0)) return { path: relative, size: info.size, binary: true };
    return { path: relative, size: info.size, text: data.toString('utf8'), ...(info.size > MAX_FILE ? { truncated: true } : {}) };
  } finally {
    await handle.close();
  }
}
