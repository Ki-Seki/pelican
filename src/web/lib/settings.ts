import { pickerValue } from '../../shared/model-names';
import type { ModelOption, RecordedSettings, RunSettings } from '../../shared/protocol';

/**
 * A session's recorded settings in the composer's terms; they are the session's own, Bypass
 * included (only a branch leaves Bypass behind).
 *
 * Claude Code records the model it asked for by id (claude-opus-5-5), while the picker lists
 * aliases that may resolve to the same model (Default and Opus 5.5 both do). The one picked for
 * this session here (`chosen`) is kept while it still resolves to what the session runs; else
 * the model is named for what it is: the id's own entry, else an alias other than Default.
 */
export function fromRecorded(recorded: RecordedSettings | undefined, models: ModelOption[] | undefined, chosen?: string): RunSettings | undefined {
  if (!recorded || Object.keys(recorded).length === 0) return undefined;
  const out: RunSettings = {};
  if (recorded.model) out.model = pickerValue(recorded.model, models, chosen);
  if (recorded.effort) out.effort = recorded.effort;
  if (recorded.fast !== undefined) out.fast = recorded.fast;
  if (recorded.ultracode !== undefined) out.ultracode = recorded.ultracode;
  if (recorded.permissionMode) out.permissionMode = recorded.permissionMode;
  return out;
}

/**
 * What a session's Claude runs with, as its run says, once it says anything. One started for
 * something other than a message (Rewind to here's check of the files, a rewind or its undo, a `!`
 * command's record) has run no turn and been told nothing: until it is, the session's own
 * settings stand, not Claude Code's defaults, which the next message would otherwise carry.
 */
export function runningWith(run: { settings: RunSettings } | undefined): RunSettings | undefined {
  return run && Object.keys(run.settings).length > 0 ? run.settings : undefined;
}
