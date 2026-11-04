import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Download, GitFork, Loader2, Pencil, SquareTerminal, Trash2 } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';

import type { McpServer, RunState, SessionSummary } from '../../shared/protocol';
import { api } from '../lib/api';
import { clockTime, dayLabel, duration, isSessionId, resumeCommand, shortPath } from '../lib/format';
import { setPrefs, usePrefs, type ViewMode } from '../lib/prefs';
import { Segmented, Sheet, SheetHeading, SheetOption } from './Sheet';

const VIEW_HINT: Record<ViewMode, string> = {
  summary: 'Your prompts and Claude’s replies; the steps in between are counted, not shown.',
  normal: 'Replies in full, long runs of steps folded.',
  verbose: 'Every step open, with its command, diff or output, and Claude’s thinking.',
};

const MCP_DOT: Record<McpServer['status'], string> = { connected: 'bg-live', pending: 'bg-wait', 'needs-auth': 'bg-wait', failed: 'bg-danger', disabled: 'bg-line' };
const MCP_LABEL: Record<McpServer['status'], string> = { connected: 'Connected', pending: 'Connecting', 'needs-auth': 'Needs sign-in', failed: 'Failed', disabled: 'Off' };

/** The session's MCP servers and whether they work; while Claude runs here, each can be turned off or reconnected. */
function McpServers({ sessionId, open }: { sessionId: string; open: boolean }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['mcp', sessionId], queryFn: () => api.mcp(sessionId), enabled: open, staleTime: 15_000 });
  // Servers can be turned on and off only in a Claude process running here.
  const live = Boolean(data?.live);
  const [busy, setBusy] = useState<string>();
  const change = (name: string, patch: { enabled?: boolean; reconnect?: boolean }) => {
    setBusy(name);
    api.setMcp(sessionId, name, patch)
      .then((result) => queryClient.setQueryData(['mcp', sessionId], { servers: result.servers, live: true }))
      .catch(() => undefined)
      .finally(() => setBusy(undefined));
  };
  const [showAll, setShowAll] = useState(false);
  if (!isLoading && (data?.servers.length ?? 0) === 0) return null;
  const servers = data?.servers ?? [];
  const order: McpServer['status'][] = ['failed', 'connected', 'pending', 'disabled', 'needs-auth'];
  const sorted = [...servers].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.name.localeCompare(b.name));
  const signIn = sorted.filter((server) => server.status === 'needs-auth');
  const shown = showAll ? sorted : sorted.filter((server) => server.status !== 'needs-auth');
  const connected = servers.filter((server) => server.status === 'connected').length;
  return (
    <>
      <SheetHeading>MCP servers{servers.length > 0 ? ` · ${connected} of ${servers.length} connected` : ''}</SheetHeading>
      {isLoading && <div className="flex px-3 py-2 text-faint"><Loader2 className="size-4 animate-spin" /></div>}
      {shown.map((server) => (
        <div key={server.name} className="flex items-center gap-3 rounded-xl px-3 py-2">
          <span className={`size-2 shrink-0 rounded-full ${MCP_DOT[server.status]}`} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14.5px]">{server.name}</div>
            <div className="truncate text-[12px] text-muted">
              {MCP_LABEL[server.status]}{server.tools > 0 ? ` · ${server.tools} tools` : ''}{server.scope ? ` · ${server.scope}` : ''}{server.error ? ` · ${server.error}` : ''}
            </div>
          </div>
          {busy === server.name ? <Loader2 className="size-4 animate-spin text-faint" /> : live && (
            server.status === 'failed' || server.status === 'needs-auth' ? (
              <button type="button" className="h-8 shrink-0 rounded-full px-3 text-[13px] text-muted hover:bg-hover hover:text-fg" onClick={() => change(server.name, { reconnect: true })}>Reconnect</button>
            ) : (
              <button type="button" className="h-8 shrink-0 rounded-full px-3 text-[13px] text-muted hover:bg-hover hover:text-fg" onClick={() => change(server.name, { enabled: server.status === 'disabled' })}>
                {server.status === 'disabled' ? 'Turn on' : 'Turn off'}
              </button>
            )
          )}
        </div>
      ))}
      {!showAll && signIn.length > 0 && (
        <button type="button" onClick={() => setShowAll(true)} className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-[13px] text-muted hover:bg-hover">
          <span className="size-2 shrink-0 rounded-full bg-wait" />
          {signIn.length} more need signing in, in Claude Code or on claude.ai
        </button>
      )}
      {data && !data.live && data.servers.length > 0 && <p className="px-3 pt-0.5 text-[12px] leading-snug text-faint">As a new Claude here would see them. Send a message to turn servers on or off for this session.</p>}
    </>
  );
}

function Detail({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex gap-3 px-3 py-1.5 text-[13px]">
      <div className="w-20 shrink-0 text-faint">{label}</div>
      <div className={`min-w-0 flex-1 break-words text-muted ${mono ? 'font-mono text-[12px] leading-5' : ''}`}>{children}</div>
    </div>
  );
}

const when = (ms: number) => `${dayLabel(ms)}, ${clockTime(ms)}`;

/** Everything you can do with one session, and what is known about it. */
export function SessionMenu({
  open,
  onClose,
  sessionId,
  session,
  cwd,
  home,
  run,
  onRenamed,
  onForked,
  onDeleted,
}: {
  open: boolean;
  onClose: () => void;
  sessionId: string;
  session?: SessionSummary;
  cwd?: string;
  home?: string;
  run?: RunState;
  onRenamed: () => void;
  onForked: (id: string) => void;
  onDeleted: () => void;
}) {
  const prefs = usePrefs();
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const running = Boolean(run?.busy);

  useEffect(() => {
    if (open) return;
    setRenaming(false);
    setConfirmDelete(false);
    setError(undefined);
    setCopied(undefined);
  }, [open]);

  const act = (work: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    work()
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };

  const copy = (what: string, text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(what);
      setTimeout(() => setCopied((c) => (c === what ? undefined : c)), 1500);
    });
  };

  const rename = (e: FormEvent) => {
    e.preventDefault();
    const next = title.trim();
    if (!next || next === session?.title) {
      setRenaming(false);
      return;
    }
    act(async () => {
      await api.rename(sessionId, next);
      setRenaming(false);
      onRenamed();
    });
  };

  const exportMarkdown = () => {
    const link = document.createElement('a');
    link.href = api.exportUrl(sessionId);
    link.download = '';
    document.body.append(link);
    link.click();
    link.remove();
  };

  return (
    <Sheet open={open} onClose={onClose} title="Session" done>
      <SheetHeading>View</SheetHeading>
      <Segmented<ViewMode>
        value={prefs.view}
        onChange={(view) => setPrefs({ view })}
        options={[{ value: 'summary', label: 'Summary' }, { value: 'normal', label: 'Normal' }, { value: 'verbose', label: 'Verbose' }]}
      />
      <p className="px-3 pt-1 pb-1 text-[12px] leading-snug text-faint">{VIEW_HINT[prefs.view]}</p>

      <SheetHeading>Actions</SheetHeading>
      {error && <div className="mx-3 mb-1 rounded-lg bg-chip px-3 py-2 text-[13px] text-danger">{error}</div>}
      {renaming ? (
        <form onSubmit={rename} className="flex items-center gap-2 px-3 py-1.5">
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            aria-label="Session title"
            className="h-10 min-w-0 flex-1 rounded-xl border border-line bg-bg px-3 text-[16px] outline-none focus:border-fg"
          />
          <button type="submit" disabled={busy} className="h-10 shrink-0 rounded-full bg-fg px-4 text-[14px] font-medium text-bg disabled:opacity-40">Save</button>
        </form>
      ) : (
        <SheetOption
          icon={<Pencil className="size-4" />}
          label="Rename"
          onSelect={() => {
            setTitle(session?.title ?? '');
            setRenaming(true);
          }}
        />
      )}
      <SheetOption
        icon={<GitFork className="size-4" />}
        label="Branch"
        description="A copy to carry on separately; this one stays as it is"
        onSelect={() => act(async () => {
          const id = await api.fork(sessionId);
          if (id) onForked(id);
        })}
      />
      {isSessionId(sessionId) && (
        <SheetOption
          icon={copied === 'resume' ? <Check className="size-4" /> : <SquareTerminal className="size-4" />}
          label={copied === 'resume' ? 'Copied' : 'Continue in a terminal'}
          description={<span className="font-mono text-[11.5px]">{resumeCommand(sessionId, cwd ? shortPath(cwd, home) : undefined)}</span>}
          onSelect={() => copy('resume', resumeCommand(sessionId, cwd))}
        />
      )}
      <SheetOption icon={<Download className="size-4" />} label="Export as Markdown" description="Prompts and replies, with each step on one line" onSelect={exportMarkdown} />
      {confirmDelete ? (
        <div className="mx-1 my-1 rounded-xl border border-line px-3 py-2.5">
          <div className="text-[14px]">Delete this session?</div>
          <div className="mt-0.5 text-[12.5px] leading-snug text-muted">Its transcript is removed from this machine, for every Claude Code app. This cannot be undone.</div>
          <div className="mt-2.5 flex gap-2">
            <button
              type="button"
              disabled={busy}
              className="h-9 rounded-full bg-danger px-4 text-[14px] font-medium text-white disabled:opacity-40"
              onClick={() => act(async () => {
                await api.remove(sessionId);
                onDeleted();
              })}
            >
              Delete
            </button>
            <button type="button" className="h-9 rounded-full bg-chip px-4 text-[14px]" onClick={() => setConfirmDelete(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <SheetOption
          icon={<Trash2 className="size-4" />}
          label="Delete"
          danger
          {...(running ? { description: 'Stop Claude first' } : {})}
          onSelect={() => !running && setConfirmDelete(true)}
        />
      )}

      <McpServers sessionId={sessionId} open={open} />

      <SheetHeading>Details</SheetHeading>
      {cwd && <Detail label="Folder" mono>{shortPath(cwd, home)}</Detail>}
      {session?.gitBranch && <Detail label="Branch" mono>{session.gitBranch}</Detail>}
      {session?.createdAt && <Detail label="Started">{when(session.createdAt)}</Detail>}
      {session?.lastActivity ? <Detail label="Last active">{when(session.lastActivity)}</Detail> : null}
      {run?.context && (
        <Detail label="Context">
          {run.context.percent}% used · {Math.round(run.context.tokens / 1000)}k of {Math.round(run.context.max / 1000)}k tokens
        </Detail>
      )}
      {run?.lastTurn && (
        <Detail label="Last turn">
          {duration(run.lastTurn.durationMs)}
          {run.lastTurn.costUsd ? ` · $${run.lastTurn.costUsd.toFixed(2)}` : ''}
        </Detail>
      )}
      <Detail label="ID" mono>
        <button type="button" className="inline-flex items-center gap-1.5 text-left hover:text-fg" onClick={() => copy('id', sessionId)}>
          {sessionId}
          {copied === 'id' ? <Check className="size-3 shrink-0" /> : <Copy className="size-3 shrink-0" />}
        </button>
      </Detail>
    </Sheet>
  );
}
