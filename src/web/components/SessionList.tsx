import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, ChevronDown, GitBranch, ListFilter, Loader2, Plus, Search, Settings, X } from 'lucide-react';
import { memo, type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { SessionStatus, SessionSummary } from '../../shared/protocol';
import { api, isUnreachable } from '../lib/api';
import { type Entry, fold, foldKey, isActive, single } from '../lib/fold';
import { dayGroup, relativeTime, timeAgo } from '../lib/format';
import { composing, MOD_ARIA } from '../lib/keyboard';
import { type Prefs, setPrefs, usePrefs, useSeen } from '../lib/prefs';
import { defaultStart, type Start } from '../lib/start';
import { Segmented, Sheet, SheetHeading, SheetToggle } from './Sheet';

/** Filter values for sessions outside projects. */
const SCRATCH = '\u0000scratch';
const TEMP = '\u0000temp';
const ARCHIVED = '\u0000archived';
const SPECIAL: Record<string, string> = { [SCRATCH]: 'Scratch', [TEMP]: 'Temporary', [ARCHIVED]: 'Archived' };

/**
 * What a session is doing, in words. `tasks`: background tasks and subagents still running in it
 * (and checks Claude stays running for), said between turns as "2 tasks".
 */
export function statusLabel(status: SessionStatus, runningIn?: string, tasks = 0): string {
  if (status === 'running') return 'Working';
  if (status === 'waiting') return runningIn ? `Needs you in ${runningIn}` : 'Needs you';
  if (status === 'live') return runningIn ? `Working in ${runningIn}` : 'Working elsewhere';
  if (tasks > 0) return tasks === 1 ? '1 task' : `${tasks} tasks`;
  return '';
}

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

/** How far a row slides to show its button, and how far (of its width) a slide acts on release. */
const REVEAL = 104;
const COMMIT = 0.4;

/**
 * A row with one action, Archive (Unarchive once archived), reached without opening the session.
 * Under a finger the row slides left, as in Mail: far enough, it acts when let go; less far, the
 * button stays showing. With a mouse or the keyboard the action is a button on the row, shown on
 * hover or focus.
 */
function Swipeable({ name, archived, compact, selected, onAction, children }: {
  /** The session's title, so each row's button says which session it acts on. */
  name: string;
  archived: boolean;
  compact: boolean;
  selected: boolean;
  onAction: () => void;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; from: number; dx: number; sideways?: boolean } | null>(null);
  const swallowClicksUntil = useRef(0);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const label = archived ? 'Unarchive' : 'Archive';
  const Icon = archived ? ArchiveRestore : Archive;

  // A row left open closes at the next touch anywhere else, as rows in Mail do.
  useEffect(() => {
    if (offset === 0 || dragging) return undefined;
    const close = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOffset(0);
    };
    document.addEventListener('pointerdown', close, true);
    return () => document.removeEventListener('pointerdown', close, true);
  }, [offset, dragging]);

  const act = () => {
    setOffset(-(box.current?.offsetWidth ?? 0));
    // The row slides out of sight, then leaves the list; if the change fails it comes back closed.
    window.setTimeout(() => {
      onAction();
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
      // Mostly up or down: that is the list scrolling, and the browser has it already.
      d.sideways = Math.abs(dx) > Math.abs(dy);
      if (!d.sideways) {
        drag.current = null;
        return;
      }
      e.currentTarget.setPointerCapture(e.pointerId);
      setDragging(true);
    }
    d.dx = dx;
    setOffset(Math.min(0, d.from + dx));
  };
  const onPointerEnd = (e: React.PointerEvent, cancelled: boolean) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    drag.current = null;
    if (!d.sideways) return;
    setDragging(false);
    // Some browsers follow a slide with a click on the row: it was not a tap.
    swallowClicksUntil.current = Date.now() + 400;
    const at = Math.min(0, d.from + d.dx);
    const width = box.current?.offsetWidth ?? 1;
    if (cancelled) setOffset(d.from);
    else if (-at > width * COMMIT) act();
    else setOffset(-at > REVEAL / 2 ? -REVEAL : 0);
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

  return (
    <div
      ref={box}
      className="group/row relative touch-pan-y touch-pinch-zoom"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => onPointerEnd(e, false)}
      onPointerCancel={(e) => onPointerEnd(e, true)}
      onClickCapture={onClickCapture}
    >
      {(offset !== 0 || dragging) && (
        <div className="absolute inset-0 flex justify-end overflow-hidden rounded-xl bg-fg">
          <button
            type="button"
            data-row-action
            onClick={act}
            className="flex h-full shrink-0 items-center justify-center gap-1.5 text-[14px] font-medium text-bg"
            style={{ width: Math.max(REVEAL, -offset) }}
          >
            <Icon className="size-4 shrink-0" />
            {label}
          </button>
        </div>
      )}
      <div
        className={`relative rounded-xl bg-bg ${dragging ? '' : 'transition-transform duration-200 motion-reduce:transition-none'}`}
        style={offset ? { transform: `translateX(${offset}px)` } : undefined}
      >
        {children}
        <button
          type="button"
          data-row-action
          aria-label={`${label}: ${name}`}
          title={label}
          onClick={onAction}
          className={`absolute right-1.5 hidden size-8 place-items-center rounded-full text-muted opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 hover:text-fg pointer-fine:grid ${compact ? 'top-1/2 -translate-y-1/2' : 'top-1.5'} ${selected ? 'bg-chip' : 'bg-hover'}`}
        >
          <Icon className="size-4" />
        </button>
      </div>
    </div>
  );
}

const ListRow = memo(function ListRow({ session, compact, onArchive, ...row }: RowProps & { compact: boolean; onArchive: (session: SessionSummary, archived: boolean) => void }) {
  const Row = compact ? CompactRow : DetailedRow;
  return (
    <Swipeable name={session.title} archived={Boolean(session.archived)} compact={compact} selected={row.selected} onAction={() => onArchive(session, !session.archived)}>
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

/** What was just archived or brought back, for Undo; or why it could not be. */
type Done = { session: SessionSummary; archived: boolean; error?: string; at: number };

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

  // Archived at once in the list, then on the server; put back if the server says no.
  const setArchived = useCallback((session: SessionSummary, archived: boolean, undoable = true) => {
    const mark = (to: boolean) => queryClient.setQueryData<SessionSummary[]>(['sessions'], (list) =>
      list?.map((s) => (s.id === session.id ? { ...s, archived: to } : s)));
    void queryClient.cancelQueries({ queryKey: ['sessions'] });
    mark(archived);
    setDone(undoable ? { session, archived, at: Date.now() } : undefined);
    api.archive(session.id, archived)
      .catch((err: Error) => {
        mark(!archived);
        setDone({ session, archived, error: err.message, at: Date.now() });
      })
      .finally(() => void queryClient.invalidateQueries({ queryKey: ['sessions'] }));
  }, [queryClient]);
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
      // Side chats belong to the session they came from: shown when asked for, or found by a search.
      if (s.sideChatOf && !q && !prefs.showSideChats) return false;
      if (project === TEMP) {
        if (!s.temp) return false;
      } else if (project === SCRATCH) {
        if (!s.scratch) return false;
      } else if (project) {
        if (s.scratch || s.temp || s.project !== project) return false;
      } else if (s.temp && !q && !prefs.showTemporary) {
        return false;
      }
      return !q || matches(s, q);
    });

    if (prefs.listGroup === 'project' && !project) {
      const byProject = new Map<string, { key: string; label: string; sessions: SessionSummary[] }>();
      for (const s of filtered) {
        const key = s.temp ? TEMP : s.scratch ? SCRATCH : s.cwd || s.project;
        const label = s.temp ? 'Temporary' : s.scratch ? 'Scratch' : s.project || '—';
        let group = byProject.get(key);
        if (!group) {
          group = { key, label, sessions: [] };
          byProject.set(key, group);
        }
        group.sessions.push(s);
      }
      return [...byProject.values()].map((g) => ({ key: g.key, label: g.label, entries: fold(g.sessions), count: g.sessions.length }));
    }

    const out: Group[] = [];
    const active = filtered.filter(isActive);
    if (active.length > 0) out.push({ key: 'active', label: 'Active', entries: active.map(single), count: active.length });
    for (const entry of fold(filtered.filter((s) => !isActive(s)))) {
      const label = dayGroup(entry.session.lastActivity);
      const last = out.at(-1);
      if (last && last.label === label) last.entries.push(entry);
      else out.push({ key: label, label, entries: [entry], count: 0 });
    }
    return out;
  }, [sessions, query, project, prefs.listGroup, prefs.showTemporary, prefs.showSideChats]);

  // A long list is drawn in pages; search and the filters above still go through every session.
  const pagesFor = `${query}\u0000${project ?? ''}\u0000${prefs.listGroup}`;
  const [paging, setPaging] = useState({ for: pagesFor, rows: PAGE });
  const rowLimit = paging.for === pagesFor ? paging.rows : PAGE;
  const shown = useMemo(() => {
    let left = rowLimit;
    const out: Group[] = [];
    for (const group of groups) {
      if (left <= 0) break;
      if (collapsed.has(group.key)) {
        out.push(group);
        continue;
      }
      const entries = group.entries.slice(0, left);
      left -= entries.length;
      out.push(entries.length === group.entries.length ? group : { ...group, entries });
    }
    const total = groups.reduce((sum, g) => sum + (collapsed.has(g.key) ? 0 : g.entries.length), 0);
    return { groups: out, more: total > rowLimit };
  }, [groups, collapsed, rowLimit]);
  const showMore = useCallback(() => setPaging({ for: pagesFor, rows: rowLimit + PAGE }), [pagesFor, rowLimit]);

  const byProject = prefs.listGroup === 'project' && !project;
  const compact = prefs.listDensity === 'compact';
  // What "All" shows, counted the way it is filtered.
  const visibleCount = (sessions ?? []).filter((s) => !s.archived && !(s.temp && !prefs.showTemporary) && !(s.sideChatOf && !prefs.showSideChats)).length;
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
              if (e.key === 'Escape' && query) {
                e.preventDefault();
                setQuery('');
              } else if (e.key === 'Enter' && query.trim() && !composing(e.nativeEvent)) {
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
          const folded = collapsed.has(group.key);
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
                    showProject={!byProject}
                    onOpen={openSession}
                    onArchive={setArchived}
                  />
                );
                if (earlier.length === 0) return row(s);
                const open = unfolded.has(foldKey(s)) || earlier.some((e) => e.id === selectedId);
                return (
                  <div key={s.id}>
                    {row(s)}
                    <button
                      type="button"
                      aria-expanded={open}
                      onClick={() => toggle(setUnfolded, foldKey(s))}
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
      <div role="status" className="pb-safe pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-3">
        {done && (
          <div className="animate-fade pointer-events-auto mb-2 flex min-h-11 max-w-sm items-center gap-2 rounded-2xl bg-fg py-1 pr-1 pl-4 text-[14px] leading-snug text-bg shadow-lg">
            <span className="min-w-0 py-1.5">{done.error ?? (done.archived ? 'Archived' : 'Unarchived')}</span>
            {done.error ? (
              <button type="button" aria-label="Dismiss" onClick={() => setDone(undefined)} className="grid size-9 shrink-0 place-items-center rounded-full hover:bg-bg/15"><X className="size-4" /></button>
            ) : (
              <button type="button" onClick={() => setArchived(done.session, !done.archived, false)} className="h-9 shrink-0 rounded-full px-3 font-medium hover:bg-bg/15">Undo</button>
            )}
          </div>
        )}
      </div>
      <ListViewSheet open={viewOpen} onClose={() => setViewOpen(false)} />
    </div>
  );
}
