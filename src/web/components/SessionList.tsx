import { useQuery } from '@tanstack/react-query';
import { ChevronDown, GitBranch, ListFilter, Loader2, Plus, Search, Settings, X } from 'lucide-react';
import { memo, useEffect, useMemo, useState } from 'react';

import type { SessionStatus, SessionSummary } from '../../shared/protocol';
import { api, isUnreachable } from '../lib/api';
import { type Entry, fold, foldKey, single } from '../lib/fold';
import { dayGroup, relativeTime } from '../lib/format';
import { composing, MOD_ARIA } from '../lib/keyboard';
import { type Prefs, setPrefs, usePrefs, useSeen } from '../lib/prefs';
import { Segmented, Sheet, SheetHeading, SheetToggle } from './Sheet';

/** Filter values for sessions outside projects. */
const SCRATCH = '\u0000scratch';
const TEMP = '\u0000temp';
const ARCHIVED = '\u0000archived';
const SPECIAL: Record<string, string> = { [SCRATCH]: 'Scratch', [TEMP]: 'Temporary', [ARCHIVED]: 'Archived' };

export function statusLabel(status: SessionStatus, runningIn?: string): string {
  if (status === 'running') return 'Working';
  if (status === 'waiting') return runningIn ? `Needs you in ${runningIn}` : 'Needs you';
  if (status === 'live') return runningIn ? `Working in ${runningIn}` : 'Working elsewhere';
  return '';
}

const DOT: Record<SessionStatus, string> = { running: 'bg-run', waiting: 'bg-wait', live: 'bg-live', idle: 'bg-line' };
const TEXT: Record<SessionStatus, string> = { running: 'text-run', waiting: 'text-wait', live: 'text-live', idle: 'text-faint' };

export function StatusDot({ status }: { status: SessionStatus }) {
  return (
    <span className="relative flex size-1.5 shrink-0">
      {(status === 'running' || status === 'live') && <span className={`absolute inline-flex size-full animate-ping rounded-full opacity-60 ${DOT[status]}`} />}
      <span className={`relative inline-flex size-1.5 rounded-full ${DOT[status]}`} />
    </span>
  );
}

export function StatusBadge({ status, runningIn }: { status: SessionStatus; runningIn?: string }) {
  if (status === 'idle') return null;
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 text-[11.5px] font-medium ${TEXT[status]}`}>
      <StatusDot status={status} />
      {statusLabel(status, runningIn)}
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

type RowProps = { session: SessionSummary; selected: boolean; unread: boolean; showProject: boolean; onOpen: (id: string) => void };

const DetailedRow = memo(function DetailedRow({ session, selected, unread, showProject, onOpen }: RowProps) {
  return (
    <button
      type="button"
      onClick={() => onOpen(session.id)}
      className={`block w-full rounded-xl px-3 py-2.5 text-left transition-colors ${selected ? 'bg-chip' : 'hover:bg-hover active:bg-hover'}`}
    >
      <div className="flex items-start gap-2">
        {unread && <span aria-label="New activity" className="mt-[7px] size-2 shrink-0 rounded-full bg-run" />}
        <div className={`line-clamp-2 min-w-0 flex-1 text-[15px] leading-snug ${unread ? 'font-semibold' : ''}`}>{session.title}</div>
        <span className="shrink-0 pt-0.5 text-[12px] text-faint tabular-nums">{relativeTime(session.lastActivity)}</span>
      </div>
      {session.preview && <div className="mt-0.5 line-clamp-1 text-[13px] leading-snug text-muted">{session.preview}</div>}
      <div className="mt-1 flex items-center gap-2 text-[12.5px] text-muted">
        <StatusBadge status={session.status} runningIn={session.runningIn} />
        {showProject && <Where session={session} />}
        {session.gitBranch && (
          <span className="flex min-w-0 items-center gap-0.5 truncate text-faint">
            <GitBranch className="size-3 shrink-0" />
            <span className="truncate">{session.gitBranch}</span>
          </span>
        )}
      </div>
    </button>
  );
});

const CompactRow = memo(function CompactRow({ session, selected, unread, showProject, onOpen }: RowProps) {
  return (
    <button
      type="button"
      onClick={() => onOpen(session.id)}
      title={statusLabel(session.status, session.runningIn) || undefined}
      className={`flex h-10 w-full items-center gap-2.5 rounded-lg px-3 text-left transition-colors ${selected ? 'bg-chip' : 'hover:bg-hover active:bg-hover'}`}
    >
      {unread ? <span aria-label="New activity" className="size-2 shrink-0 rounded-full bg-run" /> : <StatusDot status={session.status} />}
      <span className={`min-w-0 flex-1 truncate text-[14.5px] ${unread ? 'font-semibold' : ''}`}>{session.title}</span>
      {showProject && <span className="max-w-[35%] shrink-0 truncate text-[12px] text-faint">{session.scratch ? 'Scratch' : session.project}</span>}
      <span className="w-8 shrink-0 text-right text-[12px] text-faint tabular-nums">{relativeTime(session.lastActivity)}</span>
    </button>
  );
});

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
  onNew: () => void;
  onSettings: () => void;
  connected: boolean;
  banner?: React.ReactNode;
}) {
  const prefs = usePrefs();
  const isUnread = useSeen();
  const { data: sessions, isLoading, error } = useQuery({ queryKey: ['sessions'], queryFn: api.sessions, refetchInterval: 20_000 });
  const [query, setQuery] = useState('');
  const [project, setProject] = useState<string>();
  const [viewOpen, setViewOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [unfolded, setUnfolded] = useState<Set<string>>(new Set());
  const toggle = (set: React.Dispatch<React.SetStateAction<Set<string>>>, key: string) => set((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

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
    const active = filtered.filter((s) => s.status !== 'idle');
    if (active.length > 0) out.push({ key: 'active', label: 'Active', entries: active.map(single), count: active.length });
    for (const entry of fold(filtered.filter((s) => s.status === 'idle'))) {
      const label = dayGroup(entry.session.lastActivity);
      const last = out.at(-1);
      if (last && last.label === label) last.entries.push(entry);
      else out.push({ key: label, label, entries: [entry], count: 0 });
    }
    return out;
  }, [sessions, query, project, prefs.listGroup, prefs.showTemporary, prefs.showSideChats]);

  const byProject = prefs.listGroup === 'project' && !project;
  const Row = prefs.listDensity === 'compact' ? CompactRow : DetailedRow;
  // What "All" shows, counted the way it is filtered.
  const visibleCount = (sessions ?? []).filter((s) => !s.archived && !(s.temp && !prefs.showTemporary) && !(s.sideChatOf && !prefs.showSideChats)).length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 px-4 pt-3 pb-2">
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-[20px] font-semibold tracking-tight">{machine || 'Pelican'}</h1>
              <span title={connected ? 'Connected' : 'Reconnecting'} className={`size-1.5 shrink-0 rounded-full ${connected ? 'bg-live' : 'bg-wait'}`} />
            </div>
            <div className="text-[12.5px] text-faint">Claude Code{sessions ? ` · ${visibleCount} sessions` : ''}</div>
          </div>
          <button type="button" aria-label="Settings" onClick={onSettings} className="grid size-10 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg">
            <Settings className="size-[18px]" />
          </button>
          <button type="button" aria-label="New session" onClick={onNew} className="ml-1 grid size-10 place-items-center rounded-full bg-fg text-bg">
            <Plus className="size-5" />
          </button>
        </div>
        <div className="mt-3 flex items-center gap-1">
        <label className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-xl bg-chip px-3">
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
            className="min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-faint"
          />
          {query && (
            <button type="button" aria-label="Clear search" onClick={() => setQuery('')} className="text-faint">
              <X className="size-4" />
            </button>
          )}
        </label>
        {/* How the list is grouped and what it shows: next to the list, apart from Settings. */}
        <button type="button" aria-label="List options" onClick={() => setViewOpen(true)} className="grid size-10 shrink-0 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg">
          <ListFilter className="size-[18px]" />
        </button>
        </div>
        {(projects.length > 1 || archivedCount > 0) && (
          <div className="no-scrollbar -mx-4 mt-2 flex gap-1.5 overflow-x-auto px-4">
            {[undefined, ...projects].map((p) => (
              <button
                key={p ?? '*'}
                type="button"
                onClick={() => setProject(p)}
                className={`h-8 shrink-0 rounded-full px-3 text-[13px] ${project === p ? 'bg-fg text-bg' : 'bg-chip text-muted hover:text-fg'}`}
              >
                {p && SPECIAL[p] ? SPECIAL[p] : (p ?? 'All')}
                {p === TEMP && <span className="ml-1 opacity-60">{tempCount}</span>}
                {p === ARCHIVED && <span className="ml-1 opacity-60">{archivedCount}</span>}
              </button>
            ))}
          </div>
        )}
      </header>
      {banner}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-6">
        {isLoading && <div className="flex justify-center py-16 text-faint"><Loader2 className="size-5 animate-spin" /></div>}
        {/* Out of reach, the line under the header says so (App). */}
        {error && !isUnreachable(error) && <div className="px-4 py-8 text-[13px] text-danger">{(error as Error).message}</div>}
        {groups.map((group) => {
          const folded = collapsed.has(group.key);
          return (
            <section key={group.key}>
              {byProject ? (
                <button
                  type="button"
                  onClick={() => toggle(setCollapsed, group.key)}
                  className="sticky top-0 z-10 flex w-full items-center gap-1.5 bg-bg/90 px-3 pt-3 pb-1 text-left backdrop-blur"
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
                  <Row
                    key={session.id}
                    session={session}
                    selected={session.id === selectedId}
                    unread={session.id !== selectedId && session.status !== 'running' && isUnread(session.id, session.lastActivity)}
                    showProject={!byProject}
                    onOpen={onOpen}
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
                      className="-mt-1 mb-1 ml-1.5 flex h-8 items-center gap-1 rounded-full px-1.5 text-[12.5px] text-faint hover:text-fg"
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
        {sessions && groups.length === 0 && (query || project ? (
          <div className="px-4 py-12 text-center text-[13px] text-faint">No matching sessions</div>
        ) : archivedCount > 0 ? (
          <div className="px-4 py-12 text-center text-[13px] text-faint">Every session is archived: they are under Archived.</div>
        ) : (
          <div className="mx-auto max-w-xs px-4 py-14 text-center">
            <div className="text-[15px] font-medium">No sessions yet</div>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
              Start one with <span className="font-medium text-fg">+</span>. Sessions from the terminal, Claude Desktop and your editor show up here too.
            </p>
          </div>
        ))}
      </div>
      <ListViewSheet open={viewOpen} onClose={() => setViewOpen(false)} />
    </div>
  );
}
