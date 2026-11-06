import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { claudeCodeInfo, claudeCodeLine, claudeOnPath, claudeSignIn, isNewer, newerClaudeLine, newerOnPath, sdkPackage } from '../src/server/claude-code';
import { config } from '../src/server/config';

const saved = { ...config };
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'pelican-claude-'));
});
afterAll(async () => {
  Object.assign(config, saved);
  await rm(dir, { recursive: true, force: true });
});

/** A stand-in for Claude Code that answers --version and auth status as it does. */
async function fakeClaude(status: Record<string, unknown>, exit: number): Promise<string> {
  const file = path.join(dir, `claude-${exit}`);
  await writeFile(file, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.316 (Claude Code)"; exit 0; fi\necho '${JSON.stringify(status)}'\nexit ${exit}\n`);
  await chmod(file, 0o755);
  return file;
}

describe('the Claude Code Pelican runs', () => {
  it('is the one the Agent SDK bundles, whose version its package says', () => {
    const sdk = sdkPackage();
    expect(sdk.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(sdk.claudeCodeVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('or the one PELICAN_CLAUDE_PATH names, asked for its version', async () => {
    config.claudeExecutable = await fakeClaude({ loggedIn: false }, 1);
    expect(await claudeCodeInfo()).toEqual({ path: config.claudeExecutable, version: '2.1.316' });
  });
}, 20_000);

describe('whether Claude Code is signed in', () => {
  it('as `claude auth status` says, signed out included (it exits 1 then)', async () => {
    config.claudeExecutable = await fakeClaude({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }, 1);
    expect(await claudeSignIn()).toEqual({ loggedIn: false });
    config.claudeExecutable = await fakeClaude({ loggedIn: true, authMethod: 'claude.ai', email: 'ada@example.com' }, 0);
    expect(await claudeSignIn()).toEqual({ loggedIn: true, email: 'ada@example.com' });
    config.claudeExecutable = path.join(dir, 'missing');
    expect(await claudeSignIn()).toBeUndefined();
  });

  it('in one banner line, with what to do when it is not', () => {
    expect(claudeCodeLine({ version: '2.1.318' }, { loggedIn: true, email: 'ada@example.com' }, 'pelican login')).toBe('Claude Code 2.1.318 · signed in as ada@example.com');
    expect(claudeCodeLine({ version: '2.1.318' }, { loggedIn: false }, 'pelican login')).toBe('Claude Code 2.1.318 · not signed in: run `pelican login`');
    expect(claudeCodeLine({ version: '2.1.316', path: '/usr/local/bin/claude' }, undefined, 'pelican login')).toBe('Claude Code 2.1.316 (/usr/local/bin/claude)');
    expect(claudeCodeLine({ path: '/nope', missing: true }, undefined, 'pelican login')).toBe('Claude Code not found at /nope (PELICAN_CLAUDE_PATH)');
  });
}, 20_000);

/** A folder holding a `claude` that prints this script's output for --version. */
async function claudeIn(name: string, script: string): Promise<string> {
  const folder = path.join(dir, name);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'claude'), `#!/bin/sh\n${script}\n`);
  await chmod(path.join(folder, 'claude'), 0o755);
  return folder;
}

describe('the user\'s own claude, when newer than the one Pelican runs', () => {
  it('compares versions part by part, as numbers', () => {
    expect(isNewer('2.1.330', '2.1.318')).toBe(true);
    expect(isNewer('2.10.0', '2.9.99')).toBe(true);
    expect(isNewer('3.0.0', '2.1.318')).toBe(true);
    expect(isNewer('2.1.318', '2.1.318')).toBe(false);
    expect(isNewer('2.1.316', '2.1.318')).toBe(false);
  });

  it('is the first claude on PATH, in absolute folders only', async () => {
    const first = await claudeIn('first', 'echo "2.1.330 (Claude Code)"');
    const second = await claudeIn('second', 'echo "2.1.340 (Claude Code)"');
    const empty = path.join(dir, 'empty');
    await mkdir(empty, { recursive: true });
    expect(await claudeOnPath([empty, first, second].join(path.delimiter))).toBe(path.join(first, 'claude'));
    // An empty entry or a relative one means the folder Pelican started in: never looked in.
    expect(await claudeOnPath(['', path.relative(process.cwd(), first), second].join(path.delimiter))).toBe(path.join(second, 'claude'));
    expect(await claudeOnPath(empty)).toBeUndefined();
  });

  it('says its version only when it is newer', async () => {
    const folder = await claudeIn('newer', 'echo "2.1.330 (Claude Code)"');
    expect(await newerOnPath('2.1.318', folder)).toBe('2.1.330');
    expect(await newerOnPath('2.1.330', folder)).toBeUndefined();
    expect(await newerOnPath('2.2.0', folder)).toBeUndefined();
  });

  it('says nothing when it fails, or does not answer in time', async () => {
    expect(await newerOnPath('2.1.318', await claudeIn('failing', 'echo "2.1.330"; exit 1'))).toBeUndefined();
    expect(await newerOnPath('2.1.318', await claudeIn('silent', 'echo hello'))).toBeUndefined();
    const started = Date.now();
    expect(await newerOnPath('2.1.318', await claudeIn('slow', 'sleep 5; echo "2.1.330"'), 200)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('in one line for the start banner', () => {
    expect(newerClaudeLine('2.1.330')).toBe('Your claude is newer (2.1.330): update Pelican to get it');
  });
}, 20_000);
