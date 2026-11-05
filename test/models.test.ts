import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Claude Code's settings are read from a folder of the test's own, never ~/.claude.
const scratch = vi.hoisted(() => {
  const base = `${process.env.TMPDIR ?? '/tmp'}/pelican-models-test-${process.pid}`;
  process.env.CLAUDE_CONFIG_DIR = `${base}/claude`;
  process.env.PELICAN_CONFIG_DIR = `${base}/config`;
  process.env.PELICAN_STATE_DIR = `${base}/state`;
  return base;
});

const trusted = new Set<string>();
vi.mock('../src/server/trust', () => ({ claudeRanIn: async (dir: string) => trusted.has(dir), folderTrusted: async (dir: string) => trusted.has(dir) }));

const { defaultMode, signedInFrom, startError, toCompletions } = await import('../src/server/models');

let project: string;
const settings = (file: string, defaultMode: string) => writeFile(file, JSON.stringify({ permissions: { defaultMode } }));

beforeAll(async () => {
  await mkdir(path.join(scratch, 'claude'), { recursive: true });
  // Claude Code names folders by their real path (macOS's /tmp is /private/tmp).
  project = await realpath(await mkdtemp(path.join(scratch, 'project-')));
  await mkdir(path.join(project, '.claude'), { recursive: true });
});
afterAll(() => rm(scratch, { recursive: true, force: true }));

describe('whether Claude Code is signed in', () => {
  it('is not, signed out, though it still names its provider', () => {
    expect(signedInFrom({ tokenSource: 'none', apiKeySource: 'none', apiProvider: 'firstParty' })).toBe(false);
    expect(signedInFrom({ apiProvider: 'firstParty' })).toBe(false);
  });

  it('is, with an account, a key, a token, or another provider', () => {
    expect(signedInFrom({ email: 'me@example.com', tokenSource: 'claude.ai', apiProvider: 'firstParty' })).toBe(true);
    expect(signedInFrom({ apiKeySource: 'ANTHROPIC_API_KEY', apiProvider: 'firstParty' })).toBe(true);
    expect(signedInFrom({ tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN' })).toBe(true);
    expect(signedInFrom({ apiProvider: 'bedrock' })).toBe(true);
  });
});

describe('Claude Code that cannot start', () => {
  it('is said in Pelican’s words, naming its own setting', () => {
    expect(startError('Claude Code native binary not found at /opt/claude. Please ensure Claude Code is installed via native installer or specify a valid path with options.pathToClaudeCodeExecutable.'))
      .toMatch(/^Pelican could not find Claude Code at \/opt\/claude\. Set PELICAN_CLAUDE_PATH/);
    expect(startError('Claude Code executable not found at /x/claude. Is options.pathToClaudeCodeExecutable set?')).toMatch(/at \/x\/claude\. Set PELICAN_CLAUDE_PATH/);
    expect(startError('Something else')).toBeUndefined();
  });
});

describe('the mode a new session starts in', () => {
  it('is the user’s permissions.defaultMode, or none', async () => {
    expect(await defaultMode(project)).toBeUndefined();
    await settings(path.join(scratch, 'claude', 'settings.json'), 'plan');
    expect(await defaultMode(project)).toBe('plan');
    expect(await defaultMode()).toBe('plan');
  });

  it('takes a folder’s own setting only once Claude has worked there, and never an escalating one from the repository', async () => {
    await settings(path.join(project, '.claude', 'settings.json'), 'dontAsk');
    expect(await defaultMode(project)).toBe('plan');
    trusted.add(project);
    expect(await defaultMode(project)).toBe('dontAsk');
    // A repository cannot turn approvals off for whoever opens it: the user's own mode applies.
    await settings(path.join(project, '.claude', 'settings.json'), 'acceptEdits');
    expect(await defaultMode(project)).toBe('plan');
    trusted.delete(project);
  });

  it('is never Bypass: Pelican enters it only when it is picked', async () => {
    await settings(path.join(scratch, 'claude', 'settings.json'), 'bypassPermissions');
    expect(await defaultMode(project)).toBeUndefined();
    await settings(path.join(scratch, 'claude', 'settings.json'), 'auto');
    expect(await defaultMode(project)).toBe('auto');
  });
});

describe('the / list', () => {
  it('leaves out commands whose screen is the terminal', () => {
    const command = (name: string) => ({ name, description: `${name} it`, argumentHint: '' });
    expect(toCompletions([command('compact'), command('exit'), command('statusline'), command('review')], [{ name: 'reviewer', description: 'Reviews' }])).toEqual({
      commands: [{ name: 'compact', description: 'compact it', argumentHint: '' }, { name: 'review', description: 'review it', argumentHint: '' }],
      agents: [{ name: 'reviewer', description: 'Reviews' }],
    });
  });
});

it('reads no settings from the real home', () => {
  expect(process.env.CLAUDE_CONFIG_DIR).not.toBe(path.join(os.homedir(), '.claude'));
});
