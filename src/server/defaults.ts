import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile, readlink, realpath, rename, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  type DefaultChange, type DefaultSource, type EffortDefault, effortFor, type EffortTable, type FolderSetting, isSavedEffort, modelKey, OWN_EFFORT, type StartDefaults,
  type UserSettingsFile,
} from '../shared/defaults.js';
import { pickerValue } from '../shared/model-names.js';
import { isPermissionMode, type PermissionMode, START_MODES } from '../shared/modes.js';
import type { ModelOption, RunSettings } from '../shared/protocol.js';
import { sdk } from './agent-sdk.js';
import { config } from './config.js';
import { knownModels, listModels } from './models.js';
import { folderTrusted, type Launch, launchFor, NeedsTrust, type SettingSource } from './trust.js';

/**
 * Claude Code's own settings decide what a new session starts with: its model, effort, fast mode,
 * Ultracode and permission mode. This reads them as Claude Code 2.1.318 does, through the Agent
 * SDK's resolveSettings (the CLI's own merge of the user, project, local and managed files), and
 * works out each value with the rules Claude Code applies on top; and it changes the user's file
 * the way Claude Code's /model, /effort, /fast and /config change it.
 */

type Settings = Record<string, unknown>;
/** One settings file as Claude Code read it, lowest precedence first: user, project, local, managed. */
export type Layer = { source: DefaultSource; settings: Settings };

const isObject = (value: unknown): value is Settings => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The value the file with the highest precedence gives, and that file. */
function highest<T>(layers: Layer[], read: (settings: Settings) => T | undefined): { value: T; source: DefaultSource } | undefined {
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    const value = read(layers[i]!.settings);
    if (value !== undefined) return { value, source: layers[i]!.source };
  }
  return undefined;
}

const saved = (level: unknown) => (isSavedEffort(level) ? level : undefined);
const LEVELS: readonly unknown[] = ['low', 'medium', 'high', 'xhigh', 'max'];
/** A level a file caps effort at; Max is no cap, though a model's own Max takes the file's cap away for it. */
const capOf = (level: unknown) => (typeof level === 'string' && LEVELS.includes(level) ? level : undefined);

/**
 * Claude Code's table of efforts (2.1.318): each model's own level from modelSettings, keyed as
 * Claude Code keys a model (an alias, such as opus, by the model it stands for in `models`), the
 * files read from the highest precedence down, where a folder's or managed top-level effortLevel
 * stops the search too; the user's own top-level effortLevel is kept apart, for older models. And
 * the files' maxEffortLevel, the most a session's effort may be.
 */
export function effortTable(layers: Layer[], env: NodeJS.ProcessEnv = {}, models?: ModelOption[]): EffortTable {
  let legacy: EffortDefault | undefined;
  let fallback: EffortDefault | undefined;
  const walk: Array<{ source: DefaultSource; top: unknown; setsTop: boolean; own: Map<string, unknown> }> = [];
  const caps: NonNullable<EffortTable['caps']> = [];
  for (const { source, settings } of layers) {
    const own = new Map<string, unknown>();
    const capped: Record<string, string> = {};
    if (isObject(settings.modelSettings)) {
      for (const [name, entry] of Object.entries(settings.modelSettings)) {
        if (!isObject(entry)) continue;
        const key = modelKey(name, models);
        // A file's own cap for a model: the lowest it names under any of the model's keys.
        const cap = capOf(entry.maxEffortLevel);
        if (cap && !Object.hasOwn(Object.prototype, key) && (!capped[key] || LEVELS.indexOf(cap) < LEVELS.indexOf(capped[key]))) capped[key] = cap;
        if (entry.effortLevel === undefined) continue;
        if (name === key || !own.has(key)) own.set(key, entry.effortLevel);
      }
    }
    const most = saved(settings.maxEffortLevel);
    if (most || Object.keys(capped).length > 0) caps.push({ ...(most ? { top: most } : {}), ...(Object.keys(capped).length > 0 ? { byModel: capped } : {}) });
    const top = settings.effortLevel;
    if (source === 'user') {
      const level = saved(top);
      legacy = level ? { level, source } : undefined;
      walk.push({ source, top, setsTop: false, own });
      continue;
    }
    if (top !== undefined) fallback = { ...(saved(top) ? { level: saved(top)! } : {}), source };
    walk.push({ source, top, setsTop: top !== undefined, own });
  }
  walk.reverse();
  const byModel: Record<string, EffortDefault> = {};
  for (const key of new Set(walk.flatMap((w) => [...w.own.keys()]))) {
    for (const w of walk) {
      const level = w.own.has(key) ? saved(w.own.get(key)) : w.setsTop ? saved(w.top) : null;
      if (level === null) continue;
      byModel[key] = { ...(level ? { level } : {}), source: w.source };
      break;
    }
  }
  const table: EffortTable = { byModel, ...(fallback ? { fallback } : legacy ? { legacy } : {}), ...(caps.length > 0 ? { caps } : {}) };
  const asked = env.CLAUDE_CODE_EFFORT_LEVEL?.trim().toLowerCase();
  if (asked === 'auto' || asked === 'unset') table.env = null;
  else if (asked && (isSavedEffort(asked) || asked === 'max')) table.env = asked;
  return table;
}

/** The files that may set auto or bypassPermissions as the default: not a folder's, which its repository delivers. */
const MAY_ESCALATE = new Set<DefaultSource>(['user', 'managed']);

const modeIn = (settings: Settings): PermissionMode | undefined => {
  const mode = isObject(settings.permissions) ? settings.permissions.defaultMode : undefined;
  const named = mode === 'manual' ? 'default' : mode;
  return isPermissionMode(named) ? named : undefined;
};

/**
 * The mode a new session starts in, by Claude Code's rules (2.1.318): a file's
 * permissions.defaultMode, except that Auto and Bypass count only from the user's own or managed
 * settings (from a folder's, Bypass gives Manual and Auto gives the default), a Bypass that
 * disableBypassPermissionsMode turns off gives the default, and Auto needs Auto mode on. With
 * none, the default is Auto where Claude Code has it, as the terminal starts ("Auto mode is now
 * Claude Code's default permission mode"), else Manual: run through the SDK, Claude Code would
 * start in Manual, so Pelican asks for Auto itself there.
 */
export function startMode(layers: Layer[]): StartDefaults['permissionMode'] {
  const set = highest(layers, modeIn);
  const said = (mode: PermissionMode) => layers.some((layer) => MAY_ESCALATE.has(layer.source) && modeIn(layer.settings) === mode);
  const permission = (key: string) => highest(layers, (s) => (isObject(s.permissions) ? s.permissions[key] : undefined))?.value;
  const bypassOff = permission('disableBypassPermissionsMode') === 'disable';
  const autoOff = permission('disableAutoMode') === 'disable' || highest(layers, (s) => s.disableAutoMode)?.value === 'disable';
  const userMode = layers.find((layer) => layer.source === 'user');
  const own = userMode ? modeIn(userMode.settings) : undefined;
  const mine = (source: DefaultSource) => (own && source !== 'user' ? { user: own } : {});
  const builtIn = (extra: Partial<StartDefaults['permissionMode']> = {}): StartDefaults['permissionMode'] => ({
    value: autoOff ? 'default' : 'auto', source: 'built-in', ...(own ? { user: own } : {}), ...extra,
  });
  if (!set) return builtIn();
  const { value: mode, source } = set;
  if ((mode === 'bypassPermissions' || mode === 'auto') && !said(mode)) {
    const ignored = { mode, source, why: 'folder' as const };
    // A folder's Bypass is taken for Manual; a folder's Auto as if no file had said anything.
    return mode === 'bypassPermissions' ? { value: 'default', source, ...mine(source), ignored } : builtIn({ ignored });
  }
  if (mode === 'bypassPermissions' && bypassOff) return builtIn({ ignored: { mode, source, why: 'disabled' } });
  return { value: mode === 'auto' && autoOff ? 'default' : mode, source, ...mine(source) };
}

/** What a new session starts with, from Claude Code's settings files (lowest precedence first); `models`, the picker's list, as far as it is known. */
export function startDefaults(layers: Layer[], env: NodeJS.ProcessEnv, file: UserSettingsFile, models?: ModelOption[]): StartDefaults {
  const user = layers.find((layer) => layer.source === 'user')?.settings;
  const envModel = env.ANTHROPIC_MODEL?.trim();
  const named = highest(layers, (s) => (typeof s.model === 'string' && s.model.trim() ? s.model.trim() : undefined));
  const model: StartDefaults['model'] = envModel ? { value: envModel, source: 'env' }
    : named ? { value: named.value.toLowerCase() === 'default' ? 'default' : named.value, source: named.source }
      : { value: 'default', source: 'built-in' };
  if (model.source !== 'user' && typeof user?.model === 'string' && user.model.trim() && user.model.trim() !== model.value) model.user = user.model.trim();

  const fastSet = highest(layers, (s) => (typeof s.fastMode === 'boolean' ? s.fastMode : undefined));
  const perSession = highest(layers, (s) => (typeof s.fastModePerSessionOptIn === 'boolean' ? s.fastModePerSessionOptIn : undefined))?.value === true;

  const ultra = highest(layers, (s) => (typeof s.ultracode === 'boolean' ? s.ultracode : undefined));
  const workflowsOff = highest(layers, (s) => (typeof s.disableWorkflows === 'boolean' ? s.disableWorkflows : undefined))?.value === true
    || ['1', 'true', 'yes'].includes(String(env.CLAUDE_CODE_DISABLE_WORKFLOWS ?? '').toLowerCase())
    || highest(layers, (s) => (typeof s.enableWorkflows === 'boolean' ? s.enableWorkflows : undefined))?.value === false;

  return {
    model,
    effort: effortTable(layers, env, models),
    fast: { value: fastSet?.value === true && !perSession, source: fastSet?.source ?? 'built-in', perSession },
    ultracode: { value: ultra?.value === true && !workflowsOff, source: ultra?.source ?? 'built-in', workflows: !workflowsOff },
    permissionMode: startMode(layers),
    file,
  };
}

/** Claude Code's user settings file: settings.json in CLAUDE_CONFIG_DIR, else in ~/.claude. */
export const userSettingsPath = (): string => path.join(process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude'), 'settings.json');

/** Past this, Pelican neither reads nor writes the file. */
const MAX_BYTES = 2 * 1024 * 1024;

type Read = { file: UserSettingsFile; text: string | null; json?: Settings };

/** The user's settings file as it is: its text (null: there is none) and what it holds. */
async function readUserFile(): Promise<Read> {
  const file = userSettingsPath();
  let text: string;
  try {
    const info = await stat(file);
    if (info.size > MAX_BYTES) return { file: { path: file, state: 'invalid', problem: 'It is larger than 2 MB.' }, text: null };
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { file: { path: file, state: 'missing' }, text: null, json: {} };
    return { file: { path: file, state: 'invalid', problem: `It cannot be read (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}).` }, text: null };
  }
  const body = text.startsWith('\uFEFF') ? text.slice(1) : text;
  if (body.trim() === '') return { file: { path: file, state: 'ok' }, text, json: {} };
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (error) {
    return { file: { path: file, state: 'invalid', problem: `It is not valid JSON: ${(error as Error).message}` }, text };
  }
  if (!isObject(json)) return { file: { path: file, state: 'invalid', problem: 'It does not hold an object.' }, text };
  return { file: { path: file, state: 'ok' }, text, json };
}

/**
 * The settings files what a new session in `dir` starts with is read from: a folder's own only once
 * the folder is trusted, as in Claude Code (trust.ts), and never where the user kept it to their
 * own settings. `waits`: the folder's own wait for it to be trusted.
 */
async function sourcesFor(dir: string | undefined): Promise<{ sources: SettingSource[]; waits: boolean }> {
  if (!dir) return { sources: ['user'], waits: false };
  let launch: Launch | undefined;
  try {
    launch = await launchFor(dir);
  } catch (error) {
    if (!(error instanceof NeedsTrust)) throw error;
  }
  if (launch && (await folderTrusted(dir))) return { sources: launch.settingSources, waits: false };
  return { sources: ['user'], waits: !launch || launch.settingSources.includes('project') };
}

/** What a folder's own settings files set for a new session (fromSettings in trust.ts lists the same, to ask about it). */
async function folderSets(dir: string): Promise<FolderSetting[]> {
  const resolved = await sdk().then(({ resolveSettings }) => resolveSettings({ cwd: dir, settingSources: ['project', 'local'] })).catch(() => undefined);
  const set = new Set<FolderSetting>();
  for (const { source, settings } of resolved?.sources ?? []) {
    if (source !== 'project' && source !== 'local') continue;
    const s = settings as Settings;
    if (typeof s.model === 'string' && s.model.trim()) set.add('model');
    if (typeof s.effortLevel === 'string' || Object.values(isObject(s.modelSettings) ? s.modelSettings : {}).some((entry) => isObject(entry) && typeof entry.effortLevel === 'string')) set.add('effort');
    if (typeof s.fastMode === 'boolean') set.add('fast');
    if (typeof s.ultracode === 'boolean') set.add('ultracode');
    if (isObject(s.permissions) && typeof s.permissions.defaultMode === 'string') set.add('mode');
  }
  return (['model', 'effort', 'fast', 'ultracode', 'mode'] as const).filter((what) => set.has(what));
}

/** The demo's own: Claude Code's defaults, from no file at all. */
export const DEMO_DEFAULTS: StartDefaults = {
  model: { value: 'default', source: 'built-in' },
  effort: { byModel: {} },
  fast: { value: false, source: 'built-in', perSession: false },
  ultracode: { value: false, source: 'built-in', workflows: true },
  permissionMode: { value: 'auto', source: 'built-in' },
  file: { path: '~/.claude/settings.json', state: 'missing' },
};

/**
 * What a new session in `cwd` (none: a scratch session) starts with, and where each value comes
 * from; `models`, the picker's list (as last listed), by which an alias's settings are its model's.
 */
export async function readDefaults(cwd?: string, models: ModelOption[] | undefined = knownModels()): Promise<StartDefaults> {
  if (config.demo) return DEMO_DEFAULTS;
  const dir = cwd ? await realpath(cwd).catch(() => undefined) : undefined;
  const { sources: settingSources, waits } = await sourcesFor(dir);
  const waiting = dir && waits ? await folderSets(dir) : [];
  const read = await readUserFile();
  // Claude Code's own merge of the files; should it fail, the user's file as read here.
  const layers: Layer[] = await sdk().then(({ resolveSettings }) => resolveSettings({ cwd: dir ?? os.homedir(), settingSources }))
    .then((resolved) => resolved.sources.map(({ source, settings }): Layer => ({ source: source === 'flag' ? 'managed' : source, settings: settings as Settings })))
    .catch(() => (read.json && Object.keys(read.json).length > 0 ? [{ source: 'user' as const, settings: read.json }] : []));
  // JSON Claude Code skipped all the same: a value in it is not one it reads.
  const skipped = read.file.state === 'ok' && read.json && Object.keys(read.json).length > 0 && !layers.some((layer) => layer.source === 'user');
  const file: UserSettingsFile = skipped
    ? { ...read.file, state: 'skipped', problem: 'Claude Code skips it: a value in it is not one Claude Code reads.' }
    : read.file;
  return { ...startDefaults(layers, process.env, file, models), ...(waiting.length > 0 ? { waiting } : {}) };
}

/** Why a change was not made: said to the page as it is. */
export class SettingsRefused extends Error {
  constructor(message: string, readonly status: 400 | 409 = 409) {
    super(message);
  }
}

/**
 * Deep merge as Claude Code's (lodash mergeWith): objects merge key by key, anything else
 * replaces, and undefined takes the key out. Keys keep their place; new ones go at the end.
 */
export function mergeSettings(target: Settings, patch: Settings): Settings {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete target[key];
    else if (isObject(value)) target[key] = mergeSettings(isObject(target[key]) ? target[key] : {}, value);
    else target[key] = value;
  }
  return target;
}

/** What Claude Code's command writes for a change, as a patch to merge in. */
async function patchFor(change: DefaultChange, models: () => Promise<ModelOption[]>): Promise<Settings> {
  const listed = async (model: unknown) => {
    if (typeof model !== 'string' || !model || model.length > 200) throw new SettingsRefused('No such model', 400);
    if (model === 'default') return model;
    if (!(await models()).some((m) => m.value === model)) throw new SettingsRefused(`Claude Code does not list ${model}`, 400);
    return model;
  };
  if ('model' in change) {
    const model = await listed(change.model);
    return { model: model === 'default' ? undefined : model };
  }
  if ('effort' in change) {
    const { level, model } = change.effort ?? {};
    if (level !== null && !isSavedEffort(level)) throw new SettingsRefused('Claude Code keeps Low, Medium, High or Extra high as a default; Max is for one session.', 400);
    // Any model a session or a settings file names, listed or not (opus[1m]): /effort saves under its key.
    if (typeof model !== 'string' || !model.trim() || model.length > 200) throw new SettingsRefused('No such model', 400);
    const key = modelKey(model, await models());
    // As /effort does: under the model's key, or at the top for a key every object has.
    return Object.hasOwn(Object.prototype, key)
      ? { effortLevel: level ?? undefined }
      : { modelSettings: { [key]: { effortLevel: level ?? undefined } } };
  }
  if ('fast' in change) {
    if (typeof change.fast !== 'boolean') throw new SettingsRefused('Say fast: true or false', 400);
    return { fastMode: change.fast ? true : undefined };
  }
  if ('permissionMode' in change) {
    if (change.permissionMode === 'bypassPermissions') throw new SettingsRefused('Bypass permissions is never saved as a default; pick it in a session.', 400);
    if (!START_MODES.includes(change.permissionMode)) throw new SettingsRefused('No such mode', 400);
    return { permissions: { defaultMode: change.permissionMode } };
  }
  throw new SettingsRefused('Nothing to change', 400);
}

/**
 * Where a write of `file` lands: its real path, every link on the way followed, so that each link
 * stays a link (a dotfiles manager may link a link). Claude Code 2.1.318's own writer reads one
 * link, and would put a file in place of a second one. A link to a file not there yet leads to
 * where the file is to be, following the links as far as they go.
 */
async function writeTarget(file: string): Promise<string> {
  try {
    return await realpath(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let target = file;
  // As far as the system follows links; one that leads in a circle realpath has refused already.
  for (let hops = 0; hops < 40; hops += 1) {
    const link = await lstat(target).catch(() => undefined);
    if (!link?.isSymbolicLink()) break;
    const from = await realpath(path.dirname(target)).catch(() => path.dirname(target));
    target = path.resolve(from, await readlink(target));
  }
  return target;
}

/**
 * Writes `text` in place of `file` as Claude Code writes its settings: to a temporary file beside
 * the file (through a symlinked file, beside its real path: writeTarget), with the old file's
 * permissions, synced, then renamed over it. `before` is what the change was made from: when the
 * file holds anything else by then, someone changed it meanwhile, and nothing is written.
 */
async function writeOver(file: string, text: string, before: string | null): Promise<boolean> {
  const target = await writeTarget(file);
  await mkdir(path.dirname(target), { recursive: true });
  const old = await stat(target).catch(() => undefined);
  const temp = `${target}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
  const handle = await open(temp, 'wx', old ? old.mode & 0o777 : 0o666);
  try {
    try {
      await handle.writeFile(text, 'utf8');
      if (old) await handle.chmod(old.mode & 0o7777);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await writeHooks.beforeCompare?.(target);
    const now = await readFile(target, 'utf8').catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
    if (now !== before) {
      await unlink(temp);
      return false;
    }
    await rename(temp, target);
    return true;
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

/** For tests: what happens between writing the temporary file and comparing (another program's change). */
export const writeHooks: { beforeCompare?: (target: string) => Promise<void> } = {};

let queue: Promise<unknown> = Promise.resolve();

/**
 * Makes one change to Claude Code's user settings, as its command would: the file is read, the
 * change merged in, and every other key kept; written as Claude Code writes it (two-space JSON and
 * a newline), at once, and only over the file the change was made from. A file that does not
 * parse is left alone. Changes from Pelican go one at a time.
 */
export function saveDefault(change: DefaultChange, models: () => Promise<ModelOption[]> = async () => knownModels() ?? (await listModels()).models): Promise<void> {
  const run = queue.then(async () => {
    if (config.demo) throw new SettingsRefused('This is the demo: nothing changes.', 409);
    const patch = await patchFor(change, models);
    if ('fast' in change) {
      const read = await readDefaults();
      if (read.fast.perSession) throw new SettingsRefused('Your Claude Code settings start each session without fast mode (fastModePerSessionOptIn), so it is not saved.');
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const read = await readUserFile();
      if (!read.json) {
        throw new SettingsRefused(`Pelican left ${read.file.path} as it is: ${read.file.problem ?? 'it cannot be read.'} Fix it, then try again.`);
      }
      const text = `${JSON.stringify(mergeSettings(structuredClone(read.json), patch), null, 2)}\n`;
      if (text === read.text) return;
      if (await writeOver(read.file.path, text, read.text)) return;
    }
    throw new SettingsRefused('Claude Code’s settings kept changing while Pelican saved; try again.');
  });
  queue = run.catch(() => undefined);
  return run;
}

/**
 * What a new session in `cwd` runs with: what was picked for it, and from Claude Code's settings
 * what Pelican has to pass for Claude Code to start as in the terminal, the mode and fast mode
 * (which Claude Code run through the SDK leaves off unless asked). The model, effort and
 * Ultracode are Claude Code's to read; `shown` has them too, for the page. Default picked where a
 * file or the environment names a model or an effort is given as such (the model `default`, the
 * effort OWN_EFFORT): Claude Code's own, as its /model default and /effort auto make it.
 */
export async function newSessionSettings(
  cwd: string,
  picked: RunSettings,
  // As last listed: asking Claude Code now would start another process for a list the page has asked for already.
  listed: () => Promise<ModelOption[] | undefined> = async () => knownModels(),
): Promise<{ given: RunSettings; shown: RunSettings }> {
  const models = await listed();
  const defaults = await readDefaults(cwd, models);
  const model = picked.model ?? pickerValue(defaults.model.value, models);
  const option = models?.find((m) => m.value === model);
  // Default picked where a file names another: the model's own, as /effort auto gives it, which
  // CLAUDE_CODE_EFFORT_LEVEL still overrides, as in Claude Code.
  const own = picked.effort === OWN_EFFORT;
  const table = own ? { byModel: {}, ...(defaults.effort.env !== undefined ? { env: defaults.effort.env } : {}) } : defaults.effort;
  const effort = (own ? undefined : picked.effort) ?? effortFor(table, modelKey(model, models), option).level;
  const fast = picked.fast ?? (defaults.fast.value && option?.supportsFast !== false);
  const mode = picked.permissionMode ?? (defaults.permissionMode.value === 'auto' && option?.supportsAuto === false ? 'default' : defaults.permissionMode.value);
  // Ultracode turned off for it where a file turns it on is said, or Claude Code would turn it on.
  const { ultracode: _ultracode, ...rest } = picked;
  const ultracode = picked.ultracode === true || (picked.ultracode === false && defaults.ultracode.value) ? { ultracode: picked.ultracode } : {};
  const given: RunSettings = { ...rest, ...ultracode, permissionMode: mode, ...(fast ? { fast: true } : {}) };
  const shown: RunSettings = {
    model,
    ...(effort ? { effort } : {}),
    fast,
    ultracode: picked.ultracode ?? defaults.ultracode.value,
    permissionMode: mode,
  };
  return { given, shown };
}
