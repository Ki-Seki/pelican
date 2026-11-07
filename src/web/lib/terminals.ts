import { useQuery } from '@tanstack/react-query';
import { createContext, useSyncExternalStore } from 'react';

import { api } from './api';

/**
 * The terminal's part that loads with the conversation: what asks for a terminal from elsewhere
 * (Open in terminal, Run in terminal, Ctrl+`), waiting here until the Terminal tab, which loads
 * on its own (components/WorkspaceTerminal), shows and takes it.
 */

/** A terminal asked for: a new one in `folder`, typing `command` into it once its shell is ready. */
export type TerminalAsk = { id: number; folder: string; command?: string };

let asks: TerminalAsk[] = [];
let next = 1;
const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of listeners) listener();
};

/** Asks for a new terminal in a folder, with a command to run there or none. */
export function askForTerminal(folder: string, command?: string): void {
  asks = [...asks, { id: next++, folder, ...(command ? { command } : {}) }];
  changed();
}

/** The asks for folders the tab shows (see within), taken: each is answered once. */
export function takeTerminalAsks(cwd: string): TerminalAsk[] {
  const taken = asks.filter((ask) => within(ask.folder, cwd));
  if (taken.length === 0) return taken;
  asks = asks.filter((ask) => !taken.includes(ask));
  changed();
  return taken;
}

/** How many asks wait, for the tab to look again when one comes. */
export function useTerminalAsks(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => asks.length,
  );
}

/**
 * The keys go to the terminal (Ctrl+`, or the tab picked on a computer): at once when it shows,
 * else when it next does. The tab takes this once it has a screen to give them to.
 */
let focusWanted = 0;
const focusListeners = new Set<() => void>();
export function wantTerminalFocus(): void {
  focusWanted += 1;
  for (const listener of focusListeners) listener();
}
export function takeTerminalFocus(): boolean {
  const wanted = focusWanted > 0;
  focusWanted = 0;
  return wanted;
}
/** Changes each time the keys are asked for, for the tab to look again. */
export function useTerminalFocusWanted(): number {
  return useSyncExternalStore(
    (listener) => {
      focusListeners.add(listener);
      return () => focusListeners.delete(listener);
    },
    () => focusWanted,
  );
}

/**
 * Whether this Pelican runs terminals, as far as its info says without loading anything: Open in
 * terminal and Run in terminal show only then. The Terminal tab asks for sure, and says why not.
 */
export function useTerminalsAvailable(): boolean {
  const { data: info } = useQuery({ queryKey: ['info'], queryFn: api.info, staleTime: Infinity });
  return info?.terminal?.available === true;
}

/** The shell a terminal here runs, as a tab names it (zsh, pwsh), as far as the info says. */
export function useTerminalShell(): string | undefined {
  const { data: info } = useQuery({ queryKey: ['info'], queryFn: api.info, staleTime: Infinity });
  return info?.terminal?.available ? info.terminal.shell : undefined;
}

/**
 * The shell a terminal here runs (useTerminalShell), set with RunInTerminal around the
 * conversation: a step's command runs in the shell it is written for (isPowerShell).
 */
export const TerminalShell = createContext<string | undefined>(undefined);

/** Whether a shell, as a tab names it, is PowerShell, which takes a PowerShell step's command, and no other's. */
export const isPowerShell = (shell: string | undefined): boolean => shell !== undefined && /^(pwsh|powershell)(\.exe)?$/i.test(shell);

/**
 * Runs a command in a new terminal in the conversation's folder: a code block's Run in terminal,
 * and a step's, each once its question showed the whole command; none where there is no terminal.
 * A subagent's and a workflow's steps are under none: those are not Claude's doing in this
 * conversation to rerun, as a subagent's output offers none either.
 */
export const RunInTerminal = createContext<((command: string) => void) | undefined>(undefined);

/**
 * Set around Claude's own reply text, the only place a code block offers Run in terminal: not a
 * file's Markdown (a README of any repository), a subagent's or a tool's output, a plan, or a
 * workflow's result, which Claude did not write to you.
 */
export const InReply = createContext(false);

/** Whether `folder` is the session's folder or one inside it: the terminals its tab shows. */
export function within(folder: string, cwd: string): boolean {
  if (folder === cwd) return true;
  return folder.startsWith(cwd.endsWith('/') ? cwd : `${cwd}/`);
}

/** Shells, as the program in front of a terminal at its prompt: anything else is a program running there. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'mksh', 'oksh', 'tcsh', 'csh', 'nu', 'elvish', 'xonsh', 'pwsh', 'ion', 'osh', 'ysh']);
export const isShell = (program: string): boolean => SHELLS.has(program);

/** Code blocks in these languages are commands for a shell, which Run in terminal offers to run. */
const SHELL_LANGUAGES = new Set(['bash', 'sh', 'shell', 'zsh', 'fish']);
export const runsInShell = (language: string | undefined): boolean => Boolean(language && SHELL_LANGUAGES.has(language.toLowerCase()));
