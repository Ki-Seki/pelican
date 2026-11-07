import { type DefaultChange, type DefaultSource, effortOf, type FolderSetting, isSavedEffort, SOURCE_LABEL, type StartDefaults, startModeFor } from '../../shared/defaults';
import { pickerValue } from '../../shared/model-names';
import { MODE_INFO, type PermissionMode } from '../../shared/modes';
import type { ModelOption, RunSettings } from '../../shared/protocol';
import { EFFORT_LABELS } from './prefs';

/**
 * What a new session starts with, as Claude Code's settings give it (shared/defaults.ts), in the
 * composer's terms: the picker's model, its effort, fast mode and Ultracode where the model has
 * them, and the mode for that model.
 */
export function fromDefaults(defaults: StartDefaults, models: ModelOption[] | undefined): RunSettings {
  const model = pickerValue(defaults.model.value, models);
  return { ...forModel(defaults, model, models), model };
}

/** For a new session on `model`: what Claude Code's settings start it with (the model itself aside). */
export function forModel(defaults: StartDefaults, model: string, models: ModelOption[] | undefined): Omit<RunSettings, 'model'> {
  const option = models?.find((m) => m.value === model);
  const effort = effortOf(defaults, model, models).level;
  return {
    ...(effort ? { effort } : {}),
    fast: defaults.fast.value && option?.supportsFast !== false,
    ultracode: defaults.ultracode.value && (option ? option.efforts.includes('xhigh') : true),
    permissionMode: startModeFor(defaults, option),
  };
}

/**
 * What one pick in a model sheet saves as Claude Code's default, as /model, /effort and /fast do in
 * the terminal: the model, or the effort for the model (Max is for one session), or fast mode.
 * Ultracode and the mode are a session's alone. A pick of a model changes what goes with it (the
 * model's own effort, no fast mode where it has none), and saves only the model.
 */
export function defaultChange(before: RunSettings, next: RunSettings, perSessionFast = false): DefaultChange | undefined {
  const model = next.model ?? 'default';
  if (model !== (before.model ?? 'default')) return { model };
  if (next.effort !== before.effort) {
    if (next.effort === undefined) return { effort: { model, level: null } };
    return isSavedEffort(next.effort) ? { effort: { model, level: next.effort } } : undefined;
  }
  if (Boolean(next.fast) !== Boolean(before.fast) && !perSessionFast) return { fast: Boolean(next.fast) };
  return undefined;
}

const name = (model: string, models: ModelOption[] | undefined) => {
  const option = models?.find((m) => m.value === pickerValue(model, models));
  return option ? (option.value === 'default' ? 'Claude Code’s default model' : option.label) : model;
};

/** Where what new sessions start on comes from, for Settings' Model row: the files that set any of it. */
export function modelSources(defaults: StartDefaults, models: ModelOption[] | undefined): string {
  const model = pickerValue(defaults.model.value, models);
  const sources = new Set<DefaultSource>([defaults.model.source, effortOf(defaults, model, models).source]);
  if (defaults.fast.value || defaults.fast.perSession) sources.add(defaults.fast.source);
  if (defaults.ultracode.value) sources.add(defaults.ultracode.source);
  sources.delete('built-in');
  return sources.size === 0 ? 'Claude Code’s defaults' : [...sources].map((source) => SOURCE_LABEL[source]).join(', ');
}

/** A file that is not the user's own: a folder's, managed settings, or Pelican's environment. */
const other = (source: DefaultSource) => source !== 'user' && source !== 'built-in';

/** The verb's ending for what a source's name is: "Your Claude Code settings start", "This folder's file starts". */
const s = (source: DefaultSource) => (source === 'user' || source === 'managed' ? '' : 's');

const WAITING: Record<FolderSetting, string> = { model: 'the model', effort: 'the effort', fast: 'fast mode', ultracode: 'Ultracode', mode: 'the mode' };

/**
 * Says what of a folder's own settings waits for the folder to be trusted, of `kinds`: they count
 * only once it is, and Pelican asks before the new session starts.
 */
function waitingNote(defaults: StartDefaults, kinds: readonly FolderSetting[]): string | undefined {
  const words = (defaults.waiting ?? []).filter((what) => kinds.includes(what)).map((what) => WAITING[what]);
  if (words.length === 0) return undefined;
  const list = words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
  return `This folder’s own settings for ${list} wait until you trust the folder, which Pelican asks before the session starts.`;
}

/** Says which file sets what here, where it is not the user's own settings: the model sheet's note. */
export function modelNote(defaults: StartDefaults, models: ModelOption[] | undefined, model?: string): string | undefined {
  const lines: string[] = [];
  const shown = model ?? pickerValue(defaults.model.value, models);
  if (other(defaults.model.source)) {
    lines.push(`${SOURCE_LABEL[defaults.model.source]} start${s(defaults.model.source)} sessions${defaults.model.source === 'project' || defaults.model.source === 'local' ? ' here' : ''} with ${name(defaults.model.value, models)}${defaults.model.user ? ` (yours: ${name(defaults.model.user, models)})` : ''}.`);
  }
  const effort = effortOf(defaults, shown, models);
  if (other(effort.source)) {
    lines.push(effort.level
      ? `${SOURCE_LABEL[effort.source]} set${s(effort.source)} ${EFFORT_LABELS[effort.level] ?? effort.level} effort for ${name(shown, models)}.`
      : `${SOURCE_LABEL[effort.source]} leave${s(effort.source)} the effort to Claude Code.`);
  }
  if (defaults.fast.perSession) lines.push('Each session starts without fast mode: your Claude Code settings ask for it per session.');
  else if (defaults.fast.value && other(defaults.fast.source)) lines.push(`${SOURCE_LABEL[defaults.fast.source]} turn${s(defaults.fast.source)} fast mode on.`);
  if (defaults.ultracode.value) lines.push(`${SOURCE_LABEL[defaults.ultracode.source]} turn${s(defaults.ultracode.source)} Ultracode on for every session.`);
  const waiting = waitingNote(defaults, ['model', 'effort', 'fast', 'ultracode']);
  if (waiting) lines.push(waiting);
  return lines.length > 0 ? lines.join(' ') : undefined;
}

/** Says why new sessions start in the mode they do, where that is not plain, and what of the folder's waits: the mode sheet's note. */
export function modeNote(defaults: StartDefaults, model: ModelOption | undefined): string | undefined {
  const said = [startNote(defaults, model), waitingNote(defaults, ['mode'])].filter(Boolean);
  return said.length > 0 ? said.join(' ') : undefined;
}

function startNote(defaults: StartDefaults, model: ModelOption | undefined): string | undefined {
  const { permissionMode: mode } = defaults;
  const start = startModeFor(defaults, model);
  const label = (m: PermissionMode) => MODE_INFO[m].label;
  if (start === 'bypassPermissions') {
    return `${mode.source === 'managed' ? 'Managed settings start' : 'Your Claude Code settings start'} new sessions in Bypass permissions: Claude runs everything without asking.`;
  }
  if (mode.ignored?.why === 'folder') {
    return `${SOURCE_LABEL[mode.ignored.source]} ask${s(mode.ignored.source)} for ${label(mode.ignored.mode)}, which Claude Code takes only from your own settings${mode.ignored.mode === 'bypassPermissions' ? ', so sessions here start in Manual' : ''}.`;
  }
  if (mode.ignored?.why === 'disabled') return 'Your Claude Code settings ask for Bypass permissions and turn it off too (disableBypassPermissionsMode), so it is not used.';
  if (other(mode.source)) {
    return `${SOURCE_LABEL[mode.source]} start${s(mode.source)} sessions${mode.source === 'project' || mode.source === 'local' ? ' here' : ''} in ${label(start)}${mode.user && mode.user !== start ? ` (yours: ${label(mode.user)})` : ''}.`;
  }
  return undefined;
}
