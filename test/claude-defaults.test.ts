import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DefaultSource, StartDefaults } from '../src/shared/defaults';
import { effortFor, modelKey, startModeFor } from '../src/shared/defaults';
import type { ModelOption } from '../src/shared/protocol';

// Claude Code's settings are a folder of the test's own (test/setup.ts), never ~/.claude.
const trusted = vi.hoisted(() => new Set<string>());
vi.mock('../src/server/trust', () => {
  class NeedsTrust extends Error {}
  return {
    NeedsTrust,
    folderTrusted: async (dir: string) => trusted.has(dir),
    claudeRanIn: async (dir: string) => trusted.has(dir),
    launchFor: async (dir: string) => {
      if (trusted.has(dir)) return { settingSources: ['user', 'project', 'local'] };
      throw new NeedsTrust('ask');
    },
  };
});

const { mergeSettings, newSessionSettings, readDefaults, saveDefault, startDefaults, writeHooks } = await import('../src/server/defaults');

const MODELS: ModelOption[] = [
  { value: 'default', label: 'Default (recommended)', description: '', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], supportsFast: true, supportsAuto: true, resolvedModel: 'claude-opus-5-5' },
  { value: 'opus', label: 'Opus', description: '', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], supportsFast: true, supportsAuto: true, resolvedModel: 'claude-opus-5-5' },
  { value: 'sonnet', label: 'Sonnet', description: '', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], supportsFast: false, supportsAuto: true, resolvedModel: 'claude-sonnet-5-5' },
  { value: 'haiku', label: 'Haiku', description: '', efforts: [], supportsFast: false, supportsAuto: false, resolvedModel: 'claude-haiku-5-5' },
];
const models = async () => MODELS;
const FILE = { path: '/x/settings.json', state: 'ok' as const };
const layer = (source: DefaultSource, settings: Record<string, unknown>) => ({ source, settings });
const at = (...layers: Array<ReturnType<typeof layer>>) => startDefaults(layers, {}, FILE);

const userFile = () => path.join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json');
let project: string;

beforeAll(async () => {
  await mkdir(process.env.CLAUDE_CONFIG_DIR!, { recursive: true });
  // Claude Code names folders by their real path (macOS's /tmp is /private/tmp).
  project = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pelican-defaults-')));
  await mkdir(path.join(project, '.claude'), { recursive: true });
});
afterAll(() => rm(project, { recursive: true, force: true }));
beforeEach(async () => {
  await rm(userFile(), { force: true });
  await rm(path.join(project, '.claude', 'settings.json'), { force: true });
  await rm(path.join(project, '.claude', 'settings.local.json'), { force: true });
  trusted.clear();
  writeHooks.beforeCompare = undefined;
});

describe('which file wins, as in Claude Code: user, then project, then local, then managed', () => {
  it('takes the model from the file with the highest precedence, and says whose it is', () => {
    expect(at().model).toEqual({ value: 'default', source: 'built-in' });
    expect(at(layer('user', { model: 'sonnet' })).model).toEqual({ value: 'sonnet', source: 'user' });
    expect(at(layer('user', { model: 'sonnet' }), layer('project', { model: 'haiku' })).model).toEqual({ value: 'haiku', source: 'project', user: 'sonnet' });
    expect(at(layer('user', { model: 'sonnet' }), layer('project', { model: 'haiku' }), layer('local', { model: 'opus' })).model.value).toBe('opus');
    expect(at(layer('local', { model: 'opus' }), layer('managed', { model: 'haiku' })).model).toMatchObject({ value: 'haiku', source: 'managed' });
    // ANTHROPIC_MODEL in Pelican's environment, which each session gets, comes before every file.
    expect(startDefaults([layer('user', { model: 'sonnet' })], { ANTHROPIC_MODEL: 'haiku' }, FILE).model).toEqual({ value: 'haiku', source: 'env', user: 'sonnet' });
  });

  it('keeps effort per model, as /effort saves it, with a folder’s top-level effortLevel above the user’s own', () => {
    const user = layer('user', { modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh' }, 'claude-sonnet-5-5': { effortLevel: 'low' } } });
    const table = at(user).effort;
    expect(effortFor(table, modelKey('default', MODELS))).toEqual({ level: 'xhigh', source: 'user' });
    expect(effortFor(table, modelKey('sonnet', MODELS))).toEqual({ level: 'low', source: 'user' });
    expect(effortFor(table, modelKey('haiku', MODELS))).toEqual({ source: 'built-in' });
    const folder = at(user, layer('project', { effortLevel: 'medium' })).effort;
    expect(effortFor(folder, 'claude-opus-5-5')).toEqual({ level: 'medium', source: 'project' });
    expect(effortFor(folder, 'claude-haiku-5-5')).toEqual({ level: 'medium', source: 'project' });
    // A folder's own for one model beats the folder's top-level one.
    expect(effortFor(at(layer('project', { effortLevel: 'medium', modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } } })).effort, 'claude-opus-5-5').level).toBe('high');
  });

  it('gives the user’s old top-level effortLevel to older models only, as Claude Code 2.1.318 does', () => {
    const table = at(layer('user', { effortLevel: 'low' })).effort;
    expect(effortFor(table, 'claude-opus-5-5')).toEqual({ source: 'built-in' });
    expect(effortFor(table, 'claude-sonnet-4-6')).toEqual({ level: 'low', source: 'user' });
    expect(effortFor(table, modelKey('claude-sonnet-4-5-20250929[1m]'))).toEqual({ level: 'low', source: 'user' });
    expect(startDefaults([], { CLAUDE_CODE_EFFORT_LEVEL: 'high' }, FILE).effort.env).toBe('high');
  });

  it('starts fast mode where a file turns it on, but never with fastModePerSessionOptIn', () => {
    expect(at().fast).toEqual({ value: false, source: 'built-in', perSession: false });
    expect(at(layer('user', { fastMode: true })).fast).toEqual({ value: true, source: 'user', perSession: false });
    expect(at(layer('user', { fastMode: true }), layer('managed', { fastModePerSessionOptIn: true })).fast).toMatchObject({ value: false, perSession: true });
    expect(at(layer('user', { fastMode: true }), layer('managed', { fastMode: false })).fast).toMatchObject({ value: false, source: 'managed' });
  });

  it('starts Ultracode only where a file turns it on, and workflows are not off', () => {
    expect(at().ultracode).toEqual({ value: false, source: 'built-in', workflows: true });
    expect(at(layer('local', { ultracode: true })).ultracode).toEqual({ value: true, source: 'local', workflows: true });
    expect(at(layer('user', { ultracode: true, enableWorkflows: false })).ultracode).toMatchObject({ value: false, workflows: false });
    expect(at(layer('user', { ultracode: true }), layer('managed', { disableWorkflows: true })).ultracode.value).toBe(false);
  });
});

describe('the mode a new session starts in, as Claude Code decides it', () => {
  const mode = (...layers: Array<ReturnType<typeof layer>>) => at(...layers).permissionMode;

  it('is Auto where nothing says otherwise, as the terminal starts, and Manual where Auto is turned off', () => {
    expect(mode()).toEqual({ value: 'auto', source: 'built-in' });
    expect(mode(layer('user', { disableAutoMode: 'disable' })).value).toBe('default');
    expect(mode(layer('user', { permissions: { defaultMode: 'auto', disableAutoMode: 'disable' } })).value).toBe('default');
  });

  it('takes Manual, Accept edits, Plan and Don’t ask from any file, the highest first', () => {
    expect(mode(layer('user', { permissions: { defaultMode: 'acceptEdits' } }))).toEqual({ value: 'acceptEdits', source: 'user' });
    expect(mode(layer('project', { permissions: { defaultMode: 'acceptEdits' } }))).toEqual({ value: 'acceptEdits', source: 'project' });
    expect(mode(layer('user', { permissions: { defaultMode: 'plan' } }), layer('project', { permissions: { defaultMode: 'acceptEdits' } }), layer('local', { permissions: { defaultMode: 'default' } })))
      .toEqual({ value: 'default', source: 'local', user: 'plan' });
    expect(mode(layer('user', { permissions: { defaultMode: 'manual' } })).value).toBe('default');
    expect(mode(layer('user', { permissions: { defaultMode: 'dontAsk' } })).value).toBe('dontAsk');
  });

  it('takes Auto and Bypass only from the user’s own or managed settings', () => {
    expect(mode(layer('user', { permissions: { defaultMode: 'auto' } }))).toEqual({ value: 'auto', source: 'user' });
    // A folder's Auto is as if no file had said anything; the user's own mode does not come back.
    expect(mode(layer('user', { permissions: { defaultMode: 'acceptEdits' } }), layer('project', { permissions: { defaultMode: 'auto' } })))
      .toEqual({ value: 'auto', source: 'built-in', user: 'acceptEdits', ignored: { mode: 'auto', source: 'project', why: 'folder' } });
    // A folder's Bypass starts in Manual.
    expect(mode(layer('user', { permissions: { defaultMode: 'plan' } }), layer('local', { permissions: { defaultMode: 'bypassPermissions' } })))
      .toEqual({ value: 'default', source: 'local', user: 'plan', ignored: { mode: 'bypassPermissions', source: 'local', why: 'folder' } });
    expect(mode(layer('user', { permissions: { defaultMode: 'bypassPermissions' } }))).toEqual({ value: 'bypassPermissions', source: 'user' });
    expect(mode(layer('managed', { permissions: { defaultMode: 'bypassPermissions' } }))).toEqual({ value: 'bypassPermissions', source: 'managed' });
    // The user's own Bypass counts where a folder says the same.
    expect(mode(layer('user', { permissions: { defaultMode: 'bypassPermissions' } }), layer('project', { permissions: { defaultMode: 'bypassPermissions' } })).value).toBe('bypassPermissions');
  });

  it('does not start in a Bypass that settings turn off', () => {
    expect(mode(layer('user', { permissions: { defaultMode: 'bypassPermissions', disableBypassPermissionsMode: 'disable' } })))
      .toEqual({ value: 'auto', source: 'built-in', user: 'bypassPermissions', ignored: { mode: 'bypassPermissions', source: 'user', why: 'disabled' } });
  });

  it('is Manual on a model without Auto', () => {
    const defaults = at();
    expect(startModeFor(defaults, MODELS[3])).toBe('default');
    expect(startModeFor(defaults, MODELS[0])).toBe('auto');
  });
});

describe('reading Claude Code’s files', () => {
  it('reads the user’s, the folder’s and the local file as Claude Code merges them, the folder’s once trusted', async () => {
    await writeFile(userFile(), JSON.stringify({ model: 'sonnet', permissions: { defaultMode: 'acceptEdits' } }));
    await writeFile(path.join(project, '.claude', 'settings.json'), JSON.stringify({ model: 'haiku', permissions: { defaultMode: 'plan' } }));
    await writeFile(path.join(project, '.claude', 'settings.local.json'), JSON.stringify({ fastMode: true }));
    // Until it is trusted, a session there would read the user's file alone.
    let read = await readDefaults(project);
    expect(read.model).toEqual({ value: 'sonnet', source: 'user' });
    expect(read.permissionMode).toEqual({ value: 'acceptEdits', source: 'user' });
    trusted.add(project);
    read = await readDefaults(project);
    expect(read.model).toEqual({ value: 'haiku', source: 'project', user: 'sonnet' });
    expect(read.permissionMode).toEqual({ value: 'plan', source: 'project', user: 'acceptEdits' });
    expect(read.fast).toEqual({ value: true, source: 'local', perSession: false });
    expect(read.file).toEqual({ path: userFile(), state: 'ok' });
    // Settings and a scratch session: the user's own.
    expect((await readDefaults()).model).toEqual({ value: 'sonnet', source: 'user' });
  });

  it('says when the user’s file does not parse, or holds what Claude Code skips it for', async () => {
    expect((await readDefaults()).file.state).toBe('missing');
    await writeFile(userFile(), '{ "model": "sonnet",, }');
    const broken = await readDefaults();
    expect(broken.file).toMatchObject({ state: 'invalid', problem: expect.stringMatching(/not valid JSON/) });
    expect(broken.model).toEqual({ value: 'default', source: 'built-in' });
    await writeFile(userFile(), JSON.stringify({ model: 5, permissions: { defaultMode: 'plan' } }));
    const skipped = await readDefaults();
    expect(skipped.file.state).toBe('skipped');
    expect(skipped.permissionMode.value).toBe('auto');
  });

  it('starts a new session with what Claude Code’s settings give, passing only the mode, fast mode and what was picked', async () => {
    await writeFile(userFile(), JSON.stringify({ model: 'opus', fastMode: true, permissions: { defaultMode: 'plan' }, modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } } }));
    trusted.add(project);
    const start = await newSessionSettings(project, {}, models);
    expect(start.given).toEqual({ permissionMode: 'plan', fast: true });
    expect(start.shown).toMatchObject({ model: 'opus', effort: 'high', fast: true, ultracode: false, permissionMode: 'plan' });
    const picked = await newSessionSettings(project, { model: 'sonnet', permissionMode: 'acceptEdits' }, models);
    // Sonnet has no fast mode here: none is asked for.
    expect(picked.given).toEqual({ model: 'sonnet', permissionMode: 'acceptEdits' });
    expect((await newSessionSettings(project, { model: 'default' }, models)).given).toEqual({ model: 'default', permissionMode: 'plan', fast: true });
  });
});

describe('writing Claude Code’s user settings, as its commands do', () => {
  const file = () => readFile(userFile(), 'utf8');

  it('keeps every other key, as Claude Code does, and writes two-space JSON with a newline', async () => {
    await writeFile(userFile(), '{\n    "theme": "dark",\n  "permissions": {"allow": ["Bash(ls:*)"]},\n  "hooks": {"Stop": []}, "zzz": [1,2,3]\n}');
    await saveDefault({ model: 'sonnet' }, models);
    expect(await file()).toBe(`${JSON.stringify({ theme: 'dark', permissions: { allow: ['Bash(ls:*)'] }, hooks: { Stop: [] }, zzz: [1, 2, 3], model: 'sonnet' }, null, 2)}\n`);
    await saveDefault({ permissionMode: 'plan' }, models);
    expect(JSON.parse(await file())).toEqual({ theme: 'dark', permissions: { allow: ['Bash(ls:*)'], defaultMode: 'plan' }, hooks: { Stop: [] }, zzz: [1, 2, 3], model: 'sonnet' });
    await saveDefault({ model: 'default' }, models);
    expect(JSON.parse(await file())).not.toHaveProperty('model');
  });

  it('saves effort under the model’s key, takes it out for Default, and never saves Max', async () => {
    await saveDefault({ effort: { model: 'default', level: 'high' } }, models);
    expect(JSON.parse(await file())).toEqual({ modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } } });
    await saveDefault({ effort: { model: 'sonnet', level: 'low' } }, models);
    await saveDefault({ effort: { model: 'opus', level: null } }, models);
    // As /effort auto leaves it.
    expect(JSON.parse(await file())).toEqual({ modelSettings: { 'claude-opus-5-5': {}, 'claude-sonnet-5-5': { effortLevel: 'low' } } });
    await expect(saveDefault({ effort: { model: 'opus', level: 'max' as never } }, models)).rejects.toThrow(/Max is for one session/);
  });

  it('saves fast mode as /fast does, and nothing where each session starts without it', async () => {
    await saveDefault({ fast: true }, models);
    expect(JSON.parse(await file())).toEqual({ fastMode: true });
    await saveDefault({ fast: false }, models);
    expect(JSON.parse(await file())).toEqual({});
    await writeFile(userFile(), JSON.stringify({ fastModePerSessionOptIn: true }));
    await expect(saveDefault({ fast: true }, models)).rejects.toThrow(/fastModePerSessionOptIn/);
  });

  it('never writes Bypass, a mode not offered, or a model Claude Code does not list', async () => {
    await writeFile(userFile(), '{}\n');
    await expect(saveDefault({ permissionMode: 'bypassPermissions' }, models)).rejects.toThrow(/never saved as a default/);
    await expect(saveDefault({ permissionMode: 'dontAsk' }, models)).rejects.toThrow(/No such mode/);
    await expect(saveDefault({ model: 'gpt-9' }, models)).rejects.toThrow(/does not list/);
    expect(await file()).toBe('{}\n');
  });

  it('leaves a file that does not parse as it is, and says so', async () => {
    const broken = '{ "model": "opus", // a comment\n}';
    await writeFile(userFile(), broken);
    const before = await stat(userFile());
    await expect(saveDefault({ model: 'sonnet' }, models)).rejects.toThrow(/left .*settings\.json as it is: It is not valid JSON/);
    expect(await file()).toBe(broken);
    expect((await stat(userFile())).mtimeMs).toBe(before.mtimeMs);
    await writeFile(userFile(), '[1, 2]');
    await expect(saveDefault({ model: 'sonnet' }, models)).rejects.toThrow(/does not hold an object/);
  });

  it('writes nothing over a change made meanwhile, and makes its own on top of it', async () => {
    await writeFile(userFile(), JSON.stringify({ theme: 'dark' }));
    let once = true;
    writeHooks.beforeCompare = async (target) => {
      if (!once) return;
      once = false;
      // Claude Code saves a model while Pelican is writing.
      await writeFile(target, `${JSON.stringify({ theme: 'dark', model: 'haiku' }, null, 2)}\n`);
    };
    await saveDefault({ permissionMode: 'acceptEdits' }, models);
    expect(JSON.parse(await file())).toEqual({ theme: 'dark', model: 'haiku', permissions: { defaultMode: 'acceptEdits' } });
    // No temporary file is left behind.
    expect((await readdir(path.dirname(userFile()))).filter((name) => name.includes('.tmp.'))).toEqual([]);
  });

  it('gives up when the file keeps changing', async () => {
    await writeFile(userFile(), '{}');
    let n = 0;
    writeHooks.beforeCompare = async (target) => {
      n += 1;
      await writeFile(target, JSON.stringify({ n }));
    };
    await expect(saveDefault({ model: 'opus' }, models)).rejects.toThrow(/kept changing/);
    expect(JSON.parse(await file())).toEqual({ n: 5 });
  });

  it('keeps the file’s permissions, makes the folder and file where there are none, and writes through a symlinked file', async () => {
    await writeFile(userFile(), '{}');
    await chmod(userFile(), 0o600);
    await saveDefault({ fast: true }, models);
    expect((await stat(userFile())).mode & 0o777).toBe(0o600);
    // A settings file kept elsewhere (dotfiles), linked: the link stays, its target changes.
    const real = path.join(project, 'dotfiles-settings.json');
    await writeFile(real, '{"theme":"light"}');
    await rm(userFile());
    await symlink(real, userFile());
    await saveDefault({ model: 'haiku' }, models);
    expect((await lstat(userFile())).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(real, 'utf8'))).toEqual({ theme: 'light', model: 'haiku' });
    await rm(userFile());
  });

  it('writes a file reached through links to links at its real path, every link kept', async () => {
    // settings.json -> link1.json -> real.json, the middle link relative, as a dotfiles manager may make them.
    const real = path.join(project, 'real.json');
    const middle = path.join(path.dirname(userFile()), 'link1.json');
    await writeFile(real, '{"theme":"dark"}');
    await symlink(real, middle);
    await symlink('link1.json', userFile());
    try {
      await saveDefault({ model: 'opus' }, models);
      expect((await lstat(userFile())).isSymbolicLink()).toBe(true);
      expect((await lstat(middle)).isSymbolicLink()).toBe(true);
      expect(JSON.parse(await readFile(real, 'utf8'))).toEqual({ theme: 'dark', model: 'opus' });
      // A chain to a file not there yet makes it where the links lead.
      await rm(real);
      await saveDefault({ fast: true }, models);
      expect((await lstat(middle)).isSymbolicLink()).toBe(true);
      expect(JSON.parse(await readFile(real, 'utf8'))).toEqual({ fastMode: true });
      expect((await readdir(path.dirname(userFile()))).filter((name) => name.includes('.tmp.'))).toEqual([]);
    } finally {
      await rm(userFile(), { force: true });
      await rm(middle, { force: true });
      await rm(real, { force: true });
    }
  });

  it('merges as Claude Code does: objects key by key, anything else replaced, undefined taken out', () => {
    expect(mergeSettings({ a: 1, permissions: { allow: ['x'], defaultMode: 'plan' }, list: [1] }, { permissions: { defaultMode: 'auto' }, list: [2], a: undefined }))
      .toEqual({ permissions: { allow: ['x'], defaultMode: 'auto' }, list: [2] });
  });
});

it('reads and writes no settings in the real home', () => {
  expect(userFile()).not.toBe(path.join(os.homedir(), '.claude', 'settings.json'));
});

// The page's types and the server's answer agree.
export type Check = StartDefaults;
