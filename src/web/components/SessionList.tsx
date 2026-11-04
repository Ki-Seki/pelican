import { useQuery } from '@tanstack/react-query';
import { Bell, BellOff, GitBranch, Loader2, Plus, Search, X } from 'lucide-react';
import { memo, useMemo, useState } from 'react';

import type { SessionStatus, SessionSummary } from '../../shared/protocol';
import { api } from '../lib/api';
import { dayGroup, relativeTime } from '../lib/format';

export function StatusBadge({ status }: { status: SessionStatus }) {
  if (status === 'idle') return null;
  const label = status === 'running' ? 'Working' : status === 'waiting' ? 'Needs you' : 'Live';
  const color = status === 'running' ? 'bg-run' : status === 'waiting' ? 'bg-wait' : 'bg-live';
  const text = status === 'running' ? 'text-run' : status === 'waiting' ? 'text-wait' : 'text-live';
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 text-[11.5px] font-medium ${text}`}>
      <span className="relative flex size-1.5">
        {status !== 'waiting' && <span className={`absolute inline-flex size-full animate-ping rounded-full opacity-60 ${color}`} />}
        <span className={`relative inline-flex size-1.5 rounded-full ${color}`} />
      </span>
      {label}
    </span>
  );
}

const Row = memo(function Row({ session, selected, onOpen }: { session: SessionSummary; selected: boolean; onOpen: (id: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(session.id)}
      className={`block w-full rounded-xl px-3 py-2.5 text-left transition-colors ${selected ? 'bg-chip' : 'hover:bg-hover active:bg-hover'}`}
    >
      <div className="flex items-start gap-2">
        <div className="line-clamp-2 min-w-0 flex-1 text-[15px] leading-snug">{session.title}</div>
        <span className="shrink-0 pt-0.5 text-[12px] text-faint tabular-nums">{relativeTime(session.lastActivity)}</span>
      </div>
      <div className="mt-1 flex items-center gap-2 text-[12.5px] text-muted">
        <StatusBadge status={session.status} />
        <span className="min-w-0 truncate">{session.project || '—'}</span>
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

export function SessionList({
  machine,
  selectedId,
  onOpen,
  onNew,
  connected,
  notifications,
  onToggleNotifications,
}: {
  machine: string;
  selectedId?: string;
  onOpen: (id: string) => void;
  onNew: () => void;
  connected: boolean;
  notifications: 'on' | 'off' | 'unsupported' | 'denied';
  onToggleNotifications: () => void;
}) {
  const { data: sessions, isLoading, error } = useQuery({ queryKey: ['sessions'], queryFn: api.sessions, refetchInterval: 20_000 });
  const [query, setQuery] = useState('');
  const [project, setProject] = useState<string>();

  const projects = useMemo(() => {
    const seen = new Map<string, number>();
    for (const s of sessions ?? []) if (s.project && !seen.has(s.project)) seen.set(s.project, s.lastActivity);
    return [...seen.keys()].slice(0, 14);
  }, [sessions]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = (sessions ?? []).filter((s) => {
      if (project && s.project !== project) return false;
      if (!q) return true;
      return s.title.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q) || s.id.startsWith(q);
    });
    const out: Array<{ label: string; sessions: SessionSummary[] }> = [];
    const active = filtered.filter((s) => s.status !== 'idle');
    if (active.length > 0) out.push({ label: 'Active', sessions: active });
    for (const s of filtered) {
      if (s.status !== 'idle') continue;
      const label = dayGroup(s.lastActivity);
      const last = out.at(-1);
      if (last && last.label === label) last.sessions.push(s);
      else out.push({ label, sessions: [s] });
    }
    return out;
  }, [sessions, query, project]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 px-4 pt-3 pb-2">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-[20px] font-semibold tracking-tight">{machine || 'Pelican'}</h1>
              <span title={connected ? 'Connected' : 'Reconnecting'} className={`size-1.5 shrink-0 rounded-full ${connected ? 'bg-live' : 'bg-wait'}`} />
            </div>
            <div className="text-[12.5px] text-faint">
              Claude Code{sessions ? ` · ${sessions.length} sessions` : ''}
            </div>
          </div>
          {notifications !== 'unsupported' && (
            <button
              type="button"
              aria-label={notifications === 'on' ? 'Turn notifications off' : 'Turn notifications on'}
              title={notifications === 'denied' ? 'Notifications are blocked in the browser settings' : undefined}
              onClick={onToggleNotifications}
              className={`grid size-10 place-items-center rounded-full hover:bg-hover ${notifications === 'on' ? 'text-fg' : 'text-faint'}`}
            >
              {notifications === 'on' ? <Bell className="size-[18px]" /> : <BellOff className="size-[18px]" />}
            </button>
          )}
          <button type="button" aria-label="New session" onClick={onNew} className="grid size-10 place-items-center rounded-full bg-fg text-bg">
            <Plus className="size-5" />
          </button>
        </div>
        <label className="mt-3 flex h-10 items-center gap-2 rounded-xl bg-chip px-3">
          <Search className="size-4 shrink-0 text-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sessions"
            className="min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-faint"
          />
          {query && (
            <button type="button" aria-label="Clear search" onClick={() => setQuery('')} className="text-faint">
              <X className="size-4" />
            </button>
          )}
        </label>
        {projects.length > 1 && (
          <div className="no-scrollbar -mx-4 mt-2 flex gap-1.5 overflow-x-auto px-4">
            {[undefined, ...projects].map((p) => (
              <button
                key={p ?? '*'}
                type="button"
                onClick={() => setProject(p)}
                className={`h-8 shrink-0 rounded-full px-3 text-[13px] ${project === p ? 'bg-fg text-bg' : 'bg-chip text-muted hover:text-fg'}`}
              >
                {p ?? 'All'}
              </button>
            ))}
          </div>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-6">
        {isLoading && <div className="flex justify-center py-16 text-faint"><Loader2 className="size-5 animate-spin" /></div>}
        {error && <div className="px-4 py-8 text-[13px] text-danger">{(error as Error).message}</div>}
        {groups.map((group) => (
          <section key={group.label}>
            <h2 className="sticky top-0 z-10 bg-bg/90 px-3 pt-3 pb-1 text-[11.5px] font-medium tracking-wide text-faint uppercase backdrop-blur">
              {group.label}
            </h2>
            {group.sessions.map((s) => <Row key={s.id} session={s} selected={s.id === selectedId} onOpen={onOpen} />)}
          </section>
        ))}
        {sessions && groups.length === 0 && (
          <div className="px-4 py-12 text-center text-[13px] text-faint">{query || project ? 'No matching sessions' : 'No sessions yet'}</div>
        )}
      </div>
    </div>
  );
}
