import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { gitDiff, githubRepo, gitStatus, inside, listTree, readProjectFile, UNTRACKED_COUNTED } from '../src/server/workspace';
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
  });

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
  });

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
  });

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
  });

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
      // As /diff lists them: what is not committed yet first, then what only the branch's commits changed.
      expect(since.files.map((f) => [f.path, Boolean(f.committed)])).toEqual([['b.txt', false], ['c.txt', false], ['a.txt', true]]);
      expect(since).toMatchObject({ base: 'main', split: true, uncommitted: 2 });
      // On the default branch itself, all of it is what is not committed yet, compared with main as it is.
      git('stash', '-q', '-u');
      git('switch', '-q', 'main');
      const onMain = await gitStatus(work, 'base');
      expect(onMain).toMatchObject({ base: 'main', files: [], uncommitted: 0 });
      expect(onMain.repo && onMain.split).toBeFalsy();
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  // Claude Code's /diff (2.1.318): the branch against where it meets the default branch only when it
  // has commits beyond it, the newer of origin's and the local one; otherwise the last commit.
  it('compares all of it as Claude Code’s /diff does: the newer of origin’s and the local split, or the last commit', async () => {
    const work = await mkdtemp(path.join(os.tmpdir(), 'pelican-rule-'));
    const git = (...args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: work }).toString().trim();
    try {
      git('init', '-q', '-b', 'main');
      await writeFile(path.join(work, 'a.txt'), 'one\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'first');
      // A branch with nothing committed of its own: all of it is what is not committed, against main.
      git('switch', '-q', '-c', 'feat/fresh');
      await writeFile(path.join(work, 'a.txt'), 'one\ntwo\n');
      const fresh = await gitStatus(work, 'base');
      expect(fresh).toMatchObject({ branch: 'feat/fresh', base: 'main', uncommitted: 1 });
      expect(fresh.repo && fresh.split).toBeFalsy();
      expect(fresh.repo && fresh.files.map((f) => [f.path, f.added])).toEqual([['a.txt', 1]]);
      git('checkout', '-q', '--', 'a.txt');
      // origin's main is ahead of the local one, and the branch starts from it: that is where it splits.
      git('switch', '-q', 'main');
      await writeFile(path.join(work, 'b.txt'), 'b\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'second');
      const second = git('rev-parse', 'HEAD');
      git('update-ref', 'refs/remotes/origin/main', second);
      git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
      git('reset', '-q', '--hard', 'HEAD~1');
      git('switch', '-q', '-c', 'feat/ahead', second);
      await writeFile(path.join(work, 'c.txt'), 'c\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'third');
      const ahead = await gitStatus(work, 'base');
      if (!ahead.repo) throw new Error('not a repository');
      expect(ahead).toMatchObject({ base: 'main', split: true, uncommitted: 0 });
      // Against the local main, b.txt would show as changed; against origin's, only c.txt is the branch's.
      expect(ahead.files.map((f) => f.path)).toEqual(['c.txt']);
      expect(await gitDiff(work, 'c.txt', 'base')).toContain('+c');
      // A detached head has no branch to compare: the last commit.
      git('switch', '-q', '--detach', 'HEAD');
      const detached = await gitStatus(work, 'base');
      expect(detached.repo && detached.base).toBeUndefined();
      expect(detached.repo && detached.files).toEqual([]);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('names the GitHub repository origin points at, as Claude Desktop reads its address', async () => {
    expect(githubRepo('git@github.com:acme/web.git')).toBe('acme/web');
    expect(githubRepo('https://github.com/acme/web.git')).toBe('acme/web');
    expect(githubRepo('https://github.com/acme/web')).toBe('acme/web');
    expect(githubRepo('https://user@github.com/acme/web.git/')).toBe('acme/web');
    expect(githubRepo('ssh://git@ssh.github.com:443/acme/web.git')).toBe('acme/web');
    expect(githubRepo('https://GitHub.com/acme/web.git')).toBe('acme/web');
    for (const elsewhere of ['https://gitlab.com/acme/web.git', 'git@git.example.com:acme/web.git', '/tmp/remotes/web.git', 'file:///tmp/web.git', 'https://github.com/acme', 'https://github.com/acme/../web', 'https://github.com.evil.example/acme/web']) {
      expect(githubRepo(elsewhere)).toBeUndefined();
    }
    const work = await mkdtemp(path.join(os.tmpdir(), 'pelican-github-'));
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: work });
      execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/web.git'], { cwd: work });
      expect(await gitStatus(work)).toMatchObject({ remote: true, github: 'acme/web' });
      execFileSync('git', ['remote', 'set-url', 'origin', '/tmp/remotes/web.git'], { cwd: work });
      const local = await gitStatus(work);
      expect(local).toMatchObject({ remote: true });
      expect(local.repo && local.github).toBeUndefined();
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

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

  it('reads a file whose extension names what every object has as text, never as a picture', async () => {
    for (const name of ['page.constructor', 'page.__proto__']) {
      await writeFile(path.join(repo, name), '<h1>Hi</h1>\n');
      expect(await readProjectFile(repo, name)).toEqual({ path: name, size: 12, text: '<h1>Hi</h1>\n' });
    }
  });
}, 20_000);
