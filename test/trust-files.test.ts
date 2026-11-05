// What a folder's own files bring, read without letting the folder hold up the server: a named
// pipe where a settings file should be is not waited on.
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { config } from '../src/server/config';
import { folderBrings, forgetTrust, launchFor, NeedsTrust, trustQuestion } from '../src/server/trust';

let root: string;
const pipes: string[] = [];
const saved = { ...config };

const within = <T>(work: Promise<T>, ms: number): Promise<T | 'still waiting'> =>
  Promise.race([work, new Promise<'still waiting'>((resolve) => setTimeout(() => resolve('still waiting'), ms))]);

async function pipeAt(file: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  execFileSync('mkfifo', [file]);
  pipes.push(file);
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pelican-trust-files-')));
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
  config.claudeHome = path.join(root, 'claude');
  config.stateDir = path.join(root, 'state');
  config.configDir = path.join(root, 'config');
});

beforeEach(() => forgetTrust());

afterAll(async () => {
  // Anything still waiting on a pipe is let go: a writer comes and goes.
  for (const pipe of pipes) await open(pipe, constants.O_WRONLY | constants.O_NONBLOCK).then((handle) => handle.close(), () => undefined);
  Object.assign(config, saved);
  await rm(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('a named pipe in a folder nobody trusted', () => {
  for (const name of ['.mcp.json', '.claude/settings.json', '.claude/settings.local.json']) {
    it(`as ${name}: is asked about at once, and never holds up the server’s other file reads`, async () => {
      const dir = path.join(root, name.replace(/\W+/g, '-'));
      await pipeAt(path.join(dir, name));
      // More than Node's four file threads: any check that waited on the pipe would stall the rest.
      const checks = await Promise.all(Array.from({ length: 6 }, () => within(trustQuestion(dir), 2000)));
      for (const check of checks) expect(check).toEqual({ folder: dir, brings: [`Cannot be read: ${name}`] });
      await expect(within(launchFor(dir), 2000)).rejects.toBeInstanceOf(NeedsTrust);
      const other = path.join(root, 'other.txt');
      await writeFile(other, 'hello');
      expect(await within(readFile(other, 'utf8'), 2000)).toBe('hello');
    });
  }

  it('as the repository’s git config: git gives up on it, and the folder is asked about', async () => {
    const dir = path.join(root, 'git-config-pipe');
    await mkdir(dir, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' } });
    await rm(path.join(dir, '.git', 'config'));
    await pipeAt(path.join(dir, '.git', 'config'));
    const brings = folderBrings(dir);
    const other = path.join(root, 'other.txt');
    await writeFile(other, 'hello');
    expect(await within(readFile(other, 'utf8'), 2000)).toBe('hello');
    expect(await brings).toContain('Git config that git could not read');
  }, 15_000);
});
