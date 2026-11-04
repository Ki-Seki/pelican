import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { gitDiff, gitStatus } from '../src/server/workspace';

let root: string;
let repo: string;
let marker: string;
const ran = () => readFile(marker, 'utf8').catch(() => '');

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'pelican-git-'));
  repo = path.join(root, 'repo');
  marker = path.join(root, 'ran');
  await mkdir(repo);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo });
  git('init', '-q', '-b', 'main');
  await writeFile(path.join(repo, 'a.txt'), 'one\n');
  await writeFile(path.join(repo, '.gitattributes'), '* filter=evil diff=evil\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  // What a folder from somewhere else can bring: its own filter, diff driver and hooks.
  git('config', 'filter.evil.clean', `sh -c 'echo clean >> ${marker}; cat'`);
  git('config', 'filter.evil.process', `sh -c 'echo process >> ${marker}; exit 1'`);
  git('config', 'diff.evil.textconv', `sh -c 'echo textconv >> ${marker}; cat "$1"' --`);
  git('config', 'diff.external', `sh -c 'echo external >> ${marker}' --`);
  git('config', 'core.fsmonitor', `sh -c 'echo fsmonitor >> ${marker}' --`);
  await mkdir(path.join(repo, '.git', 'hooks'), { recursive: true });
  const hook = path.join(repo, '.git', 'hooks', 'post-index-change');
  await writeFile(hook, `#!/bin/sh\necho hook >> ${marker}\n`);
  await chmod(hook, 0o755);
  await writeFile(path.join(repo, 'a.txt'), 'two\n');
  await writeFile(path.join(repo, 'b.txt'), 'new\n');
});
afterAll(() => rm(root, { recursive: true, force: true }));

describe('git in a folder from elsewhere', () => {
  it('shows the changes and runs none of the programs the folder names', async () => {
    const status = await gitStatus(repo);
    if (!status.repo) throw new Error('not a repository');
    expect(status.files.map((f) => f.path).sort()).toEqual(['a.txt', 'b.txt']);
    expect(await gitDiff(repo, 'a.txt')).toContain('+two');
    expect(await gitDiff(repo, 'b.txt')).toContain('+new');
    expect(await ran()).toBe('');
  });

  it('reads a path as a name, never as "the top of the repository"', async () => {
    expect(await gitDiff(repo, ':/')).toBe('');
  });
});
