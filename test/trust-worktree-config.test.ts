// security#1 "Use my settings only" with the filter in config.worktree, worktreeConfig = 2.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, expect, it } from 'vitest';

const { config } = await import('../src/server/config');
const trust = await import('../src/server/trust');
let root: string;
const saved = { ...config };
const gitEnv = (extra: Record<string, string> = {}) => ({ ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1', ...extra });
const gitIn = (dir: string, args: string[], extra: Record<string, string> = {}) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: dir, env: gitEnv(extra), stdio: ['ignore', 'pipe', 'pipe'] }).toString();
beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'recheck-sec1b-')));
  config.claudeHome = path.join(root, 'claude');
  config.stateDir = path.join(root, 'state');
  config.configDir = path.join(root, 'config');
});
afterAll(async () => {
  Object.assign(config, saved);
  await rm(root, { recursive: true, force: true });
});

it('a folder with a hook (so the sheet shows) and the filter in config.worktree, worktreeConfig = 2', async () => {
  trust.forgetTrust();
  const dir = path.join(root, 'repo');
  const marker = path.join(root, 'ran');
  await mkdir(path.join(dir, '.claude'), { recursive: true });
  gitIn(dir, ['init', '-q', '-b', 'main']);
  await writeFile(path.join(dir, '.gitattributes'), '*.dat filter=evil\n');
  await writeFile(path.join(dir, 'a.dat'), 'one\n');
  gitIn(dir, ['add', '-A']);
  gitIn(dir, ['commit', '-q', '-m', 'x']);
  await rm(path.join(dir, 'a.dat'));
  await new Promise((r) => setTimeout(r, 20));
  await writeFile(path.join(dir, 'a.dat'), 'one\n');
  await writeFile(path.join(dir, '.git', 'config'), `${await readFile(path.join(dir, '.git', 'config'), 'utf8')}[extensions]\n\tworktreeConfig = 2\n`);
  await writeFile(path.join(dir, '.git', 'config.worktree'), `[filter "evil"]\n\tclean = sh -c 'echo ran >> ${marker} && cat'\n`);
  await writeFile(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } }));
  const brings = await trust.folderBrings(dir);
  await trust.rememberChoice(dir, 'user-only');
  const launch = await trust.launchFor(dir);
  gitIn(dir, ['--no-optional-locks', 'status', '--short', '--ignore-submodules=dirty'], launch.env ?? {});
  const ranIt = (await readFile(marker, 'utf8').catch(() => '')).includes('ran');
  console.log(JSON.stringify({ brings, launch, filterRanUnderUserOnly: ranIt }));
  expect(ranIt).toBe(false);
});
