import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { app } from '../src/server/app';
import { config } from '../src/server/config';
import { listCompletions } from '../src/server/models';
import { gitDiff, gitStatus } from '../src/server/workspace';

let root: string;
let repo: string;
let marker: string;
const ran = () => readFile(marker, 'utf8').catch(() => '');
const saved = { ...config };
const savedHome = process.env.CLAUDE_CONFIG_DIR;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'pelican-git-'));
  // No Claude Code sessions anywhere: no folder counts as one Claude has worked in.
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
  config.claudeHome = path.join(root, 'claude');
  config.stateDir = path.join(root, 'state');
});
const kept = { claudeExecutable: config.claudeExecutable, auth: config.auth };
afterEach(() => {
  Object.assign(config, kept);
});

// Each test has a repository of its own, with a change to a.txt and a new b.txt.
beforeEach(async () => {
  repo = await mkdtemp(path.join(root, 'repo-'));
  marker = `${repo}.ran`;
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo });
  git('init', '-q', '-b', 'main');
  await writeFile(path.join(repo, 'a.txt'), 'one\n');
  await writeFile(path.join(repo, '.gitattributes'), '*.txt diff=evil\n*.dat filter=evil\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  // What a folder from somewhere else can bring: a diff driver, an external diff, a monitor, hooks.
  git('config', 'diff.evil.textconv', `sh -c 'echo textconv >> ${marker}; cat "$1"' --`);
  git('config', 'diff.external', `sh -c 'echo external >> ${marker}' --`);
  git('config', 'core.fsmonitor', `sh -c 'echo fsmonitor >> ${marker}' --`);
  git('config', 'filter.evil.clean', `sh -c 'echo clean >> ${marker}; cat'`);
  await mkdir(path.join(repo, '.git', 'hooks'), { recursive: true });
  const hook = path.join(repo, '.git', 'hooks', 'post-index-change');
  await writeFile(hook, `#!/bin/sh\necho hook >> ${marker}\n`);
  await chmod(hook, 0o755);
  await writeFile(path.join(repo, 'a.txt'), 'two\n');
  await writeFile(path.join(repo, 'b.txt'), 'new\n');
});
afterAll(async () => {
  Object.assign(config, saved);
  if (savedHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedHome;
  await rm(root, { recursive: true, force: true });
});

describe('git', () => {
  it('in a folder Claude has worked in, shows the changes and starts nothing on the side', async () => {
    const status = await gitStatus(repo);
    if (!status.repo) throw new Error('not a repository');
    expect(status.files.map((f) => f.path).sort()).toEqual(['a.txt', 'b.txt']);
    expect(await gitDiff(repo, 'a.txt')).toContain('+two');
    expect(await gitDiff(repo, 'b.txt')).toContain('+new');
    expect(await ran()).toBe('');
  });

  it('reads a path as a name, and never one with ..', async () => {
    expect(await gitDiff(repo, ':/')).toBe('');
    await expect(gitDiff(repo, 'x/../a.txt')).rejects.toThrow(/outside/);
  });

  it('in a folder nobody trusted, does not run for / and @ either: Claude Code looks from the home folder', async () => {
    const launched = path.join(root, 'launched');
    const fake = path.join(root, 'claude-fake');
    await writeFile(fake, `#!/bin/sh\n{ echo "cwd=$(pwd)"; for a in "$@"; do echo "arg=$a"; done; } > ${launched}\nexit 1\n`);
    await chmod(fake, 0o755);
    config.claudeExecutable = fake;
    // A tracked file the filter applies to, changed on disk: git status would run the filter.
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null', '-c', 'filter.evil.clean=cat', '-c', 'core.fsmonitor=false', 'add', '-A'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null', '-c', 'filter.evil.clean=cat', '-c', 'core.fsmonitor=false', 'commit', '-q', '-m', 'dat'], { cwd: repo });
    await writeFile(path.join(repo, 'c.dat'), 'changed\n');
    await expect(listCompletions(repo)).rejects.toThrow();
    const log = await readFile(launched, 'utf8');
    expect(log).toContain(`cwd=${await realpath(os.homedir())}\n`);
    expect(log).toContain('arg=--setting-sources=user\n');
    expect(log).toContain('arg={"disableAllHooks":true}\n');
    expect(await ran()).toBe('');
  });

  it('in a folder Claude has not worked in, does not run at all', async () => {
    config.auth = 'none';
    await writeFile(path.join(repo, 'c.dat'), 'filtered\n');
    const response = await app.request(`/api/git?cwd=${encodeURIComponent(repo)}`, { headers: { host: 'localhost:7860', 'x-pelican': '1' } });
    expect(await response.json()).toEqual({ repo: false, untrusted: true });
    expect(await ran()).toBe('');
  });
});
