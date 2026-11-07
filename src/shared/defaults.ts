import type { PermissionMode } from './modes';
import type { ModelOption } from './protocol';

/**
 * What a new session starts with is Claude Code's to say, from its settings files, as the terminal
 * and Claude Desktop read them (Claude Code 2.1.318). Pelican keeps no defaults of its own: the
 * server reads the files and works out what Claude Code would start with in a folder, and where
 * each value comes from; Settings and a session's model sheet write the user's file as Claude
 * Code's own /model, /effort, /fast and /config do.
 */

/** Where a value comes from: Claude Code itself, one of its settings files, or Pelican's environment. */
export type DefaultSource = 'built-in' | 'user' | 'project' | 'local' | 'managed' | 'env';

/** The levels /effort saves as a default; Max is for one session, and Claude Code keeps it nowhere. */
export const SAVED_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
export type SavedEffort = (typeof SAVED_EFFORTS)[number];
export const isSavedEffort = (value: unknown): value is SavedEffort => (SAVED_EFFORTS as readonly unknown[]).includes(value);

/** Every level, the least first. */
const LEVELS: readonly string[] = [...SAVED_EFFORTS, 'max'];

/**
 * A new session's effort picked as Default where Claude Code's settings would start it with another:
 * the model's own, as `/effort auto` gives it (Claude Code's word for its default). Only a pick says it.
 */
export const OWN_EFFORT = 'auto';

export type EffortDefault = { level?: string; source: DefaultSource };

/**
 * Claude Code keeps effort per model (modelSettings.<model>.effortLevel, which /effort writes), so
 * the effort a session starts with depends on its model: `effortFor` reads this for one.
 */
export type EffortTable = {
  /** By Claude Code's key for a model (claude-opus-5-5): what the files say for it; no level where a file clears it. */
  byModel: Record<string, EffortDefault>;
  /** A top-level effortLevel in a folder's or managed settings: each model without its own gets it. */
  fallback?: EffortDefault;
  /** A top-level effortLevel in the user's own file, from older versions: Claude Code applies it to older models only. */
  legacy?: EffortDefault;
  /** CLAUDE_CODE_EFFORT_LEVEL in Pelican's environment, which every session gets; null where it says auto. */
  env?: string | null;
  /**
   * The files' maxEffortLevel, which no session's effort goes above: by file, the model's own cap
   * (modelSettings.<model>.maxEffortLevel, Max for none) in place of the file's; the lowest counts.
   */
  caps?: Array<{ top?: string; byModel?: Record<string, string> }>;
};

export type StartDefaults = {
  /** The picker's value ('default': Claude Code's own), and the user's own pick where another file overrides it here. */
  model: { value: string; source: DefaultSource; user?: string };
  effort: EffortTable;
  /** `perSession`: fastModePerSessionOptIn, with which every session starts without fast mode and /fast saves nothing. */
  fast: { value: boolean; source: DefaultSource; perSession: boolean };
  /** Ultracode is a session's own; a settings file may still turn it on (no command writes it). `workflows`: whether it can be on. */
  ultracode: { value: boolean; source: DefaultSource; workflows: boolean };
  /**
   * For a model with Auto; startModeFor says it for another. `ignored`: what a file asks for that Claude
   * Code does not take from there (Auto or Bypass from a folder's files) or that settings turn off.
   */
  permissionMode: {
    value: PermissionMode;
    source: DefaultSource;
    user?: PermissionMode;
    ignored?: { mode: PermissionMode; source: DefaultSource; why: 'folder' | 'disabled' };
  };
  /** Claude Code's user settings file, the one file Pelican changes. */
  file: UserSettingsFile;
  /**
   * What the folder's own settings set for a new session that is not taken yet: a folder's count
   * only once it is trusted, as in Claude Code, and Pelican asks first. None where they count, or
   * where the user kept the folder to their own settings.
   */
  waiting?: FolderSetting[];
};

/** What a folder's settings may set for a new session, as the sheets name it. */
export type FolderSetting = 'model' | 'effort' | 'fast' | 'ultracode' | 'mode';

/**
 * ok: read, and Claude Code reads it too. missing: none yet (a change creates it). invalid: not
 * JSON (or not an object), so Claude Code skips it and nothing is written to it. skipped: JSON
 * that Claude Code skips for a value it cannot read; a change still goes in, as Claude Code's do.
 */
export type UserSettingsFile = { path: string; state: 'ok' | 'missing' | 'invalid' | 'skipped'; problem?: string };

/** One change to the user's settings, as one of Claude Code's commands makes it. */
export type DefaultChange =
  /** /model: a model from the picker; 'default' takes the setting out. */
  | { model: string }
  /** /effort for a model: a saved level, or null for Default (/effort auto). */
  | { effort: { model: string; level: SavedEffort | null } }
  /** /fast. */
  | { fast: boolean }
  /** /config's Default permission mode: never Bypass. */
  | { permissionMode: PermissionMode };

/**
 * Claude Code's key for a model in modelSettings: the model's id (an alias resolved through the
 * picker's list), without [1m], a provider's prefix or a date; it matches all those spellings.
 */
export function modelKey(model: string, models?: ModelOption[]): string {
  // opus[1m] is opus's key, as an alias the list does not have.
  const bare = model.trim().replace(/\[[12]m\]$/i, '');
  const option = models?.find((m) => m.value === model) ?? models?.find((m) => m.value === bare);
  let key = (option?.resolvedModel ?? bare).trim().toLowerCase().replace(/\[[12]m\]$/, '');
  key = key.slice(key.lastIndexOf('/') + 1).replace(/^(?:[a-z-]+\.)?anthropic\./, '');
  return key.replace(/-v\d+(?::\d+)?$/, '').replace(/[@-]\d{8}$/, '');
}

/** The models Claude Code still gives the user's old top-level effortLevel to (2.1.318's list). */
const LEGACY_EFFORT_MODELS = new Set([
  'claude-3-5-haiku', 'claude-3-5-sonnet', 'claude-3-7-sonnet', 'claude-haiku-4-5', 'claude-sonnet-4-0', 'claude-sonnet-4-5',
  'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-opus-4-0', 'claude-opus-4-1', 'claude-opus-4-5', 'claude-opus-4-6', 'claude-opus-4-7',
  'claude-opus-4-8', 'claude-opus-5', 'claude-fable-5', 'claude-fable-5-1', 'claude-mythos-5', 'claude-mythos-5-1',
]);
const takesLegacyEffort = (key: string) => LEGACY_EFFORT_MODELS.has(key) || !/^claude-[a-z]+-\d{1,2}(?:-\d{1,2})?$/.test(key);

/**
 * The effort a new session on this model starts with, as Claude Code works it out: Pelican's
 * environment first, then the model's own, then a folder's or managed top-level effortLevel, then
 * (for older models) the user's top-level one; no level is Claude Code's own default for the model.
 */
export function effortFor(table: EffortTable, key: string | undefined, model?: ModelOption): EffortDefault {
  const found: EffortDefault = table.env !== undefined
    ? (table.env === null ? { source: 'env' } : { level: table.env, source: 'env' })
    : key !== undefined && Object.hasOwn(table.byModel, key) ? table.byModel[key]!
      : table.fallback ?? (table.legacy && key !== undefined && takesLegacyEffort(key) ? table.legacy : { source: 'built-in' });
  const capped = capTo(found, capFor(table, key));
  if (!capped.level || !model || model.efforts.includes(capped.level)) return capped;
  // A model without effort levels gets none; one without Extra high or Max gets High, as Claude Code clamps it.
  if (model.efforts.length === 0) return { source: capped.source };
  return capped.level === 'xhigh' || capped.level === 'max' ? { ...capped, level: 'high' } : capped;
}

/** The highest effort the files let a session on the model with this key run at (maxEffortLevel); none for no cap. */
export function capFor(table: EffortTable, key: string | undefined): string | undefined {
  let cap: string | undefined;
  for (const file of table.caps ?? []) {
    // A model's own cap stands in for its file's; Max is none.
    const level = (key !== undefined && file.byModel && Object.hasOwn(file.byModel, key) ? file.byModel[key] : undefined) ?? file.top;
    if (level && level !== 'max' && (cap === undefined || LEVELS.indexOf(level) < LEVELS.indexOf(cap))) cap = level;
  }
  return cap;
}

const capTo = (found: EffortDefault, cap: string | undefined): EffortDefault =>
  (found.level && cap && LEVELS.indexOf(found.level) > LEVELS.indexOf(cap) ? { ...found, level: cap } : found);

/**
 * The effort a new session on the picker's `model` starts with. A table read before the server
 * knew the list of models keeps an alias's own key (opus): it counts for the model it stands for.
 */
export function effortOf(defaults: StartDefaults, model: string, models: ModelOption[] | undefined): EffortDefault {
  const key = modelKey(model, models);
  const table = defaults.effort;
  const alias = Object.hasOwn(table.byModel, key) ? undefined : Object.keys(table.byModel).find((name) => modelKey(name, models) === key);
  return effortFor(alias ? { ...table, byModel: { ...table.byModel, [key]: table.byModel[alias]! } } : table, key, models?.find((m) => m.value === model));
}

/** The mode a new session starts in on `model`: Auto is Manual on a model without it, as in Claude Code. */
export function startModeFor(defaults: StartDefaults, model: { supportsAuto?: boolean } | undefined): PermissionMode {
  return defaults.permissionMode.value === 'auto' && model?.supportsAuto === false ? 'default' : defaults.permissionMode.value;
}

/** Where a value comes from, in a few words. */
export const SOURCE_LABEL: Record<DefaultSource, string> = {
  'built-in': 'Claude Code’s default',
  user: 'Your Claude Code settings',
  project: 'This folder’s .claude/settings.json',
  local: 'This folder’s .claude/settings.local.json',
  managed: 'Managed settings',
  env: 'Pelican’s environment',
};
