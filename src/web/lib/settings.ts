import type { ModelOption, RecordedSettings, RunSettings } from '../../shared/protocol';

/**
 * A session's recorded settings in the composer's terms. Claude Code records the model it asked
 * for by id (claude-opus-5-5); the picker lists aliases (default, opus) with what they resolve to,
 * so the id maps back to Default when that is what it resolves to, else to the first alias that does.
 */
export function fromRecorded(recorded: RecordedSettings | undefined, models: ModelOption[] | undefined): RunSettings | undefined {
  if (!recorded || Object.keys(recorded).length === 0) return undefined;
  const out: RunSettings = {};
  if (recorded.model) {
    const exact = models?.find((m) => m.value === recorded.model);
    const resolving = models?.filter((m) => m.resolvedModel === recorded.model) ?? [];
    out.model = exact?.value ?? (resolving.find((m) => m.value === 'default') ?? resolving[0])?.value ?? recorded.model;
  }
  if (recorded.effort) out.effort = recorded.effort;
  if (recorded.fast !== undefined) out.fast = recorded.fast;
  if (recorded.ultracode !== undefined) out.ultracode = recorded.ultracode;
  if (recorded.permissionMode) out.permissionMode = recorded.permissionMode;
  return out;
}
