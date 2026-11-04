import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Settings that keep git from running anything a folder brings with it: a
 * repository's own config can name a file-system monitor, an external diff
 * program or text converters, and git would start them just to show a status
 * or a diff. Pelican only reads, so it turns them off, and it takes no locks
 * that would get in the way of the user's own git.
 */
const SAFE = ['-c', 'core.fsmonitor=false', '-c', 'safe.bareRepository=explicit', '-c', 'core.quotepath=off'];
const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };

/** Runs a read-only git command in `cwd`; rejects on a non-zero exit, with stdout on the error. */
export async function git(cwd: string, args: string[], timeout = 15_000): Promise<string> {
  const diff = args[0] === 'diff' ? ['--no-ext-diff', '--no-textconv'] : [];
  const { stdout } = await run('git', [...SAFE, args[0]!, ...diff, ...args.slice(1)], { cwd, env: ENV, maxBuffer: 32 * 1024 * 1024, timeout });
  return stdout;
}
