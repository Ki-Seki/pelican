import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ChevronDown, ChevronLeft, ChevronUp, Circle, CircleDot, Clock, CornerDownRight, FolderGit2, GitBranch, Info, ListChecks, Loader2, MoreHorizontal, SquareTerminal, TriangleAlert, X } from 'lucide-react';
import { type DragEvent, useEffect, useMemo, useRef, useState } from 'react';

import { MODE_INFO } from '../../shared/modes';
import type { Attachment, BackgroundTask, Block, ChatMessage, RewindResult, RunSettings, RunState, ScheduledCheck, SendMode, SessionSummary, UsageLimit } from '../../shared/protocol';
import { announce, announcement, askedFor, type ChatMoment } from '../lib/announce';
import { api, ApiError, apiUrl, isDemoNote, isUnreachable, type TrustChoice } from '../lib/api';
import { useDemoNote } from '../lib/demo';
import { clearDraft } from '../lib/drafts';
import { newId } from '../lib/ids';
import { baseName, clockTime, shortPath, untilTime } from '../lib/format';
import { composing } from '../lib/keyboard';
import { loadDefaults, markSeen, markTipSeen, saveSessionChoice, sessionChoice, tipSeen, usePrefs, viewOf } from '../lib/prefs';
import { fromRecorded } from '../lib/settings';
import { socket } from '../lib/socket';
import { INSTALL_URL, STATIC_DEMO } from '../lib/static-demo';
import {
  addLocalMessage,
  adoptView,
  getView,
  loadLatest,
  removeLocalMessage,
  syncRun,
  truncateFrom,
  useSessionView,
} from '../lib/store';
import { setSessionTitle } from '../lib/title';
import { currentTasks, type Todo } from '../lib/tools';
import { Composer, type ComposerHandle } from './Composer';
import { MessageList } from './MessageList';
import { OfflineLine, retryNow, useOffline } from './Offline';
import { PermissionCard } from './PermissionCard';
import { QueuedStrip } from './QueuedStrip';
import { StatusBadge, StatusDot } from './SessionList';
import { SessionMenu } from './SessionMenu';
import { Sheet } from './Sheet';
import { TodoList } from './ToolCall';
import { type TrustAsk, TrustSheet } from './TrustSheet';
import { Workspace } from './Workspace';

/** What a branch starts with: the settings it came from, but asking first instead of Bypass. */
const withoutBypass = (settings: RunSettings): RunSettings =>
  (settings.permissionMode === 'bypassPermissions' ? { ...settings, permissionMode: 'default' } : settings);

/**
 * /clear, /reset and /new, as in Claude Code: a fresh conversation in the same folder, going on
 * with the same settings (Bypass aside). Handed to the new session's view by its id.
 */
const CLEAR = /^\/(clear|reset|new)(\s|$)/;
const carried = new Map<string, RunSettings>();

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
      aria-label={`Context ${percent}% full`}
      title={`Context ${percent}% full: ${Math.round(context.tokens / 1000)}k of ${Math.round(context.max / 1000)}k tokens`}
      className={`relative flex h-9 shrink-0 items-center gap-1 rounded-full px-2 text-[11.5px] tabular-nums after:absolute after:-inset-y-1 after:inset-x-0 hover:bg-hover ${tone}`}
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

/** Whether a usage limit is reached, not only close: only that is shown as an error. */
export const limitReached = (limits: UsageLimit[] | undefined) => Boolean(limits?.some((l) => l.status === 'rejected'));

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
  const [error, setError] = useState<{ text: string; note: boolean }>();
  const files = preview.data?.files ?? [];
  const rel = (file: string) => (cwd && file.startsWith(`${cwd}/`) ? file.slice(cwd.length + 1) : file);
  return (
    <Sheet open={Boolean(uuid)} onClose={onClose} title="Rewind code">
      <div className="px-3 pt-1 pb-3 text-[14px] leading-relaxed">
        {preview.isLoading && <div className="flex items-center gap-2 text-muted"><Loader2 className="size-4 animate-spin" /> Checking what changed since this prompt</div>}
        {preview.error && <div className={isDemoNote(preview.error) ? 'text-muted' : 'text-danger'}><NoteText text={(preview.error as Error).message} /></div>}
        {preview.data && !preview.data.canRewind && (
          <div className="text-muted">{preview.data.error ?? 'Nothing to put back: Claude has not changed any files since this prompt.'}</div>
        )}
        {preview.data?.canRewind && files.length === 0 && <div className="text-muted">No files changed since this prompt.</div>}
        {preview.data?.canRewind && files.length > 0 && (
          <>
            <p>{files.length === 1 ? 'Put this file back as it was' : `Put these ${files.length} files back as they were`} before this prompt. The conversation stays as it is.</p>
            <ul className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-line px-3 py-1.5 font-mono text-[12px] text-muted">
              {files.map((file) => <li key={file} className="truncate py-0.5">{rel(file)}</li>)}
            </ul>
            {(preview.data.insertions || preview.data.deletions) ? (
              <div className="mt-1.5 font-mono text-[12px]"><span className="text-add">+{preview.data.insertions ?? 0}</span> <span className="text-del">−{preview.data.deletions ?? 0}</span> <span className="font-sans text-faint">lines change back</span></div>
            ) : null}
            {error && <div className={`mt-2 text-[13px] ${error.note ? 'text-muted' : 'text-danger'}`}><NoteText text={error.text} /></div>}
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                disabled={working}
                className="h-9 rounded-full bg-fg px-4 text-[14px] font-medium text-bg disabled:opacity-40"
                onClick={() => {
                  setWorking(true);
                  setError(undefined);
                  api.rewind(sessionId, uuid!, false)
                    .then((result) => (result.canRewind ? onDone(result) : setError({ text: result.error ?? 'Could not put the files back', note: false })))
                    .catch((err: Error) => setError({ text: err.message, note: isDemoNote(err) }))
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

// eslint-disable-next-line no-control-regex
const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g, '');

/** What a background command printed, its last 8 KiB, read again every two seconds while open. */
function TaskOutputSheet({ sessionId, task, onClose }: { sessionId: string; task?: BackgroundTask; onClose: () => void }) {
  const { data, error } = useQuery({
    queryKey: ['task-output', sessionId, task?.id],
    queryFn: () => api.taskOutput(sessionId, task!.id),
    enabled: Boolean(task),
    refetchInterval: 2000,
    gcTime: 0,
  });
  return (
    <Sheet open={Boolean(task)} onClose={onClose} title={task?.description || 'Background task'}>
      <div className="px-3 pt-1 pb-3">
        {error ? <div className="text-[13px] text-danger">{(error as Error).message}</div>
          : !data ? <div className="flex justify-center py-3"><Loader2 className="size-4 animate-spin text-faint" /></div>
            : data.output.trim() ? (
              <pre className="max-h-[60dvh] overflow-auto rounded-lg bg-chip px-3 py-2 font-mono text-[12px] leading-[1.5] whitespace-pre-wrap break-words text-muted">
                {data.truncated ? '…\n' : ''}{stripAnsi(data.output)}
              </pre>
            ) : <div className="text-[13px] text-muted">Nothing printed yet.</div>}
      </div>
    </Sheet>
  );
}

/**
 * Background tasks (shells and agents Claude left running) and the check-ins Claude scheduled.
 * One shows as a row; more fold into a single row, so they never crowd the conversation, and open
 * into a short list. A command's row opens what it printed; an agent's says what it is doing.
 */
function BackgroundTasks({ sessionId, tasks, scheduled }: { sessionId: string; tasks: BackgroundTask[]; scheduled: ScheduledCheck[] }) {
  const [open, setOpen] = useState(false);
  const [reading, setReading] = useState<BackgroundTask>();
  const stop = (id: string) => void api.stopTask(sessionId, id);
  const row = (task: BackgroundTask) => (
    <div key={task.id} className="flex items-center gap-2 py-1 pr-1 pl-3 text-[12.5px] text-muted">
      <Pulse />
      <span className="min-w-0 flex-1 truncate">
        {task.description || 'Background task'}
        {task.summary && <span className="text-faint"> · {task.summary}</span>}
      </span>
      {task.output && <button type="button" onClick={() => setReading(task)} className="relative h-7 shrink-0 rounded-full px-2.5 text-[12px] after:absolute after:-inset-y-2 after:inset-x-0 hover:bg-hover hover:text-fg">Output</button>}
      <button type="button" onClick={() => stop(task.id)} className="relative h-7 shrink-0 rounded-full px-2.5 text-[12px] after:absolute after:-inset-y-2 after:inset-x-0 hover:bg-hover hover:text-fg">Stop</button>
    </div>
  );
  // Claude stays running here for these; it says when the next one is due.
  const check = (item: ScheduledCheck) => (
    <div key={item.id} className="flex h-9 items-center gap-2 pr-3 pl-3 text-[12.5px] text-muted">
      <Clock className="size-3.5 shrink-0 text-faint" />
      <span className="min-w-0 flex-1 truncate">{item.what}</span>
      {item.next && <span className="shrink-0 text-faint tabular-nums">{clockTime(item.next)}</span>}
    </div>
  );
  const sheet = <TaskOutputSheet sessionId={sessionId} {...(reading ? { task: reading } : {})} onClose={() => setReading(undefined)} />;
  if (tasks.length + scheduled.length === 1) {
    return <div className="mx-auto mb-2 max-w-3xl rounded-full border border-line bg-panel">{tasks[0] ? row(tasks[0]) : check(scheduled[0]!)}{sheet}</div>;
  }
  if (tasks.length === 0) {
    return <div className="mx-auto mb-2 max-w-3xl rounded-2xl border border-line bg-panel py-0.5">{scheduled.map(check)}</div>;
  }
  const latest = tasks.at(-1)!;
  return (
    <div className="mx-auto mb-2 max-w-3xl">
      {open ? (
        <div className="rounded-2xl border border-line bg-panel py-1">
          <button type="button" onClick={() => setOpen(false)} className="flex h-8 w-full items-center gap-2 px-3 text-left text-[12.5px] text-muted hover:text-fg">
            <span className="min-w-0 flex-1 truncate">{tasks.length} background tasks</span>
            <ChevronDown className="size-4 shrink-0" />
          </button>
          <div className="max-h-[30vh] overflow-y-auto overscroll-contain">{tasks.map(row)}{scheduled.map(check)}</div>
        </div>
      ) : (
        <button type="button" onClick={() => setOpen(true)} className="flex h-8 w-full items-center gap-2 rounded-full border border-line bg-panel px-3 text-left text-[12.5px] text-muted hover:text-fg">
          <Pulse />
          <span className="shrink-0 tabular-nums">{tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}{scheduled.length > 0 ? ` · ${scheduled.length} scheduled` : ''}</span>
          <span className="min-w-0 flex-1 truncate text-faint">{latest.description || 'Background task'}</span>
          <ChevronUp className="size-4 shrink-0" />
        </button>
      )}
      {sheet}
    </div>
  );
}

const TASK_ICON = {
  completed: <CheckCircle2 className="size-3.5 shrink-0 text-live" />,
  in_progress: <CircleDot className="size-3.5 shrink-0 text-run" />,
  pending: <Circle className="size-3.5 shrink-0 text-faint" />,
};

/**
 * Claude's task list, pinned above the composer while there is work left: the one live view of
 * it. Opened, the bar itself grows into the list, rather than showing another copy of the task
 * card the conversation may have just above.
 */
function TasksBar({ tasks }: { tasks: Todo[] }) {
  const [open, setOpen] = useState(false);
  const done = tasks.filter((t) => t.status === 'completed').length;
  const current = tasks.find((t) => t.status === 'in_progress');
  return (
    <div className={`mx-auto mb-2 max-w-3xl border border-line bg-panel ${open ? 'rounded-2xl' : 'rounded-full'}`}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="relative flex h-8 w-full items-center gap-2 px-3 text-left text-[12.5px] text-muted after:absolute after:-inset-y-1.5 after:inset-x-0 hover:text-fg">
        <ListChecks className="size-3.5 shrink-0" />
        <span className="shrink-0 tabular-nums">{done}/{tasks.length}</span>
        <span className="min-w-0 flex-1 truncate">{open ? 'Tasks' : current ? current.activeForm || current.content : done === tasks.length ? 'All done' : 'Tasks'}</span>
        {open ? <ChevronDown className="size-4 shrink-0" /> : <ChevronUp className="size-4 shrink-0" />}
      </button>
      {open && (
        <ul className="max-h-[30vh] space-y-1 overflow-y-auto overscroll-contain px-3 pb-2.5 text-[13px] leading-snug">
          {tasks.map((task, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className="mt-px">{TASK_ICON[task.status] ?? TASK_ICON.pending}</span>
              <span className={task.status === 'completed' ? 'text-faint line-through' : ''}>{task.status === 'in_progress' && task.activeForm ? task.activeForm : task.content}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The demo's note, with its way out on the site: a link to install. */
function NoteText({ text }: { text: string }) {
  const at = STATIC_DEMO ? text.indexOf('Install Pelican') : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <a href={INSTALL_URL} className="font-medium text-fg underline decoration-faint underline-offset-2">Install Pelican</a>
      {text.slice(at + 'Install Pelican'.length)}
    </>
  );
}

/** A line above the composer. Red only for what went wrong; the demo's note and warnings are info. */
function Notice({ tone = 'info', children, onDismiss }: { tone?: 'info' | 'error' | 'live'; children: React.ReactNode; onDismiss?: () => void }) {
  return (
    <div className={`mx-auto mb-2 flex max-w-3xl items-start gap-2 rounded-xl px-3 py-2 text-[12.5px] leading-snug ${tone === 'error' ? 'border border-line bg-panel text-danger' : 'text-muted'}`}>
      {tone === 'error' ? <TriangleAlert className="mt-px size-4 shrink-0" /> : tone === 'live' ? <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-live" /> : <Info className="mt-px size-3.5 shrink-0" />}
      <div className="min-w-0 flex-1">{children}</div>
      {onDismiss && (
        <button type="button" aria-label="Dismiss" onClick={onDismiss} className="relative -my-0.5 grid size-6 shrink-0 place-items-center rounded-full text-faint after:absolute after:-inset-2.5 hover:text-fg">
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}

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
  /** Opens a new, empty session in a folder. */
  onStartIn: (cwd: string) => void;
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
  const [carry] = useState(() => {
    const settings = sessionId ? undefined : carried.get(viewId);
    carried.delete(viewId);
    return settings;
  });
  const [settings, setSettings] = useState<RunSettings>(() => {
    const base = loadDefaults();
    if (!sessionId) return carry ? { ...base, ...carry } : base;
    const live = getView(sessionId).run?.settings;
    if (live) return { ...base, ...live };
    const choice = sessionChoice(sessionId);
    return choice ? { ...base, ...choice.settings } : base;
  });
  const [draft, setDraftText] = useState<{ text: string; key: number; append?: boolean }>();
  const [note, setNote] = useState<string>();
  // A send that failed. `note`: not an error to show in red, but the demo saying what it does not
  // do, or the computer out of reach (the line under the header says so too).
  const [sendError, setSendError] = useState<{ text: string; note: boolean }>();
  const failed = (error: unknown) => setSendError({ text: (error as Error).message, note: isDemoNote(error) || isUnreachable(error) });
  const [demoNote, dismissDemoNote] = useDemoNote(sessionId);
  const [menuOpen, setMenuOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [rewinding, setRewinding] = useState<string>();
  const [openElsewhereSeen, setOpenElsewhereSeen] = useState(() => tipSeen('open-elsewhere'));
  const [running, setRunning] = useState<string>();
  const [modeSeen, setModeSeen] = useState<string>();
  const [trustAsk, setTrustAsk] = useState<TrustAsk>();
  const { data: limits } = useQuery({ queryKey: ['usage'], queryFn: api.usage, refetchInterval: 60_000, enabled: !demo });

  useEffect(() => {
    if (!sessionId) return undefined;
    // The demo's server changes nothing; what changes here, the demo plays out in the page.
    if (!demo) socket.subscribe(sessionId);
    void loadLatest(sessionId);
    return () => {
      if (!demo) socket.unsubscribe(sessionId);
    };
  }, [sessionId, demo]);

  useEffect(() => {
    if (sessionId && detail) syncRun(sessionId, detail.run);
  }, [sessionId, detail]);

  // Whatever is on screen counts as read.
  useEffect(() => {
    if (sessionId) markSeen(sessionId, Math.max(Date.now(), session?.lastActivity ?? 0));
  }, [sessionId, session?.lastActivity, view.messages.length]);

  // The model, effort, speed, Ultracode and permission mode belong to the session. The composer
  // shows, most specific first: what Claude runs with for it here right now (kept up to date,
  // also when plan mode ends or another tab changes them); else a choice made here that no turn has
  // used yet; else what its last turn ran with (its transcript), the model named as it was picked
  // here. New sessions start from the defaults in Settings, which only Settings changes.
  const chosen = useRef(Boolean(carry));
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

  // A new session starts in the mode Claude Code's settings give (permissions.defaultMode), as in
  // the terminal; with none, it asks first.
  const { data: defaults } = useQuery({
    queryKey: ['defaults', scratch ? '' : newCwd ?? ''],
    queryFn: () => api.defaults(scratch ? undefined : newCwd),
    enabled: !sessionId && (scratch || Boolean(newCwd)),
    staleTime: 30_000,
    retry: false,
  });
  useEffect(() => {
    if (sessionId || chosen.current || !defaults?.permissionMode) return;
    setSettings((current) => ({ ...current, permissionMode: defaults.permissionMode! }));
  }, [sessionId, defaults?.permissionMode]);

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

  const send = async (text: string, attachments: Attachment[], mode: SendMode, trust?: TrustChoice) => {
    setSendError(undefined);
    setNote(undefined);
    dismissDemoNote();
    if (sessionId && CLEAR.test(text) && cwd) {
      carried.set(`new:${cwd}`, withoutBypass(settings));
      onStartIn(cwd);
      return;
    }
    const uuid = newId();
    // Queued, it waits in the strip above the composer: in the conversation once Claude gets it.
    if (!(busy && mode === 'queue')) addLocalMessage(viewId, localMessage(uuid, text, attachments));
    const body = { text, attachments: attachments.map((a) => a.id), settings, uuid, ...(busy ? { mode } : {}), ...(trust ? { trust } : {}) };
    try {
      if (sessionId) {
        await api.send(sessionId, body);
        saveSessionChoice(sessionId, settings);
        clearDraft(viewId, text);
      } else if (newCwd || scratch) {
        const { sessionId: created } = await api.create({ ...body, ...(scratch ? { scratch: true } : { cwd: newCwd }) });
        saveSessionChoice(created, settings);
        clearDraft(viewId, text);
        adoptView(viewId, created);
        void queryClient.invalidateQueries({ queryKey: ['sessions'] });
        onOpen(created, true);
      }
    } catch (error) {
      // Nothing reached Claude: take the message back and give the text back to edit.
      removeLocalMessage(viewId, uuid);
      if (error instanceof ApiError && error.trust) {
        // The folder has programs of its own and nobody trusted it: ask, then send it again.
        setTrustAsk({ brings: error.trust.brings, answer: (choice) => void send(text, attachments, mode, choice), cancel: () => setDraftText({ text, key: Date.now() }) });
        return;
      }
      failed(error);
      setDraftText({ text, key: Date.now() });
    }
  };

  const firstPrompt = view.messages.find((m) => m.role === 'user' && m.blocks.some((b) => b.type === 'text'));
  const firstText = firstPrompt?.blocks.find((b) => b.type === 'text');
  const title = session?.title ?? (firstText?.type === 'text' ? firstText.text.slice(0, 80) : scratch ? 'New scratch session' : newCwd ? 'New session' : '');
  const cwd = session?.cwd || view.run?.cwd || newCwd;
  const permissions = view.run?.permissions ?? [];
  // One request at a time, the oldest first, as Claude Code asks: the rest wait behind it.
  const request = permissions[0];
  const status = view.run ? (permissions.length > 0 ? 'waiting' : busy ? 'running' : session?.status === 'live' ? 'live' : 'idle') : session?.status ?? 'idle';

  // A `!` command: run in the session's folder, shown in the conversation, read by Claude with the next message.
  const shell = async (command: string) => {
    if (!sessionId) return;
    setSendError(undefined);
    setRunning(command);
    try {
      await api.shell(sessionId, command);
      clearDraft(viewId, `!${command}`);
    } catch (error) {
      failed(error);
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
    if (busy) {
      setSendError({ text: 'Stop Claude before editing an earlier prompt.', note: false });
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
      if (alive.current) failed(error);
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

  useEffect(() => setSessionTitle(title), [title]);
  useEffect(() => () => setSessionTitle(undefined), []);

  // Said to screen readers once per change: Claude asking for something, a reply, an error.
  const reply = useMemo(() => {
    for (let i = view.messages.length - 1; i >= 0; i -= 1) {
      const message = view.messages[i]!;
      if (message.role === 'user' && message.blocks.some((b) => b.type === 'text')) return undefined;
      const text = message.role === 'assistant' ? message.blocks.filter((b) => b.type === 'text').map((b) => (b.type === 'text' ? b.text : '')).join('\n') : '';
      if (text.trim()) return text;
    }
    return undefined;
  }, [view.messages]);
  const moment = useRef<ChatMoment | undefined>(undefined);
  useEffect(() => {
    const now: ChatMoment = { permissions, busy, ...(reply ? { reply } : {}), ...(view.run?.error ? { error: view.run.error } : {}) };
    const before = moment.current;
    moment.current = now;
    const words = before && announcement(before, now, cwd);
    if (words) announce(words);
  });
  useEffect(() => {
    if (sendError) announce(sendError.text);
  }, [sendError]);

  // Esc stops Claude, as in Claude Code, when nothing else takes it: an open sheet, the / list,
  // a field of its own (the reason for a Deny), or a part of the page outside this chat.
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!busy || !sessionId) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.repeat || composing(e) || document.querySelector('dialog[open]')) return;
      const target = e.target instanceof HTMLElement ? e.target : undefined;
      if (target && target !== document.body && !root.current?.contains(target)) return;
      if (target?.matches('input, textarea, select, [contenteditable="true"]') && !target.matches('[aria-label="Message Claude"]')) return;
      e.preventDefault();
      void api.interrupt(sessionId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, sessionId]);

  // Files dropped anywhere on the conversation go to the composer.
  const composer = useRef<ComposerHandle>(null);
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);
  const carriesFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files');
  const dropHandlers = {
    onDragEnter: (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      dragDepth.current += 1;
      setDropping(true);
    },
    onDragOver: (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDropping(false);
    },
    onDrop: (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDropping(false);
      composer.current?.addFiles(e.dataTransfer.files);
    },
  };

  const offline = useOffline();
  // Out of reach, App says so once for the whole page.
  useEffect(() => {
    if (view.error && offline !== 'unreachable') announce(view.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.error]);
  const retry = () => {
    retryNow(queryClient);
    if (sessionId) void loadLatest(sessionId);
  };
  const context = view.run?.context;
  const meter = context ? <ContextMeter context={context} onClick={() => setMenuOpen(true)} /> : undefined;

  const subtitle = useMemo(() => (cwd ? shortPath(cwd, home) : scratch ? 'A new folder in ~/scratch' : ''), [cwd, home, scratch]);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['session', sessionId] });
    void queryClient.invalidateQueries({ queryKey: ['sessions'] });
  };

  return (
    <div ref={root} className="relative flex h-full min-h-0 flex-col [@media(max-height:380px)]:overflow-y-auto" {...dropHandlers}>
      <header className="flex shrink-0 items-center gap-0.5 border-b border-line bg-bg/95 px-2 py-1.5 backdrop-blur">
        {!wide && (
          <button type="button" aria-label="Back to sessions" onClick={onBack} className="relative grid size-10 shrink-0 place-items-center rounded-full after:absolute after:-inset-0.5 hover:bg-hover">
            <ChevronLeft className="size-5" />
          </button>
        )}
        <h2 className="min-w-0 flex-1">
          <button
            type="button"
            onClick={() => sessionId && setMenuOpen(true)}
            aria-haspopup={sessionId ? 'dialog' : undefined}
            className={`block w-full min-w-0 rounded-lg px-2 py-1 text-left ${wide ? 'pl-3' : ''} ${sessionId ? '' : 'cursor-default'}`}
          >
            <div className="truncate text-[15px] font-medium">{title || ' '}</div>
            <div className="flex min-w-0 items-center gap-2 overflow-hidden text-[12px] text-faint">
              {/* The list has room for "Working in Claude Desktop"; a phone's header, for the folder too. */}
              {!wide && status === 'live' && session?.runningIn && !view.run ? (
                <span className="inline-flex shrink-0 items-center gap-1.5 text-[11.5px] font-medium text-live"><StatusDot status="live" />In {session.runningIn}</span>
              ) : (
                <StatusBadge status={status} runningIn={view.run ? undefined : session?.runningIn} />
              )}
              <span className="min-w-0 truncate font-mono" title={cwd}>{cwd ? (wide ? subtitle : baseName(cwd)) : ''}</span>
              {/* On a phone the line has room for the branch only when nothing else is going on; the session menu always has it. */}
              {session?.gitBranch && (wide || status === 'idle') && (
                <span className="flex min-w-0 shrink-[2] items-center gap-0.5"><GitBranch className="size-3 shrink-0" /><span className="truncate">{session.gitBranch}</span></span>
              )}
            </div>
          </button>
        </h2>
        {/* On a phone the meter sits by Send once the context is filling; the session menu always has the number. */}
        {wide && meter}
        {cwd && (
          <button type="button" aria-label="Changes and files" onClick={() => setWorkspaceOpen(true)} className="relative grid size-10 shrink-0 place-items-center rounded-full text-muted after:absolute after:-inset-0.5 hover:bg-hover hover:text-fg">
            <FolderGit2 className="size-[18px]" />
            {changes > 0 && <span className="absolute top-1.5 right-1 min-w-4 rounded-full bg-fg px-1 text-center text-[10px] leading-4 font-medium text-bg tabular-nums">{changes > 99 ? '99+' : changes}</span>}
          </button>
        )}
        {sessionId && (
          <button type="button" aria-label="Session menu" onClick={() => setMenuOpen(true)} className="relative grid size-10 shrink-0 place-items-center rounded-full text-muted after:absolute after:-inset-0.5 hover:bg-hover hover:text-fg">
            <MoreHorizontal className="size-5" />
          </button>
        )}
      </header>
      {/* Wide, the list beside says it; one line is enough. */}
      {!wide && <OfflineLine state={offline} {...(machine ? { machine } : {})} onRetry={retry} />}

      <div className="flex min-h-0 flex-1 flex-col [@media(max-height:380px)]:min-h-[80%]">
        {sessionId || view.messages.length > 0 ? (
          <MessageList
            sessionId={viewId}
            // Can't reach the computer: the line under the header says so, and offers to retry.
            view={offline === 'unreachable' && view.error ? { ...view, error: undefined } : view}
            cwd={cwd}
            mode={viewOf(prefs, sessionId)}
            {...(sessionId ? { ...(busy ? {} : { onEdit: edit }), onRewind: (uuid: string) => setRewinding(uuid) } : {})}
          />
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center">
            <div>
              <div className="text-[17px] font-medium">What should Claude do?</div>
              <div className="mt-1 font-mono text-[12.5px] text-faint">{subtitle}</div>
            </div>
          </div>
        )}
      </div>

      {/* Never taller than about half the screen, so the conversation, the composer and Stop stay in view. */}
      <div className="max-h-[55%] shrink-0 overflow-y-auto overscroll-contain px-3 [@media(max-height:600px)]:max-h-[40%] [@media(max-height:380px)]:max-h-none [@media(max-height:380px)]:overflow-visible">
        {request && (
          <section aria-label={askedFor(request, cwd, true)} className="mx-auto max-w-3xl">
            {permissions.length > 1 && <div className="px-1 pb-1 text-right text-[11.5px] text-faint tabular-nums">1 of {permissions.length}</div>}
            <PermissionCard key={request.id} sessionId={sessionId!} request={request} cwd={cwd} />
          </section>
        )}
        {showTasks && <TasksBar tasks={tasks} />}
        {sessionId && ((view.run?.tasks?.length ?? 0) + (view.run?.scheduled?.length ?? 0)) > 0 && (
          <BackgroundTasks sessionId={sessionId} tasks={view.run?.tasks ?? []} scheduled={view.run?.scheduled ?? []} />
        )}
        {running && (
          <Notice><span className="flex items-center gap-2"><Loader2 className="size-3.5 animate-spin" /> Running <code className="font-mono">{running}</code></span></Notice>
        )}
        {prefs.suggestions && view.run?.suggestion && !busy && !running && (
          <div className="mx-auto mb-2 flex max-w-3xl">
            <button type="button" onClick={() => setDraftText({ text: view.run!.suggestion!, key: Date.now() })} className="relative flex min-h-9 min-w-0 items-center gap-1.5 rounded-full px-2 py-1 text-left text-[13px] text-muted after:absolute after:-inset-y-1 after:inset-x-0 hover:bg-hover hover:text-fg">
              <CornerDownRight className="size-3.5 shrink-0 text-faint" />
              <span className="truncate">{view.run.suggestion}</span>
            </button>
          </div>
        )}
        {limitNotice(limits) && <Notice tone={limitReached(limits) ? 'error' : 'info'}>{limitNotice(limits)}</Notice>}
        {session?.status === 'live' && !view.run && (
          <Notice tone="live">Sending here starts a second Claude on this conversation.</Notice>
        )}
        {session?.status === 'waiting' && session.runningIn && !view.run && (
          <Notice>
            Claude is waiting for an answer in {session.runningIn}. Sending here runs a second Claude on the same conversation.
          </Notice>
        )}
        {/* Open, idle, in another app too: explained once, the first time it happens; the session
            menu says it for each session after that. */}
        {session?.openIn && status !== 'live' && !busy && !openElsewhereSeen && (
          <Notice onDismiss={() => {
            markTipSeen('open-elsewhere');
            setOpenElsewhereSeen(true);
          }}>
            Also open in {session.openIn}, which shows what you send here once you reopen the session there.
          </Notice>
        )}
        {modelList?.signedIn === false && (
          <Notice tone="error">
            Claude Code is not signed in on {machine || 'this machine'}. Run <code className="font-mono">claude</code> in a terminal there, sign in, then come back.
          </Notice>
        )}
        {view.run?.modeChanged && view.run.modeChanged !== modeSeen && (
          <Notice onDismiss={() => setModeSeen(view.run?.modeChanged)}>{MODE_INFO[view.run.modeChanged].now}</Notice>
        )}
        {note && <Notice onDismiss={() => setNote(undefined)}>{note}</Notice>}
        {demoNote && <Notice onDismiss={dismissDemoNote}>{demoNote}</Notice>}
        {sendError && (
          <Notice tone={sendError.note ? 'info' : 'error'} onDismiss={() => setSendError(undefined)}>
            <NoteText text={sendError.text} />
          </Notice>
        )}
        {sessionId && view.run?.queued && view.run.queued.length > 0 && (
          <QueuedStrip
            queued={view.run.queued}
            onRemove={(prompt) => void api.unqueue(sessionId, prompt.uuid).catch(() => undefined)}
            onEdit={(prompt) => void api.unqueue(sessionId, prompt.uuid).then(() => setDraftText({ text: prompt.text, key: Date.now(), append: true }), () => undefined)}
          />
        )}
      </div>

      <Composer
        ref={composer}
        busy={busy}
        settings={settings}
        onSettings={changeSettings}
        models={modelList?.models}
        onSend={(text, attachments, mode) => void send(text, attachments, mode)}
        {...(sessionId ? { onShell: (command: string) => void shell(command) } : {})}
        onStop={() => sessionId && void api.interrupt(sessionId)}
        stopping={Boolean(view.run?.stopping)}
        // On a computer the box takes the keys as soon as a chat opens (the composer skips this on touch screens).
        autoFocus
        placeholder={sessionId ? 'Reply to Claude' : 'Message Claude'}
        draftKey={viewId}
        {...(!wide && context && context.percent >= 60 ? { trailing: meter } : {})}
        {...(cwd ? { cwd } : {})}
        {...(draft ? { draft } : {})}
      />

      {dropping && (
        <div className="pointer-events-none absolute inset-2 z-30 grid place-items-center rounded-2xl border-2 border-dashed border-faint bg-bg/85 text-[14px] text-muted">
          Drop to attach
        </div>
      )}

      {cwd && (
        <Workspace
          open={workspaceOpen}
          onClose={() => setWorkspaceOpen(false)}
          cwd={cwd}
          onMention={(path) => {
            setWorkspaceOpen(false);
            setDraftText({ text: `@${path} `, key: Date.now(), append: true });
          }}
        />
      )}
      <TrustSheet ask={trustAsk} {...(cwd ? { folder: cwd } : {})} {...(home ? { home } : {})} onDone={() => setTrustAsk(undefined)} />
      {sessionId && (
        <RewindSheet
          sessionId={sessionId}
          {...(rewinding ? { uuid: rewinding } : {})}
          {...(cwd ? { cwd } : {})}
          onClose={() => setRewinding(undefined)}
          onDone={(result) => {
            setRewinding(undefined);
            const count = result.files?.length ?? 0;
            setNote(`Put ${count} file${count === 1 ? '' : 's'} back as they were before that prompt. The conversation stays as it is.`);
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
