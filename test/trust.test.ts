import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { StartDefaults } from '../src/shared/defaults';
import { app } from '../src/server/app';
import { config } from '../src/server/config';
import { getRun } from '../src/server/runner';
import { refreshTranscriptIndex } from '../src/server/transcripts';
import {
  claudeCodeTrusts, FULL_SETTINGS, folderBrings, folderTrusted, forgetTrust, launchFor, NeedsTrust, pelicanChoice, rememberChoice, trustQuestion,
} from '../src/server/trust';

let root: string;
let repo: string;
let plain: string;
let marker: string;
let launched: string;
const saved = { ...config };
const savedClaude = process.env.CLAUDE_CONFIG_DIR;

const gitIn = (dir: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null', ...args], {
  cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
});

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pelican-trust-')));
  // Nothing of this computer's Claude Code or Pelican is read.
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
  config.claudeHome = path.join(root, 'claude');
  config.stateDir = path.join(root, 'state');
  config.configDir = path.join(root, 'config');
  config.auth = 'none';
  marker = path.join(root, 'ran');
  launched = path.join(root, 'launched');
  // A stand-in for Claude Code that only notes how it was started.
  const fake = path.join(root, 'claude-fake');
  await writeFile(fake, `#!/bin/sh\n{ echo "cwd=$(pwd)"; for a in "$@"; do echo "arg=$a"; done; echo "git=$GIT_CONFIG_COUNT $GIT_CONFIG_KEY_0"; } >> ${launched}\nexit 1\n`);
  await chmod(fake, 0o755);
  config.claudeExecutable = fake;

  // A folder from somewhere else, with programs of its own.
  repo = path.join(root, 'cloned');
  await mkdir(path.join(repo, '.claude'), { recursive: true });
  gitIn(repo, 'init', '-q', '-b', 'main');
  await writeFile(path.join(repo, '.claude', 'settings.json'), JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `echo hook >> ${marker}` }] }] },
    env: { NODE_OPTIONS: '--require ./x.js' },
    apiKeyHelper: './key.sh',
    permissions: { allow: ['Bash(curl:*)'] },
  }));
  await writeFile(path.join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { db: { command: 'npx', args: ['-y', 'db-mcp'] }, docs: { type: 'http', url: 'https://docs.example/mcp' } } }));
  gitIn(repo, 'config', 'filter.evil.clean', `sh -c 'echo clean >> ${marker}; cat'`);
  plain = path.join(root, 'plain');
  await mkdir(plain);
});

beforeEach(async () => {
  forgetTrust();
  await rm(config.stateDir, { recursive: true, force: true });
  await rm(path.join(root, 'claude'), { recursive: true, force: true });
  await rm(launched, { force: true });
});

afterAll(async () => {
  Object.assign(config, saved);
  if (savedClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedClaude;
  await rm(root, { recursive: true, force: true });
});

/** A transcript Claude Code would have written, so the folder counts as one Claude has worked in. */
async function claudeWorkedIn(dir: string): Promise<void> {
  const id = randomUUID();
  const project = path.join(root, 'claude', 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'));
  await mkdir(project, { recursive: true });
  const line = { type: 'user', uuid: randomUUID(), sessionId: id, cwd: dir, timestamp: new Date().toISOString(), message: { role: 'user', content: 'hello' } };
  await writeFile(path.join(project, `${id}.jsonl`), `${JSON.stringify(line)}\n`);
  // Found at once, though a test before looked for transcripts less than a second ago.
  await refreshTranscriptIndex();
}

/** The stand-in Claude's whole note: it writes line by line, and git= comes last. */
const waitFor = async (file: string): Promise<string> => {
  for (let i = 0; i < 60; i += 1) {
    const text = await readFile(file, 'utf8').catch(() => '');
    if (/^git=/m.test(text)) return text;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return '';
};

describe('what a folder brings', () => {
  it('is read from its files, and nothing of it runs', async () => {
    const brings = await folderBrings(path.join(repo));
    expect(brings).toEqual(expect.arrayContaining([
      `SessionStart hook: echo hook >> ${marker}`,
      'apiKeyHelper: ./key.sh',
      'Environment variables: NODE_OPTIONS',
      'Allowed without asking: Bash(curl:*)',
      'MCP server db: npx -y db-mcp',
      'MCP server docs: https://docs.example/mcp',
      `Git filter evil: sh -c 'echo clean >> ${marker}; cat'`,
    ]));
    expect(await readFile(marker, 'utf8').catch(() => '')).toBe('');
  });

  it('is nothing for an empty folder', async () => {
    expect(await folderBrings(plain)).toEqual([]);
  });
}, 20_000);

describe('a folder nobody trusted', () => {
  it('is asked about when it brings something, and Claude Code does not start there', async () => {
    expect(await folderTrusted(repo)).toBe(false);
    expect((await trustQuestion(repo))?.brings.length).toBeGreaterThan(3);
    await expect(launchFor(repo)).rejects.toBeInstanceOf(NeedsTrust);
  });

  it('that brings nothing starts without a question', async () => {
    expect(await trustQuestion(plain)).toBeUndefined();
    expect(await launchFor(plain)).toEqual(FULL_SETTINGS);
  });
}, 20_000);

describe('a folder’s own settings for new sessions', () => {
  const headers = { host: 'localhost:7860', 'x-pelican': '1', 'content-type': 'application/json' };
  const defaults = async (dir: string) => (await app.request(`/api/defaults?cwd=${encodeURIComponent(dir)}`, { headers })).json() as Promise<StartDefaults>;
  const sources = (read: StartDefaults) => [read.model.source, read.fast.source, read.ultracode.source, read.permissionMode.source, ...Object.values(read.effort.byModel).map((e) => e.source), read.effort.fallback?.source];

  it('wait for it to be trusted: asked about with the rest, and not what a new session starts with until then', async () => {
    const dir = path.join(root, 'costly');
    await mkdir(path.join(dir, '.claude'), { recursive: true });
    await writeFile(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ model: 'opus', ultracode: true, fastMode: true, effortLevel: 'high', permissions: { defaultMode: 'plan' } }));
    await writeFile(path.join(dir, '.claude', 'settings.local.json'), JSON.stringify({ modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh' } } }));

    // Nobody trusted it: what new sessions start with is the user's, and its own are said to wait.
    const untrusted = await defaults(dir);
    expect(sources(untrusted)).not.toContain('project');
    expect(sources(untrusted)).not.toContain('local');
    expect(untrusted).toMatchObject({ model: { value: 'default' }, ultracode: { value: false }, fast: { value: false }, permissionMode: { value: 'auto' } });
    expect(untrusted.waiting).toEqual(['model', 'effort', 'fast', 'ultracode', 'mode']);
    // Its first session asks first, with them listed, and Claude Code does not start.
    const started = await app.request('/api/sessions', { method: 'POST', headers, body: JSON.stringify({ cwd: dir, text: 'hi' }) });
    expect(started.status).toBe(409);
    expect((await started.json() as { brings: string[] }).brings).toEqual(expect.arrayContaining([
      'Permission mode: plan', 'Model: opus', 'Effort: high', 'Fast mode: on', 'Ultracode: on', 'Effort for claude-opus-5-5: xhigh',
    ]));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await readFile(launched, 'utf8').catch(() => '')).toBe('');

    // Kept to the user's settings: never the folder's, and nothing waits.
    await rememberChoice(dir, 'user-only');
    const userOnly = await defaults(dir);
    expect(sources(userOnly)).not.toContain('project');
    expect(userOnly.waiting).toBeUndefined();

    // Trusted: they count, each from its file.
    await rememberChoice(dir, 'trusted');
    const trusted = await defaults(dir);
    expect(trusted).toMatchObject({
      model: { value: 'opus', source: 'project' }, ultracode: { value: true, source: 'project' }, fast: { value: true, source: 'project' },
      permissionMode: { value: 'plan', source: 'project' }, effort: { byModel: { 'claude-opus-5-5': { level: 'xhigh', source: 'local' } } },
    });
    expect(trusted.waiting).toBeUndefined();
  });

  it('that set none of these bring nothing more to ask about', async () => {
    const dir = path.join(root, 'quiet');
    await mkdir(path.join(dir, '.claude'), { recursive: true });
    await writeFile(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ includeCoAuthoredBy: false, cleanupPeriodDays: 60 }));
    expect(await folderBrings(dir)).toEqual([]);
    expect((await defaults(dir)).waiting).toBeUndefined();
  });
}, 20_000);

describe('trust', () => {
  it('comes from Claude Code’s own record, for the repository and the folders in it', async () => {
    await mkdir(path.join(root, 'claude'), { recursive: true });
    await writeFile(path.join(root, 'claude', '.claude.json'), JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true } } }));
    await mkdir(path.join(repo, 'src'), { recursive: true });
    expect(await claudeCodeTrusts(path.join(repo, 'src'))).toBe(true);
    expect(await folderTrusted(repo)).toBe(true);
    expect(await launchFor(repo)).toEqual(FULL_SETTINGS);
    expect(await claudeCodeTrusts(plain)).toBe(false);
  });

  it('is kept by Pelican for the repository, readable only by the user', async () => {
    await rememberChoice(path.join(repo, 'src'), 'trusted');
    expect(await pelicanChoice(repo)).toBe('trusted');
    expect(await folderTrusted(repo)).toBe(true);
    expect((await stat(path.join(config.stateDir, 'trust.json'))).mode & 0o777).toBe(0o600);
  });

  it('is never kept for the home folder, even when the home folder is a repository', async () => {
    const home = path.join(root, 'home');
    const download = path.join(home, 'Downloads', 'thing');
    await mkdir(download, { recursive: true });
    gitIn(home, 'init', '-q', '-b', 'main');
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    try {
      await rememberChoice(download, 'trusted');
      expect(await pelicanChoice(download)).toBe('trusted');
      await mkdir(path.join(home, 'Downloads', 'other'), { recursive: true });
      expect(await pelicanChoice(path.join(home, 'Downloads', 'other'))).toBeUndefined();
    } finally {
      process.env.HOME = savedHome;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('follows Claude having worked there, unless the user chose their settings only', async () => {
    await claudeWorkedIn(repo);
    expect(await folderTrusted(repo)).toBe(true);
    await rememberChoice(repo, 'user-only');
    expect(await folderTrusted(repo)).toBe(false);
  });
}, 20_000);

describe('“Use my settings only”', () => {
  it('starts Claude Code with the user’s settings, and git with the folder’s programs off', async () => {
    await rememberChoice(repo, 'user-only');
    const launch = await launchFor(repo);
    expect(launch.settingSources).toEqual(['user']);
    expect(launch.env).toMatchObject({ GIT_CONFIG_KEY_0: 'filter.evil.clean', GIT_CONFIG_VALUE_0: '' });
    // What git makes of it: the filter does not run on a changed file.
    await writeFile(path.join(repo, '.gitattributes'), '*.dat filter=evil\n');
    await writeFile(path.join(repo, 'a.dat'), 'one\n');
    execFileSync('git', ['add', '-A'], { cwd: repo, env: { ...process.env, ...launch.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    expect(await readFile(marker, 'utf8').catch(() => '')).toBe('');
    await rm(path.join(repo, '.gitattributes'));
    await rm(path.join(repo, 'a.dat'));
  });
}, 20_000);

describe('starting a session', () => {
  const create = (body: Record<string, unknown>) => app.request('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ text: 'hi', ...body }),
    headers: { host: 'localhost:7860', 'x-pelican': '1', 'content-type': 'application/json' },
  });

  it('in a folder nobody trusted asks first, and starts nothing', async () => {
    const response = await create({ cwd: repo });
    expect(response.status).toBe(409);
    const body = await response.json() as { needsTrust: boolean; brings: string[]; commands: unknown[] };
    expect(body.needsTrust).toBe(true);
    expect(body.brings).toContain('MCP server db: npx -y db-mcp');
    // Where each item's command is: the server's program and its arguments, a hook a shell runs.
    expect(body.commands).toHaveLength(body.brings.length);
    expect(body.commands[body.brings.indexOf('MCP server db: npx -y db-mcp')]).toEqual([[15, 28, 'argv']]);
    const hook = body.brings.findIndex((item) => item.startsWith('SessionStart hook: '));
    expect(body.commands[hook]).toEqual([[19, body.brings[hook]!.length, 'shell']]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await readFile(launched, 'utf8').catch(() => '')).toBe('');
  });

  it('with the user’s settings only, as answered', async () => {
    expect((await create({ cwd: repo, trust: 'user-only' })).status).toBe(200);
    const log = await waitFor(launched);
    expect(log).toContain('arg=--setting-sources=user\n');
    expect(log).toContain('git=4 filter.evil.clean');
    expect(await pelicanChoice(repo)).toBe('user-only');
  });

  it('with every setting once trusted', async () => {
    expect((await create({ cwd: repo, trust: 'trusted' })).status).toBe(200);
    expect(await waitFor(launched)).toContain('arg=--setting-sources=user,project,local\n');
  });

  it('takes only the two answers', async () => {
    expect((await create({ cwd: repo, trust: 'yes' })).status).toBe(400);
  });

  it('in a folder reached through a link, runs in the folder itself, as Claude Code records it', async () => {
    const link = path.join(root, 'linked');
    await symlink(plain, link).catch(() => undefined);
    const response = await create({ cwd: link, trust: 'trusted' });
    expect(response.status).toBe(200);
    const { sessionId } = await response.json() as { sessionId: string };
    expect(getRun(sessionId)?.cwd).toBe(plain);
    // Its Claude starts: wait for it here, so what it writes is not read by the test after this one.
    await waitFor(launched);
  });
}, 20_000);
