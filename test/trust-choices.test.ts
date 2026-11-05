// What the user answered stays: "Use my settings only" is never pushed out by later answers.
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { config } from '../src/server/config';
import { folderTrusted, forgetTrust, launchFor, pelicanChoice, rememberChoice } from '../src/server/trust';

let root: string;
let repo: string;
const saved = { ...config };

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pelican-trust-choices-')));
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
  config.claudeHome = path.join(root, 'claude');
  config.stateDir = path.join(root, 'state');
  config.configDir = path.join(root, 'config');
  repo = path.join(root, 'downloaded');
  await mkdir(path.join(repo, '.claude'), { recursive: true });
  await writeFile(path.join(repo, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hook' }] }] } }));
  forgetTrust();
});

afterAll(async () => {
  Object.assign(config, saved);
  await rm(root, { recursive: true, force: true });
});

/** The transcript a session there leaves, as Claude Code writes it: the folder counts as one Claude has worked in. */
async function sessionRanIn(dir: string): Promise<void> {
  const id = randomUUID();
  const project = path.join(root, 'claude', 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'));
  await mkdir(project, { recursive: true });
  const line = { type: 'user', uuid: randomUUID(), sessionId: id, cwd: dir, timestamp: new Date().toISOString(), message: { role: 'user', content: 'hello' } };
  await writeFile(path.join(project, `${id}.jsonl`), `${JSON.stringify(line)}\n`);
}

describe('“Use my settings only”', () => {
  it('outlasts any number of later answers, such as a scratch session’s each', async () => {
    await rememberChoice(repo, 'user-only');
    // The sessions started that way are sessions Claude Code ran there.
    await sessionRanIn(repo);
    expect((await launchFor(repo)).settingSources).toEqual(['user']);
    for (let i = 0; i < 1100; i += 1) await rememberChoice(path.join(root, 'scratch', `s${i}`), 'trusted');
    forgetTrust();
    expect(await pelicanChoice(repo)).toBe('user-only');
    expect(await folderTrusted(repo)).toBe(false);
    expect((await launchFor(repo)).settingSources).toEqual(['user']);
    // The answers to trust are still kept to a bounded number, newest first.
    const kept = JSON.parse(await readFile(path.join(config.stateDir, 'trust.json'), 'utf8')) as { folders: Record<string, string> };
    expect(Object.keys(kept.folders).length).toBeLessThanOrEqual(1001);
    expect(kept.folders[path.join(root, 'scratch', 's1099')]).toBe('trusted');
    expect(kept.folders[path.join(root, 'scratch', 's0')]).toBeUndefined();
  }, 60_000);
});
