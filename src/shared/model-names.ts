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

/**
 * A model Claude Code's settings or a session name that the picker's list does not offer (opus[1m],
 * a dated id), as an option of its own, as Claude Code's /model shows one: by the listed model it is
 * a version of, with that model's efforts and fast mode, else by its name; "Custom model (opus[1m])".
 */
export function unlistedModel(value: string, models: ModelOption[]): ModelOption {
  const long = /\[1m\]$/i.test(value);
  const bare = value.replace(/\[[12]m\]$/i, '');
  const base = models.find((m) => m.value !== 'default' && (m.value === bare || m.resolvedModel === bare));
  return {
    value,
    label: base ? `${base.label}${long ? ' (1M context)' : ''}` : value,
    description: `Custom model (${value})`,
    efforts: base?.efforts ?? [],
    supportsFast: base?.supportsFast ?? false,
    ...(base?.supportsAuto !== undefined ? { supportsAuto: base.supportsAuto } : {}),
    ...(base?.resolvedModel ? { resolvedModel: base.resolvedModel } : {}),
  };
}
