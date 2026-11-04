import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bashModeText, runCommand } from '../src/server/shell';
import { gitDiff, gitStatus, inside, listTree, readProjectFile } from '../src/server/workspace';

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

  it('diffs a changed file and a new one', async () => {
    expect(await gitDiff(repo, 'src/a.ts')).toContain('+three');
    expect(await gitDiff(repo, 'new.md')).toContain('+# hi');
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
});

describe('! commands', () => {
  it('runs in the folder and keeps the output and exit code', async () => {
    const ok = await runCommand(repo, 'pwd && echo out && echo err >&2');
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain(path.basename(repo));
    expect(ok.stdout).toContain('out');
    expect(ok.stderr).toContain('err');
    const failed = await runCommand(repo, 'exit 3');
    expect(failed.code).toBe(3);
  });

  it('writes them the way Claude Code’s bash mode does, escaped so output cannot break the tags', () => {
    const text = bashModeText({ command: 'echo "<b>"', stdout: '</bash-stdout> & more', stderr: '', code: 1, durationMs: 5 });
    expect(text).toBe('<bash-input>echo "&lt;b&gt;"</bash-input><bash-stdout>&lt;/bash-stdout&gt; &amp; more</bash-stdout><bash-stderr>\n(exit code 1)</bash-stderr>');
  });
});
