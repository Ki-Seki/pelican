import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import type { FileContent, GitFile, GitStatus, TreeEntry } from '../shared/protocol.js';
import { git } from './git.js';
import { openRegular } from './open.js';

const MAX_FILE = 512 * 1024;
const MAX_DIFF = 400_000;


const OUTSIDE = 'That path is outside the session’s folder';
const within = (root: string, full: string) => full === root || full.startsWith(`${root}${path.sep}`);

/**
 * A path inside the session's folder, or an error: the panels never reach outside it. No `..`
 * at all: resolving it by the text would cancel a linked folder before the link is checked
 * (`link/../x`), and the panels never ask for one.
 */
export function inside(cwd: string, relative: string): string {
  if ((relative ?? '').split(/[\\/]/).includes('..')) throw new Error(OUTSIDE);
  const root = path.resolve(cwd);
  const full = path.resolve(root, relative || '.');
  if (!within(root, full)) throw new Error(OUTSIDE);
  return full;
}

/** The same, for a path that exists, with links followed: a link may not lead out of the folder either. */
async function insideReal(cwd: string, relative: string): Promise<string> {
  const full = inside(cwd, relative);
  const [root, real] = await Promise.all([realpath(cwd), realpath(full)]);
  if (!within(root, real)) throw new Error(OUTSIDE);
  return real;
}

const KIND: Record<string, GitFile['status']> = { M: 'modified', T: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'added', U: 'conflicted' };

/**
 * The repository the folder is in, when its work tree is the folder or a folder above it. A
 * repository whose config points its work tree somewhere else (core.worktree) would show files
 * from outside: Pelican treats that as no repository.
 */
async function repositoryOf(cwd: string): Promise<string | undefined> {
  try {
    const top = (await git(cwd, ['rev-parse', '--show-toplevel'], 5000)).trim();
    if (!top) return undefined;
    const [root, folder] = await Promise.all([realpath(top), realpath(cwd)]);
    return within(root, folder) ? root : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The repository's default branch, as Claude Code's /diff compares against it ("since your branch
 * split from the default branch"): the one the remote's HEAD names, else a local main or master.
 * `ref` is what git compares with; `name` what people call it.
 */
async function defaultBranch(cwd: string): Promise<{ name: string; ref: string } | undefined> {
  const remote = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], 5000).then((out) => out.trim(), () => '');
  if (/^origin\/[\w./-]+$/.test(remote) && !remote.includes('..')) return { name: remote.slice('origin/'.length), ref: `refs/remotes/${remote}` };
  for (const name of ['main', 'master']) {
    if (await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], 5000).then(() => true, () => false)) return { name, ref: `refs/heads/${name}` };
  }
  return undefined;
}

/** Where the branch split from the default branch, when it is another branch: a commit's full id. */
async function splitPoint(cwd: string, branch: string | undefined): Promise<string | undefined> {
  const base = await defaultBranch(cwd);
  if (!base || !branch || branch === base.name) return undefined;
  const sha = await git(cwd, ['merge-base', 'HEAD', base.ref], 5000).then((out) => out.trim(), () => '');
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : undefined;
}

/**
 * The files changed since a commit, by git's own letters (`git diff --name-status`), renames found
 * as git finds them: committed since then and not, as `git diff <commit>` compares the work tree.
 */
async function changedSince(cwd: string, commit: string): Promise<GitFile[]> {
  const raw = await git(cwd, ['diff', '--name-status', '-M', '-z', '--relative', commit]);
  const fields = raw.split('\0');
  const files: GitFile[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const code = fields[i]!;
    if (!code) continue;
    const kind = code[0]!;
    if (kind === 'R' || kind === 'C') {
      const from = fields[i + 1];
      const to = fields[i + 2];
      i += 2;
      if (to) files.push({ path: to, status: kind === 'R' ? 'renamed' : 'added', ...(kind === 'R' && from ? { from } : {}) });
    } else {
      const file = fields[(i += 1)];
      if (file) files.push({ path: file, status: KIND[kind] ?? 'modified' });
    }
  }
  return files;
}

/**
 * What changed in the session's folder, with line counts: since the last commit (`uncommitted`,
 * the default), or since the branch split from the default branch (`base`), its commits and what
 * is not committed yet, new files included. Also the branch, its upstream, and the default branch.
 */
export async function gitStatus(cwd: string, scope: 'uncommitted' | 'base' = 'uncommitted'): Promise<GitStatus> {
  if (!(await repositoryOf(cwd))) return { repo: false };
  let raw: string;
  let prefix = '';
  try {
    // A session in a folder inside a repository sees that folder's changes, by its own paths.
    prefix = (await git(cwd, ['rev-parse', '--show-prefix'], 5000)).trim();
    raw = await git(cwd, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--', '.']);
  } catch {
    return { repo: false };
  }
  const local = (file: string | undefined) => (file && prefix && file.startsWith(prefix) ? file.slice(prefix.length) : file);
  const out: Extract<GitStatus, { repo: true }> = { repo: true, files: [] };
  const entries = raw.split('\0');
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    if (entry.startsWith('# branch.head ')) {
      const head = entry.slice(14);
      if (head !== '(detached)') out.branch = head;
    } else if (entry.startsWith('# branch.upstream ')) {
      out.upstream = entry.slice(18);
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
      const item: GitFile = { path: local(file)!, status };
      if (entry.startsWith('2 ')) {
        const from = local(entries[i + 1]);
        if (from) item.from = from;
        i += 1;
      }
      out.files.push(item);
    } else if (entry.startsWith('? ')) {
      out.files.push({ path: local(entry.slice(2))!, status: 'untracked' });
    }
  }
  const base = await defaultBranch(cwd).catch(() => undefined);
  if (base) out.base = base.name;
  // Since the branch split: what git diff says changed since then, and the new files status found.
  let since: string | undefined;
  if (scope === 'base') {
    since = await splitPoint(cwd, out.branch);
    if (!since) return { ...out, files: [] };
    const untracked = out.files.filter((f) => f.status === 'untracked');
    try {
      out.files = [...await changedSince(cwd, since), ...untracked];
    } catch {
      out.files = untracked;
    }
  }
  // Line counts against the last commit (or the empty tree before the first one), or the split.
  try {
    const against = since ?? await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']).then(() => 'HEAD', () => '4b825dc642cb6eb9a060e54bf8d69288fbee4904');
    const numstat = await git(cwd, ['diff', '--numstat', '-M', '--relative', '-z', against]);
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
  await countUntracked(cwd, out.files);
  return out;
}

/**
 * Untracked files counted, at most, for their lines: the first ones, small ones, and only so much
 * in all. Each status read used to read up to 200 of them whole (100 MB), every few seconds.
 */
export const UNTRACKED_COUNTED = { files: 100, bytesEach: 256 * 1024, bytesInAll: 4 * 1024 * 1024 };

/**
 * A new file is all added lines; git does not count those for files it does not track yet. Files
 * past the limits, binary ones and special ones get no count (the list shows none).
 */
async function countUntracked(cwd: string, files: GitFile[]): Promise<void> {
  let budget = UNTRACKED_COUNTED.bytesInAll;
  for (const file of files.filter((f) => f.status === 'untracked').slice(0, UNTRACKED_COUNTED.files)) {
    if (budget <= 0) return;
    try {
      const handle = await openRegular(await insideReal(cwd, file.path));
      try {
        const { size } = await handle.stat();
        if (size > UNTRACKED_COUNTED.bytesEach || size > budget) continue;
        budget -= size;
        const data = Buffer.alloc(size);
        await handle.read(data, 0, size, 0);
        if (data.subarray(0, 8000).includes(0)) continue;
        let lines = 0;
        for (let at = data.indexOf(0x0a); at !== -1; at = data.indexOf(0x0a, at + 1)) lines += 1;
        file.added = lines + (size > 0 && data[size - 1] !== 0x0a ? 1 : 0);
      } finally {
        await handle.close();
      }
    } catch {
      // Unreadable, or a link that leads out of the folder: no count.
    }
  }
}

/**
 * The diff of one file against the last commit, or (`base`) against where the branch split from
 * the default branch; an untracked file shows as all added.
 */
export async function gitDiff(cwd: string, file: string, scope: 'uncommitted' | 'base' = 'uncommitted'): Promise<string> {
  if (!(await repositoryOf(cwd))) return '';
  // The file itself may be gone (a deleted file has a diff), but the folder it is in may not lead
  // out of the session's folder through a link.
  const full = inside(cwd, file);
  const [root, parent] = await Promise.all([realpath(cwd), realpath(path.dirname(full)).catch(() => undefined)]);
  if (parent && !within(root, parent)) throw new Error(OUTSIDE);
  let diff = '';
  try {
    const branch = scope === 'base' ? (await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], 5000)).trim() : undefined;
    const against = scope === 'base' ? await splitPoint(cwd, branch) : 'HEAD';
    if (against) diff = await git(cwd, ['diff', '-M', against, '--', file]);
  } catch {
    diff = '';
  }
  // Untracked (or no commits yet): all added. A tracked file with nothing to show has no diff.
  const committed = !diff && await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD'], 5000).then(() => true, () => false);
  const tracked = committed && await git(cwd, ['ls-files', '-z', '--', file], 5000).then((out) => out.length > 0, () => false);
  if (!diff && !tracked) {
    // git diff --no-index exits with 1 when the files differ. `./`: a file named `-` would
    // otherwise be read from stdin.
    diff = await git(cwd, ['diff', '--no-index', '--', '/dev/null', `./${file}`]).catch((error: { stdout?: string }) => error.stdout ?? '');
  }
  return diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n… (diff cut short)` : diff;
}

/** At most this many paths are looked up at once (links in a reply), each this long at most. */
export const EXISTS_MAX = 50;

/**
 * Which of `paths` are files in the session's folder: relative, with no `..`, a real path inside
 * the folder's, and a regular file (not a folder, a pipe or a device). For the links in a reply:
 * a path that is not there gets none. Nothing is read, nothing runs.
 */
export async function existingFiles(cwd: string, paths: readonly string[]): Promise<string[]> {
  const root = await realpath(cwd);
  const found = await Promise.all(paths.slice(0, EXISTS_MAX).map(async (relative) => {
    if (!relative || relative.length > 1024 || path.isAbsolute(relative)) return undefined;
    try {
      const real = await realpath(inside(cwd, relative));
      if (!within(root, real)) return undefined;
      return (await stat(real)).isFile() ? relative : undefined;
    } catch {
      return undefined;
    }
  }));
  return found.filter((p): p is string => Boolean(p));
}

const HIDDEN = new Set(['.git', 'node_modules', '.DS_Store']);

/** One folder of the session's tree: folders first, then files. */
export async function listTree(cwd: string, relative: string): Promise<TreeEntry[]> {
  const dir = await insideReal(cwd, relative);
  const names = await readdir(dir, { withFileTypes: true });
  const entries: TreeEntry[] = [];
  for (const entry of names) {
    if (HIDDEN.has(entry.name)) continue;
    const rel = path.join(relative, entry.name);
    if (entry.isDirectory()) entries.push({ name: entry.name, path: rel, dir: true });
    else if (entry.isFile() || entry.isSymbolicLink()) {
      const size = await stat(path.join(dir, entry.name)).then((s) => (s.isDirectory() ? -1 : s.size), () => undefined);
      if (size === -1) entries.push({ name: entry.name, path: rel, dir: true });
      else entries.push({ name: entry.name, path: rel, dir: false, ...(size !== undefined ? { size } : {}) });
    }
  }
  return entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** A file of the folder opened to be read whole (a download): its real path inside the folder, a regular file. */
export async function openProjectFile(cwd: string, relative: string): Promise<{ handle: Awaited<ReturnType<typeof openRegular>>; size: number }> {
  const handle = await openRegular(await insideReal(cwd, relative));
  try {
    return { handle, size: (await handle.stat()).size };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

const IMAGE: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };

/**
 * A file to read on the phone: text up to half a megabyte, images as data, other binaries named
 * only. A named pipe or a device is not read (`openRegular`): opening one could hold up every
 * file read of the server.
 */
export async function readProjectFile(cwd: string, relative: string): Promise<FileContent> {
  const full = await insideReal(cwd, relative);
  const ext = path.extname(full).slice(1).toLowerCase();
  const handle = await openRegular(full);
  try {
    const info = await handle.stat();
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
