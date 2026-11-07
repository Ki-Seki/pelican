// What else a repository's git config, and a hooks folder it came with, make git run: an external
// diff, a diff driver's command and text converter, a pager, the program SSH runs as, a password
// prompt and credential helpers, a signing program, aliases, and hooks. Listed when the folder is
// asked about; turned off, with the user's own settings kept, under "Use my settings only"; and
// never run by Changes' own git. Each command here only notes that it ran, in this test's folder.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { config } from '../src/server/config';
import { folderBrings, forgetTrust, launchFor, NeedsTrust, rememberChoice } from '../src/server/trust';
import { gitDiff, gitStatus } from '../src/server/workspace';

let root: string;
const saved = { ...config };
const savedEnv = { global: process.env.GIT_CONFIG_GLOBAL, pager: process.env.PAGER };

/** Git as a person or Claude runs it there: none of this computer's settings, and those given. */
const gitEnv = (extra: Record<string, string> = {}) => ({ ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', ...extra });
const gitIn = (dir: string, args: string[], extra: Record<string, string> = {}, input?: string) =>
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, env: gitEnv(extra), input: input ?? '', encoding: 'utf8', timeout: 20_000 });

/** The repository's own config: each program a command that notes, under its name, that it ran. */
const HOSTILE = (note: (name: string) => string) => `[diff]
\texternal = ${note('external')}
[diff "evil"]
\tcommand = ${note('driver')}
\ttextconv = ${note('textconv')}
[core]
\tpager = ${note('pager')}
\tsshCommand = ${note('ssh')}
\taskPass = ${note('askpass')}
[pager]
\tlog = ${note('pager-log')}
[credential]
\thelper = !${note('helper')}
[credential "https://example.com"]
\thelper = !${note('helper-url')}
[gpg]
\tprogram = ${note('gpg')}
[alias]
\tst = !${note('alias')}
\tlg = -c core.pager=true log
[alias "co"]
\tcommand = !${note('alias-co')}
`;

let dir: string;
let notes: string;
/** What ran, by name. */
const ran = async () => (await readFile(notes, 'utf8').catch(() => '')).split('\n').filter(Boolean);

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pelican-git-programs-')));
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
  Object.assign(config, { claudeHome: path.join(root, 'claude'), stateDir: path.join(root, 'state'), configDir: path.join(root, 'config') });
  notes = path.join(root, 'ran.txt');
  const noter = path.join(root, 'note.sh');
  await writeFile(noter, `#!/bin/sh\necho "$1" >> '${notes}'\n`);
  await chmod(noter, 0o755);
  // A repository as a tarball brings it: a commit, a change since, .gitattributes naming the
  // driver for a.txt; b.md has none, so the external diff is its.
  dir = path.join(root, 'unpacked');
  await mkdir(dir, { recursive: true });
  gitIn(dir, ['init', '-q', '-b', 'main']);
  await writeFile(path.join(dir, '.gitattributes'), '*.txt diff=evil\n');
  await writeFile(path.join(dir, 'a.txt'), 'one\n');
  await writeFile(path.join(dir, 'b.md'), 'one\n');
  gitIn(dir, ['-c', 'core.hooksPath=/dev/null', 'add', '-A']);
  gitIn(dir, ['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'one']);
  await writeFile(path.join(dir, 'a.txt'), 'one\ntwo\n');
  await writeFile(path.join(dir, 'b.md'), 'one\ntwo\n');
  const own = path.join(dir, '.git', 'config');
  await writeFile(own, (await readFile(own, 'utf8')) + HOSTILE((name) => `${noter} ${name}`));
  // Its hooks folder, with two hooks and a sample git ships, which never runs.
  for (const hook of ['pre-commit', 'post-commit']) {
    await writeFile(path.join(dir, '.git', 'hooks', hook), `#!/bin/sh\n${noter} hook-${hook}\n`);
    await chmod(path.join(dir, '.git', 'hooks', hook), 0o755);
  }
});

beforeEach(async () => {
  forgetTrust();
  await rm(config.stateDir, { recursive: true, force: true });
  await rm(notes, { force: true });
  process.env.GIT_CONFIG_GLOBAL = os.devNull;
  delete process.env.PAGER;
});

afterAll(async () => {
  Object.assign(config, saved);
  for (const [name, value] of [['GIT_CONFIG_GLOBAL', savedEnv.global], ['PAGER', savedEnv.pager]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(root, { recursive: true, force: true });
});

describe('the programs a repository’s git config and hooks folder bring', () => {
  it('are each listed when the folder is asked about, and reading them runs nothing', async () => {
    const brings = await folderBrings(dir);
    const note = (name: string) => `${path.join(root, 'note.sh')} ${name}`;
    expect(brings).toEqual(expect.arrayContaining([
      `Git external diff: ${note('external')}`,
      `Git diff driver evil: ${note('driver')}`,
      `Git text converter evil: ${note('textconv')}`,
      `Git pager: ${note('pager')}`,
      `Git pager for log: ${note('pager-log')}`,
      `Git SSH command: ${note('ssh')}`,
      `Git password prompt: ${note('askpass')}`,
      `Git credential helper: !${note('helper')}`,
      `Git credential helper for https://example.com: !${note('helper-url')}`,
      `Git signing program: ${note('gpg')}`,
      `Git alias st: !${note('alias')}`,
      'Git alias lg: -c core.pager=true log',
      `Git alias co: !${note('alias-co')}`,
      'Git hooks: post-commit, pre-commit',
    ]));
    // The sample git puts in every repository is no hook.
    expect(brings.join('\n')).not.toContain('sample');
    await expect(launchFor(dir)).rejects.toBeInstanceOf(NeedsTrust);
    expect(await ran()).toEqual([]);
    // And git does run them otherwise.
    gitIn(dir, ['diff']);
    gitIn(dir, ['st']);
    gitIn(dir, ['credential', 'fill'], {}, 'protocol=https\nhost=example.com\n\n');
    gitIn(dir, ['commit', '-q', '--allow-empty', '-m', 'two']);
    expect(await ran()).toEqual(expect.arrayContaining(['driver', 'external', 'alias', 'helper', 'helper-url', 'hook-pre-commit', 'hook-post-commit']));
  });

  it('run none of theirs with the user’s settings only: git there gets settings that turn each off', async () => {
    await rememberChoice(dir, 'user-only');
    const launch = await launchFor(dir);
    expect(launch.settingSources).toEqual(['user']);
    const env = launch.env ?? {};
    const value = (name: string) => gitIn(dir, ['config', '--get', name], env).stdout.trim();
    // A diff: the external one and the driver's command are of nothing, so git says so and stops.
    const diff = gitIn(dir, ['diff'], env);
    expect(diff.status).not.toBe(0);
    expect(diff.stderr).toMatch(/external diff died/);
    expect(gitIn(dir, ['diff', '--no-ext-diff'], env).stdout).toContain('+two');
    // A text converter shows the file as it is.
    expect(gitIn(dir, ['log', '-p', '--', 'a.txt'], env).stdout).toContain('+one');
    // The pager is the user's, or less; so is each command's.
    expect(gitIn(dir, ['var', 'GIT_PAGER'], env).stdout.trim()).toBe('less');
    expect(value('pager.log')).toBe('true');
    // SSH as ssh, no password prompt, the format's own signing program.
    expect(value('core.sshCommand')).toBe('ssh');
    expect(value('core.askPass')).toBe('');
    expect(value('gpg.program')).toBe('gpg');
    // Aliases of nothing; credential helpers emptied; hooks off.
    expect(gitIn(dir, ['st'], env).stderr).toMatch(/expansion of alias 'st' failed/);
    expect(gitIn(dir, ['co'], env).stderr).toMatch(/expansion of alias 'co' failed/);
    gitIn(dir, ['credential', 'fill'], env, 'protocol=https\nhost=example.com\n\n');
    gitIn(dir, ['commit', '-q', '--allow-empty', '-m', 'three'], env);
    expect(await ran()).toEqual([]);
  });

  it('give way to the user’s own settings of the same names, credential helpers and all', async () => {
    const global = path.join(root, 'gitconfig');
    await writeFile(global, `[alias]\n\tst = status --short\n[core]\n\tpager = more\n[credential]\n\thelper = !${path.join(root, 'note.sh')} mine\n`);
    process.env.GIT_CONFIG_GLOBAL = global;
    process.env.PAGER = 'most';
    await rememberChoice(dir, 'user-only');
    const env = { ...(await launchFor(dir)).env, GIT_CONFIG_GLOBAL: global };
    expect(gitIn(dir, ['st'], env).stdout).toContain('M a.txt');
    expect(gitIn(dir, ['var', 'GIT_PAGER'], env).stdout.trim()).toBe('more');
    gitIn(dir, ['credential', 'fill'], env, 'protocol=https\nhost=example.com\n\n');
    expect(await ran()).toEqual(['mine']);
  });
}, 30_000);

describe('Changes, in a folder trusted with these', () => {
  it('runs none of them: its status, its /diff count and a file’s diff', async () => {
    const status = await gitStatus(dir, 'base');
    expect(status).toMatchObject({ repo: true });
    expect(JSON.stringify(status)).toContain('a.txt');
    expect(await gitDiff(dir, 'a.txt')).toContain('+two');
    expect(await ran()).toEqual([]);
  });

  it('fetches nothing a partial clone lacks: no transport, so no program a remote names', async () => {
    // A clone without its files' contents, whose remote's program would run on a fetch.
    const source = path.join(root, 'source');
    await mkdir(source);
    gitIn(source, ['init', '-q', '-b', 'main']);
    await writeFile(path.join(source, 'big.txt'), 'old\n');
    gitIn(source, ['-c', 'core.hooksPath=/dev/null', 'add', '-A']);
    gitIn(source, ['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'one']);
    gitIn(source, ['config', 'uploadpack.allowFilter', 'true']);
    const partial = path.join(root, 'partial');
    execFileSync('git', ['clone', '-q', '--filter=blob:none', '--no-checkout', `file://${source}`, partial], { env: gitEnv() });
    gitIn(partial, ['config', 'remote.origin.uploadpack', `${path.join(root, 'note.sh')} upload-pack`]);
    gitIn(partial, ['config', 'protocol.file.allow', 'always']);
    await writeFile(path.join(partial, 'big.txt'), 'new\n');
    // Its diff needs the blob it lacks: Pelican's git does not go for it.
    await gitDiff(partial, 'big.txt', 'base').catch(() => '');
    await gitStatus(partial, 'base').catch(() => undefined);
    expect(await ran()).toEqual([]);
  });
}, 30_000);
