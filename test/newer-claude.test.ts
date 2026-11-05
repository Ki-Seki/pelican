import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { app } from '../src/server/app';
import { accessToken, loadAuth } from '../src/server/auth';
import { checkNewerClaude, claudeCodeInfo, newerClaude } from '../src/server/claude-code';
import { config } from '../src/server/config';

// Its own file: the check runs once per process, and its answer stays.
const saved = { ...config };
const savedPath = process.env.PATH;
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'pelican-newer-'));
  config.configDir = path.join(dir, 'config');
  config.claudeExecutable = undefined;
  config.demo = false;
  await loadAuth();
});
afterAll(async () => {
  Object.assign(config, saved);
  process.env.PATH = savedPath;
  await rm(dir, { recursive: true, force: true });
});

describe('a newer claude of the user\'s own', () => {
  it('is checked once at start, and /api/info says so from then on', async () => {
    const ours = (await claudeCodeInfo()).version;
    expect(ours).toMatch(/^\d+\.\d+\.\d+$/);
    // A stand-in that is always newer than the Claude Code Pelican brings.
    await writeFile(path.join(dir, 'claude'), '#!/bin/sh\necho "999.0.0 (Claude Code)"\n');
    await chmod(path.join(dir, 'claude'), 0o755);
    process.env.PATH = dir;

    expect(newerClaude()).toBeUndefined();
    const check = checkNewerClaude();
    expect(checkNewerClaude()).toBe(check);
    expect(await check).toBe('999.0.0');
    expect(newerClaude()).toBe('999.0.0');

    const response = await app.request('/api/info', { headers: { host: 'localhost:7860', 'x-pelican': '1', authorization: `Bearer ${accessToken()}` } });
    expect((await response.json()).claudeCode).toEqual({ version: ours, newer: '999.0.0' });
  });
});
