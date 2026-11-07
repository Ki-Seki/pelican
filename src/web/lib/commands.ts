import type { LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useSyncExternalStore } from 'react';

import type { Command } from '../../shared/protocol';
import type { Device } from './actions';
import type { KeyId } from './keyboard';

/**
 * One list of everything that can be done by name, the same in the message box's / list and in
 * ⌘K's command menu: this session's actions by Claude Code's names (/btw, /branch, /rename…), then
 * Pelican's own (Pin, Files, New session…), then Claude Code's commands and skills. The open chat
 * and the page put their parts in it while they are there.
 */
export type CommandGroup = 'session' | 'pelican' | 'claude';

export const GROUP_NAMES: Record<CommandGroup, string> = { session: 'This session', pelican: 'Pelican actions', claude: 'Claude Code' };

export type CommandItem = {
  id: string;
  group: CommandGroup;
  /** What it is called, as menus call it: Side chat, Rename. */
  label: string;
  icon?: LucideIcon;
  /** Claude Code's name for it, without the slash: typed after a / it is this. */
  name?: string;
  /** Names that do the same: /clear and /reset for /new. */
  aliases?: readonly string[];
  /** What the / list says of it: "Ask in side chat". */
  description?: string;
  /** Desktop's key for it (shown faintly once it works). */
  key?: KeyId;
  /** It needs words after its name (/btw a question): picked from a list, it waits for them in the box. */
  needsWords?: boolean;
  /** Only on one kind of screen (Keyboard shortcuts: where there is a keyboard). */
  only?: Device;
  run: (words: string) => void;
};

const parts = new Map<string, CommandItem[]>();
/** The open chat's: its folder, whose Claude Code commands are listed, and its message box. */
export type CommandContext = { cwd?: string; putInBox?: (text: string) => void };
let context: CommandContext = {};
let version = 0;
const listeners = new Set<() => void>();
const changed = () => {
  version += 1;
  for (const listener of listeners) listener();
};

/** Puts a part of the list in while the caller is there (the page's own, the open chat's). */
export function useCommandPart(part: string, items: CommandItem[]): void {
  useEffect(() => {
    parts.set(part, items);
    changed();
    return () => {
      if (parts.get(part) === items) {
        parts.delete(part);
        changed();
      }
    };
  }, [part, items]);
}

/** Puts the open chat's context in while it is there. */
export function useCommandContext(next: CommandContext): void {
  useEffect(() => {
    context = next;
    changed();
    return () => {
      if (context === next) {
        context = {};
        changed();
      }
    };
  }, [next]);
}

const ORDER: CommandGroup[] = ['session', 'pelican', 'claude'];

/**
 * Everything registered now, by group. The open chat's part comes before the page's, and takes the
 * place of one of the page's with the same id (New session: in this session's folder).
 */
export function registered(): CommandItem[] {
  const byId = new Map<string, CommandItem>();
  const names = [...parts.keys()].sort((a, b) => Number(b === 'chat') - Number(a === 'chat'));
  for (const name of names) for (const item of parts.get(name) ?? []) if (!byId.has(item.id)) byId.set(item.id, item);
  const all = [...byId.values()];
  return ORDER.flatMap((group) => all.filter((item) => item.group === group));
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useCommandItems(): CommandItem[] {
  useSyncExternalStore(subscribe, () => version);
  return useMemo(() => registered(), [version]);
}

export function useCommandState(): { items: CommandItem[]; context: CommandContext } {
  const now = useSyncExternalStore(subscribe, () => version);
  return useMemo(() => ({ items: registered(), context }), [now]);
}

/** For the tests: as a page just loaded. */
export function forgetCommands(): void {
  parts.clear();
  context = {};
  changed();
}

/**
 * The whole list: Pelican's items, then Claude Code's commands and skills. A command of your own
 * (one Claude Code does not mark as its own) takes the name of one of Pelican's: /export runs
 * yours, and Pelican's Export stays, by its name, without the /. One of Claude Code's own that
 * Pelican does in its own way (/context, /rename, /export…) is Pelican's, and is listed once.
 */
export function commandList(items: readonly CommandItem[], claude: readonly Command[], device: Device): CommandItem[] {
  const fits = items.filter((item) => !item.only || item.only === device);
  const yours = new Set(claude.filter((c) => !c.builtin).map((c) => c.name));
  const own = fits.map((item) => {
    if (!item.name || !yours.has(item.name)) return item;
    const { name: _taken, aliases, ...rest } = item;
    const left = aliases?.filter((alias) => !yours.has(alias));
    return { ...rest, ...(left && left.length > 0 ? { aliases: left } : {}) };
  });
  const pelicans = new Set(own.flatMap((item) => [item.name, ...(item.aliases ?? [])]).filter(Boolean));
  const theirs: CommandItem[] = claude
    .filter((c) => !(c.builtin && pelicans.has(c.name)))
    .map((c) => ({
      id: `claude:${c.name}`,
      group: 'claude' as const,
      label: `/${c.name}`,
      name: c.name,
      description: c.argumentHint ? `${c.argumentHint} · ${c.description}` : c.description,
      run: () => {},
    }));
  return [...own, ...theirs];
}

/** Whether an item is one of Claude Code's, which goes to Claude as typed. */
export const isClaudeCommand = (item: CommandItem): boolean => item.group === 'claude';

/** The item a typed `/name words` names, and the words after it; none for a name Pelican does not do. */
export function commandFor(text: string, list: readonly CommandItem[]): { item: CommandItem; words: string } | undefined {
  const typed = /^\/([\w:.-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!typed) return undefined;
  const name = typed[1]!.toLowerCase();
  const item = list.find((i) => !isClaudeCommand(i) && (i.name === name || i.aliases?.includes(name)));
  return item ? { item, words: (typed[2] ?? '').trim() } : undefined;
}

/** Whether an item answers to what was typed after the /, by its name, a name it also has, or its label's words. */
export function matchesQuery(item: CommandItem, query: string): boolean {
  const q = query.trim().toLowerCase().replace(/^\//, '');
  if (!q) return true;
  const names = [item.name, ...(item.aliases ?? [])].filter((n): n is string => Boolean(n));
  if (names.some((n) => n.toLowerCase().includes(q))) return true;
  return item.label.toLowerCase().split(/\s+/).some((word) => word.startsWith(q)) || item.label.toLowerCase().startsWith(q);
}

/** The items for a query, those whose name starts with it first within each group, the groups in order. */
export function filtered(list: readonly CommandItem[], query: string): CommandItem[] {
  const q = query.trim().toLowerCase().replace(/^\//, '');
  const found = list.filter((item) => matchesQuery(item, q));
  if (!q) return found;
  const starts = (item: CommandItem) => Boolean(item.name?.toLowerCase().startsWith(q)) || item.label.toLowerCase().startsWith(q);
  return ORDER.flatMap((group) => {
    const inGroup = found.filter((item) => item.group === group);
    return [...inGroup.filter(starts), ...inGroup.filter((item) => !starts(item))];
  });
}
