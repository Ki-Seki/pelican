/**
 * On a phone, Back (Android's button, the browser's, an edge swipe) closes the sheet or menu that
 * is open, as it closes one in an app, and goes no further: each sheet has an entry of its own in
 * the browser's history while it is open, at the page's own address. Closed another way (Done, a
 * tap outside, an action picked), it takes its entry back out without going anywhere.
 *
 * Taking an entry out is a step back, which the browser makes a moment later: until it has, the
 * page's own history steps (a session opened, a pane's step) wait for it (`whenSettled`), so that
 * neither undoes the other, and the step back is the page's alone: nothing else hears it.
 */

type Entry = { id: number; close: () => void; gone: boolean; pushed: boolean; url?: string };

/** Entries of an earlier load of the page are not this one's: a reload starts the count again. */
const LOAD = Math.random().toString(36).slice(2, 10);
const markOf = (entry: Entry) => `${LOAD}:${entry.id}`;
const markIn = (state: unknown): string | undefined => {
  const mark = (state as { pelicanSheet?: unknown } | null)?.pelicanSheet;
  return typeof mark === 'string' ? mark : undefined;
};
const ours = (mark: string | undefined) => Boolean(mark?.startsWith(`${LOAD}:`));

let count = 0;
/** The sheets with an entry, the latest last. */
const open: Entry[] = [];
/** Steps back the page took itself, whose popstate is still to come. */
let expected = 0;
/**
 * The address the page had when it took its last step back, and the one the sheet's entry was
 * made at: the entry under it, at that one still, takes the address the page had.
 */
let carry: { to: string; from: string | undefined } | undefined;
let waiting: Array<() => void> = [];
let fallback: ReturnType<typeof setTimeout> | undefined;

function settle(): void {
  if (expected > 0) return;
  clearTimeout(fallback);
  fallback = undefined;
  const run = waiting;
  waiting = [];
  for (const step of run) {
    if (expected > 0) waiting.push(step);
    else step();
  }
}

/** Does `step` (a change to the history) now, or once the page's own step back has been made. */
export function whenSettled(step: () => void): void {
  if (expected > 0) waiting.push(step);
  else step();
}

function stepBack(from?: string): void {
  expected += 1;
  carry = { to: location.href, from };
  history.back();
  // A step back that never comes (no entry under this one) holds nothing up for long.
  clearTimeout(fallback);
  fallback = setTimeout(() => {
    expected = 0;
    settle();
  }, 1000);
}

/** An entry of a sheet that has closed, left under another (one opened over it closed later): stepped over. */
const stale = (mark: string | undefined) => ours(mark) && !open.some((entry) => markOf(entry) === mark);

function onPop(event: PopStateEvent): void {
  const now = markIn(event.state);
  if (expected > 0) {
    expected -= 1;
    event.stopImmediatePropagation();
    // What changed in the address while the sheet was up (a pane's tab, from the sheet) was the
    // page's: the entry under it takes it.
    if (carry && carry.to !== location.href && carry.from === location.href) history.replaceState(history.state, '', carry.to);
    if (stale(now)) stepBack();
    else settle();
    return;
  }
  // Back, or Forward: every sheet whose entry is past the one now shown closes, the top one first.
  // Where the address stays, the step was the sheets' alone, and nothing else hears it.
  const at = now ? open.findIndex((entry) => markOf(entry) === now) : -1;
  const closing = open.splice(at + 1);
  if (closing.length > 0 && closing.every((entry) => entry.url === location.href)) event.stopImmediatePropagation();
  for (const entry of closing.reverse()) {
    entry.gone = true;
    entry.close();
  }
  // Landed on the entry of a sheet that closed under another, or that the page went on from: on past it.
  if (stale(now)) stepBack();
}

if (typeof window !== 'undefined') {
  // Before anything else hears it (App's route, the pane's steps), which it may keep from them.
  window.addEventListener('popstate', onPop);
  // A reload with a sheet open leaves its entry as the page's own; it is no sheet's now.
  const mark = markIn(history.state);
  if (mark) {
    const { pelicanSheet: _gone, ...rest } = history.state as Record<string, unknown>;
    history.replaceState(Object.keys(rest).length > 0 ? rest : null, '');
  }
}

/**
 * Gives an open sheet its entry in the history: Back calls `close`. The entry keeps what the
 * page's own entry says (a pane's steps count on it), at the same address.
 */
export function openEntry(close: () => void): Entry {
  count += 1;
  const entry: Entry = { id: count, close, gone: false, pushed: false };
  open.push(entry);
  whenSettled(() => {
    if (entry.gone) return;
    const state = history.state && typeof history.state === 'object' ? history.state : {};
    entry.url = location.href;
    // At the address the page has (left out, so a page served under another name keeps it).
    history.pushState({ ...state, pelicanSheet: markOf(entry) }, '');
    entry.pushed = true;
  });
  return entry;
}

/**
 * The sheet closed some other way, or went with what held it: its entry comes out, a step back,
 * when it is the one shown. One under another's, or the page's own now (the page went on from it
 * meanwhile), stays: a step back would undo what came after it.
 */
export function closeEntry(entry: Entry): void {
  if (entry.gone) return;
  entry.gone = true;
  const at = open.indexOf(entry);
  if (at >= 0) open.splice(at, 1);
  whenSettled(() => {
    if (entry.pushed && markIn(history.state) === markOf(entry)) stepBack(entry.url);
  });
}

/** For the tests: once the page's own steps back have been made, which land a moment after a sheet closes. */
export function sheetHistorySettled(): Promise<void> {
  return new Promise((resolve) => whenSettled(resolve));
}

/** For the tests: as a page just loaded. */
export function resetSheetHistory(): void {
  open.splice(0);
  expected = 0;
  carry = undefined;
  waiting = [];
  clearTimeout(fallback);
  fallback = undefined;
}
