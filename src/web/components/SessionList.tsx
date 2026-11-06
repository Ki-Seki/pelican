import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, ChevronDown, GitBranch, ListFilter, Loader2, type LucideIcon, Pin, PinOff, Plus, Search, Settings, X } from 'lucide-react';
import { memo, type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { SessionStatus, SessionSummary } from '../../shared/protocol';
import { api, isUnreachable } from '../lib/api';
import { type Entry, fold, foldKey, isActive } from '../lib/fold';
import { dayGroup, relativeTime, timeAgo } from '../lib/format';
import { composing, MOD_ARIA } from '../lib/keyboard';
import { changed, changeWords, type ListChange, makeChange, undoOf } from '../lib/list-changes';
import { type Prefs, setPrefs, usePrefs, useSeen } from '../lib/prefs';
import { defaultStart, type Start } from '../lib/start';
import { statusLabel } from '../lib/status';
import { Segmented, Sheet, SheetHeading, SheetToggle } from './Sheet';

/** Filter values for sessions outside projects. */
const SCRATCH = '\u0000scratch';
const TEMP = '\u0000temp';
const ARCHIVED = '\u0000archived';
const SPECIAL: Record<string, string> = { [SCRATCH]: 'Scratch', [TEMP]: 'Temporary', [ARCHIVED]: 'Archived' };
/** The group pinned sessions show in, at the top of the list in either grouping. */
const PINNED = '\u0000pinned';

const DOT: Record<SessionStatus, string> = { running: 'bg-run', waiting: 'bg-wait', live: 'bg-live', idle: 'bg-line' };
const TEXT: Record<SessionStatus, string> = { running: 'text-run', waiting: 'text-wait', live: 'text-live', idle: 'text-faint' };

/** Pulsing while a turn runs; background work between turns has Claude's color, still. */
export function StatusDot({ status, tasks = 0 }: { status: SessionStatus; tasks?: number }) {
  const color = status === 'idle' && tasks > 0 ? DOT.running : DOT[status];
  return (
    <span className="relative flex size-1.5 shrink-0">
      {(status === 'running' || status === 'live') && <span className={`absolute inline-flex size-full animate-ping rounded-full opacity-60 ${DOT[status]}`} />}
      <span className={`relative inline-flex size-1.5 rounded-full ${color}`} />
    </span>
  );
}

export function StatusBadge({ status, runningIn, tasks = 0 }: { status: SessionStatus; runningIn?: string; tasks?: number }) {
  const label = statusLabel(status, runningIn, tasks);
  if (!label) return null;
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 text-[11.5px] font-medium ${status === 'idle' ? TEXT.running : TEXT[status]}`}>
      <StatusDot status={status} tasks={tasks} />
      {label}
    </span>
  );
}

const matches = (s: SessionSummary, q: string) =>
  s.title.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q) || (s.preview ?? '').toLowerCase().includes(q) || s.id.startsWith(q);

function Where({ session }: { session: SessionSummary }) {
  if (session.archived) return <span className="min-w-0 truncate text-faint">Archived · {session.project}</span>;
  if (session.sideChatOf) return <span className="min-w-0 truncate text-faint">Side chat · {session.project}</span>;
  if (session.temp) return <span className="min-w-0 truncate text-faint">Temporary · {session.project}</span>;
  if (session.scratch) return <span className="min-w-0 truncate text-faint">Scratch</span>;
  return <span className="min-w-0 truncate">{session.project || '—'}</span>;
}

/**
 * Each session has an address of its own, so a row is a link: a plain click opens the session
 * here, and Cmd/Ctrl-click, Shift-click or the middle button leave it to the browser (a new tab
 * or window), as in any list of links.
 */
const sessionHref = (id: string) => `?s=${encodeURIComponent(id)}`;

function openHere(e: React.MouseEvent, id: string, onOpen: (id: string) => void) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  onOpen(id);
}

/** What a row is called for a screen reader: its title, state and age, not every word on it. */
function rowName(session: SessionSummary, unread: boolean, showProject: boolean): string {
  return [
    session.title,
    statusLabel(session.status, session.runningIn, session.tasks),
    unread ? 'new activity' : '',
    session.pinned ? 'pinned' : '',
    session.archived ? 'archived' : '',
    showProject ? (session.scratch ? 'scratch' : session.project) : '',
    timeAgo(session.lastActivity),
  ].filter(Boolean).join(', ');
}

/** The open session: a bar at the row's edge as well as the tint, which alone is too faint to tell. */
const OpenMark = () => <span aria-hidden className="absolute inset-y-2.5 left-0 w-[3px] rounded-full bg-fg" />;

type RowProps = { session: SessionSummary; selected: boolean; unread: boolean; showProject: boolean; onOpen: (id: string) => void };

const DetailedRow = memo(function DetailedRow({ session, selected, unread, showProject, onOpen }: RowProps) {
  const preview = useId();
  return (
    <a
      href={sessionHref(session.id)}
      aria-label={rowName(session, unread, showProject)}
      aria-describedby={session.stopped || session.preview ? preview : undefined}
      aria-current={selected ? 'page' : undefined}
      onClick={(e) => openHere(e, session.id, onOpen)}
      className={`relative block rounded-xl px-3 py-2.5 transition-colors ${selected ? 'bg-chip' : 'group-hover/row:bg-hover active:bg-hover'}`}
    >
      {selected && <OpenMark />}
      <div className="flex items-start gap-2">
        {unread && <span aria-label="New activity" className="mt-[7px] size-2 shrink-0 rounded-full bg-run" />}
        <div className={`line-clamp-2 min-w-0 flex-1 text-[15px] leading-snug ${unread ? 'font-semibold' : ''}`}>{session.title}</div>
        <span className="shrink-0 pt-0.5 text-[12px] text-faint tabular-nums">{relativeTime(session.lastActivity)}</span>
      </div>
      {/* A turn that ended on an error has no reply to show: why it stopped, quietly. */}
      {session.stopped ? (
        <div id={preview} className="mt-0.5 line-clamp-1 text-[13px] leading-snug text-faint">Stopped: {session.stopped}</div>
      ) : session.preview && <div id={preview} className="mt-0.5 line-clamp-1 text-[13px] leading-snug text-muted">{session.preview}</div>}
      <div className="mt-1 flex items-center gap-2 text-[12.5px] text-muted">
        <StatusBadge status={session.status} runningIn={session.runningIn} tasks={session.tasks} />
        {showProject && <Where session={session} />}
        {session.gitBranch && (
          <span className="flex min-w-0 items-center gap-0.5 truncate text-faint">
            <GitBranch className="size-3 shrink-0" />
            <span className="truncate">{session.gitBranch}</span>
          </span>
        )}
      </div>
    </a>
  );
});

const CompactRow = memo(function CompactRow({ session, selected, unread, showProject, onOpen }: RowProps) {
  return (
    <a
      href={sessionHref(session.id)}
      aria-label={rowName(session, unread, showProject)}
      aria-current={selected ? 'page' : undefined}
      onClick={(e) => openHere(e, session.id, onOpen)}
      title={statusLabel(session.status, session.runningIn, session.tasks) || undefined}
      className={`relative flex h-11 items-center gap-2.5 rounded-lg px-3 transition-colors pointer-fine:h-10 ${selected ? 'bg-chip' : 'group-hover/row:bg-hover active:bg-hover'}`}
    >
      {selected && <OpenMark />}
      {unread ? <span aria-label="New activity" className="size-2 shrink-0 rounded-full bg-run" /> : <StatusDot status={session.status} tasks={session.tasks} />}
      <span className={`min-w-0 flex-1 truncate text-[14.5px] ${unread ? 'font-semibold' : ''}`}>{session.title}</span>
      {showProject && <span className="max-w-[35%] shrink-0 truncate text-[12px] text-faint">{session.scratch ? 'Scratch' : session.project}</span>}
      <span className="w-8 shrink-0 text-right text-[12px] text-faint tabular-nums">{relativeTime(session.lastActivity)}</span>
    </a>
  );
});

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Whether focus came by the keyboard, as the browser shows it: a pointer's leaves no ring. */
function keyboardFocus(el: Element): boolean {
  try {
    return el.matches(':focus-visible');
  } catch {
    return false;
  }
}

/** How far a row slides to show its button, and how far (of its width) a slide acts on release. */
const REVEAL = 104;
const COMMIT = 0.4;

/** What a row can do without opening its session: Pin (Unpin), or Archive (Unarchive). */
type RowAction = { label: string; icon: LucideIcon; act: () => void };

/**
 * A row with its actions, reached without opening the session: Pin, shown from the left, and
 * Archive, from the right (Unpin and Unarchive once done). Under a finger the row slides, as in
 * Mail: right for Pin, left for Archive; far enough, it acts when let go; less far, the button
 * stays showing. With a mouse or the keyboard the actions are buttons on the row, shown on hover
 * or focus.
 */
function Swipeable({ id, name, start, end, compact, selected, children }: {
  /** The session's id, which tells its row in the list. */
  id: string;
  /** The session's title, so each row's buttons say which session they act on. */
  name: string;
  /** Pin or Unpin, under a slide to the right; none for an archived session. */
  start?: RowAction;
  /** Archive or Unarchive, under a slide to the left. */
  end: RowAction;
  compact: boolean;
  selected: boolean;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; from: number; dx: number; sideways?: boolean } | null>(null);
  const swallowClicksUntil = useRef(0);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  // Only a row with something to show on its left slides right.
  const bounded = (x: number) => (start ? x : Math.min(0, x));
  const shown = offset > 0 ? start : offset < 0 ? end : undefined;

  // A row left open closes at the next touch anywhere else, as rows in Mail do.
  useEffect(() => {
    if (offset === 0 || dragging) return undefined;
    const close = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOffset(0);
    };
    document.addEventListener('pointerdown', close, true);
    return () => document.removeEventListener('pointerdown', close, true);
  }, [offset, dragging]);

  const act = (action: RowAction, toward: 1 | -1) => {
    setOffset(toward * (box.current?.offsetWidth ?? 0));
    // The row slides out of sight, then leaves its place in the list; if the change fails it comes back closed.
    window.setTimeout(() => {
      action.act();
      setOffset(0);
    }, reducedMotion() ? 0 : 180);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType !== 'touch' || !e.isPrimary) return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, from: offset, dx: 0 };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (d.sideways === undefined) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      // Mostly up or down: that is the list scrolling, and the browser has it already. Nor does a
      // closed row with nothing on its left take a slide to the right.
      d.sideways = Math.abs(dx) > Math.abs(dy) && (dx < 0 || Boolean(start) || d.from !== 0);
      if (!d.sideways) {
        drag.current = null;
        return;
      }
      e.currentTarget.setPointerCapture(e.pointerId);
      setDragging(true);
    }
    d.dx = dx;
    setOffset(bounded(d.from + dx));
  };
  const onPointerEnd = (e: React.PointerEvent, cancelled: boolean) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    drag.current = null;
    if (!d.sideways) return;
    setDragging(false);
    // Some browsers follow a slide with a click on the row: it was not a tap.
    swallowClicksUntil.current = Date.now() + 400;
    const at = bounded(d.from + d.dx);
    const width = box.current?.offsetWidth ?? 1;
    if (cancelled) setOffset(d.from);
    else if (at > width * COMMIT && start) act(start, 1);
    else if (-at > width * COMMIT) act(end, -1);
    else setOffset(Math.abs(at) > REVEAL / 2 ? Math.sign(at) * REVEAL : 0);
  };
  const onClickCapture = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('[data-row-action]')) return;
    if (Date.now() < swallowClicksUntil.current || offset !== 0) {
      // A tap on a row showing its button closes it, rather than opening the session.
      e.preventDefault();
      e.stopPropagation();
      setOffset(0);
    }
  };

  const button = (action: RowAction) => (
    <button
      type="button"
      data-row-action
      aria-label={`${action.label}: ${name}`}
      title={action.label}
      onClick={action.act}
      className={`grid size-8 place-items-center rounded-full text-muted opacity-0 group-hover/row:opacity-100 group-has-focus-visible/actions:opacity-100 hover:text-fg ${selected ? 'bg-chip' : 'bg-hover'}`}
    >
      <action.icon className="size-4" />
    </button>
  );

  return (
    <div
      ref={box}
      data-session={id}
      className="group/row relative touch-pan-y touch-pinch-zoom"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => onPointerEnd(e, false)}
      onPointerCancel={(e) => onPointerEnd(e, true)}
      onClickCapture={onClickCapture}
    >
      {shown && (
        <div className={`absolute inset-0 flex overflow-hidden rounded-xl bg-fg ${offset > 0 ? 'justify-start' : 'justify-end'}`}>
          <button
            type="button"
            data-row-action
            onClick={() => act(shown, offset > 0 ? 1 : -1)}
            className="flex h-full shrink-0 items-center justify-center gap-1.5 text-[14px] font-medium text-bg"
            style={{ width: Math.max(REVEAL, Math.abs(offset)) }}
          >
            <shown.icon className="size-4 shrink-0" />
            {shown.label}
          </button>
        </div>
      )}
      <div
        className={`relative rounded-xl bg-bg ${dragging ? '' : 'transition-transform duration-200 motion-reduce:transition-none'}`}
        style={offset ? { transform: `translateX(${offset}px)` } : undefined}
      >
        {children}
        {/* Shown together, on hover or when the keyboard reaches either. */}
        <div className={`group/actions absolute right-1.5 hidden gap-0.5 pointer-fine:flex ${compact ? 'top-1/2 -translate-y-1/2' : 'top-1.5'}`}>
          {start && button(start)}
          {button(end)}
        </div>
      </div>
    </div>
  );
}

const ListRow = memo(function ListRow({ session, compact, onChange, ...row }: RowProps & { compact: boolean; onChange: (session: SessionSummary, change: ListChange) => void }) {
  const Row = compact ? CompactRow : DetailedRow;
  const pin: RowAction = session.pinned
    ? { label: 'Unpin', icon: PinOff, act: () => onChange(session, { pinned: false }) }
    : { label: 'Pin', icon: Pin, act: () => onChange(session, { pinned: true }) };
  const archive: RowAction = session.archived
    ? { label: 'Unarchive', icon: ArchiveRestore, act: () => onChange(session, { archived: false }) }
    : { label: 'Archive', icon: Archive, act: () => onChange(session, { archived: true }) };
  return (
    <Swipeable id={session.id} name={session.title} {...(session.archived ? {} : { start: pin })} end={archive} compact={compact} selected={row.selected}>
      <Row session={session} {...row} />
    </Swipeable>
  );
});

/**
 * The filter chips: one row that scrolls sideways, faded at an edge that has more beyond it. A
 * mouse wheel, which only moves up and down, scrolls it sideways too.
 */
function ChipRow({ items, children }: { items: string; children: ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });
  useEffect(() => {
    const el = scroller.current;
    if (!el) return undefined;
    const measure = () => {
      const next = { start: el.scrollLeft > 1, end: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 };
      setEdges((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
    };
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    };
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: false });
    const resized = new ResizeObserver(measure);
    resized.observe(el);
    return () => {
      el.removeEventListener('scroll', measure);
      el.removeEventListener('wheel', onWheel);
      resized.disconnect();
    };
  }, [items]);
  const mask = edges.start || edges.end
    ? `linear-gradient(to right, ${edges.start ? 'transparent, #000 28px' : '#000'}, ${edges.end ? '#000 calc(100% - 28px), transparent' : '#000'})`
    : undefined;
  return (
    <div
      ref={scroller}
      role="group"
      aria-label="Show sessions from"
      // The padding holds the chips' taller touch area, which the scrolling row would cut off.
      className="no-scrollbar -mx-4 mt-1 -mb-1 flex gap-1.5 overflow-x-auto px-4 py-1"
      style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
    >
      {children}
    </div>
  );
}

/** Rows are drawn this many at a time, the next ones as the list nears its end. */
const PAGE = 150;

function MoreRows({ root, onNear }: { root: React.RefObject<HTMLElement | null>; onNear: () => void }) {
  const mark = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = mark.current;
    if (!el) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) onNear();
    }, { root: root.current, rootMargin: '0px 0px 1500px 0px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [root, onNear]);
  return <div ref={mark} aria-hidden className="h-px" />;
}

type Group = { key: string; label: string; entries: Entry[]; count: number };

/** How many sessions a group holds, the earlier ones folded into its rows too. */
const sessionsIn = (entries: Entry[]) => entries.reduce((n, entry) => n + 1 + entry.earlier.length, 0);

function ListViewSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const prefs = usePrefs();
  return (
    <Sheet open={open} onClose={onClose} title="Session list" done>
      <SheetHeading>Group by</SheetHeading>
      <Segmented<Prefs['listGroup']>
        value={prefs.listGroup}
        onChange={(listGroup) => setPrefs({ listGroup })}
        options={[{ value: 'time', label: 'Time' }, { value: 'project', label: 'Project' }]}
      />
      <SheetHeading>Rows</SheetHeading>
      <Segmented<Prefs['listDensity']>
        value={prefs.listDensity}
        onChange={(listDensity) => setPrefs({ listDensity })}
        options={[{ value: 'detailed', label: 'Detailed' }, { value: 'compact', label: 'Compact' }]}
      />
      <SheetHeading>Also show</SheetHeading>
      <SheetToggle
        label="Temporary sessions"
        description="Mostly started by other sessions"
        checked={prefs.showTemporary}
        onChange={(showTemporary) => setPrefs({ showTemporary })}
      />
      <SheetToggle
        label="Side chats"
        checked={prefs.showSideChats}
        onChange={(showSideChats) => setPrefs({ showSideChats })}
      />
    </Sheet>
  );
}

/** What was just pinned or archived, or brought back, for Undo; or why it could not be. */
type Done = { session: SessionSummary; change: ListChange; error?: string; at: number };

export function SessionList({
  machine,
  selectedId,
  onOpen,
  onNew,
  onSettings,
  connected,
  banner,
}: {
  machine: string;
  selectedId?: string;
  onOpen: (id: string) => void;
  /** Starts a new session there; nowhere given, the page that asks where. */
  onNew: (start?: Start) => void;
  onSettings: () => void;
  connected: boolean;
  banner?: React.ReactNode;
}) {
  const prefs = usePrefs();
  const isUnread = useSeen();
  const queryClient = useQueryClient();
  const { data: sessions, isLoading, error } = useQuery({ queryKey: ['sessions'], queryFn: api.sessions, refetchInterval: 20_000 });
  const [query, setQuery] = useState('');
  const [project, setProject] = useState<string>();
  const [viewOpen, setViewOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [unfolded, setUnfolded] = useState<Set<string>>(new Set());
  const [done, setDone] = useState<Done>();
  const scroller = useRef<HTMLDivElement>(null);
  const toggle = (set: React.Dispatch<React.SetStateAction<Set<string>>>, key: string) => set((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  // The rows keep the same callbacks from one render to the next, so only rows that changed redraw.
  const openRef = useRef(onOpen);
  useLayoutEffect(() => {
    openRef.current = onOpen;
  });
  const openSession = useCallback((id: string) => openRef.current(id), []);

  // A row's own button, or Undo, leaves focus with the session it changed, which the list draws
  // anew elsewhere or no longer shows: on its row, where it went, or on the row that took its place.
  const toast = useRef<HTMLDivElement>(null);
  const refocus = useRef<{ ids: string[]; scroll: boolean }>(undefined);
  const keepFocus = useCallback((id: string) => {
    const from = document.activeElement;
    if (!from || (from.closest('[data-session]')?.getAttribute('data-session') !== id && !toast.current?.contains(from))) return;
    const ids = [...(scroller.current?.querySelectorAll('[data-session]') ?? [])].map((row) => row.getAttribute('data-session')!);
    const at = ids.indexOf(id);
    refocus.current = { ids: at < 0 ? [id] : [id, ...ids.slice(at + 1), ...ids.slice(0, at).reverse()], scroll: keyboardFocus(from) };
  }, []);

  // Pinned or archived at once in the list, then on the server; put back if the server says no.
  const change = useCallback((session: SessionSummary, to: ListChange, undoable = true) => {
    keepFocus(session.id);
    setDone(undoable ? { session, change: to, at: Date.now() } : undefined);
    makeChange(queryClient, session, to).catch((err: Error) => {
      keepFocus(session.id);
      setDone({ session, change: to, error: err.message, at: Date.now() });
    });
  }, [queryClient, keepFocus]);
  useEffect(() => {
    if (!done) return undefined;
    const timer = setTimeout(() => setDone(undefined), done.error ? 8000 : 5000);
    return () => clearTimeout(timer);
  }, [done]);

  // One chip per real project; scratch sessions share one chip, and so do temporary ones,
  // which "All" leaves out unless the list's options say otherwise: they are mostly runs other sessions started.
  const projects = useMemo(() => {
    const seen = new Map<string, number>();
    for (const s of sessions ?? []) if (s.project && !s.scratch && !s.temp && !s.archived && !seen.has(s.project)) seen.set(s.project, s.lastActivity);
    const list = [...seen.keys()].slice(0, 14);
    if ((sessions ?? []).some((s) => s.scratch && !s.archived)) list.push(SCRATCH);
    if ((sessions ?? []).some((s) => s.temp && !s.archived)) list.push(TEMP);
    if ((sessions ?? []).some((s) => s.archived)) list.push(ARCHIVED);
    return list;
  }, [sessions]);
  const tempCount = useMemo(() => (sessions ?? []).filter((s) => s.temp && !s.archived).length, [sessions]);
  const archivedCount = useMemo(() => (sessions ?? []).filter((s) => s.archived).length, [sessions]);
  // A chip that went away (its last session unarchived or gone) takes its filter with it.
  useEffect(() => {
    if (project && sessions && !projects.includes(project)) setProject(undefined);
  }, [project, projects, sessions]);

  const groups = useMemo((): Group[] => {
    const q = query.trim().toLowerCase();
    const filtered = (sessions ?? []).filter((s) => {
      // Archived sessions show under their own chip, or when a search finds them.
      if (project === ARCHIVED) return s.archived && (!q || matches(s, q));
      if (s.archived && !q) return false;
      // Side chats belong to the session they came from: shown when asked for, found by a search,
      // or pinned (as is a temporary session: a pin keeps it in view whatever the list's options).
      if (s.sideChatOf && !q && !prefs.showSideChats && !s.pinned) return false;
      if (project === TEMP) {
        if (!s.temp) return false;
      } else if (project === SCRATCH) {
        if (!s.scratch) return false;
      } else if (project) {
        if (s.scratch || s.temp || s.project !== project) return false;
      } else if (s.temp && !q && !prefs.showTemporary && !s.pinned) {
        return false;
      }
      return !q || matches(s, q);
    });

    // Pinned sessions lead, whatever the grouping, each with its status and its earlier runs.
    const entries = fold(filtered);
    const out: Group[] = [];
    const pinned = entries.filter((entry) => entry.session.pinned);
    if (pinned.length > 0) out.push({ key: PINNED, label: 'Pinned', entries: pinned, count: sessionsIn(pinned) });
    const rest = entries.filter((entry) => !entry.session.pinned);

    if (prefs.listGroup === 'project' && !project) {
      const byProject = new Map<string, Group>();
      for (const entry of rest) {
        const s = entry.session;
        const key = s.temp ? TEMP : s.scratch ? SCRATCH : s.cwd || s.project;
        let group = byProject.get(key);
        if (!group) {
          group = { key, label: s.temp ? 'Temporary' : s.scratch ? 'Scratch' : s.project || '—', entries: [], count: 0 };
          byProject.set(key, group);
        }
        group.entries.push(entry);
      }
      return [...out, ...[...byProject.values()].map((group) => ({ ...group, count: sessionsIn(group.entries) }))];
    }

    const active = rest.filter((entry) => isActive(entry.session));
    if (active.length > 0) out.push({ key: 'active', label: 'Active', entries: active, count: active.length });
    for (const entry of rest) {
      if (isActive(entry.session)) continue;
      const label = dayGroup(entry.session.lastActivity);
      const last = out.at(-1);
      if (last && last.label === label) last.entries.push(entry);
      else out.push({ key: label, label, entries: [entry], count: 0 });
    }
    return out;
  }, [sessions, query, project, prefs.listGroup, prefs.showTemporary, prefs.showSideChats]);

  const byProject = prefs.listGroup === 'project' && !project;
  // A group folds only where its heading can unfold it, grouped by project: Pinned, folded there,
  // still shows its sessions grouped by time or under a chip.
  const isFolded = useCallback((key: string) => byProject && collapsed.has(key), [byProject, collapsed]);

  // A long list is drawn in pages; search and the filters above still go through every session.
  const pagesFor = `${query}\u0000${project ?? ''}\u0000${prefs.listGroup}`;
  const [paging, setPaging] = useState({ for: pagesFor, rows: PAGE });
  const rowLimit = paging.for === pagesFor ? paging.rows : PAGE;
  const shown = useMemo(() => {
    let left = rowLimit;
    const out: Group[] = [];
    for (const group of groups) {
      if (left <= 0) break;
      if (isFolded(group.key)) {
        out.push(group);
        continue;
      }
      const entries = group.entries.slice(0, left);
      left -= entries.length;
      out.push(entries.length === group.entries.length ? group : { ...group, entries });
    }
    const total = groups.reduce((sum, g) => sum + (isFolded(g.key) ? 0 : g.entries.length), 0);
    return { groups: out, more: total > rowLimit };
  }, [groups, isFolded, rowLimit]);
  const showMore = useCallback(() => setPaging({ for: pagesFor, rows: rowLimit + PAGE }), [pagesFor, rowLimit]);

  useLayoutEffect(() => {
    const kept = refocus.current;
    if (!kept) return;
    refocus.current = undefined;
    if (document.activeElement && document.activeElement !== document.body) return;
    const rows = [...(scroller.current?.querySelectorAll<HTMLElement>('[data-session]') ?? [])];
    for (const id of kept.ids) {
      const link = rows.find((row) => row.getAttribute('data-session') === id)?.querySelector<HTMLElement>('a[href]');
      if (link) {
        // Followed on the keyboard; with a pointer, the list stays where it is.
        link.focus({ preventScroll: !kept.scroll });
        return;
      }
    }
  }, [shown]);

  const compact = prefs.listDensity === 'compact';
  // What "All" shows, counted the way it is filtered.
  const visibleCount = (sessions ?? []).filter((s) => !s.archived && (s.pinned || (!(s.temp && !prefs.showTemporary) && !(s.sideChatOf && !prefs.showSideChats)))).length;
  const startNew = () => onNew(project === SCRATCH ? { scratch: true } : defaultStart(sessions ?? [], project && !SPECIAL[project] ? project : undefined));

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <header className="shrink-0 px-4 pt-3 pb-2">
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-[20px] font-semibold tracking-tight">{machine || 'Pelican'}</h1>
              <span title={connected ? 'Connected' : 'Reconnecting'} className={`size-1.5 shrink-0 rounded-full ${connected ? 'bg-live' : 'bg-wait'}`} />
            </div>
            <div className="text-[12.5px] text-faint">Claude Code{sessions ? ` · ${visibleCount} sessions` : ''}</div>
          </div>
          <button type="button" aria-label="Settings" onClick={onSettings} className="grid size-11 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg pointer-fine:size-10">
            <Settings className="size-[18px]" />
          </button>
          <button type="button" aria-label="New session" onClick={startNew} className="ml-1 grid size-11 place-items-center rounded-full bg-fg text-bg pointer-fine:size-10">
            <Plus className="size-5" />
          </button>
        </div>
        <div className="mt-3 flex items-center gap-1">
        <label className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-xl bg-chip pl-3 focus-within:ring-1 focus-within:ring-faint pointer-fine:h-10">
          <Search className="size-4 shrink-0 text-faint" />
          <input
            id="session-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            // ⌘K comes here (App); Enter opens the first match, Esc clears.
            aria-keyshortcuts={`${MOD_ARIA}+K`}
            onKeyDown={(e) => {
              // Keys an input method takes are its own: Esc there cancels a conversion, not the search.
              if (composing(e.nativeEvent)) return;
              if (e.key === 'Escape' && query) {
                e.preventDefault();
                setQuery('');
              } else if (e.key === 'Enter' && query.trim()) {
                const first = groups[0]?.entries[0]?.session;
                if (first) onOpen(first.id);
              }
            }}
            placeholder="Search sessions"
            aria-label="Search sessions"
            className="min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-faint"
          />
          {query && (
            <button type="button" aria-label="Clear search" onClick={() => setQuery('')} className="grid size-11 shrink-0 place-items-center rounded-xl text-faint hover:text-fg pointer-fine:size-10">
              <X className="size-4" />
            </button>
          )}
        </label>
        {/* How the list is grouped and what it shows: next to the list, apart from Settings. */}
        <button type="button" aria-label="List options" onClick={() => setViewOpen(true)} className="grid size-11 shrink-0 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg pointer-fine:size-10">
          <ListFilter className="size-[18px]" />
        </button>
        </div>
        {(projects.length > 1 || archivedCount > 0) && (
          <ChipRow items={projects.join('\u0000')}>
            {[undefined, ...projects].map((p) => (
              <button
                key={p ?? '*'}
                type="button"
                aria-pressed={project === p}
                onClick={() => setProject(p)}
                // A taller touch area than the chip shows.
                className={`relative h-9 shrink-0 rounded-full px-3.5 text-[13.5px] after:absolute after:inset-x-0 after:-inset-y-1 after:content-[''] ${project === p ? 'bg-fg text-bg' : 'bg-chip text-muted hover:text-fg'}`}
              >
                {p && SPECIAL[p] ? SPECIAL[p] : (p ?? 'All')}
                {/* Faint on a plain chip; see-through on the chosen one, where faint would vanish. */}
                {p === TEMP && <span className={`ml-1 ${project === p ? 'opacity-60' : 'text-faint'}`}>{tempCount}</span>}
                {p === ARCHIVED && <span className={`ml-1 ${project === p ? 'opacity-60' : 'text-faint'}`}>{archivedCount}</span>}
              </button>
            ))}
          </ChipRow>
        )}
      </header>
      {banner}
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-6">
        {isLoading && <div className="flex justify-center py-16 text-faint"><Loader2 className="size-5 animate-spin" /></div>}
        {/* Out of reach, the line under the header says so (App). */}
        {error && !isUnreachable(error) && <div className="px-4 py-8 text-[13px] text-danger">{(error as Error).message}</div>}
        {shown.groups.map((group) => {
          const folded = isFolded(group.key);
          return (
            <section key={group.key}>
              {byProject ? (
                <button
                  type="button"
                  aria-expanded={!folded}
                  onClick={() => toggle(setCollapsed, group.key)}
                  className="sticky top-0 z-10 flex min-h-10 w-full items-center gap-1.5 bg-bg/90 px-3 pt-3 pb-1 text-left backdrop-blur"
                >
                  <ChevronDown className={`size-3.5 text-faint transition-transform ${folded ? '-rotate-90' : ''}`} />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{group.label}</span>
                  <span className="text-[12px] text-faint tabular-nums">{group.count}</span>
                </button>
              ) : (
                <h2 className="sticky top-0 z-10 bg-bg/90 px-3 pt-3 pb-1 text-[11.5px] font-medium tracking-wide text-faint uppercase backdrop-blur">
                  {group.label}
                </h2>
              )}
              {!folded && group.entries.map(({ session: s, earlier }) => {
                const row = (session: SessionSummary) => (
                  <ListRow
                    key={session.id}
                    session={session}
                    compact={compact}
                    selected={session.id === selectedId}
                    unread={session.id !== selectedId && session.status !== 'running' && isUnread(session.id, session.lastActivity)}
                    showProject={!byProject || group.key === PINNED}
                    onOpen={openSession}
                    onChange={change}
                  />
                );
                if (earlier.length === 0) return row(s);
                // Unfolded stays unfolded when a newer run takes the row; a pinned row keeps its session.
                const key = s.pinned ? s.id : foldKey(s);
                const open = unfolded.has(key) || earlier.some((e) => e.id === selectedId);
                return (
                  <div key={s.id}>
                    {row(s)}
                    <button
                      type="button"
                      aria-expanded={open}
                      onClick={() => toggle(setUnfolded, key)}
                      className="-mt-2 ml-1.5 flex h-10 items-center gap-1 rounded-full px-1.5 text-[12.5px] text-faint hover:text-fg"
                    >
                      {open ? 'Hide' : `${earlier.length} earlier`}
                      <ChevronDown className={`size-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
                    </button>
                    {open && <div className="mb-1 ml-3 border-l border-line pl-1">{earlier.map(row)}</div>}
                  </div>
                );
              })}
            </section>
          );
        })}
        {shown.more && <MoreRows key={rowLimit} root={scroller} onNear={showMore} />}
        {sessions && groups.length === 0 && (query || project ? (
          <div className="px-4 py-12 text-center text-[13px] text-faint">No matching sessions</div>
        ) : archivedCount > 0 ? (
          <div className="px-4 py-12 text-center text-[13px] text-faint">Every session is archived</div>
        ) : (
          <div className="mx-auto max-w-xs px-4 py-14 text-center">
            <div className="text-[15px] font-medium">No sessions yet</div>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
              Start one with <span className="font-medium text-fg">+</span>. Sessions from the terminal, Claude Desktop and your editor show up here too.
            </p>
          </div>
        ))}
      </div>
      {/* Always there, so a screen reader hears what lands in it. */}
      <div ref={toast} role="status" className="pb-safe pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-3">
        {done && (
          <div className="animate-fade pointer-events-auto mb-2 flex min-h-11 max-w-sm items-center gap-2 rounded-2xl bg-fg py-1 pr-1 pl-4 text-[14px] leading-snug text-bg shadow-lg">
            <span className="min-w-0 py-1.5">{done.error ?? changeWords(done.change)}</span>
            {done.error ? (
              <button type="button" aria-label="Dismiss" onClick={() => setDone(undefined)} className="grid size-9 shrink-0 place-items-center rounded-full hover:bg-bg/15"><X className="size-4" /></button>
            ) : (
              <button type="button" onClick={() => change(changed(done.session, done.change), undoOf(done.session, done.change), false)} className="h-9 shrink-0 rounded-full px-3 font-medium hover:bg-bg/15">Undo</button>
            )}
          </div>
        )}
      </div>
      <ListViewSheet open={viewOpen} onClose={() => setViewOpen(false)} />
    </div>
  );
}
