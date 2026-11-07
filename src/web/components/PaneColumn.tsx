import { type KeyboardEvent, type PointerEvent, type ReactNode, useLayoutEffect, useRef, useState } from 'react';

/**
 * The column beside the conversation on a computer (from 1024px), which Changes, Files and the
 * Terminal (the pane) and the side chat share: each alone takes all of it; both, from 1280px, the
 * pane on top and the side chat under it, a handle between them to share the height, which this
 * browser remembers. Under 1280px, where there is not room for both, the one asked for last shows
 * (useSideChat), the other waiting behind it.
 *
 * Each sits in it as it sits alone beside the conversation: placed at the right edge of what holds
 * it, as tall as that is. Stacked, each is held by a part of the column; otherwise the parts hold
 * nothing of their own (display: contents) and each takes the whole height. The parts stay in place
 * either way, so neither the pane nor the side chat starts again when the other comes or goes.
 */

/**
 * Where the handle sits, as a share of the column's height from its top, until it is dragged: the
 * pane gets the larger part, room for Changes' files and its Commit changes and Create PR, or a
 * terminal's rows; the side chat its question box and an answer's first lines.
 */
export const SPLIT = 0.55;
/** As far as the handle goes, by the keys or a drag; the height each part keeps at least is in place() too. */
const MIN_SPLIT = 0.15;
const MAX_SPLIT = 0.85;
/** One press of an arrow key on the handle. */
const STEP = 0.05;
/**
 * Room each part keeps however the handle is dragged or the window shrinks: the pane its tabs and
 * a few files, or a dozen of a terminal's rows; the side chat its box and a few lines.
 */
const PANE_MIN = '300px';
const SIDE_MIN = '240px';
const KEY = 'pelican:side-chat-split';

const clampSplit = (value: number) => Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, value));

function readSplit(): number {
  try {
    const value = Number(localStorage.getItem(KEY));
    return Number.isFinite(value) && value > 0 ? clampSplit(value) : SPLIT;
  } catch {
    return SPLIT;
  }
}

function saveSplit(value: number): void {
  try {
    localStorage.setItem(KEY, String(Math.round(value * 1000) / 1000));
  } catch {
    // Private mode: it lasts while the page is open.
  }
}

/** The handle's place, in CSS: the share given, kept far enough from either end for both parts. */
const place = (split: number) => `clamp(${PANE_MIN}, ${(split * 100).toFixed(2)}%, calc(100% - ${SIDE_MIN}))`;

/** How many panes sit beside the conversation now: while any does, the page carries data-pane (App folds the list under 1280px). */
let docked = 0;

/** Marks the page while `active`: a pane (or the side chat) sits beside the conversation. */
export function useDockedMark(active: boolean): void {
  useLayoutEffect(() => {
    if (!active) return undefined;
    docked += 1;
    document.documentElement.dataset.pane = 'docked';
    return () => {
      docked -= 1;
      if (docked === 0) delete document.documentElement.dataset.pane;
    };
  }, [active]);
}

export function PaneColumn({ stacked, pane, side }: {
  /** Both are beside the conversation, with room for both: the pane on top, the side chat under it. */
  stacked: boolean;
  pane: ReactNode;
  side: ReactNode;
}) {
  const [split, setShown] = useState(readSplit);
  const latest = useRef(split);
  const setSplit = (value: number) => {
    latest.current = value;
    setShown(value);
  };
  const column = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number } | undefined>(undefined);
  const at = place(split);

  const moveTo = (clientY: number) => {
    const box = column.current?.getBoundingClientRect();
    if (!box || box.height <= 0) return;
    setSplit(clampSplit((clientY - box.top) / box.height));
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    drag.current = { id: e.pointerId };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== e.pointerId) return;
    moveTo(e.clientY);
  };
  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = undefined;
    if (e.type === 'pointerup') moveTo(e.clientY);
    saveSplit(latest.current);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = e.key === 'ArrowUp' ? split - STEP
      : e.key === 'ArrowDown' ? split + STEP
        : e.key === 'Home' ? MIN_SPLIT
          : e.key === 'End' ? MAX_SPLIT
            : e.key === 'Enter' ? SPLIT
              : undefined;
    if (next === undefined) return;
    e.preventDefault();
    const value = clampSplit(next);
    setSplit(value);
    saveSplit(value);
  };

  return (
    <div ref={column} data-pane-column={stacked ? 'stacked' : undefined} className={stacked ? 'absolute inset-y-0 right-0 w-(--pane-w)' : 'contents'}>
      <div data-pane-part="pane" className={stacked ? 'absolute inset-x-0 top-0' : 'contents'} style={stacked ? { height: at } : undefined}>{pane}</div>
      {stacked && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the side chat"
          aria-valuemin={Math.round(MIN_SPLIT * 100)}
          aria-valuemax={Math.round(MAX_SPLIT * 100)}
          aria-valuenow={Math.round(split * 100)}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onDoubleClick={() => {
            setSplit(SPLIT);
            saveSplit(SPLIT);
          }}
          onKeyDown={onKeyDown}
          style={{ top: at }}
          className="group absolute inset-x-0 z-10 -mt-1.5 grid h-3 cursor-row-resize touch-none place-items-center outline-none select-none"
        >
          <span aria-hidden className="absolute inset-x-0 top-1/2 h-px bg-line" />
          <span aria-hidden className="relative h-1 w-9 rounded-full bg-line transition-colors group-hover:bg-faint group-focus-visible:bg-muted group-active:bg-muted" />
        </div>
      )}
      <div data-pane-part="side" className={stacked ? 'absolute inset-x-0 bottom-0' : 'contents'} style={stacked ? { top: at } : undefined}>{side}</div>
    </div>
  );
}
