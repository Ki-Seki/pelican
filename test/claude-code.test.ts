import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { claudeCodeInfo, claudeCodeLine, claudeSignIn, sdkPackage } from '../src/server/claude-code';
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
});

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
});
