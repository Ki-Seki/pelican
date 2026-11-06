import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { gitDiff, gitStatus, inside, listTree, readProjectFile, UNTRACKED_COUNTED } from '../src/server/workspace';
import { headerOnly } from '../src/web/lib/diff-header';

let repo: string;
beforeAll(async () => {
  repo = await mkdtemp(path.join(os.tmpdir(), 'pelican-workspace-'));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' },
  });
  git('init', '-q', '-b', 'main');
  await mkdir(path.join(repo, 'src'));
  await writeFile(path.join(repo, 'src', 'a.ts'), 'one\ntwo\n');
  await writeFile(path.join(repo, 'old name.txt'), 'kept\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  await writeFile(path.join(repo, 'src', 'a.ts'), 'one\n2\nthree\n');
  await writeFile(path.join(repo, 'new.md'), '# hi\nthere\n');
  git('mv', 'old name.txt', 'new name.txt');
});
afterAll(() => rm(repo, { recursive: true, force: true }));

describe('workspace', () => {
  it('lists changes with their kind and line counts, also for new and renamed files', async () => {
    const status = await gitStatus(repo);
    expect(status.repo).toBe(true);
    if (!status.repo) return;
    expect(status.branch).toBe('main');
    const byPath = Object.fromEntries(status.files.map((f) => [f.path, f]));
    expect(byPath['src/a.ts']).toMatchObject({ status: 'modified', added: 2, removed: 1 });
    expect(byPath['new.md']).toMatchObject({ status: 'untracked', added: 2 });
    expect(byPath['new name.txt']).toMatchObject({ status: 'renamed', from: 'old name.txt' });
  });

  it('says whether there is a remote to push to, from the config alone', async () => {
    const work = await mkdtemp(path.join(os.tmpdir(), 'pelican-remote-'));
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: work });
      const local = await gitStatus(work);
      expect(local.repo && local.remote).toBeFalsy();
      // An address nothing answers at: knowing there is a remote contacts none.
      execFileSync('git', ['remote', 'add', 'origin', 'https://git.invalid/acme/app.git'], { cwd: work });
      const pushable = await gitStatus(work);
      expect(pushable.repo && pushable.remote).toBe(true);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }, 15_000);

  // A system or managed git config can set `remote.origin.fetch` alone, so that `git remote`
  // names origin in every repository; without an address there is nowhere to push.
  it('finds no remote in a repository whose system or global config names one with no address', async () => {
    const work = await mkdtemp(path.join(os.tmpdir(), 'pelican-remote-'));
    const saved = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_SYSTEM, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
    try {
      execFileSync('git', ['init', '-q', '-b', 'feat/x'], { cwd: work });
      const config = path.join(work, 'shared.gitconfig');
      await writeFile(config, '[remote "origin"]\n\tfetch = ^refs/heads/mergeQueue-*\n');
      process.env.GIT_CONFIG_GLOBAL = config;
      expect(execFileSync('git', ['remote'], { cwd: work, encoding: 'utf8' }).trim()).toBe('origin');
      const global = await gitStatus(work);
      expect(global.repo && global.remote).toBeFalsy();
      process.env.GIT_CONFIG_GLOBAL = os.devNull;
      delete process.env.GIT_CONFIG_NOSYSTEM;
      process.env.GIT_CONFIG_SYSTEM = config;
      const system = await gitStatus(work);
      expect(system.repo && system.remote).toBeFalsy();
      // With an address, in the repository's own config or only a push address, there is one.
      execFileSync('git', ['config', 'remote.origin.pushurl', 'https://git.invalid/acme/app.git'], { cwd: work });
      const pushOnly = await gitStatus(work);
      expect(pushOnly.repo && pushOnly.remote).toBe(true);
    } finally {
      for (const [name, value] of [['GIT_CONFIG_GLOBAL', saved.global], ['GIT_CONFIG_SYSTEM', saved.system], ['GIT_CONFIG_NOSYSTEM', saved.nosystem]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(work, { recursive: true, force: true });
    }
  }, 15_000);

  it('counts the lines of new files only so far: big ones and those past the first hundred get no count', async () => {
    const many = await mkdtemp(path.join(os.tmpdir(), 'pelican-untracked-'));
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: many });
      await writeFile(path.join(many, 'big.txt'), 'x\n'.repeat(UNTRACKED_COUNTED.bytesEach));
      await writeFile(path.join(many, 'last line.txt'), 'a\nb');
      await mkdir(path.join(many, 'more'));
      for (let i = 0; i < UNTRACKED_COUNTED.files + 20; i += 1) await writeFile(path.join(many, 'more', `${String(i).padStart(3, '0')}.txt`), 'one\n');
      const status = await gitStatus(many);
      if (!status.repo) throw new Error('not a repository');
      const byPath = Object.fromEntries(status.files.map((f) => [f.path, f]));
      expect(byPath['big.txt']?.added).toBeUndefined();
      expect(byPath['last line.txt']?.added).toBe(2);
      expect(status.files.filter((f) => f.added !== undefined).length).toBeLessThanOrEqual(UNTRACKED_COUNTED.files);
    } finally {
      await rm(many, { recursive: true, force: true });
    }
  });

  it('diffs a changed file and a new one', async () => {
    expect(await gitDiff(repo, 'src/a.ts')).toContain('+three');
    expect(await gitDiff(repo, 'new.md')).toContain('+# hi');
  });

  it('diffs a renamed file with its old path: what changed in it, as its row counts, not a whole new file', async () => {
    const work = await mkdtemp(path.join(os.tmpdir(), 'pelican-rename-'));
    const git = (...args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: work });
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}\n`).join('');
    const added = (diff: string) => diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
    try {
      git('init', '-q', '-b', 'main');
      await writeFile(path.join(work, 'old.txt'), lines(50));
      await writeFile(path.join(work, 'kept.txt'), lines(40));
      git('add', '-A');
      git('commit', '-q', '-m', 'first');
      // On a branch: one rename committed since the split, and one staged, not committed yet.
      git('switch', '-q', '-c', 'feat/rename');
      git('mv', 'kept.txt', 'moved.txt');
      await writeFile(path.join(work, 'moved.txt'), lines(40).replace('line 20\n', 'line twenty\n'));
      git('commit', '-q', '-am', 'move');
      git('mv', 'old.txt', 'new.txt');
      await writeFile(path.join(work, 'new.txt'), lines(50).replace('line 25\n', 'line twenty-five\n'));
      git('add', '-A');

      const now = await gitStatus(work);
      if (!now.repo) throw new Error('not a repository');
      expect(now.files.find((f) => f.path === 'new.txt')).toMatchObject({ status: 'renamed', from: 'old.txt', added: 1, removed: 1 });
      const uncommitted = await gitDiff(work, 'new.txt', 'uncommitted', 'old.txt');
      expect(uncommitted).toMatch(/^rename from old\.txt$/m);
      expect(added(uncommitted)).toBe(1);

      const since = await gitStatus(work, 'base');
      if (!since.repo) throw new Error('not a repository');
      expect(since.files.find((f) => f.path === 'moved.txt')).toMatchObject({ status: 'renamed', from: 'kept.txt', added: 1, removed: 1 });
      const base = await gitDiff(work, 'moved.txt', 'base', 'kept.txt');
      expect(base).toMatch(/^rename from kept\.txt$/m);
      expect(added(base)).toBe(1);
      // The old path is held to the folder as the new one is.
      await expect(gitDiff(work, 'new.txt', 'uncommitted', '../outside.txt')).rejects.toThrow();
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }, 15_000);

  it('says of a file renamed whole that it was renamed from its old path, unchanged, also when git quotes the name', async () => {
    const work = await mkdtemp(path.join(os.tmpdir(), 'pelican-rename-'));
    const git = (...args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: work });
    try {
      git('init', '-q', '-b', 'main');
      await writeFile(path.join(work, 'old.txt'), 'a\nb\n');
      await writeFile(path.join(work, 'run.sh'), 'echo hi\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'first');
      git('mv', 'old.txt', 'docs "draft".txt');
      await chmod(path.join(work, 'run.sh'), 0o755);
      const renamed = await gitDiff(work, 'docs "draft".txt', 'uncommitted', 'old.txt');
      // git writes only its header for these: no line changed.
      expect(renamed).not.toContain('@@');
      expect(headerOnly(renamed)).toBe('Renamed from old.txt, unchanged');
      expect(headerOnly(await gitDiff(work, 'run.sh'))).toBe('Made executable');
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }, 15_000);

  it('shows everything since the branch split from the default branch: commits, edits and new files', async () => {
    const work = await mkdtemp(path.join(os.tmpdir(), 'pelican-split-'));
    const git = (...args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: work });
    try {
      git('init', '-q', '-b', 'main');
      await writeFile(path.join(work, 'a.txt'), 'one\n');
      await writeFile(path.join(work, 'b.txt'), 'two\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'first');
      git('switch', '-q', '-c', 'feat/x');
      await writeFile(path.join(work, 'a.txt'), 'one\nmore\n');
      git('commit', '-q', '-am', 'on the branch');
      await writeFile(path.join(work, 'b.txt'), 'changed\n');
      await writeFile(path.join(work, 'c.txt'), 'new\n');
      const now = await gitStatus(work);
      if (!now.repo) throw new Error('not a repository');
      expect(now).toMatchObject({ branch: 'feat/x', base: 'main' });
      expect(now.files.map((f) => f.path).sort()).toEqual(['b.txt', 'c.txt']);
      const since = await gitStatus(work, 'base');
      if (!since.repo) throw new Error('not a repository');
      const byPath = Object.fromEntries(since.files.map((f) => [f.path, f]));
      expect(byPath['a.txt']).toMatchObject({ status: 'modified', added: 1, removed: 0 });
      expect(byPath['b.txt']).toMatchObject({ status: 'modified', added: 1, removed: 1 });
      expect(byPath['c.txt']).toMatchObject({ status: 'untracked', added: 1 });
      expect(await gitDiff(work, 'a.txt', 'base')).toContain('+more');
      expect(await gitDiff(work, 'a.txt')).toBe('');
      // On the default branch itself there is no split to show.
      git('stash', '-q', '-u');
      git('switch', '-q', 'main');
      const onMain = await gitStatus(work, 'base');
      expect(onMain.repo && onMain.files).toEqual([]);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }, 15_000);

  it('says when a folder is not a repository', async () => {
    const plain = await mkdtemp(path.join(os.tmpdir(), 'pelican-plain-'));
    expect(await gitStatus(plain)).toEqual({ repo: false });
    await rm(plain, { recursive: true, force: true });
  });

  it('lists folders first and reads files, never outside the folder', async () => {
    const entries = await listTree(repo, '');
    expect(entries[0]).toMatchObject({ name: 'src', dir: true });
    expect(entries.some((e) => e.name === '.git')).toBe(false);
    expect((await readProjectFile(repo, 'src/a.ts')).text).toBe('one\n2\nthree\n');
    expect(() => inside(repo, '../etc/passwd')).toThrow();
    expect(() => inside(repo, '/etc/passwd')).toThrow();
    await expect(readProjectFile(repo, '../../etc/hosts')).rejects.toThrow();
  });
});
