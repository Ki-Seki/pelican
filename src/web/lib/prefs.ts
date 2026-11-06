import { useSyncExternalStore } from 'react';

import { START_MODES } from '../../shared/modes';
import type { RunSettings } from '../../shared/protocol';

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
 * What a new session starts with, set in Settings (a choice in a session stays in that session);
 * remembered per browser. The permission mode is there only once one was picked in Settings;
 * until then new sessions start in the one Claude Code's settings give, else Auto (startMode).
 */
/** The effort new sessions start with until another is picked in Settings (owner's decision). */
export const START_EFFORT = 'high';

type StoredDefaults = Partial<Omit<RunSettings, 'effort'>> & { effort?: string | null };

/** What was picked in Settings, as it is kept: effort null is Default picked there (Claude Code's own for the model). */
export function loadDefaults(): RunSettings {
  const raw = read<StoredDefaults>(SETTINGS_KEY, {});
  return {
    model: raw.model ?? 'default',
    ...(raw.effort ? { effort: raw.effort } : {}),
    fast: Boolean(raw.fast),
    ultracode: Boolean(raw.ultracode),
    ...(raw.permissionMode && START_MODES.includes(raw.permissionMode) ? { permissionMode: raw.permissionMode } : {}),
  };
}

/** What a new session starts with: Settings' picks, with High effort until an effort is picked there. */
export function newSessionDefaults(): RunSettings {
  const picked = 'effort' in read<StoredDefaults>(SETTINGS_KEY, {});
  const defaults = loadDefaults();
  return picked || defaults.effort ? defaults : { ...defaults, effort: START_EFFORT };
}

export function saveDefaults({ permissionMode, effort, ...settings }: RunSettings): void {
  // Default is kept as a pick of its own (null), so it is not taken for nothing picked yet.
  write(SETTINGS_KEY, { ...settings, effort: effort ?? null, ...(permissionMode && START_MODES.includes(permissionMode) ? { permissionMode } : {}) });
}

const TIPS_KEY = 'pelican:tips-seen';

/** Tips shown once per browser: whether this one was seen (and closed) already. */
export function tipSeen(name: string): boolean {
  return Boolean(read<Record<string, boolean>>(TIPS_KEY, {})[name]);
}

export function markTipSeen(name: string): void {
  write(TIPS_KEY, { ...read<Record<string, boolean>>(TIPS_KEY, {}), [name]: true });
}

const CHOICES_KEY = 'pelican:session-settings';
type Choice = { settings: RunSettings; at: number };

/**
 * What was picked in one session's composer, and when: a pick no turn has used yet stays when
 * you leave the session and come back, and the model picked stays named as picked (Opus 5.5,
 * not Default, though both are the same model). Bypass too: it is the session's own.
 */
export function sessionChoice(sessionId: string): Choice | undefined {
  return read<Record<string, Choice>>(CHOICES_KEY, {})[sessionId];
}

export function saveSessionChoice(sessionId: string, settings: RunSettings): void {
  const all = read<Record<string, Choice>>(CHOICES_KEY, {});
  all[sessionId] = { settings, at: Date.now() };
  // The newest couple of hundred are plenty.
  const kept = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, 200);
  write(CHOICES_KEY, Object.fromEntries(kept));
}

/**
 * How much of a conversation shows: Claude Desktop's transcript views, in its order. Normal folds
 * the steps into one-line summaries and shows the replies whole; Thinking adds Claude's thinking;
 * Verbose opens every step as well.
 */
export type ViewMode = 'normal' | 'thinking' | 'verbose';
export type Theme = 'system' | 'light' | 'dark';

export const VIEW_OPTIONS: ReadonlyArray<{ value: ViewMode; label: string; title: string }> = [
  { value: 'normal', label: 'Normal', title: 'Steps folded into one line each, with Claude’s full replies' },
  { value: 'thinking', label: 'Thinking', title: 'Steps folded, plus Claude’s thinking' },
  { value: 'verbose', label: 'Verbose', title: 'Every step open, plus Claude’s thinking' },
];

/**
 * A view as it was kept. Desktop dropped Summary, and a session set to it opens in Normal there,
 * so here too: Pelican's own Summary goes the same way, and anything unknown is Normal.
 */
export const viewMode = (value: unknown): ViewMode => (value === 'thinking' || value === 'verbose' ? value : 'normal');

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
  /** Sessions shown in a view of their own, not `view` (set in each session's menu). */
  sessionViews: Record<string, ViewMode>;
  /** On a wide screen, Changes and files stays open beside the conversation, from one session to the next. */
  workspacePane: boolean;
  /** The terminal's font size, its one setting: set with a pinch on the terminal, or Ctrl and the wheel. */
  terminalFontSize: number;
};

const DEFAULT_PREFS: Prefs = {
  theme: 'system', enterToSend: 'auto', view: 'normal', showTemporary: false, showSideChats: false, listGroup: 'time', listDensity: 'detailed',
  sendWhileBusy: 'steer', suggestions: true, sessionViews: {}, workspacePane: false, terminalFontSize: 13,
};

/**
 * The views kept from before, in today's names: Normal and Verbose stay as picked, Summary becomes
 * Normal; a session's own view that is now the same as the default follows the default again.
 */
export function migrateViews(stored: Prefs): Prefs {
  const view = viewMode(stored.view);
  const sessionViews = Object.fromEntries(Object.entries(stored.sessionViews ?? {}).flatMap(([id, picked]) => {
    const kept = viewMode(picked);
    return kept === view ? [] : [[id, kept]];
  }));
  return { ...stored, view, sessionViews };
}

let prefs: Prefs = (() => {
  const stored = read(PREFS_KEY, DEFAULT_PREFS);
  const migrated = migrateViews(stored);
  // Written back once, in today's names.
  if (JSON.stringify(migrated) !== JSON.stringify(stored)) write(PREFS_KEY, migrated);
  return migrated;
})();
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

/** The view a session opens in: its own when one was picked for it, else the default. */
export const viewOf = (p: Prefs, sessionId: string | undefined): ViewMode => (sessionId && p.sessionViews?.[sessionId]) || p.view;

/**
 * The views a session offers, as Desktop's session menu does: Thinking only once Claude has
 * thought in it (or when it is the view already).
 */
export const viewsFor = (thinking: boolean, current: ViewMode) => VIEW_OPTIONS.filter((option) => option.value !== 'thinking' || thinking || current === 'thinking');

/** The view after `view`, as Ctrl+O steps through them in Desktop. */
export function nextView(view: ViewMode, thinking: boolean): ViewMode {
  const order = viewsFor(thinking, view).map((option) => option.value);
  return order[(order.indexOf(view) + 1) % order.length] ?? 'normal';
}

/** A session's own view; picking the one the others open in makes it follow that one again. */
export function setSessionView(sessionId: string, view: ViewMode): void {
  const views = { ...(prefs.sessionViews ?? {}) };
  delete views[sessionId];
  if (view !== prefs.view) views[sessionId] = view;
  // The latest couple of hundred are plenty (a key set again moves to the end).
  setPrefs({ sessionViews: Object.fromEntries(Object.entries(views).slice(-200)) });
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
