import { useSyncExternalStore } from 'react';

/**
 * Where Changes and files is, kept in the page's address next to the session (`?s=…`):
 * - `w`: the tab, `changes` or `files`; on a phone its being there is what opens the view;
 * - `p`: the file whose diff or text is shown, or in Files a folder (ending in `/`);
 * - `l`: a line of that file;
 * - `t`: what Changes shows: `base` for everything since the branch split, a prompt's id for the
 *   edits of that turn, nothing for the uncommitted changes (the default, as in Claude Code).
 *
 * On a phone each step is an entry in the browser's history, so the back gesture walks back
 * through them, and the view can be left for the conversation in one go. On a computer the pane
 * beside the conversation keeps its place in the address too, without adding entries.
 */
export type WorkspaceTab = 'changes' | 'files';
export type WorkspaceStep = { tab: WorkspaceTab; path?: string; line?: number; scope?: string };

const KEYS = ['w', 'p', 'l', 't'] as const;

/** The step an address holds, or undefined when the workspace is not in it. */
export function stepOf(search: string): WorkspaceStep | undefined {
  const params = new URLSearchParams(search);
  const tab = params.get('w');
  if (tab !== 'changes' && tab !== 'files') return undefined;
  const path = params.get('p') ?? '';
  const line = Number(params.get('l'));
  const scope = params.get('t') ?? '';
  return {
    tab,
    ...(path ? { path } : {}),
    ...(Number.isSafeInteger(line) && line > 0 ? { line } : {}),
    ...(tab === 'changes' && scope ? { scope } : {}),
  };
}

/** The address with `step` in place of the workspace's part (none: taken out), the rest kept as it was. */
export function withStep(search: string, step: WorkspaceStep | undefined): string {
  const params = new URLSearchParams(search);
  for (const key of KEYS) params.delete(key);
  if (step) {
    params.set('w', step.tab);
    if (step.path) params.set('p', step.path);
    if (step.line) params.set('l', String(step.line));
    if (step.tab === 'changes' && step.scope) params.set('t', step.scope);
  }
  // `?new&cwd=…` keeps its bare `new`.
  const query = params.toString().replace(/=(?=&|$)/g, '');
  return query ? `?${query}` : '';
}

type State = { pelicanWorkspace?: unknown; pelicanFrom?: unknown } | null;

/** How many of the history entries up to this one are the workspace's own (0: none). */
const depthOf = (state: unknown): number => {
  const depth = (state as State)?.pelicanWorkspace;
  return typeof depth === 'number' && depth > 0 ? depth : 0;
};

const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of listeners) listener();
};

/**
 * Left for the conversation, before the browser has gone back there: going back through the
 * history is answered later (popstate), and the view must be gone at once, so that what comes
 * next (focus in the message box) finds the conversation there.
 */
let leaving = false;

function subscribe(listener: () => void): () => void {
  const onPop = () => {
    leaving = false;
    listener();
  };
  listeners.add(listener);
  window.addEventListener('popstate', onPop);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', onPop);
  };
}

/** The workspace's step in the address, following the back and forward buttons. */
export function useWorkspaceStep(): WorkspaceStep | undefined {
  const search = useSyncExternalStore(subscribe, () => (leaving ? '' : location.search));
  return stepOf(search);
}

const here = () => `${location.pathname}${location.search}${location.hash}`;
const urlWith = (step: WorkspaceStep | undefined) => `${location.pathname}${withStep(location.search, step)}${location.hash}`;

/**
 * Goes to a step. `push`: a step of its own in the history, which a phone's back gesture comes
 * back from; it notes the step it came from, so going up to that one again is a step back (see
 * goUp). Otherwise this entry becomes the step.
 */
export function goTo(step: WorkspaceStep | undefined, push: boolean): void {
  leaving = false;
  const url = urlWith(step);
  if (url !== here()) {
    const depth = depthOf(history.state);
    if (push && step) history.pushState({ pelicanWorkspace: depth + 1, pelicanFrom: location.search }, '', url);
    else history.replaceState(history.state, '', url);
  }
  changed();
}

/**
 * Up from a step to `step` (a file to its folder, a diff to its list): a step back in the history
 * when that is where it came from, else this entry becomes that step, so a file opened from the
 * chat goes up to its folder and the back gesture still leads to the chat.
 */
export function goUp(step: WorkspaceStep): void {
  const state = history.state as State;
  if (depthOf(state) > 1 && state?.pelicanFrom === withStep(location.search, step)) history.back();
  else goTo(step, false);
}

/** Leaves the workspace for the conversation: back past all of its steps, or out of the address. */
export function leave(): void {
  const depth = depthOf(history.state);
  if (depth === 0) {
    goTo(undefined, false);
    return;
  }
  leaving = true;
  changed();
  history.go(-depth);
}

/** The folder a path is in, as Files names folders (`a/b/`), or '' for the top. */
export function folderOf(path: string): string {
  const cut = path.replace(/\/$/, '').lastIndexOf('/');
  return cut > 0 ? `${path.slice(0, cut)}/` : '';
}
