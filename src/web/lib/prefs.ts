import { useSyncExternalStore } from 'react';

import type { PermissionMode, RunSettings } from '../../shared/protocol';

const SETTINGS_KEY = 'pelican:settings';
const PREFS_KEY = 'pelican:prefs';

const read = <T>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...(JSON.parse(raw) as T) } : fallback;
  } catch {
    return fallback;
  }
};

const write = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode; nothing persists.
  }
};

/**
 * Composer settings a new session starts with; remembered per browser. The permission mode is
 * not among them: it belongs to one session, as Shift+Tab's does in Claude Code, so choosing
 * Bypass once never makes it the start of every new session. New work asks first.
 */
export function loadDefaults(): RunSettings {
  const raw = read<Partial<RunSettings>>(SETTINGS_KEY, {});
  return {
    model: raw.model ?? 'default',
    ...(raw.effort ? { effort: raw.effort } : {}),
    fast: Boolean(raw.fast),
    ultracode: Boolean(raw.ultracode),
    permissionMode: 'default',
  };
}

export function saveDefaults({ permissionMode: _mode, ...settings }: RunSettings): void {
  write(SETTINGS_KEY, settings);
}

const CHOICES_KEY = 'pelican:session-settings';
type Choice = { settings: RunSettings; at: number };

/**
 * What was picked in one session's composer and not yet used: it stays when you leave the
 * session and come back, until a turn runs with it (or after it). Bypass is not kept here either.
 */
export function sessionChoice(sessionId: string): Choice | undefined {
  return read<Record<string, Choice>>(CHOICES_KEY, {})[sessionId];
}

export function saveSessionChoice(sessionId: string, { permissionMode, ...settings }: RunSettings): void {
  const all = read<Record<string, Choice>>(CHOICES_KEY, {});
  all[sessionId] = { settings: { ...settings, ...(permissionMode && permissionMode !== 'bypassPermissions' ? { permissionMode } : {}) }, at: Date.now() };
  // The newest few dozen are plenty.
  const kept = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, 50);
  write(CHOICES_KEY, Object.fromEntries(kept));
}

export type ViewMode = 'summary' | 'normal' | 'verbose';
export type Theme = 'system' | 'light' | 'dark';

/** How the app looks and behaves on this device. */
export type Prefs = {
  theme: Theme;
  /** auto: Enter sends on a computer, adds a line on a phone. */
  enterToSend: 'auto' | 'always' | 'never';
  view: ViewMode;
  /** List runs in the system temp directory under "All" too. */
  showTemporary: boolean;
  /** List Claude Desktop's side chats too. */
  showSideChats: boolean;
  /** The session list: grouped by day or by project, with full or one-line rows. */
  listGroup: 'time' | 'project';
  listDensity: 'detailed' | 'compact';
  /** While Claude works, a new message joins the turn (steer) or waits for it to end (queue). */
  sendWhileBusy: 'steer' | 'queue';
  /** Offer Claude Code's guess at the next prompt after a turn. */
  suggestions: boolean;
};

const DEFAULT_PREFS: Prefs = {
  theme: 'system', enterToSend: 'auto', view: 'normal', showTemporary: false, showSideChats: false, listGroup: 'time', listDensity: 'detailed',
  sendWhileBusy: 'steer', suggestions: true,
};

let prefs: Prefs = read(PREFS_KEY, DEFAULT_PREFS);
const listeners = new Set<() => void>();

export function getPrefs(): Prefs {
  return prefs;
}

export function setPrefs(patch: Partial<Prefs>): void {
  prefs = { ...prefs, ...patch };
  write(PREFS_KEY, prefs);
  applyTheme();
  for (const listener of listeners) listener();
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => prefs,
  );
}

/** Light or dark follows the system unless chosen; the page's colors read `data-theme`. */
export function applyTheme(): void {
  const root = document.documentElement;
  if (prefs.theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = prefs.theme;
  // The page has one theme-color per system scheme; a chosen theme sets both.
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const systemDark = meta.media.includes('dark');
    const dark = prefs.theme === 'system' ? systemDark : prefs.theme === 'dark';
    meta.content = dark ? '#0a0a0a' : '#fafafa';
  }
}

export function enterSends(): boolean {
  if (prefs.enterToSend === 'always') return true;
  if (prefs.enterToSend === 'never') return false;
  return !window.matchMedia('(pointer: coarse)').matches;
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

const SEEN_KEY = 'pelican:seen';
let seen: Record<string, number> = read(SEEN_KEY, {});
/** Activity before this was there when this browser first opened Pelican: nothing is unread then. */
const seenSince: number = (() => {
  const key = 'pelican:seen-since';
  try {
    const stored = Number(localStorage.getItem(key));
    if (stored) return stored;
    const now = Date.now();
    localStorage.setItem(key, String(now));
    return now;
  } catch {
    return Date.now();
  }
})();
const seenListeners = new Set<() => void>();

/** Remembers that a session's activity up to `at` has been looked at here. */
export function markSeen(sessionId: string, at: number): void {
  if ((seen[sessionId] ?? 0) >= at) return;
  seen = { ...seen, [sessionId]: at };
  write(SEEN_KEY, seen);
  for (const listener of seenListeners) listener();
}

export function useSeen(): (sessionId: string, lastActivity: number) => boolean {
  const snapshot = useSyncExternalStore(
    (listener) => {
      seenListeners.add(listener);
      return () => seenListeners.delete(listener);
    },
    () => seen,
  );
  return (sessionId, lastActivity) => lastActivity > Math.max(snapshot[sessionId] ?? 0, seenSince);
}
