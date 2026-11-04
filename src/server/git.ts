import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { config } from './config.js';

const run = promisify(execFile);

/**
 * Settings that keep git from running anything a folder brings with it. Pelican only reads
 * (status, diffs, file lists), but a repository's own config can name programs that git
 * starts just to show a status or a diff: a file-system monitor, hooks (post-index-change),
 * an external diff, text converters, and clean/process filters for the files its attributes
 * name. All of them are turned off here; Pelican takes no locks the user's own git would
 * trip over, never asks for credentials, and reads pathspecs literally (`:/` is a name, not
 * "the top of the repository").
 */
const SAFE = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'safe.bareRepository=explicit', '-c', 'core.quotepath=off'];

function environment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1' };
  if (config.demo) {
    // The demo's folders may sit inside a repository of yours (a home folder kept in git):
    // git must not look above the demo for one.
    try {
      env.GIT_CEILING_DIRECTORIES = path.dirname(realpathSync(config.home));
    } catch {
      env.GIT_CEILING_DIRECTORIES = path.dirname(config.home);
    }
  }
  return env;
}

const filterCache = new Map<string, { at: number; args: string[] }>();

/**
 * `-c filter.<driver>.clean=` and the like for every filter driver the folder's own config
 * defines (local, worktree or included scope). Reading config runs nothing. Drivers from your
 * global or system config, such as Git LFS, are yours and stay as they are.
 */
async function filterOverrides(cwd: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const cached = filterCache.get(cwd);
  if (cached && Date.now() - cached.at < 10_000) return cached.args;
  let listing = '';
  try {
    listing = (await run('git', ['config', '--show-scope', '--includes', '--name-only', '--get-regexp', '^filter\\.'], { cwd, env, timeout: 5000 })).stdout;
  } catch {
    // No filters (git exits with 1), or not a repository.
  }
  const drivers = new Set<string>();
  for (const line of listing.split('\n')) {
    const [scope, name] = line.trim().split(/\s+/);
    if (!scope || !name || scope === 'global' || scope === 'system') continue;
    const driver = /^filter\.(.+)\.[^.]+$/.exec(name)?.[1];
    if (driver) drivers.add(driver);
  }
  const args = [...drivers].flatMap((d) => ['-c', `filter.${d}.clean=`, '-c', `filter.${d}.smudge=`, '-c', `filter.${d}.process=`, '-c', `filter.${d}.required=false`]);
  filterCache.set(cwd, { at: Date.now(), args });
  return args;
}

/** Runs a read-only git command in `cwd`; rejects on a non-zero exit, with stdout on the error. */
export async function git(cwd: string, args: string[], timeout = 15_000): Promise<string> {
  const env = environment();
  const command = args[0]!;
  const extra = command === 'diff' ? ['--no-ext-diff', '--no-textconv', '--ignore-submodules=all']
    : command === 'status' ? ['--ignore-submodules=all']
      : [];
  const filters = await filterOverrides(cwd, env);
  const { stdout } = await run('git', [...SAFE, ...filters, command, ...extra, ...args.slice(1)], { cwd, env, maxBuffer: 32 * 1024 * 1024, timeout });
  return stdout;
}
