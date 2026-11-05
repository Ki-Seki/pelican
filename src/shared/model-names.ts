import type { ModelOption } from './protocol';

/**
 * The picker's name for a model id Claude Code reports (claude-opus-5-5), which several aliases
 * may resolve to (Default and Opus 5.5 both do): `chosen` while it still resolves to that id, else
 * the id's own entry, else an alias other than Default, else the id itself.
 */
export function pickerValue(id: string, models: ModelOption[] | undefined, chosen?: string): string {
  const resolves = (value: string | undefined): value is string =>
    value !== undefined && (value === id || models?.find((m) => m.value === value)?.resolvedModel === id);
  if (resolves(chosen)) return chosen;
  const exact = models?.find((m) => m.value === id);
  const resolving = models?.filter((m) => m.resolvedModel === id) ?? [];
  return exact?.value ?? (resolving.find((m) => m.value !== 'default') ?? resolving[0])?.value ?? id;
}
