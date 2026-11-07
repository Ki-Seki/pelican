// What a repository's git config makes git run, read the way git reads it: through includes, from
// a worktree's own config, with keys on the section line and git's own folding of names.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { config } from '../src/server/config';
import { folderBrings, forgetTrust, launchFor, NeedsTrust, rememberChoice } from '../src/server/trust';

let root: string;
const saved = { ...config };

const gitEnv = (extra: Record<string, string> = {}) => ({ ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1', ...extra });
const gitIn = (dir: string, args: string[], extra: Record<string, string> = {}) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: dir, env: gitEnv(extra), stdio: ['ignore', 'pipe', 'pipe'] }).toString();

/**
 * A repository as a tarball brings it: a committed a.dat that its .gitattributes sends through the
 * filter "evil", unpacked again so git must look at its content (which runs the filter), and the
 * config given added to .git/config. CMD is a command that notes it ran.
 */
async function unpacked(name: string, configText: string, files: Record<string, string> = {}): Promise<{ dir: string; ran: () => Promise<boolean> }> {
  const dir = path.join(root, name);
  const marker = path.join(root, `${name}.ran`);
  await mkdir(dir, { recursive: true });
  gitIn(dir, ['init', '-q', '-b', 'main']);
  await writeFile(path.join(dir, '.gitattributes'), '*.dat filter=evil\n');
  await writeFile(path.join(dir, 'a.dat'), 'one\n');
  gitIn(dir, ['add', '-A']);
  gitIn(dir, ['commit', '-q', '-m', 'x']);
  await dirty(dir);
  const cmd = `sh -c 'echo ran >> ${marker} && cat'`;
  await writeFile(path.join(dir, '.git', 'config'), (await readFile(path.join(dir, '.git', 'config'), 'utf8')) + configText.replaceAll('CMD', cmd));
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), text.replaceAll('CMD', cmd));
  }
  return { dir, ran: async () => (await readFile(marker, 'utf8').catch(() => '')).includes('ran') };
}

/** The file written again, as unpacking does: git has to read it (through the filter) to know it is unchanged. */
async function dirty(dir: string): Promise<void> {
  await rm(path.join(dir, 'a.dat'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeFile(path.join(dir, 'a.dat'), 'one\n');
}

/** What git does in the folder when Claude Code starts with "Use my settings only". */
async function statusUserOnly(dir: string): Promise<Record<string, string>> {
  await rememberChoice(dir, 'user-only');
  const launch = await launchFor(dir);
  expect(launch.settingSources).toEqual(['user']);
  gitIn(dir, ['status', '--short'], launch.env ?? {});
  return launch.env ?? {};
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pelican-trust-git-')));
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
  config.claudeHome = path.join(root, 'claude');
  config.stateDir = path.join(root, 'state');
  config.configDir = path.join(root, 'config');
});

beforeEach(async () => {
  forgetTrust();
  await rm(config.stateDir, { recursive: true, force: true });
});

afterAll(async () => {
  Object.assign(config, saved);
  await rm(root, { recursive: true, force: true });
});

describe('a git filter the repository’s config sets up', () => {
  const forms: Array<[string, string, Record<string, string>?]> = [
    ['in its own section', '[filter "evil"]\n\tclean = CMD\n'],
    ['with the key on the section line', '[filter "evil"] clean = CMD\n'],
    ['in an included file', '[include]\n\tpath = ../.gitfilters\n', { '.gitfilters': '[filter "evil"]\n\tclean = CMD\n' }],
    ['in a file included on a condition that holds', '[includeIf "onbranch:main"]\n\tpath = ../.gitfilters\n', { '.gitfilters': '[filter "evil"]\n\tclean = CMD\n' }],
    ['in the worktree’s own config', '[extensions]\n\tworktreeConfig = true\n', { '.git/config.worktree': '[filter "evil"]\n\tclean = CMD\n' }],
    ['in the old [filter.Evil] form, which git folds to lower case', '[filter.Evil]\n\tclean = CMD\n'],
  ];

  for (const [form, text, files] of forms) {
    it(`${form}: is asked about, and git does not run it with the user’s settings only`, async () => {
      const { dir, ran } = await unpacked(form.replace(/\W+/g, '-'), text, files);
      const brings = await folderBrings(dir);
      expect(brings.some((item) => item.startsWith('Git filter evil: ') && item.includes('echo ran'))).toBe(true);
      await expect(launchFor(dir)).rejects.toBeInstanceOf(NeedsTrust);
      // Reading the config ran nothing.
      expect(await ran()).toBe(false);
      await statusUserOnly(dir);
      expect(await ran()).toBe(false);
      // And the repository really does run it otherwise.
      await dirty(dir);
      gitIn(dir, ['status', '--short']);
      expect(await ran()).toBe(true);
    });
  }

  it('in a file included only on another branch: listed, and off with the user’s settings only after a switch to that branch', async () => {
    const { dir, ran } = await unpacked('later', '[includeIf "onbranch:dev"]\n\tpath = ../.devfilters\n', { '.devfilters': '[filter "evil"]\n\tclean = CMD\n' });
    const brings = await folderBrings(dir);
    expect(brings).toEqual(expect.arrayContaining([expect.stringMatching(/^Git filter evil: /), 'Git config includes: ../.devfilters']));
    const env = await statusUserOnly(dir);
    gitIn(dir, ['checkout', '-q', '-b', 'dev'], env);
    gitIn(dir, ['status', '--short'], env);
    expect(await ran()).toBe(false);
  });

  it('in a file included on a condition of a megabyte with a line separator in it: listed, at once', async () => {
    const condition = `onbranch:dev${'a'.repeat(1 << 20)}\u2028x`;
    const { dir } = await unpacked('separator', `[includeIf "${condition}"]\n\tpath = ../.devfilters\n`, { '.devfilters': '[filter "evil"]\n\tclean = CMD\n' });
    const started = performance.now();
    const brings = await folderBrings(dir);
    expect(performance.now() - started).toBeLessThan(5000);
    expect(brings).toEqual(expect.arrayContaining([expect.stringMatching(/^Git filter evil: /), 'Git config includes: ../.devfilters']));
  });

  it('says that the config includes another file, even one that is not there yet', async () => {
    const { dir } = await unpacked('missing', '[include]\n\tpath = ../.later\n');
    expect(await folderBrings(dir)).toContain('Git config includes: ../.later');
  });

  it('is asked about when git cannot read the config at all', async () => {
    const { dir } = await unpacked('broken', '[filter "evil"\n\tclean = CMD\n');
    expect(await folderBrings(dir)).toContain('Git config that git could not read');
  });

  it('turns off the file-system monitor and hooks folder of the worktree’s config too', async () => {
    const { dir } = await unpacked('monitor', '[extensions]\n\tworktreeConfig = true\n', { '.git/config.worktree': '[core]\n\tfsmonitor = ./watch.sh\n\thooksPath = .hooks\n' });
    expect(await folderBrings(dir)).toEqual(expect.arrayContaining(['Git fsmonitor: ./watch.sh', 'Git hooks folder: .hooks']));
    await rememberChoice(dir, 'user-only');
    const env = (await launchFor(dir)).env ?? {};
    const pairs = Object.keys(env).filter((k) => k.startsWith('GIT_CONFIG_KEY_')).map((k) => `${env[k]}=${env[k.replace('KEY', 'VALUE')]}`);
    expect(pairs).toEqual(expect.arrayContaining(['core.fsmonitor=false', 'core.hooksPath=/dev/null']));
  });
}, 20_000);

describe('a folder git does not see as a repository of its own', () => {
  it('brings nothing of git: an empty .git, or a repository without a config file', async () => {
    const empty = path.join(root, 'empty-dot-git');
    await mkdir(path.join(empty, '.git'), { recursive: true });
    expect(await folderBrings(empty)).toEqual([]);
    const bare = path.join(root, 'no-config');
    await mkdir(bare, { recursive: true });
    gitIn(bare, ['init', '-q', '-b', 'main']);
    await rm(path.join(bare, '.git', 'config'));
    expect(await folderBrings(bare)).toEqual([]);
    await rememberChoice(bare, 'user-only');
    expect(await launchFor(bare)).toEqual({ settingSources: ['user'] });
  });
}, 20_000);
