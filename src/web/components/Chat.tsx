import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronLeft, ChevronUp, CornerDownRight, FolderGit2, GitBranch, Info, ListChecks, Loader2, MoreHorizontal, SquareTerminal, TriangleAlert, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { Attachment, BackgroundTask, Block, ChatMessage, RewindResult, RunSettings, RunState, SendMode, SessionSummary, UsageLimit } from '../../shared/protocol';
import { api, apiUrl } from '../lib/api';
import { newId } from '../lib/ids';
import { baseName, shortPath, untilTime } from '../lib/format';
import { loadDefaults, markSeen, markTipSeen, saveSessionChoice, sessionChoice, tipSeen, usePrefs, viewOf } from '../lib/prefs';
import { fromRecorded } from '../lib/settings';
import { socket } from '../lib/socket';
import type { Start } from '../lib/start';
import {
  addLocalMessage,
  adoptView,
  clearDraft,
  getDraft,
  getView,
  loadLatest,
  removeLocalMessage,
  setRun,
  truncateFrom,
  useSessionView,
} from '../lib/store';
import { currentTasks, type Todo } from '../lib/tools';
import { Composer } from './Composer';
import { MessageList } from './MessageList';
import { StartIn } from './NewSession';
import { PermissionCard } from './PermissionCard';
import { StatusBadge } from './SessionList';
import { SessionMenu } from './SessionMenu';
import { Sheet } from './Sheet';
import { TodoList } from './ToolCall';
import { PANE_KEYS, useWorkspacePane, Workspace } from './Workspace';

/** What a branch starts with: the settings it came from, but asking first instead of Bypass. */
const withoutBypass = (settings: RunSettings): RunSettings =>
  (settings.permissionMode === 'bypassPermissions' ? { ...settings, permissionMode: 'default' } : settings);

function localMessage(uuid: string, text: string, attachments: Attachment[]): ChatMessage {
  const blocks: Block[] = [];
  for (const a of attachments) {
    if (a.mime.startsWith('image/')) blocks.push({ type: 'image', source: { type: 'url', url: apiUrl(`uploads/${a.id}`) } });
  }
  const files = attachments.filter((a) => !a.mime.startsWith('image/')).map((a) => `📎 ${a.name}`);
  const body = [text, ...files].filter(Boolean).join('\n');
  if (body) blocks.push({ type: 'text', text: body });
  return { uuid, role: 'user', blocks, timestamp: Date.now(), pending: true };
}

/** How full the context window is: a ring that warns as it fills. */
function ContextMeter({ context, onClick }: { context: NonNullable<RunState['context']>; onClick: () => void }) {
  const percent = Math.max(0, Math.min(100, context.percent));
  const r = 7;
  const circumference = 2 * Math.PI * r;
  const tone = percent >= 90 ? 'text-danger' : percent >= 75 ? 'text-wait' : 'text-muted';
  return (
    <button
      type="button"
      onClick={onClick}
      title={`Context ${percent}% full: ${Math.round(context.tokens / 1000)}k of ${Math.round(context.max / 1000)}k tokens`}
      className={`flex h-10 shrink-0 items-center gap-1 rounded-full px-2 text-[11.5px] tabular-nums hover:bg-hover ${tone}`}
    >
      <svg viewBox="0 0 18 18" className="size-[18px] -rotate-90">
        <circle cx="9" cy="9" r={r} fill="none" stroke="var(--line)" strokeWidth="2.5" />
        <circle cx="9" cy="9" r={r} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeDasharray={`${(percent / 100) * circumference} ${circumference}`} />
      </svg>
      <span>{percent}%</span>
    </button>
  );
}

const LIMIT_NAME: Record<string, string> = {
  five_hour: '5-hour', seven_day: 'weekly', seven_day_opus: 'weekly Opus', seven_day_sonnet: 'weekly Sonnet', overage: 'extra usage',
};

/** A usage limit worth knowing about now: reached, or close. */
export function limitNotice(limits: UsageLimit[] | undefined): string | undefined {
  const limit = limits?.find((l) => l.status === 'rejected') ?? limits?.find((l) => l.status === 'allowed_warning');
  if (!limit) return undefined;
  const name = LIMIT_NAME[limit.type] ?? 'usage';
  const resets = limit.resetsAt ? ` It resets ${/^\d/.test(untilTime(limit.resetsAt)) ? 'at ' : ''}${untilTime(limit.resetsAt)}.` : '';
  if (limit.status === 'rejected') return `You have reached your ${name} limit.${resets}`;
  const used = typeof limit.utilization === 'number' ? `${Math.round(limit.utilization * 100)}% of ` : 'most of ';
  return `You have used ${used}your ${name} limit.${resets}`;
}

/** Rewind code: what putting files back before a prompt would change, then doing it. */
function RewindSheet({ sessionId, uuid, cwd, onClose, onDone }: { sessionId: string; uuid?: string; cwd?: string; onClose: () => void; onDone: (result: RewindResult) => void }) {
  const preview = useQuery({
    queryKey: ['rewind', sessionId, uuid],
    queryFn: () => api.rewind(sessionId, uuid!, true),
    enabled: Boolean(uuid),
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();
  const files = preview.data?.files ?? [];
  const rel = (file: string) => (cwd && file.startsWith(`${cwd}/`) ? file.slice(cwd.length + 1) : file);
  return (
    <Sheet open={Boolean(uuid)} onClose={onClose} title="Rewind code">
      <div className="px-3 pt-1 pb-3 text-[14px] leading-relaxed">
        {preview.isLoading && <div className="flex items-center gap-2 text-muted"><Loader2 className="size-4 animate-spin" /> Checking what changed since this prompt</div>}
        {preview.error && <div className="text-danger">{(preview.error as Error).message}</div>}
        {preview.data && !preview.data.canRewind && (
          <div className="text-muted">{preview.data.error ?? 'Nothing to put back: Claude has not changed any files since this prompt.'}</div>
        )}
        {preview.data?.canRewind && files.length === 0 && <div className="text-muted">No files changed since this prompt.</div>}
        {preview.data?.canRewind && files.length > 0 && (
          <>
            <p>Put {files.length === 1 ? 'this file' : `these ${files.length} files`} back the way they were before this prompt. The conversation stays as it is.</p>
            <ul className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-line px-3 py-1.5 font-mono text-[12px] text-muted">
              {files.map((file) => <li key={file} className="truncate py-0.5">{rel(file)}</li>)}
            </ul>
            {(preview.data.insertions || preview.data.deletions) ? (
              <div className="mt-1.5 font-mono text-[12px]"><span className="text-add">+{preview.data.insertions ?? 0}</span> <span className="text-del">−{preview.data.deletions ?? 0}</span> <span className="font-sans text-faint">lines change back</span></div>
            ) : null}
            {error && <div className="mt-2 text-[13px] text-danger">{error}</div>}
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                disabled={working}
                className="h-9 rounded-full bg-fg px-4 text-[14px] font-medium text-bg disabled:opacity-40"
                onClick={() => {
                  setWorking(true);
                  setError(undefined);
                  api.rewind(sessionId, uuid!, false)
                    .then((result) => (result.canRewind ? onDone(result) : setError(result.error ?? 'Could not put the files back')))
                    .catch((err: Error) => setError(err.message))
                    .finally(() => setWorking(false));
                }}
              >
                {working ? <Loader2 className="size-4 animate-spin" /> : 'Put files back'}
              </button>
              <button type="button" className="h-9 rounded-full bg-chip px-4 text-[14px]" onClick={onClose}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}

const Pulse = () => (
  <span className="relative flex size-1.5 shrink-0"><span className="absolute inline-flex size-full animate-ping rounded-full bg-run opacity-60" /><span className="relative inline-flex size-1.5 rounded-full bg-run" /></span>
);

/**
 * Background tasks (shells and agents Claude left running). One shows as a row with Stop; more
 * fold into a single row, so they never crowd the conversation, and open into a short list.
 */
function BackgroundTasks({ sessionId, tasks }: { sessionId: string; tasks: BackgroundTask[] }) {
  const [open, setOpen] = useState(false);
  const stop = (id: string) => void api.stopTask(sessionId, id);
  const row = (task: BackgroundTask) => (
    <div key={task.id} className="flex items-center gap-2 py-1 pr-1 pl-3 text-[12.5px] text-muted">
      <Pulse />
      <span className="min-w-0 flex-1 truncate">{task.description || 'Background task'}</span>
      <button type="button" onClick={() => stop(task.id)} className="h-7 shrink-0 rounded-full px-2.5 text-[12px] hover:bg-hover hover:text-fg">Stop</button>
    </div>
  );
  if (tasks.length === 1) return <div className="mx-auto mb-2 max-w-3xl rounded-full border border-line bg-panel">{row(tasks[0]!)}</div>;
  const latest = tasks.at(-1)!;
  return (
    <div className="mx-auto mb-2 max-w-3xl">
      {open ? (
        <div className="rounded-2xl border border-line bg-panel py-1">
          <button type="button" onClick={() => setOpen(false)} className="flex h-8 w-full items-center gap-2 px-3 text-left text-[12.5px] text-muted hover:text-fg">
            <span className="min-w-0 flex-1 truncate">{tasks.length} background tasks</span>
            <ChevronDown className="size-4 shrink-0" />
          </button>
          <div className="max-h-[30vh] overflow-y-auto overscroll-contain">{tasks.map(row)}</div>
        </div>
      ) : (
        <button type="button" onClick={() => setOpen(true)} className="flex h-8 w-full items-center gap-2 rounded-full border border-line bg-panel px-3 text-left text-[12.5px] text-muted hover:text-fg">
          <Pulse />
          <span className="shrink-0 tabular-nums">{tasks.length} tasks</span>
          <span className="min-w-0 flex-1 truncate text-faint">{latest.description || 'Background task'}</span>
          <ChevronUp className="size-4 shrink-0" />
        </button>
      )}
    </div>
  );
}

/** Claude's task list, pinned above the composer while there is work left. */
function TasksBar({ tasks }: { tasks: Todo[] }) {
  const [open, setOpen] = useState(false);
  const done = tasks.filter((t) => t.status === 'completed').length;
  const current = tasks.find((t) => t.status === 'in_progress');
  return (
    <div className="mx-auto mb-2 max-w-3xl">
      {open ? (
        <div className="relative max-h-[40vh] overflow-y-auto overscroll-contain rounded-xl">
          <TodoList input={{ todos: tasks }} />
          <button type="button" aria-label="Hide tasks" onClick={() => setOpen(false)} className="absolute top-1.5 right-1.5 grid size-7 place-items-center rounded-full text-faint hover:bg-hover hover:text-fg">
            <ChevronDown className="size-4" />
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setOpen(true)} className="flex h-8 w-full items-center gap-2 rounded-full border border-line bg-panel px-3 text-left text-[12.5px] text-muted hover:text-fg">
          <ListChecks className="size-3.5 shrink-0" />
          <span className="shrink-0 tabular-nums">{done}/{tasks.length}</span>
          <span className="min-w-0 flex-1 truncate">{current ? current.activeForm || current.content : done === tasks.length ? 'All done' : 'Tasks'}</span>
        </button>
      )}
    </div>
  );
}

function Notice({ tone = 'info', children, onDismiss }: { tone?: 'info' | 'error' | 'live'; children: React.ReactNode; onDismiss?: () => void }) {
  return (
    <div className={`mx-auto mb-2 flex max-w-3xl items-start gap-2 rounded-xl px-3 py-2 text-[12.5px] leading-snug ${tone === 'error' ? 'border border-line bg-panel text-danger' : 'text-muted'}`}>
      {tone === 'error' ? <TriangleAlert className="mt-px size-4 shrink-0" /> : tone === 'live' ? <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-live" /> : <Info className="mt-px size-3.5 shrink-0" />}
      <div className="min-w-0 flex-1">{children}</div>
      {onDismiss && (
        <button type="button" aria-label="Dismiss" onClick={onDismiss} className="-my-0.5 grid size-6 shrink-0 place-items-center rounded-full text-faint hover:text-fg">
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}

const DEMO_NOTE = 'This is the demo, so nothing runs. Start Pelican on your own computer to work with Claude.';

export function Chat({
  sessionId,
  newCwd,
  scratch = false,
  home,
  machine,
  demo,
  wide,
  onBack,
  onOpen,
  onStartIn,
}: {
  sessionId?: string;
  newCwd?: string;
  /** A new session in a fresh scratch folder, made when the first message is sent. */
  scratch?: boolean;
  home?: string;
  machine?: string;
  demo?: boolean;
  wide: boolean;
  onBack: () => void;
  onOpen: (id: string, replace?: boolean) => void;
  /** Opens a new, empty session somewhere else, in place of this one. */
  onStartIn: (start: Start) => void;
}) {
  const viewId = sessionId ?? `new:${scratch ? 'scratch' : newCwd}`;
  const view = useSessionView(viewId);
  const prefs = usePrefs();
  const queryClient = useQueryClient();
  const busy = Boolean(view.run?.busy);
  const { data: modelList } = useQuery({ queryKey: ['models'], queryFn: api.models, staleTime: 10 * 60_000 });
  const { data: detail } = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => api.session(sessionId!),
    enabled: Boolean(sessionId),
    // The task list comes from here when the page holds only the end of a long conversation.
    refetchInterval: busy && view.offset > 0 ? 5_000 : 30_000,
  });
  const listed = queryClient.getQueryData<SessionSummary[]>(['sessions'])?.find((s) => s.id === sessionId);
  const session = detail?.session ?? listed;
  const [settings, setSettings] = useState<RunSettings>(() => {
    const base = loadDefaults();
    if (!sessionId) return base;
    const live = getView(sessionId).run?.settings;
    if (live) return { ...base, ...live };
    const choice = sessionChoice(sessionId);
    return choice ? { ...base, ...choice.settings } : base;
  });
  const [initialDraft] = useState(() => getDraft(viewId));
  const [draft, setDraftText] = useState<{ text: string; key: number; append?: boolean } | undefined>(() => (initialDraft ? { text: initialDraft.text, key: 1 } : undefined));
  const [note, setNote] = useState(initialDraft?.note);
  const [sendError, setSendError] = useState<string>();
  const [menuOpen, setMenuOpen] = useState(false);
  const [rewinding, setRewinding] = useState<string>();
  const [openElsewhereSeen, setOpenElsewhereSeen] = useState(() => tipSeen('open-elsewhere'));
  const [running, setRunning] = useState<string>();
  const { data: limits } = useQuery({ queryKey: ['usage'], queryFn: api.usage, refetchInterval: 60_000, enabled: !demo });

  useEffect(() => clearDraft(viewId), [viewId]);

  useEffect(() => {
    if (!sessionId) return;
    socket.subscribe(sessionId);
    void loadLatest(sessionId);
    return () => socket.unsubscribe(sessionId);
  }, [sessionId]);

  useEffect(() => {
    if (sessionId && detail?.run && !getView(sessionId).run) setRun(sessionId, detail.run);
  }, [sessionId, detail?.run]);

  // Whatever is on screen counts as read.
  useEffect(() => {
    if (sessionId) markSeen(sessionId, Math.max(Date.now(), session?.lastActivity ?? 0));
  }, [sessionId, session?.lastActivity, view.messages.length]);

  // The model, effort, speed, Ultracode and permission mode belong to the session. The composer
  // shows, most specific first: what Claude runs with for it here right now (kept up to date,
  // also when plan mode ends or another tab changes them); else a choice made here that no turn has
  // used yet; else what its last turn ran with (its transcript), the model named as it was picked
  // here. New sessions start from the defaults in Settings, which only Settings changes.
  const chosen = useRef(false);
  const runSettings = view.run?.settings;
  const runKey = JSON.stringify(runSettings ?? null);
  useEffect(() => {
    if (runSettings) setSettings((current) => ({ ...current, ...runSettings }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runKey]);
  const recorded = useMemo(
    () => fromRecorded(detail?.settings, modelList?.models, sessionId ? sessionChoice(sessionId)?.settings.model : undefined),
    [detail?.settings, modelList?.models, sessionId],
  );
  const recordedKey = JSON.stringify(recorded ?? null);
  useEffect(() => {
    if (runSettings || chosen.current || !sessionId) return;
    const choice = session ? sessionChoice(sessionId) : undefined;
    if (choice && session && choice.at > session.lastActivity) setSettings((current) => ({ ...current, ...choice.settings }));
    else if (recorded) setSettings({ ...loadDefaults(), ...recorded });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, recordedKey, session?.lastActivity, Boolean(runSettings)]);

  const changeSettings = (next: RunSettings) => {
    chosen.current = true;
    setSettings(next);
    // It stays with this session when you leave and come back; a new session's goes with it once sent.
    if (sessionId) saveSessionChoice(sessionId, next);
    // A Claude running for this session switches now (from its next step), not at the next message.
    if (sessionId && view.run) {
      void api.applySettings(sessionId, next).catch(() => undefined);
    }
  };

  const send = async (text: string, attachments: Attachment[], mode: SendMode) => {
    setSendError(undefined);
    setNote(undefined);
    if (demo) {
      setSendError(DEMO_NOTE);
      setDraftText({ text, key: Date.now() });
      return;
    }
    const uuid = newId();
    const queued = busy && mode === 'queue';
    addLocalMessage(viewId, { ...localMessage(uuid, text, attachments), ...(queued ? { queued: true } : {}) });
    const body = { text, attachments: attachments.map((a) => a.id), settings, uuid, ...(busy ? { mode } : {}) };
    try {
      if (sessionId) {
        await api.send(sessionId, body);
        saveSessionChoice(sessionId, settings);
      } else if (newCwd || scratch) {
        const { sessionId: created } = await api.create({ ...body, ...(scratch ? { scratch: true } : { cwd: newCwd }) });
        saveSessionChoice(created, settings);
        adoptView(viewId, created);
        void queryClient.invalidateQueries({ queryKey: ['sessions'] });
        onOpen(created, true);
      }
    } catch (error) {
      // Nothing reached Claude: take the message back and give the text back to edit.
      removeLocalMessage(viewId, uuid);
      setSendError((error as Error).message);
      setDraftText({ text, key: Date.now() });
    }
  };

  const firstPrompt = view.messages.find((m) => m.role === 'user' && m.blocks.some((b) => b.type === 'text'));
  const firstText = firstPrompt?.blocks.find((b) => b.type === 'text');
  const title = session?.title ?? (firstText?.type === 'text' ? firstText.text.slice(0, 80) : scratch ? 'New scratch session' : newCwd ? 'New session' : '');
  const cwd = session?.cwd || view.run?.cwd || newCwd;
  const workspace = useWorkspacePane(Boolean(cwd));
  const permissions = view.run?.permissions ?? [];
  const status = view.run ? (permissions.length > 0 ? 'waiting' : busy ? 'running' : session?.status === 'live' ? 'live' : 'idle') : session?.status ?? 'idle';

  // A `!` command: run in the session's folder, shown in the conversation, read by Claude with the next message.
  const shell = async (command: string) => {
    if (!sessionId) return;
    setSendError(undefined);
    if (demo) {
      setSendError(DEMO_NOTE);
      setDraftText({ text: `!${command}`, key: Date.now() });
      return;
    }
    setRunning(command);
    try {
      await api.shell(sessionId, command);
    } catch (error) {
      setSendError((error as Error).message);
      setDraftText({ text: `!${command}`, key: Date.now() });
    } finally {
      setRunning(undefined);
    }
  };

  // Edit and send again, in one request: the last prompt is replaced in this session, as rewinding
  // does in Claude Code; an earlier one gets a branch made just before it (the first prompt: a new
  // session in the same folder), and this session stays as it was. A failed send leaves nothing
  // behind, and a retry with the same `key` gets the same result.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const edit = async (uuid: string, text: string, key: string, keepImages: number[]): Promise<boolean> => {
    if (!sessionId) return false;
    setSendError(undefined);
    if (demo) {
      setSendError(DEMO_NOTE);
      return false;
    }
    if (busy) {
      setSendError('Stop Claude before editing an earlier prompt.');
      return false;
    }
    try {
      // The server decides: the last prompt is replaced here; an earlier one branches, and a
      // branch never starts in Bypass.
      const result = await api.edit(sessionId, { before: uuid, text, settings, uuid: key, keepImages });
      saveSessionChoice(result.sessionId, result.inPlace ? settings : withoutBypass(settings));
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      if (result.inPlace) {
        truncateFrom(viewId, uuid);
        addLocalMessage(viewId, localMessage(key, text, []));
      } else if (alive.current) {
        onOpen(result.sessionId);
      }
      return true;
    } catch (error) {
      if (alive.current) setSendError((error as Error).message);
      return false;
    }
  };

  // Files changed in the session's folder, for the badge on the Changes button; refreshed when a turn ends.
  const { data: git } = useQuery({ queryKey: ['git', cwd], queryFn: () => api.git(cwd!), enabled: Boolean(cwd), refetchInterval: 30_000 });
  const changes = git?.repo ? git.files.length : 0;
  useEffect(() => {
    if (!busy && cwd) void queryClient.invalidateQueries({ queryKey: ['git', cwd] });
  }, [busy, cwd, queryClient]);

  const tasks = useMemo(
    () => (sessionId && view.offset > 0 ? detail?.tasks ?? [] : currentTasks(view.messages)),
    [sessionId, view.offset, view.messages, detail?.tasks],
  );
  const showTasks = tasks.length > 0 && (busy || tasks.some((t) => t.status !== 'completed'));

  useEffect(() => {
    document.title = title ? `${title} · Pelican` : 'Pelican';
  }, [title]);

  const subtitle = useMemo(() => (cwd ? shortPath(cwd, home) : scratch ? 'A new folder in ~/scratch' : ''), [cwd, home, scratch]);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['session', sessionId] });
    void queryClient.invalidateQueries({ queryKey: ['sessions'] });
  };

  return (
    <div className={`flex h-full min-h-0 flex-col ${workspace.docked ? 'relative pr-(--pane-w)' : ''}`}>
      <header className="flex shrink-0 items-center gap-0.5 border-b border-line bg-bg/95 px-2 py-1.5 backdrop-blur">
        {!wide && (
          <button type="button" aria-label="Back to sessions" onClick={onBack} className="grid size-10 shrink-0 place-items-center rounded-full hover:bg-hover">
            <ChevronLeft className="size-5" />
          </button>
        )}
        <button
          type="button"
          onClick={() => sessionId && setMenuOpen(true)}
          className={`min-w-0 flex-1 rounded-lg px-2 py-1 text-left ${wide ? 'pl-3' : ''} ${sessionId ? '' : 'cursor-default'}`}
        >
          <div className="truncate text-[15px] font-medium">{title || ' '}</div>
          <div className="flex min-w-0 items-center gap-2 overflow-hidden text-[12px] text-faint">
            <StatusBadge status={status} runningIn={view.run ? undefined : session?.runningIn} />
            <span className="min-w-0 truncate font-mono" title={cwd}>{cwd ? (wide ? subtitle : baseName(cwd)) : ''}</span>
            {session?.gitBranch && (
              <span className="flex min-w-0 shrink items-center gap-0.5 truncate"><GitBranch className="size-3 shrink-0" />{session.gitBranch}</span>
            )}
          </div>
        </button>
        {/* On a phone the meter shows up once the context is filling; the session menu always has the number. */}
        {view.run?.context && (wide || view.run.context.percent >= 60) && <ContextMeter context={view.run.context} onClick={() => setMenuOpen(true)} />}
        {cwd && (
          <button
            type="button"
            aria-label="Changes and files"
            aria-pressed={workspace.dockable ? workspace.open : undefined}
            title={`Changes and files (${PANE_KEYS})`}
            onClick={() => workspace.setOpen(!workspace.open)}
            className={`relative grid size-10 shrink-0 place-items-center rounded-full hover:bg-hover hover:text-fg ${workspace.docked ? 'bg-hover text-fg' : 'text-muted'}`}
          >
            <FolderGit2 className="size-[18px]" />
            {changes > 0 && <span className="absolute top-1.5 right-1 min-w-4 rounded-full bg-fg px-1 text-center text-[10px] leading-4 font-medium text-bg tabular-nums">{changes > 99 ? '99+' : changes}</span>}
          </button>
        )}
        {sessionId && (
          <button type="button" aria-label="Session menu" onClick={() => setMenuOpen(true)} className="grid size-10 shrink-0 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg">
            <MoreHorizontal className="size-5" />
          </button>
        )}
      </header>

      {sessionId || view.messages.length > 0 ? (
        <MessageList sessionId={viewId} view={view} cwd={cwd} mode={viewOf(prefs, sessionId)} {...(sessionId ? { ...(busy ? {} : { onEdit: edit }), onRewind: (uuid: string) => setRewinding(uuid) } : {})} />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center">
          <div className="min-w-0 max-w-full">
            <div className="text-[17px] font-medium">What should Claude do?</div>
            <StartIn start={newCwd ? { cwd: newCwd } : { scratch: true }} {...(home ? { home } : {})} onStart={onStartIn} />
          </div>
        </div>
      )}

      <div className="shrink-0 px-3">
        {permissions.map((request) => (
          <PermissionCard key={request.id} sessionId={sessionId!} request={request} cwd={cwd} />
        ))}
        {showTasks && <TasksBar tasks={tasks} />}
        {sessionId && view.run?.tasks && view.run.tasks.length > 0 && <BackgroundTasks sessionId={sessionId} tasks={view.run.tasks} />}
        {running && (
          <Notice><span className="flex items-center gap-2"><Loader2 className="size-3.5 animate-spin" /> Running <code className="font-mono">{running}</code></span></Notice>
        )}
        {prefs.suggestions && view.run?.suggestion && !busy && !running && (
          <div className="mx-auto mb-2 flex max-w-3xl">
            <button type="button" onClick={() => setDraftText({ text: view.run!.suggestion!, key: Date.now() })} className="flex min-w-0 items-center gap-1.5 rounded-full px-2 py-1 text-left text-[13px] text-muted hover:bg-hover hover:text-fg">
              <CornerDownRight className="size-3.5 shrink-0 text-faint" />
              <span className="truncate">{view.run.suggestion}</span>
            </button>
          </div>
        )}
        {limitNotice(limits) && <Notice tone="error">{limitNotice(limits)}</Notice>}
        {session?.status === 'live' && !view.run && (
          <Notice tone="live">
            Claude is working on this session {session.runningIn ? `in ${session.runningIn}` : 'elsewhere'} right now. Sending here runs a second Claude on the same conversation.
          </Notice>
        )}
        {/* Open, idle, in another app too: explained once, the first time it happens; the session
            menu says it for each session after that. */}
        {session?.openIn && status !== 'live' && !busy && !openElsewhereSeen && (
          <Notice onDismiss={() => {
            markTipSeen('open-elsewhere');
            setOpenElsewhereSeen(true);
          }}>
            This session is also open in {session.openIn} (others may be too). Pelican catches up before it sends; {session.openIn} sees your messages once you reopen the session there.
          </Notice>
        )}
        {modelList?.signedIn === false && (
          <Notice tone="error">
            Claude Code is not signed in on {machine || 'this machine'}. Run <code className="font-mono">claude</code> in a terminal there, sign in, then come back.
          </Notice>
        )}
        {note && <Notice onDismiss={() => setNote(undefined)}>{note}</Notice>}
        {sendError && <Notice tone="error" onDismiss={() => setSendError(undefined)}>{sendError}</Notice>}
      </div>

      <Composer
        busy={busy}
        settings={settings}
        onSettings={changeSettings}
        models={modelList?.models}
        onSend={(text, attachments, mode) => void send(text, attachments, mode)}
        {...(sessionId ? { onShell: (command: string) => void shell(command) } : {})}
        onStop={() => sessionId && void api.interrupt(sessionId)}
        autoFocus={!sessionId || Boolean(initialDraft)}
        placeholder={busy ? 'Queue a message' : sessionId ? 'Reply to Claude' : 'Message Claude'}
        {...(cwd ? { cwd } : {})}
        {...(draft ? { draft } : {})}
      />

      {cwd && (
        <Workspace
          open={workspace.open}
          docked={workspace.docked}
          onClose={() => workspace.setOpen(false)}
          cwd={cwd}
          onAddToMessage={(text) => {
            if (!workspace.docked) workspace.setOpen(false);
            setDraftText({ text, key: Date.now(), append: true });
          }}
        />
      )}
      {sessionId && (
        <RewindSheet
          sessionId={sessionId}
          {...(rewinding ? { uuid: rewinding } : {})}
          {...(cwd ? { cwd } : {})}
          onClose={() => setRewinding(undefined)}
          onDone={(result) => {
            setRewinding(undefined);
            const count = result.files?.length ?? 0;
            setNote(`Put ${count} file${count === 1 ? '' : 's'} back the way they were before that prompt. The conversation is unchanged; to carry on from there too, use Edit and resend on it.`);
            void queryClient.invalidateQueries({ queryKey: ['git', cwd] });
          }}
        />
      )}
      {sessionId && (
        <SessionMenu
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          sessionId={sessionId}
          {...(session ? { session } : {})}
          {...(cwd ? { cwd } : {})}
          {...(home ? { home } : {})}
          {...(view.run ? { run: view.run } : {})}
          onRenamed={refresh}
          onForked={(id) => {
            // A branch is new work: it carries this session's settings, except Bypass.
            saveSessionChoice(id, withoutBypass(settings));
            setMenuOpen(false);
            void queryClient.invalidateQueries({ queryKey: ['sessions'] });
            onOpen(id);
          }}
          onDeleted={() => {
            setMenuOpen(false);
            void queryClient.invalidateQueries({ queryKey: ['sessions'] });
            onBack();
          }}
        />
      )}
    </div>
  );
}
