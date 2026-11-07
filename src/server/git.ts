import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { config } from './config.js';

const run = promisify(execFile);

/**
 * Git runs only in folders Claude Code has worked in (see trust.ts), where the repository's
 * config is the user's own. Even there Pelican only reads, so it starts nothing git would start
 * on the side: no hooks, no file-system monitor, no external diff, diff driver or text converter,
 * no pager, and no transport at all, so no SSH command, credential helper or password prompt,
 * not even for a partial clone's missing objects (which git would otherwise fetch on its own). It
 * runs git's own commands, which no alias stands for. It takes no locks the user's own git would
 * trip over, never asks for credentials, reads pathspecs literally (`:/` is a name, not "the top
 * of the repository"), and leaves submodules' work trees alone.
 */
const SAFE = ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'safe.bareRepository=explicit', '-c', 'core.quotepath=off'];

/** Git's variables that pick a repository or add settings of their own: the folder decides, not whatever Pelican was started with. */
const REPOSITORY_VARIABLES = /^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|CEILING_DIRECTORIES)$/;

/** `env` without git's variables that pick a repository or add settings (REPOSITORY_VARIABLES). */
export function withoutRepository(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) if (!REPOSITORY_VARIABLES.test(name)) kept[name] = value;
  return kept;
}

function environment(): NodeJS.ProcessEnv {
  // No transport is allowed (an empty list, which the repository's protocol settings cannot widen), and none is tried for a missing object.
  const env: NodeJS.ProcessEnv = { ...withoutRepository(process.env), GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1', GIT_ALLOW_PROTOCOL: '', GIT_NO_LAZY_FETCH: '1' };
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

/** Runs a read-only git command in `cwd`; rejects on a non-zero exit, with stdout on the error. */
export async function git(cwd: string, args: string[], timeout = 15_000): Promise<string> {
  const command = args[0]!;
  const extra = command === 'diff' ? ['--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty']
    : command === 'status' ? ['--ignore-submodules=dirty']
      : [];
  const { stdout } = await run('git', [...SAFE, command, ...extra, ...args.slice(1)], { cwd, env: environment(), maxBuffer: 32 * 1024 * 1024, timeout });
  return stdout;
}
