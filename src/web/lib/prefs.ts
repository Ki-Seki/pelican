import type { PermissionMode, RunSettings } from '../../shared/protocol';

const KEY = 'pelican:settings';

/** Composer settings a new session starts with; remembered per browser. */
export function loadDefaults(): RunSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as RunSettings;
    return { model: raw.model ?? 'default', effort: raw.effort, fast: Boolean(raw.fast), permissionMode: raw.permissionMode ?? 'default' };
  } catch {
    return { model: 'default', fast: false, permissionMode: 'default' };
  }
}

export function saveDefaults(settings: RunSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Private mode; settings just do not persist.
  }
}

export const PERMISSION_MODES: Array<{ value: PermissionMode; label: string; short: string; description: string }> = [
  { value: 'default', label: 'Ask before acting', short: 'Ask', description: 'Approve each edit and command' },
  { value: 'acceptEdits', label: 'Accept edits', short: 'Edits', description: 'Edit files freely, ask before commands' },
  { value: 'plan', label: 'Plan first', short: 'Plan', description: 'Read and plan; no changes until you approve' },
  { value: 'auto', label: 'Auto', short: 'Auto', description: 'Claude decides what needs your approval' },
  { value: 'bypassPermissions', label: 'Bypass permissions', short: 'Bypass', description: 'Never ask. Use with care' },
];

export const EFFORT_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

/** Short forms for the composer's one-line summary. */
export const EFFORT_SHORT: Record<string, string> = {
  low: 'Low',
  medium: 'Med',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
};
