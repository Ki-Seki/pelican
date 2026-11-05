// security#1 does folder trust see what git runs?
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const { config } = await import('../src/server/config');
const trust = await import('../src/server/trust');

let root: string;
const saved = { ...config };
const gitEnv = (extra: Record<string, string> = {}) => ({ ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1', ...extra });
const gitIn = (dir: string, args: string[], extra: Record<string, string> = {}) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: dir, env: gitEnv(extra), stdio: ['ignore', 'pipe', 'pipe'] }).toString();

async function unpacked(name: string, configText: string, files: Record<string, string> = {}) {
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
async function dirty(dir: string) {
  await rm(path.join(dir, 'a.dat'));
  await new Promise((r) => setTimeout(r, 20));
  await writeFile(path.join(dir, 'a.dat'), 'one\n');
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'recheck-sec1-')));
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
  config.claudeHome = path.join(root, 'claude');
  config.stateDir = path.join(root, 'state');
  config.configDir = path.join(root, 'config');
});
beforeEach(async () => {
  trust.forgetTrust();
  await rm(config.stateDir, { recursive: true, force: true });
});
afterAll(async () => {
  Object.assign(config, saved);
  await rm(root, { recursive: true, force: true });
});

describe('original forms', () => {
  const forms: Array<[string, string, Record<string, string>?]> = [
    ['include', '[include]\n\tpath = ../.gitfilters\n', { '.gitfilters': '[filter "evil"]\n\tclean = CMD\n' }],
    ['includeIf', '[includeIf "onbranch:main"]\n\tpath = ../.gitfilters\n', { '.gitfilters': '[filter "evil"]\n\tclean = CMD\n' }],
    ['sameline', '[filter "evil"] clean = CMD\n'],
    ['worktree-true', '[extensions]\n\tworktreeConfig = true\n', { '.git/config.worktree': '[filter "evil"]\n\tclean = CMD\n' }],
    ['dotted', '[filter.Evil]\n\tclean = CMD\n'],
  ];
  for (const [name, text, files] of forms) {
    it(`${name}: listed, launch refused, user-only turns it off`, async () => {
      const { dir, ran } = await unpacked(name, text, files);
      const brings = await trust.folderBrings(dir);
      expect(brings.some((b: string) => b.startsWith('Git filter'))).toBe(true);
      await expect(trust.launchFor(dir)).rejects.toBeInstanceOf(trust.NeedsTrust);
      await trust.rememberChoice(dir, 'user-only');
      const launch = await trust.launchFor(dir);
      gitIn(dir, ['--no-optional-locks', 'status', '--short', '--ignore-submodules=dirty'], launch.env ?? {});
      expect(await ran()).toBe(false);
    }, 20_000);
  }
});

describe('variants', () => {
  for (const value of ['2', '1k', '0x1', '-1']) {
    it(`config.worktree with extensions.worktreeConfig = ${value} (git reads it as true)`, async () => {
      const { dir, ran } = await unpacked(`wtc-${value}`, `[extensions]\n\tworktreeConfig = ${value}\n`, { '.git/config.worktree': '[filter "evil"]\n\tclean = CMD\n' });
      const brings = await trust.folderBrings(dir);
      let launch: unknown;
      try { launch = await trust.launchFor(dir); } catch (e) { launch = e instanceof trust.NeedsTrust ? 'NeedsTrust' : String(e); }
      gitIn(dir, ['--no-optional-locks', 'status', '--short', '--ignore-submodules=dirty']);
      console.log(`worktreeConfig=${value}`, JSON.stringify({ brings, launch, gitRanFilter: await ran() }));
      expect(brings.some((b: string) => b.startsWith('Git filter'))).toBe(true);
    }, 20_000);
  }

  it('a folder that is itself a git directory with core.worktree (no .git entry)', async () => {
    const src = path.join(root, 'bare-src');
    await mkdir(src, { recursive: true });
    gitIn(src, ['init', '-q', '-b', 'main']);
    await writeFile(path.join(src, '.gitattributes'), '*.dat filter=evil\n');
    await writeFile(path.join(src, 'a.dat'), 'one\n');
    gitIn(src, ['add', '-A']);
    gitIn(src, ['commit', '-q', '-m', 'x']);
    const dir = path.join(root, 'bare');
    await cp(path.join(src, '.git'), dir, { recursive: true });
    await cp(path.join(src, '.gitattributes'), path.join(dir, '.gitattributes'));
    await cp(path.join(src, 'a.dat'), path.join(dir, 'a.dat'));
    const marker = path.join(root, 'bare.ran');
    await writeFile(path.join(dir, 'config'), `${await readFile(path.join(dir, 'config'), 'utf8')}[core]\n\tbare = false\n\tworktree = .\n[filter "evil"]\n\tclean = sh -c 'echo ran >> ${marker} && cat'\n`);
    await dirty(dir);
    const brings = await trust.folderBrings(dir);
    let launch: unknown;
    try { launch = await trust.launchFor(dir); } catch (e) { launch = e instanceof trust.NeedsTrust ? 'NeedsTrust' : String(e); }
    gitIn(dir, ['--no-optional-locks', 'status', '--short', '--ignore-submodules=dirty']);
    const ranIt = (await readFile(marker, 'utf8').catch(() => '')).includes('ran');
    console.log('bare-with-worktree', JSON.stringify({ brings, launch, gitRanFilter: ranIt }));
    expect(brings.some((b: string) => b.startsWith('Git filter'))).toBe(true);
  }, 20_000);
});
