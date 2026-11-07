// New sessions as the Claude Code the Agent SDK bundles starts them, against a stand-in API
// (stand-in-api.ts), in this test's temporary folders: from Claude Code's own settings file,
// read and written as Claude Code does, with nothing of Pelican's own.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { query } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { config } from '../src/server/config';
import { saveDefault } from '../src/server/defaults';
import { closeAll, getRun, sendMessage } from '../src/server/runner';
import type { ModelOption } from '../src/shared/protocol';
import { type MessagesRequest, type StandIn, standInApi, until } from './stand-in-api';

const home = vi.hoisted(() => {
  // Nothing of a Claude Code this test may itself run under reaches the one it starts, and the
  // computer's own home (shell files, settings) stays out of it: test/setup.ts made the folders.
  for (const key of Object.keys(process.env)) if ((key.startsWith('CLAUDE') && key !== 'CLAUDE_CONFIG_DIR') || key.startsWith('ANTHROPIC_')) delete process.env[key];
  process.env.HOME = `${process.env.CLAUDE_CONFIG_DIR}-home`;
  return process.env.HOME;
});

let api: StandIn;
let folder: string;
const userFile = () => path.join(config.claudeHome, 'settings.json');
/** The turns asked for with a prompt (not titles or suggestions). */
const turnFor = (prompt: string) => api.requests.find((request) => (request.tools?.length ?? 0) > 0 && JSON.stringify(request.messages ?? []).includes(prompt));
const effortOf = (request: MessagesRequest | undefined) => (request as { output_config?: { effort?: string } } | undefined)?.output_config?.effort;

/** Starts a session in the folder as Pelican does, with nothing picked, and waits for its turn. */
async function start(prompt: string) {
  const id = await sendMessage({ cwd: folder }, { text: prompt, attachments: [], settings: {} });
  await until(() => Boolean(turnFor(prompt)) && getRun(id)?.busy === false, 90_000, `the turn of ${prompt}`);
  // Claude Code's word on the effort it applied comes just after its first message.
  await until(() => getRun(id)?.state().settings.effort !== undefined, 10_000, 'the applied effort');
  return getRun(id)!;
}

/** What the bundled Claude Code starts with when nothing at all is passed to it, in the same folder and settings. */
async function bare(): Promise<{ model: string; permissionMode: string; effort: unknown }> {
  const q = query({ prompt: 'Just say hi', options: { cwd: folder, settingSources: ['user', 'project', 'local'], env: { ...process.env }, maxTurns: 1 } });
  try {
    for await (const message of q) {
      if (message.type === 'system' && message.subtype === 'init') {
        const settings = await (q as unknown as { getSettings: () => Promise<{ applied?: { effort?: unknown } }> }).getSettings();
        return { model: message.model, permissionMode: message.permissionMode, effort: settings.applied?.effort };
      }
    }
  } finally {
    q.close();
  }
  throw new Error('No init');
}

beforeAll(async () => {
  mkdirSync(home, { recursive: true });
  folder = path.join(realpathSync(path.dirname(config.claudeHome)), 'acme-api');
  mkdirSync(folder, { recursive: true });
  mkdirSync(config.claudeHome, { recursive: true });
  api = await standInApi(() => 'OK.');
  Object.assign(process.env, {
    ANTHROPIC_BASE_URL: api.url,
    ANTHROPIC_API_KEY: 'sk-ant-stand-in',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_ERROR_REPORTING: '1',
  });
}, 30_000);

afterAll(async () => {
  closeAll();
  await api?.close();
});

describe('a new session, in the Claude Code the Agent SDK bundles', () => {
  it('starts with the model, effort and mode of Claude Code’s settings, as Claude Code itself starts', async () => {
    writeFileSync(userFile(), JSON.stringify({ theme: 'dark', model: 'sonnet', modelSettings: { 'claude-sonnet-5-5': { effortLevel: 'low' } }, permissions: { defaultMode: 'plan' } }));
    const run = await start('First, from the settings');
    expect(turnFor('First, from the settings')?.model).toBe('claude-sonnet-5-5');
    expect(effortOf(turnFor('First, from the settings'))).toBe('low');
    expect(run.state().settings).toMatchObject({ model: 'sonnet', effort: 'low', permissionMode: 'plan' });
    expect(await bare()).toEqual({ model: 'claude-sonnet-5-5', permissionMode: 'plan', effort: 'low' });
  }, 150_000);

  it('starts with what Settings saved, read back by Claude Code from the file as it wrote it', async () => {
    const listed: ModelOption[] = [
      { value: 'default', label: 'Default', description: '', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], supportsFast: true, supportsAuto: true, resolvedModel: 'claude-opus-5-5' },
      { value: 'haiku', label: 'Haiku', description: '', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], supportsFast: false, supportsAuto: true, resolvedModel: 'claude-haiku-5-5' },
    ];
    await saveDefault({ model: 'haiku' }, async () => listed);
    await saveDefault({ effort: { model: 'haiku', level: 'high' } }, async () => listed);
    await saveDefault({ permissionMode: 'acceptEdits' }, async () => listed);
    expect(JSON.parse(readFileSync(userFile(), 'utf8'))).toEqual({
      theme: 'dark',
      model: 'haiku',
      modelSettings: { 'claude-sonnet-5-5': { effortLevel: 'low' }, 'claude-haiku-5-5': { effortLevel: 'high' } },
      permissions: { defaultMode: 'acceptEdits' },
    });
    const run = await start('Second, after Settings');
    expect(turnFor('Second, after Settings')?.model).toBe('claude-haiku-5-5');
    expect(effortOf(turnFor('Second, after Settings'))).toBe('high');
    expect(run.state().settings).toMatchObject({ model: 'haiku', effort: 'high', permissionMode: 'acceptEdits' });
    expect(await bare()).toEqual({ model: 'claude-haiku-5-5', permissionMode: 'acceptEdits', effort: 'high' });
  }, 150_000);

  it('starts in Auto where no file names a mode, as the terminal does, with Claude Code’s own effort', async () => {
    writeFileSync(userFile(), '{}\n');
    const run = await start('Third, from nothing');
    expect(turnFor('Third, from nothing')?.model).toBe('claude-opus-5-5');
    expect(run.state().settings.permissionMode).toBe('auto');
    // Claude Code's own effort for the model, as it says it applies it.
    expect(run.state().settings.effort).toBe(effortOf(turnFor('Third, from nothing')));
    expect(await bare()).toMatchObject({ model: 'claude-opus-5-5', effort: run.state().settings.effort });
  }, 150_000);
});
