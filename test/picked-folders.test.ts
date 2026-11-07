// A session started here in a folder under the system's temp folder (a checkout in /tmp, picked
// with Browse folders) is the user's: listed, and its folder offered again for new sessions. One
// another tool made in a temp folder stays under Temporary.
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SessionSummary } from '../src/shared/protocol';
import { app } from '../src/server/app';
import { config } from '../src/server/config';
import { folderKind, pickedFolders } from '../src/server/folders';
import { refreshTranscriptIndex } from '../src/server/transcripts';

let root: string;
const saved = { ...config };
const savedClaude = process.env.CLAUDE_CONFIG_DIR;

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pelican-picked-')));
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
  config.claudeHome = path.join(root, 'claude');
  config.stateDir = path.join(root, 'state');
  config.configDir = path.join(root, 'config');
  config.auth = 'none';
  // A stand-in for Claude Code that starts nothing.
  const fake = path.join(root, 'claude-fake');
  await writeFile(fake, '#!/bin/sh\nexit 1\n');
  await chmod(fake, 0o755);
  config.claudeExecutable = fake;
});

afterAll(async () => {
  Object.assign(config, saved);
  if (savedClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedClaude;
  await rm(root, { recursive: true, force: true });
});

/** A transcript Claude Code would have written for a session in `dir`. */
async function sessionIn(dir: string, prompt: string): Promise<string> {
  const id = randomUUID();
  const project = path.join(root, 'claude', 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'));
  await mkdir(project, { recursive: true });
  const at = new Date().toISOString();
  const rows = [
    { type: 'user', uuid: randomUUID(), sessionId: id, cwd: dir, timestamp: at, message: { role: 'user', content: prompt } },
    { type: 'assistant', uuid: randomUUID(), sessionId: id, cwd: dir, timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
  ];
  await writeFile(path.join(project, `${id}.jsonl`), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  await refreshTranscriptIndex();
  return id;
}

const request = (url: string, init: RequestInit = {}) => app.request(url, {
  ...init,
  headers: { host: 'localhost:7860', 'x-pelican': '1', 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) },
});

describe('a folder in the temp folder', () => {
  it('is a throwaway one until a session is started in it here', () => {
    const dir = path.join(os.tmpdir(), 'checkout');
    expect(folderKind(dir)).toBe('temp');
    expect(folderKind(dir, new Set([dir]))).toBe('project');
    expect(folderKind(`${dir}/`, new Set([dir]))).toBe('project');
    // Only the folder picked: another beside it, or inside it, is still a throwaway one.
    expect(folderKind(`${dir}-2`, new Set([dir]))).toBe('temp');
    expect(folderKind(path.join(dir, 'sub'), new Set([dir]))).toBe('temp');
  });

  it('picked for a new session here, lists its sessions and is offered again; one another tool used stays Temporary', async () => {
    const picked = path.join(root, 'checkout');
    const other = path.join(root, 'claude-scratchpad');
    await mkdir(picked);
    await mkdir(other);
    const started = await request('/api/sessions', { method: 'POST', body: JSON.stringify({ cwd: picked, text: 'hi', trust: 'trusted' }) });
    expect(started.status).toBe(200);
    expect((await pickedFolders()).has(picked)).toBe(true);
    const mine = await sessionIn(picked, 'Fix the build');
    const theirs = await sessionIn(other, 'A tool’s own run');
    const { sessions } = (await (await request('/api/sessions')).json()) as { sessions: SessionSummary[] };
    expect(sessions.find((s) => s.id === mine)).toMatchObject({ cwd: picked });
    expect(sessions.find((s) => s.id === mine)?.temp).toBeUndefined();
    expect(sessions.find((s) => s.id === theirs)?.temp).toBe(true);
    const { projects } = (await (await request('/api/projects')).json()) as { projects: Array<{ path: string }> };
    expect(projects.map((p) => p.path)).toContain(picked);
    expect(projects.map((p) => p.path)).not.toContain(other);
  });
});
