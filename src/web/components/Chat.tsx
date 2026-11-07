import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity, Archive, ArchiveRestore, BarChart3, CheckCircle2, ChevronDown, ChevronLeft, ChevronUp, Circle, CircleDot, Clock, CornerDownRight, Cpu, Download, FileDiff, Folder,
  Gauge, GitBranch, GitFork, Info, ListChecks, Loader2, type LucideIcon, MessagesSquare, Pencil, Pin, PinOff, Plug, Plus, ShieldCheck, SquareTerminal, TriangleAlert, X, Zap,
} from 'lucide-react';
import { type DragEvent, lazy, type ReactNode, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { OWN_EFFORT, startModeFor } from '../../shared/defaults';
import { pickerValue } from '../../shared/model-names';
import { MODE_INFO } from '../../shared/modes';
import { REWIND_BUSY } from '../../shared/rewind';
import { shortTitle } from '../../shared/titles';
import type { Attachment, BackgroundTask, Block, ChatMessage, RewindCheck, RewindRestore, RunSettings, RunState, ScheduledCheck, SendMode, SessionSummary, UsageLimit } from '../../shared/protocol';
import { announce, announcement, askedFor, type ChatMoment } from '../lib/announce';
import { api, ApiError, apiUrl, isDemoNote, isUnreachable, type TrustChoice, type TrustQuestion } from '../lib/api';
import { useDemoNote } from '../lib/demo';
import { commandOf, SESSION_ACTIONS } from '../lib/actions';
import { addWaiting, clearDraft, loadDraft, moveDraft, putBackWaiting, removeWaiting, saveDraft, takeWaiting, waitingOf } from '../lib/drafts';
import { newId } from '../lib/ids';
import { baseName, clockTime, shortPath, untilTime } from '../lib/format';
import { ariaKeys, closesPane, composing, hasKeyboard, isKey, type KeyId, withKey } from '../lib/keyboard';
import { type CommandItem, useCommandContext, useCommandPart } from '../lib/commands';
import { changeListed } from '../lib/list-changes';
import { retried } from '../lib/load';
import { cancelCheck, resend } from '../lib/next-steps';
import { type PathLinks, PathLinksContext } from '../lib/path-links';
import { defaultChange, forModel, modeNote, modelNote } from '../lib/defaults';
import { getPrefs, markSeen, nextView, saveSessionChoice, sessionChoice, setSessionView, usePrefs, VIEW_OPTIONS, viewMode, viewOf } from '../lib/prefs';
import { messageWith, olderQuote, promptGist, readMessage, sendNowMessage, type WaitingItem } from '../lib/quote';
import { CommentsChat } from '../lib/review';
import { fromRecorded, runningWith } from '../lib/settings';
import { addShell } from '../lib/shells';
import { socket } from '../lib/socket';
import type { Start } from '../lib/start';
import { INSTALL_URL, STATIC_DEMO } from '../lib/static-demo';
import { elsewhere, elsewherePlaceholder } from '../lib/status';
import {
  addLocalMessage,
  adoptView,
  getView,
  loadLatest,
  removeLocalMessage,
  setRewound,
  syncRun,
  useSessionView,
} from '../lib/store';
import { askForTerminal, RunInTerminal, TerminalShell, useTerminalsAvailable, useTerminalShell, wantTerminalFocus } from '../lib/terminals';
import { setSessionTitle } from '../lib/title';
import { currentTasks, type Todo } from '../lib/tools';
import { buildItems, splitFiles, type Item } from '../lib/turns';
import { revealWorkflow } from '../lib/workflows';
import { useWorkspaceStep } from '../lib/workspace-route';
import { Composer, type ComposerDraft, type ComposerHandle } from './Composer';
import { ContextPanel, ContextRing } from './ContextPanel';
import { McpSheet, useMcpServers } from './McpSheet';
import { MessageList } from './MessageList';
import { modelOf, SavedForNewSessions } from './ModelSheet';
import { StartIn } from './NewSession';
import { OfflineLine, retryNow, useOffline } from './Offline';
import { PaneColumn } from './PaneColumn';
import { keepAskedInView, PermissionCard } from './PermissionCard';
import { QueuedStrip } from './QueuedStrip';
import { RewindDialog, RewindPicker, type RewindPoint, type RewindProblem } from './Rewind';
import { type QuoteTarget, QuoteTargetContext } from './Quotes';
import { StatusBadge } from './SessionList';
import { showCommandMenu } from './CommandMenu';
import { exportSession, type MenuProblem, RenameSheet, SessionMenu } from './SessionMenu';
import { Sheet } from './Sheet';
import { SideChat, useSideChat, useSideChatAsked } from './SideChat';
import { type TrustAsk, TrustSheet } from './TrustSheet';
import { lineCount, shownTab, useWorkspacePane, Workspace } from './Workspace';
import type { WorkspaceTab } from '../lib/workspace-route';
import { usePlanLimits } from './PlanLimits';
import { prefetchWorkspace } from './WorkspaceTabs';

/**
 * /clear, /reset and /new, as in Claude Code: a fresh conversation in the same folder, going on
 * with the same settings, Bypass aside: then it starts in the mode a new session does. Handed to
 * the new session's view by its id.
 */
const CLEAR = /^\/(clear|reset|new)(\s|$)/;
const carried = new Map<string, RunSettings>();

const SETTING_KEYS = ['model', 'effort', 'fast', 'ultracode', 'permissionMode'] as const;

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

/**
 * How long Claude Code's check before a rewind may take before its dialog shows, as in Claude
 * Desktop: one answered sooner, with nothing to put back, rewinds the conversation at once.
 */
const REWIND_PAUSE_MS = 400;
/** How long Rewind's "unavailable while Claude is working" stays where Claude was not seen at work here. */
const REWIND_REFUSAL_MS = 5000;

/** Rewind to here being asked about: the message, and what its check says can go back. */
type RewindAsk = RewindPoint & { token: number; preview: RewindCheck | 'pending'; shown: boolean };

/** What a rewind puts in the box: the prompt's words, its files, and its quotes and comments waiting above. */
type InBox = { text: string; file: (attachment: Attachment) => boolean; items: WaitingItem[] };

/**
 * What a rewind to the prompt put in the box, read from the prompt itself: its words and quotes,
 * and its pictures and files, which the server saved again by these names (server/rewind.ts).
 */
function inBoxOf(prompt: ChatMessage | undefined): InBox | undefined {
  if (!prompt) return undefined;
  const { text: typed, files } = splitFiles(prompt.blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n\n'));
  const { items, text } = readMessage(typed);
  const pictures = prompt.blocks.filter((b) => b.type === 'image').length;
  const names = new Set(files.map((f) => f.name));
  return { text, items, file: (a) => names.has(a.name) || Array.from({ length: pictures }, (_, i) => `image-${i + 1}.`).some((n) => a.name.startsWith(n)) };
}

// Usage and activity loads when it is first opened, from Context.
const UsageSheet = lazy(() => retried(() => import('./Usage')).then((m) => ({ default: m.UsageSheet })));

/** The lines changed in the session's folder, as git counts them: "+31 −2". */
function Lines({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="font-mono text-[12px] tabular-nums">
      {added > 0 && <span className="text-add">+{added}</span>}
      {added > 0 && removed > 0 && ' '}
      {removed > 0 && <span className="text-del">−{removed}</span>}
    </span>
  );
}

/** A pane's quiet button in the header on a computer: Changes, Files, Terminal, with its name and key in its tooltip. */
function PaneButton({ icon: Icon, label, keyId, pressed, onClick, children, ref }: {
  icon: LucideIcon;
  label: string;
  keyId: KeyId;
  pressed: boolean;
  onClick: () => void;
  children?: ReactNode;
  ref?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      aria-keyshortcuts={ariaKeys(keyId)}
      title={withKey(label, keyId)}
      onClick={onClick}
      className={`relative flex h-9 shrink-0 items-center gap-1.5 rounded-full px-2.5 after:absolute after:-inset-y-0.5 after:inset-x-0 hover:bg-hover hover:text-fg ${pressed ? 'bg-hover text-fg' : 'text-muted'}`}
    >
      <Icon className="size-[18px] shrink-0" />
      {children}
    </button>
  );
}

/**
 * On a phone, the panes as tiles at the top of the title's menu, the first menu a newcomer opens:
 * Changes with its lines takes the room they need, so it shows them whole, "Changes +13 −1", as
 * the view's own tab does; the others share the rest.
 */
function PaneTiles({ lines, onPick }: { lines?: { added: number; removed: number }; onPick: (tab: WorkspaceTab) => void }) {
  const counted = Boolean(lines && (lines.added > 0 || lines.removed > 0));
  const tile = (tab: WorkspaceTab, Icon: LucideIcon, label: string, extra?: ReactNode) => (
    <button type="button" onClick={() => onPick(tab)} className="flex min-h-16 min-w-0 flex-col items-center justify-center gap-1 rounded-2xl bg-chip px-2 py-2 text-[14px] active:bg-hover">
      <Icon className="size-[18px] text-muted" />
      <span className="flex max-w-full items-baseline gap-1.5 truncate">{label}{extra}</span>
    </button>
  );
  return (
    <div className={`grid gap-2 px-1 pt-1 pb-2 ${counted ? 'grid-cols-[minmax(max-content,1.4fr)_1fr_1fr]' : 'grid-cols-3'}`}>
      {tile('changes', FileDiff, 'Changes', counted && lines ? <Lines {...lines} /> : undefined)}
      {tile('files', Folder, 'Files')}
      {tile('terminal', SquareTerminal, 'Terminal')}
    </div>
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

/** "1 in background", "3 in background · 1 scheduled": what Claude left running here, and the checks it stays running for. */
const inBackground = (tasks: number, scheduled: number) =>
  [tasks > 0 ? `${tasks} in background` : '', scheduled > 0 ? `${scheduled} scheduled` : ''].filter(Boolean).join(' · ');

/**
 * Background tasks (shells, agents and workflows Claude left running) and the check-ins Claude
 * scheduled, "1 in background", as Claude Code's /tasks lists them (⌃B opens them, as in Claude
 * Desktop, or /tasks). One shows as a row; more fold into a single row, so they never crowd the
 * conversation, and open into a short list. A command's row opens what it printed and stops it; an
 * agent's says what it is doing and leads to its card, which has Stop too; a workflow's leads to its
 * card, where its one Stop is.
 */
function BackgroundTasks({ sessionId, tasks, scheduled, open, setOpen, onCancel, ref }: {
  sessionId: string;
  tasks: BackgroundTask[];
  scheduled: ScheduledCheck[];
  /** The list open, folded into one row while there are more than one. */
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Asks Claude to cancel a check: it is Claude's to cancel, as in the CLI. */
  onCancel: (check: ScheduledCheck) => void;
  ref?: React.Ref<HTMLDivElement>;
}) {
  const [reading, setReading] = useState<BackgroundTask>();
  const stop = (id: string) => void api.stopTask(sessionId, id);
  const row = (task: BackgroundTask) => {
    // A workflow's Stop is on its card alone; an agent's and a workflow's row leads to the card.
    const workflow = task.type === 'local_workflow';
    const card = task.toolUseId;
    const words = (
      <>
        {task.description || 'Background task'}
        {task.summary && <span className="text-faint"> · {task.summary}</span>}
      </>
    );
    return (
      <div key={task.id} className="flex items-center gap-2 py-1 pr-1 pl-3 text-[12.5px] text-muted">
        <Pulse />
        {card ? (
          <button type="button" onClick={() => revealWorkflow(card)} title={workflow ? 'Show the workflow' : 'Show the agent'} className="relative flex min-w-0 flex-1 text-left after:absolute after:-inset-y-2 after:inset-x-0 hover:text-fg">
            <span className="min-w-0 truncate">{words}</span>
          </button>
        ) : <span className="min-w-0 flex-1 truncate">{words}</span>}
        {task.output && <button type="button" onClick={() => setReading(task)} className="relative h-7 shrink-0 rounded-full px-2.5 text-[12px] after:absolute after:-inset-y-2 after:inset-x-0 hover:bg-hover hover:text-fg">Output</button>}
        {!workflow && <button type="button" onClick={() => stop(task.id)} className="relative h-7 shrink-0 rounded-full px-2.5 text-[12px] after:absolute after:-inset-y-2 after:inset-x-0 hover:bg-hover hover:text-fg">Stop</button>}
      </div>
    );
  };
  // Claude stays running here for these; it says when the next one is due.
  const check = (item: ScheduledCheck) => (
    <div key={item.id} className="flex h-9 items-center gap-2 pr-1 pl-3 text-[12.5px] text-muted">
      <Clock className="size-3.5 shrink-0 text-faint" />
      <span className="min-w-0 flex-1 truncate">{item.what}</span>
      {item.next && <span className="shrink-0 text-faint tabular-nums">{clockTime(item.next)}</span>}
      <button type="button" title="Ask Claude to cancel it" onClick={() => onCancel(item)} className="relative h-7 shrink-0 rounded-full px-2.5 text-[12px] after:absolute after:-inset-y-2 after:inset-x-0 hover:bg-hover hover:text-fg">Cancel</button>
    </div>
  );
  const sheet = <TaskOutputSheet sessionId={sessionId} {...(reading ? { task: reading } : {})} onClose={() => setReading(undefined)} />;
  const label = inBackground(tasks.length, scheduled.length);
  if (tasks.length + scheduled.length === 1) {
    return <div ref={ref} role="region" aria-label={label} className="mx-auto mb-2 max-w-3xl rounded-full border border-line bg-panel">{tasks[0] ? row(tasks[0]) : check(scheduled[0]!)}{sheet}</div>;
  }
  if (tasks.length === 0) {
    return <div ref={ref} role="region" aria-label={label} className="mx-auto mb-2 max-w-3xl rounded-2xl border border-line bg-panel py-0.5">{scheduled.map(check)}</div>;
  }
  const latest = tasks.at(-1)!;
  return (
    <div ref={ref} role="region" aria-label={label} className="mx-auto mb-2 max-w-3xl">
      {open ? (
        <div className="rounded-2xl border border-line bg-panel py-1">
          <button type="button" aria-expanded onClick={() => setOpen(false)} className="flex h-8 w-full items-center gap-2 px-3 text-left text-[12.5px] text-muted hover:text-fg">
            <span className="min-w-0 flex-1 truncate">{label}</span>
            <ChevronDown className="size-4 shrink-0" />
          </button>
          <div className="max-h-[30vh] overflow-y-auto overscroll-contain">{tasks.map(row)}{scheduled.map(check)}</div>
        </div>
      ) : (
        <button type="button" aria-expanded={false} onClick={() => setOpen(true)} className="flex h-8 w-full items-center gap-2 rounded-full border border-line bg-panel px-3 text-left text-[12.5px] text-muted hover:text-fg">
          <Pulse />
          <span className="shrink-0 tabular-nums">{label}</span>
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

/**
 * While Claude waits for an answer, Claude's task list and what runs in the background fold into
 * this one line under its card, so the card and its buttons sit near the thumb and the conversation
 * keeps its room; a tap unfolds them until the card is answered.
 */
function FoldedBars({ tasks, background, onUnfold }: { tasks: Todo[]; background: string; onUnfold: () => void }) {
  const done = tasks.filter((t) => t.status === 'completed').length;
  const current = tasks.find((t) => t.status === 'in_progress');
  return (
    <button type="button" aria-expanded={false} onClick={onUnfold} className="relative mx-auto mb-2 flex h-8 w-full max-w-3xl items-center gap-2 rounded-full border border-line bg-panel px-3 text-left text-[12.5px] text-muted after:absolute after:-inset-y-1.5 after:inset-x-0 hover:text-fg">
      {tasks.length > 0 && (
        <>
          <ListChecks className="size-3.5 shrink-0" />
          <span className="shrink-0 tabular-nums">{done}/{tasks.length}</span>
          <span className="min-w-0 flex-1 truncate">{current ? current.activeForm || current.content : done === tasks.length ? 'All done' : 'Tasks'}</span>
        </>
      )}
      {background && (
        <span className={`flex min-w-0 items-center gap-2 ${tasks.length > 0 ? 'shrink-0' : 'flex-1'}`}>
          {tasks.length > 0 && <span aria-hidden className="text-faint">·</span>}
          <Pulse />
          <span className="truncate tabular-nums">{background}</span>
        </span>
      )}
      <ChevronUp className="size-4 shrink-0" />
    </button>
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
function Notice({ tone = 'info', children, onDismiss }: { tone?: 'info' | 'error'; children: React.ReactNode; onDismiss?: () => void }) {
  return (
    <div className={`mx-auto mb-2 flex max-w-3xl items-start gap-2 rounded-xl px-3 py-2 text-[12.5px] leading-snug ${tone === 'error' ? 'border border-line bg-panel text-danger' : 'text-muted'}`}>
      {tone === 'error' ? <TriangleAlert className="mt-px size-4 shrink-0" /> : <Info className="mt-px size-3.5 shrink-0" />}
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
  lead,
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
  /** Opens a new, empty session somewhere else, in place of this one (`push`: after it, Back comes back here). */
  onStartIn: (start: Start, push?: boolean) => void;
  /** Before the title, on a computer while the session list is hidden: the button that shows it. */
  lead?: ReactNode;
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
  // A side chat opened as a session of its own (from the list, a search, the usage page) is read
  // only here too, as its Claude is: questions, without files, `!` or `/` commands, nor anything
  // that changes files (Rewind, Edit, Commit and the like).
  const sideChat = Boolean(session?.sideChatOf);
  const [carry] = useState(() => {
    const settings = sessionId ? undefined : carried.get(viewId);
    carried.delete(viewId);
    return settings;
  });
  // A session's own settings; for a new session, what was picked for it here (or came with it),
  // the rest being what Claude Code's settings start it with (below).
  const [settings, setSettings] = useState<RunSettings>(() => {
    if (!sessionId) return carry ?? {};
    return runningWith(getView(sessionId).run) ?? sessionChoice(sessionId)?.settings ?? {};
  });
  const [draft, setDraftText] = useState<ComposerDraft>();
  const [note, setNote] = useState<string>();
  // A send that failed. `note`: not an error to show in red, but the demo saying what it does not
  // do, or the computer out of reach (the line under the header says so too).
  const [sendError, setSendError] = useState<{ text: string; note: boolean }>();
  const failed = (error: unknown) => setSendError({ text: (error as Error).message, note: isDemoNote(error) || isUnreachable(error) });
  // "Rewind is unavailable while Claude is working" holds while it works: it goes once Claude stops,
  // or, where it was not seen at work here (a message from another page took the session for a
  // moment), a few seconds after it was said.
  const rewindRefused = sendError?.text === REWIND_BUSY;
  const workedSinceRefused = useRef(false);
  useEffect(() => {
    if (!rewindRefused) {
      workedSinceRefused.current = false;
      return undefined;
    }
    if (busy) {
      workedSinceRefused.current = true;
      return undefined;
    }
    const timer = setTimeout(() => setSendError((now) => (now?.text === REWIND_BUSY ? undefined : now)), workedSinceRefused.current ? 0 : REWIND_REFUSAL_MS);
    return () => clearTimeout(timer);
  }, [rewindRefused, busy]);
  const [demoNote, dismissDemoNote] = useDemoNote(sessionId);
  // The title's menu, opened under the title (from the keyboard: its first action has focus).
  const [menu, setMenu] = useState<{ keys: boolean }>();
  const titleButton = useRef<HTMLButtonElement>(null);
  const [contextAt, setContextAt] = useState<Element | null>();
  const [mcpOpen, setMcpOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  // While Claude runs here its MCP servers are known at once: a failed one says so above the box.
  const mcp = useMcpServers(sessionId, Boolean(view.run) && !sideChat);
  const failedMcp = useMemo(() => (mcp.data?.live ? mcp.data.servers.filter((server) => server.status === 'failed').map((server) => server.name) : []), [mcp.data]);
  const [mcpSeen, setMcpSeen] = useState<string>();
  const [usageOpen, setUsageOpen] = useState(false);
  // Rewind to here, asked about (its dialog), and /rewind's list of messages.
  const [rewind, setRewind] = useState<RewindAsk>();
  const [rewindWork, setRewindWork] = useState<{ working: boolean; problem?: RewindProblem }>({ working: false });
  const [picking, setPicking] = useState(false);
  // What runs in the background here, its list open (⌃B, /tasks).
  const [backgroundOpen, setBackgroundOpen] = useState(false);
  // The card Claude waits on whose bars were unfolded (FoldedBars): they fold again for the next one.
  const [unfoldedFor, setUnfoldedFor] = useState<string>();
  const backgroundBar = useRef<HTMLDivElement>(null);
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
  // here. New sessions start as Claude Code's settings start them (Settings, lib/defaults.ts).
  const chosen = useRef(Boolean(carry));
  const runSettings = runningWith(view.run);
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
    else if (recorded) setSettings({ permissionMode: undefined, ...recorded });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, recordedKey, session?.lastActivity, Boolean(runSettings)]);

  // What Claude Code's settings start a new session with in its folder (a scratch session: none),
  // read as the session would; in a session, its folder's, for the model sheet. Nothing of
  // Pelican's own: a new session sends only what was picked for it, and the server asks Claude
  // Code for the rest (defaults.ts).
  const defaultsQuery = (folder: string | undefined) => ({
    queryKey: ['defaults', folder ?? ''],
    queryFn: () => api.defaults(folder),
    staleTime: 30_000,
    retry: false,
  });
  const defaultsFolder = sessionId ? session?.cwd || view.run?.cwd : scratch ? undefined : newCwd;
  const { data: defaults } = useQuery({ ...defaultsQuery(defaultsFolder), enabled: sessionId ? Boolean(defaultsFolder) : scratch || Boolean(newCwd) });
  const models = modelList?.models;
  const optionOf = (next: RunSettings) => models?.find((m) => m.value === (next.model ?? 'default'));
  /** A new session on `model`, as Claude Code's settings start it. */
  const startOn = (model: string): RunSettings => ({ model, ...(defaults ? forModel(defaults, model, models) : {}) });
  const startModel = defaults ? pickerValue(defaults.model.value, models) : 'default';
  const shown: RunSettings = sessionId ? settings : { ...startOn(settings.model ?? startModel), ...settings };
  /** The mode a new session in `folder` starts in on the model of `next`: Bypass only where Claude Code's settings say so. */
  const startModeIn = async (folder: string | undefined, next: RunSettings) =>
    queryClient.fetchQuery(defaultsQuery(folder)).then((d) => startModeFor(d, optionOf(next)), () => 'default' as const);
  /** What a branch, an edited earlier prompt or a /clear goes on with: these settings, Bypass only as a new session would start. */
  const branchSettings = async (): Promise<RunSettings> =>
    (settings.permissionMode === 'bypassPermissions' ? { ...settings, permissionMode: await startModeIn(cwd, settings) } : settings);

  // A pick of a model, an effort or fast mode is saved for new sessions too, as /model, /effort and
  // /fast save it in Claude Code; Max effort, Ultracode and the mode stay with the session.
  const [saveProblem, setSaveProblem] = useState<string>();
  const saveForNewSessions = (before: RunSettings, next: RunSettings) => {
    const change = defaultChange(before, next, defaults?.fast.perSession);
    if (!change) return;
    setSaveProblem(undefined);
    api.saveDefault(change, defaultsFolder)
      .then((fresh) => {
        queryClient.setQueryData(['defaults', defaultsFolder ?? ''], fresh);
        void queryClient.invalidateQueries({ queryKey: ['defaults'], predicate: (q) => q.queryKey[1] !== (defaultsFolder ?? '') });
      })
      .catch((error: Error) => setSaveProblem(isDemoNote(error) ? error.message : `Not saved for new sessions: ${error.message}`));
  };

  const changeSettings = (next: RunSettings) => {
    chosen.current = true;
    const before = shown;
    if (sessionId) {
      setSettings(next);
      // It stays with this session when you leave and come back.
      saveSessionChoice(sessionId, next);
      // A Claude running for this session switches now (from its next step), not at the next message.
      if (view.run) void api.applySettings(sessionId, next).catch(() => undefined);
    } else {
      // A new session keeps as picked what is not what Claude Code would start it with; a model
      // without Auto moving a worked-out Auto to Manual is no pick.
      const start = { ...startOn(next.model ?? startModel), model: startModel };
      const picks: RunSettings = {};
      for (const key of SETTING_KEYS) if (next[key] !== start[key]) Object.assign(picks, { [key]: next[key] });
      setSettings(picks);
    }
    saveForNewSessions(before, next);
  };

  /**
   * Sends a message. `from`: the message box, whose words go back to it if the message does not go,
   * and which takes along what waits above it (quotes, line comments, files); Send now in Changes
   * and files, what waits alone; a quote with its note sent at once from the note box (`reply`,
   * the whole message already), which waits again if it does not go; or the chat itself (Retry,
   * Compact, Cancel on a check-in), which leaves the box and what waits as they are.
   */
  const send = async (text: string, attachments: Attachment[], mode: SendMode, from: 'box' | 'comments' | 'chat' | 'request' | { reply: WaitingItem }, trust?: TrustChoice) => {
    setSendError(undefined);
    setNote(undefined);
    dismissDemoNote();
    if (sessionId && !sideChat && CLEAR.test(text) && cwd) {
      // Out of Bypass, the new conversation starts in the mode a new session does.
      const { permissionMode = 'default', ...rest } = settings;
      carried.set(`new:${cwd}`, permissionMode === 'bypassPermissions' ? rest : { ...rest, permissionMode });
      // Done with, as a sent message is: left as this session's draft, it would clear again.
      clearDraft(viewId, text);
      onStartIn({ cwd });
      return;
    }
    const uuid = newId();
    // What waits above the box goes with the next prompt sent from this chat, as quotes and line
    // comments do in Claude Desktop; a command takes none. Taken now, it goes with this message
    // only; it comes back if the message does not go.
    const box = from === 'box' || from === 'comments';
    // A reply sent from the note box is the message; one that waited again after a try that did
    // not go (the folder's trust asked first) leaves the list as it goes again.
    if (typeof from === 'object') takeWaiting(viewId, (item) => item.id === from.reply.id);
    const taken = box && !text.trimStart().startsWith('/') ? takeWaiting(viewId) : typeof from === 'object' ? [from.reply] : [];
    const said = box ? messageWith(taken, text) : text;
    // Queued, it waits in the strip above the composer: in the conversation once Claude gets it.
    if (!(busy && mode === 'queue')) addLocalMessage(viewId, localMessage(uuid, said, attachments));
    try {
      // An effort the model does not offer (High on a model without efforts) is not sent. A new
      // session sends what was picked for it; Claude Code's settings give the rest, on the server.
      const offered = modelOf(models, shown);
      const fit = (picked: RunSettings) => (picked.effort && picked.effort !== OWN_EFFORT && offered && !offered.efforts.includes(picked.effort) ? { ...picked, effort: undefined } : picked);
      // A new session's Default effort, picked where Claude Code's settings give another, is said as
      // Claude Code says it: its own for the model, as /effort auto gives it.
      const sent = fit(!sessionId && Object.hasOwn(settings, 'effort') && settings.effort === undefined ? { ...settings, effort: OWN_EFFORT } : settings);
      // A request from Changes says it waits for a turn the server may have under way that this
      // page has not heard of yet: never steered into it.
      const body = { text: said, attachments: attachments.map((a) => a.id), settings: sent, uuid, ...(busy || from === 'request' ? { mode } : {}), ...(trust ? { trust } : {}) };
      if (sessionId) {
        await api.send(sessionId, body);
        saveSessionChoice(sessionId, sent);
        if (from === 'box') clearDraft(viewId, text);
      } else if (newCwd || scratch) {
        const { sessionId: created } = await api.create({ ...body, ...(scratch ? { scratch: true } : { cwd: newCwd }) });
        saveSessionChoice(created, fit(shown));
        if (from === 'box') clearDraft(viewId, text);
        // What is left in the box, typed since or waiting above it to be put back, goes on with
        // the session it was for, not with the next new session in this folder.
        composer.current?.saveDraft();
        moveDraft(viewId, created);
        adoptView(viewId, created);
        void queryClient.invalidateQueries({ queryKey: ['sessions'] });
        onOpen(created, true);
      }
      // Trusted now, or kept to your settings: the folder's own settings count, or never will.
      if (trust) void queryClient.invalidateQueries({ queryKey: ['defaults'] });
    } catch (error) {
      // Nothing reached Claude: take the message back. What waited with it waits again; words from
      // the box go back to it, files and all, above anything typed since. What the chat sent leaves
      // the box be.
      removeLocalMessage(viewId, uuid);
      putBackWaiting(viewId, taken);
      const giveBack = () => {
        if (from === 'box') setDraftText({ text, attachments, key: Date.now(), back: true });
      };
      if (error instanceof ApiError && error.trust) {
        // The folder has programs of its own and nobody trusted it: ask, then send it again. Only
        // the first answer counts: a double tap on the sheet must not start two Claudes.
        let settled = false;
        const once = (then: () => void) => {
          if (settled) return;
          settled = true;
          then();
        };
        setTrustAsk({
          brings: error.trust.brings,
          commands: error.trust.commands,
          more: error.trust.more,
          answer: (choice) => once(() => void send(text, attachments, mode, from, choice)),
          cancel: () => once(giveBack),
        });
        return;
      }
      failed(error);
      giveBack();
    }
  };

  const firstPrompt = view.messages.find((m) => m.role === 'user' && m.blocks.some((b) => b.type === 'text'));
  const firstText = firstPrompt?.blocks.find((b) => b.type === 'text');
  // Before the list has it, a new session is called by its first prompt, shortened as the server does.
  const title = session?.title ?? (firstText?.type === 'text' ? shortTitle(promptGist(firstText.text)) : scratch ? 'New scratch session' : newCwd ? 'New session' : '');
  const cwd = session?.cwd || view.run?.cwd || newCwd;
  const workspace = useWorkspacePane(Boolean(cwd));
  // A side chat has none of its own. Beside the conversation it shares a column with Changes, Files
  // and the Terminal: under them from 1280px, in their place below that (PaneColumn).
  const composer = useRef<ComposerHandle>(null);
  const side = useSideChat(sessionId, Boolean(sessionId) && !sideChat, workspace, () => composer.current?.focus());
  /** The side chat's message box, where a passage taken for it waits for the question. */
  const sideBox = sessionId ? `side:${sessionId}` : undefined;
  // Quotes taken in the conversation go to this chat's message box; Send now in the note box sends
  // one at once, a steer while Claude works; Start a side chat takes one to the side chat.
  const sendReply = useRef<(item: WaitingItem) => void>(() => {});
  sendReply.current = (item) => void send(sendNowMessage(item.text, item.note ?? ''), [], 'steer', { reply: item });
  const { open: sideOpen, show: showSide, start: startSide } = side;
  // Asked for from the session's row in the list.
  const showSideNow = useCallback(() => showSide(), [showSide]);
  useSideChatAsked(sideChat ? undefined : sessionId, showSideNow);
  const quoteTarget = useMemo<QuoteTarget>(() => ({
    chat: viewId,
    sendNow: (item) => sendReply.current(item),
    focusBox: () => composer.current?.focus(),
    ...(sideBox && !sideChat ? { sideChat: { open: sideOpen, start: startSide } } : {}),
  }), [viewId, sideBox, sideChat, sideOpen, startSide]);
  // Under 1280px the side chat, asked for last, takes the pane's place beside the conversation; the pane waits behind it.
  const paneShown = workspace.open && !side.hidesPane;
  const permissions = view.run?.permissions ?? [];
  // One request at a time, the oldest first, as Claude Code asks: the rest wait behind it.
  const request = permissions[0];
  // Another app working on the session, or waiting there for an answer, is what the session is
  // doing, also while Claude is idle here: the status says it, the same way the list does.
  const other = elsewhere(session, view.run);
  const otherAtWork = other && other.situation !== 'open' ? other : undefined;
  const status = permissions.length > 0 ? 'waiting' : busy ? 'running'
    : otherAtWork ? (otherAtWork.situation === 'waiting' ? 'waiting' : 'live')
      : view.run ? 'idle' : session?.status ?? 'idle';
  // Between turns: background tasks and subagents still running, and the checks Claude stays running for.
  const working = view.run ? (busy ? 0 : (view.run.tasks?.length ?? 0) + (view.run.scheduled?.length ?? 0)) : session?.tasks ?? 0;

  // A `!` command: it runs in the session's folder, its output shows in the conversation as it
  // comes, and once done Claude answers it, as in the CLI. A folder nobody trusted is asked about
  // first, as for a message.
  const shell = async (command: string, trust?: TrustChoice) => {
    if (!sessionId) return;
    setSendError(undefined);
    try {
      addShell(sessionId, (await api.shell(sessionId, command, trust)).shell);
      clearDraft(viewId, `!${command}`);
    } catch (error) {
      if (error instanceof ApiError && error.trust) {
        let settled = false;
        setTrustAsk({
          brings: error.trust.brings,
          commands: error.trust.commands,
          more: error.trust.more,
          answer: (choice) => {
            if (!settled) void shell(command, choice);
            settled = true;
          },
          cancel: () => {
            if (!settled) setDraftText({ text: `!${command}`, key: Date.now(), back: true });
            settled = true;
          },
        });
        return;
      }
      failed(error);
      setDraftText({ text: `!${command}`, key: Date.now(), back: true });
    }
  };

  // An API error the conversation ends on: its prompt goes again, with its pictures and files.
  const sendAgain = (prompt: Extract<Item, { kind: 'user' }>) => {
    setSendError(undefined);
    void resend(prompt).then(({ text, attachments }) => send(text, attachments, prefs.sendWhileBusy, 'chat'), failed);
  };

  /**
   * Rewind to here, as in Claude Desktop: Claude Code's check of what the code would get back runs
   * first. When no file changed after the message and the check answered at once, the conversation
   * goes back at once: one tap, with Undo rewind at the cut. Otherwise its dialog asks, offering the
   * three choices where files changed, from the moment the check has taken a while.
   */
  const rewindToken = useRef(0);
  // What a rewind put in the box, for Undo rewind to take back while it is as it was; after a
  // reload, what the prompt, back in the conversation, would have put there.
  const backInBox = useRef<InBox>(undefined);
  const closeRewind = () => {
    rewindToken.current += 1;
    setRewind(undefined);
    setRewindWork({ working: false });
  };
  const doRewind = async (target: { token: number; uuid: string }, restore: RewindRestore, asked: boolean) => {
    if (!sessionId) return;
    setRewindWork({ working: true });
    try {
      const done = await api.rewind(sessionId, target.uuid, restore);
      // Done, whatever happened to the dialog meanwhile.
      if (rewindToken.current === target.token) closeRewind();
      if (done.prompt) {
        // The conversation ends before the message, and its words, quotes and files are back in the box.
        setRewound(viewId, { prompt: target.uuid, at: Date.now() });
        const { items, text } = readMessage(done.prompt.text);
        putBackWaiting(viewId, items);
        if (text || done.prompt.attachments.length > 0) setDraftText({ text, attachments: done.prompt.attachments, key: Date.now(), back: true });
        const ids = done.prompt.attachments.map((a) => a.id);
        backInBox.current = { text, file: (a) => ids.includes(a.id), items };
      }
      if (done.skipped) {
        setNote(`Restored the code, but skipped ${done.skipped === 1 ? '1 file' : `${done.skipped} files`} that couldn’t be safely written. Skipped files were left untouched.`);
      } else if (restore === 'code') {
        setNote('Code restored');
      }
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      if (restore !== 'conversation') {
        void queryClient.invalidateQueries({ queryKey: ['git', cwd] });
        void queryClient.invalidateQueries({ queryKey: ['changes', sessionId] });
      }
    } catch (error) {
      const problem = { text: (error as Error).message, note: isDemoNote(error) };
      // Said in the dialog when it is up; a rewind that asked nothing says it where the chat says such things.
      if (asked && rewindToken.current === target.token) setRewindWork({ working: false, problem });
      else {
        if (rewindToken.current === target.token) closeRewind();
        setSendError(problem);
      }
    }
  };
  const requestRewind = (point: RewindPoint, trust?: TrustChoice) => {
    if (!sessionId) return;
    setSendError(undefined);
    if (busy) {
      setSendError({ text: REWIND_BUSY, note: true });
      return;
    }
    rewindToken.current += 1;
    const token = rewindToken.current;
    const started = performance.now();
    setRewindWork({ working: false });
    setRewind({ token, ...point, preview: 'pending', shown: false });
    // Desktop's pause: a check that answers within it asks nothing it need not.
    setTimeout(() => setRewind((now) => (now?.token === token ? { ...now, shown: true } : now)), REWIND_PAUSE_MS);
    api.rewindCheck(sessionId, point.uuid, trust).then((check) => {
      if (rewindToken.current !== token) return;
      if (check.files.length === 0 && check.conversationStays) {
        closeRewind();
        setSendError({ text: check.conversationStays, note: true });
      } else if (check.files.length === 0 && performance.now() - started < REWIND_PAUSE_MS) {
        setRewind(undefined);
        void doRewind({ token, uuid: point.uuid }, 'conversation', false);
      } else {
        setRewind({ token, ...point, preview: check, shown: true });
      }
    }, (error: unknown) => {
      if (rewindToken.current !== token) return;
      closeRewind();
      // Its check starts the session's Claude: in a folder nobody trusted, as a message does, it asks first.
      if (error instanceof ApiError && error.trust) {
        let settled = false;
        setTrustAsk({
          brings: error.trust.brings,
          commands: error.trust.commands,
          more: error.trust.more,
          answer: (choice) => {
            if (!settled) requestRewind(point, choice);
            settled = true;
          },
          cancel: () => {
            settled = true;
          },
        });
        return;
      }
      failed(error);
    });
  };
  // Undo rewind: the messages come back, the files stay as they are, and the words the rewind put in
  // the box go back out of it, while they are as they were.
  const undoRewind = async () => {
    if (!sessionId) return;
    setSendError(undefined);
    const cut = getView(viewId).rewound;
    try {
      await api.undoRewind(sessionId);
      await setRewound(viewId, undefined);
      const back = backInBox.current ?? inBoxOf(getView(viewId).messages.find((m) => m.uuid === cut?.prompt));
      backInBox.current = undefined;
      if (back) {
        composer.current?.takeBack(back.text, back.file);
        for (const item of waitingOf(viewId)) if (back.items.some((b) => b.kind === item.kind && b.text === item.text && b.note === item.note)) removeWaiting(viewId, item.id);
      }
    } catch (error) {
      failed(error);
    }
  };
  // Rewound here or in another page, or no longer: the turns Changes lists end at the cut, or do not.
  const cutAt = view.rewound?.prompt;
  const lastCut = useRef(cutAt);
  useEffect(() => {
    if (lastCut.current === cutAt) return;
    lastCut.current = cutAt;
    if (sessionId) void queryClient.invalidateQueries({ queryKey: ['changes', sessionId] });
  }, [cutAt, sessionId, queryClient]);
  // /rewind's list: the prompts that began turns, oldest first.
  const rewindPoints = useMemo<RewindPoint[]>(() => (picking ? buildItems(view.messages, machine).flatMap((item) => (
    item.kind === 'user' && !item.command && !item.steered && !item.pending
      ? [{ uuid: item.key, text: promptGist(item.text).trim() || item.files.map((f) => f.name).join(', ') || 'A picture', ...(item.timestamp ? { timestamp: item.timestamp } : {}) }]
      : []
  )) : []), [picking, view.messages, machine]);

  // The pane's tabs load once the conversation is up, ready before they are asked for.
  useEffect(() => {
    if (!cwd) return undefined;
    const timer = setTimeout(prefetchWorkspace, 1500);
    return () => clearTimeout(timer);
  }, [cwd]);

  // All of the changes in the session's folder, as Claude Code's /diff counts them (the branch
  // against where it split from the default branch when it has commits beyond it, else what is not
  // committed), for the Changes button's lines: read when the chat opens and as each turn ends;
  // Changes and files reads it more often only while it is looked at.
  const { data: git } = useQuery({ queryKey: ['git', cwd, 'base'], queryFn: () => api.git(cwd!, 'base'), enabled: Boolean(cwd) });
  // What each turn changed, from Claude Code's records: for the line under a turn, and Show in Changes.
  const { data: turnChanges } = useQuery({ queryKey: ['changes', sessionId], queryFn: () => api.changes(sessionId!), enabled: Boolean(sessionId), staleTime: 30_000 });
  useEffect(() => {
    if (!busy && cwd) void queryClient.invalidateQueries({ queryKey: ['git', cwd] });
    if (!busy && sessionId) void queryClient.invalidateQueries({ queryKey: ['changes', sessionId] });
  }, [busy, cwd, sessionId, queryClient]);
  // Paths in the conversation, and in a side chat's answers, open their file in Changes and files,
  // at their line; a turn's line its changes. The side chat makes way first, wherever it is.
  const { show: showWorkspace } = workspace;
  const { makeWay } = side;
  const terminalsHere = useTerminalsAvailable();
  const links = useMemo<PathLinks | undefined>(() => cwd ? {
    cwd,
    openFile: (path, line) => makeWay(() => showWorkspace({ tab: 'files', path, ...(line ? { line } : {}) })),
    openChanges: (path) => makeWay(() => showWorkspace({ tab: 'changes', path })),
    ...(git?.repo ? { changed: new Set(git.files.map((f) => f.path)) } : {}),
    ...(terminalsHere ? {
      openTerminal: (folder: string) => {
        askForTerminal(folder ? `${cwd.replace(/\/$/, '')}/${folder.replace(/\/$/, '')}` : cwd);
        wantTerminalFocus();
        makeWay(() => showWorkspace({ tab: 'terminal' }));
      },
    } : {}),
    openTurn: (uuid) => makeWay(() => showWorkspace({ tab: 'changes', scope: uuid })),
    ...(turnChanges ? { turns: turnChanges.turns, lines: turnChanges.lines } : {}),
  } : undefined, [cwd, showWorkspace, makeWay, turnChanges, terminalsHere, git]);

  // Ctrl+` shows the terminal and gives it the keys, as in Claude Desktop; pressed in the terminal,
  // it hides it and the message box has them again. Ctrl+Shift+` opens a new terminal in the
  // session's folder, as Desktop's New terminal does. The side chat makes way first.
  const paneTab = shownTab(useWorkspaceStep());
  const { setOpen: setPaneOpen } = workspace;
  useEffect(() => {
    if (!cwd) return undefined;
    const onKey = (e: KeyboardEvent) => {
      const fresh = isKey(e, 'newTerminal');
      if ((!fresh && !isKey(e, 'terminal')) || e.repeat || composing(e) || document.querySelector('dialog[open]')) return;
      e.preventDefault();
      const inTerminal = e.target instanceof Element && Boolean(e.target.closest('[data-terminal]'));
      if (!fresh && paneShown && paneTab === 'terminal' && inTerminal) {
        setPaneOpen(false);
        composer.current?.focus();
        return;
      }
      // The tab starts it once it knows terminals run here, and otherwise says why.
      if (fresh) askForTerminal(cwd);
      wantTerminalFocus();
      makeWay(() => showWorkspace({ tab: 'terminal' }));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cwd, paneShown, paneTab, setPaneOpen, makeWay, showWorkspace]);
  // Cmd/Ctrl+\ closes a pane beside the conversation from anywhere on the page, as ⌘/ lists it: the
  // one it is pressed in (which closes itself), else the one asked for last of the side chat and
  // Changes, Files or the Terminal.
  const { docked: sideDocked, front: sideFront, close: closeSide } = side;
  const paneDocked = workspace.docked && paneShown;
  useEffect(() => {
    if (!sideDocked && !paneDocked) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (!closesPane(e) || e.repeat || e.defaultPrevented || composing(e) || document.querySelector('dialog[open]:not([data-closing])')) return;
      e.preventDefault();
      if (sideDocked && (!paneDocked || sideFront === 'side')) closeSide();
      else setPaneOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sideDocked, paneDocked, sideFront, closeSide, setPaneOpen]);
  // Run in terminal, from a command in a reply or a step, once asked: a new terminal in the
  // session's folder runs it, in the shell the terminal runs.
  const terminals = useTerminalsAvailable();
  const terminalShell = useTerminalShell();
  const runInTerminal = useMemo(() => (cwd && terminals ? (command: string) => {
    askForTerminal(cwd, command);
    makeWay(() => showWorkspace({ tab: 'terminal' }));
  } : undefined), [cwd, terminals, makeWay, showWorkspace]);
  // The trust sheet, for a terminal in a folder nobody trusted that brings programs.
  const askTrust = useCallback(({ brings, commands, more }: TrustQuestion) => new Promise<TrustChoice | undefined>((resolve) => {
    let settled = false;
    const once = (choice?: TrustChoice) => {
      if (settled) return;
      settled = true;
      resolve(choice);
    };
    setTrustAsk({ brings, commands, more, answer: (choice) => once(choice), cancel: () => once() });
  }), []);

  const tasks = useMemo(
    () => (sessionId && view.offset > 0 ? detail?.tasks ?? [] : currentTasks(view.messages)),
    [sessionId, view.offset, view.messages, detail?.tasks],
  );
  // A side chat's tasks are the copy of its session's, not work of its own.
  const showTasks = !sideChat && tasks.length > 0 && (busy || tasks.some((t) => t.status !== 'completed'));
  const inBackgroundNow = Boolean(sessionId) && (view.run?.tasks?.length ?? 0) + (view.run?.scheduled?.length ?? 0) > 0;
  // While Claude waits for an answer, the two fold into one line under its card, until unfolded.
  const folded = Boolean(request) && unfoldedFor !== request?.id && (showTasks || inBackgroundNow);

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
  // The message box's height, for a card's foot to stay just above it where the whole chat scrolls
  // (a phone on its side, PermissionCard); and there, a card that comes is scrolled to, its foot in
  // view, as it is anywhere else at once.
  useLayoutEffect(() => {
    const el = root.current;
    const box = el?.querySelector<HTMLElement>(':scope > [data-composer]');
    if (!el || !box || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => el.style.setProperty('--composer-h', `${box.offsetHeight}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, []);
  const asking = request?.id;
  useEffect(() => {
    const el = root.current;
    if (!asking || !el) return undefined;
    const short = window.matchMedia('(max-height: 380px)');
    let frame = 0;
    // Where the whole chat scrolls, its start at the top, its foot above the message box: as much of
    // it as there is room for. Anywhere, the start of what it asks about above its buttons.
    const show = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const card = el.querySelector('[data-dock] section');
        if (!card) return;
        if (short.matches) el.scrollTop += card.getBoundingClientRect().top - el.getBoundingClientRect().top;
        const scroller = short.matches ? el : el.querySelector<HTMLElement>('[data-dock]');
        if (scroller) keepAskedInView(scroller, card);
      });
    };
    show();
    // Turned on its side, or upright again, while the card waits: shown so again.
    short.addEventListener?.('change', show);
    return () => {
      cancelAnimationFrame(frame);
      short.removeEventListener?.('change', show);
    };
  }, [asking]);
  useEffect(() => {
    if (!busy || !sessionId) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.repeat || composing(e) || document.querySelector('dialog[open]')) return;
      const target = e.target instanceof HTMLElement ? e.target : undefined;
      if (target && target !== document.body && !root.current?.contains(target)) return;
      if (target?.matches('input, textarea, select, [contenteditable="true"]') && !target.matches('[aria-label="Message Claude"], [aria-label="Side question"]')) return;
      e.preventDefault();
      void api.interrupt(sessionId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, sessionId]);

  // Ctrl+O steps through the transcript views, as in Claude Desktop (Ctrl on a Mac too); Thinking
  // comes in once Claude has thought here.
  const thought = useMemo(() => view.messages.some((m) => m.blocks.some((b) => b.type === 'thinking' && b.thinking.trim() !== '')), [view.messages]);
  useEffect(() => {
    if (!sessionId) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'o' || e.defaultPrevented || composing(e) || document.querySelector('dialog[open]')) return;
      e.preventDefault();
      setSessionView(sessionId, nextView(viewOf(getPrefs(), sessionId), thought));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sessionId, thought]);

  // Files dropped anywhere on the conversation go to the composer.
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
  // By Send once a turn has run, as in Desktop: on a phone faint and without its number below 60%.
  const ring = context && sessionId ? <ContextRing context={context} quiet={!wide && context.percent < 60} onClick={(at) => setContextAt(at)} /> : undefined;
  // What git counts as changed in the folder, in lines: the Changes button's "+31 −2".
  const lines = useMemo(() => (git?.repo ? { ...lineCount(git.files), files: git.files.length } : undefined), [git]);
  const showPane = (tab: WorkspaceTab) => {
    if (tab === 'terminal') wantTerminalFocus();
    makeWay(() => showWorkspace({ tab }));
  };
  /** A pane's button: shows its tab, or hides the pane when that tab is what it shows. */
  const togglePane = (tab: WorkspaceTab) => (paneShown && paneTab === tab ? workspace.setOpen(false) : showPane(tab));
  const { bars: planBars } = usePlanLimits(usageOpen);

  const subtitle = useMemo(() => (cwd ? shortPath(cwd, home) : scratch ? 'A new folder in ~/scratch' : ''), [cwd, home, scratch]);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['session', sessionId] });
    void queryClient.invalidateQueries({ queryKey: ['sessions'] });
  };

  // Another folder picked for a new session before it starts: what is typed goes along, and so
  // do the settings picked here, but Bypass, which was picked for the other folder.
  const startIn = (start: Start) => {
    const next = `new:${'scratch' in start ? 'scratch' : start.cwd}`;
    // The folder it is in already: nothing moves, and nothing is set aside for a later new session there.
    if (next === viewId) return;
    composer.current?.saveDraft();
    moveDraft(viewId, next);
    if (chosen.current) {
      const { permissionMode, ...rest } = settings;
      carried.set(next, permissionMode && permissionMode !== 'bypassPermissions' ? { ...rest, permissionMode } : rest);
    }
    onStartIn(start);
  };

  // This session's, by Claude Code's names, for the / list and ⌘K, and their keys (lib/commands).
  const fork = () => {
    if (!sessionId) return;
    api.fork(sessionId)
      .then((id) => {
        if (!id) return;
        void queryClient.invalidateQueries({ queryKey: ['sessions'] });
        // A fork is new work: it carries this session's settings, except Bypass.
        return branchSettings().then((next) => {
          saveSessionChoice(id, next);
          onOpen(id);
        });
      })
      .catch((error: Error) => setSendError({ text: error.message, note: isDemoNote(error) }));
  };
  const archive = (archived: boolean) => {
    if (!session) return;
    void changeListed(queryClient, session, { archived }).catch(() => undefined);
    // Archived, it leaves for the list, which offers Undo.
    if (archived) onBack();
  };
  const rename = (words: string) => {
    if (!sessionId) return;
    if (!words) {
      setRenaming(true);
      return;
    }
    api.rename(sessionId, words).then(refresh, (error: Error) => setSendError({ text: error.message, note: isDemoNote(error) }));
  };
  // Fork from here, on a prompt: a new session up to just before it, the prompt's words in its box,
  // its quotes waiting above it and its files and pictures attached, as Desktop's Fork from here
  // does. The first prompt has nothing before it: a new session in the same folder, with them.
  const forkFrom = (prompt: Extract<Item, { kind: 'user' }>) => {
    if (!sessionId) return;
    api.forkBefore(sessionId, prompt.key)
      .then(async ({ sessionId: id, prompt: back }) => {
        const { items: waiting, text } = readMessage(back.text);
        const fill = (view: string) => {
          // What was typed there and not sent stays, the prompt's words after it, as words added to a box go.
          const kept = loadDraft(view);
          const words = kept?.text.trim() ? `${kept.text.replace(/\s+$/, '')}\n\n${text}` : text;
          saveDraft(view, words, [...(kept?.attachments ?? []), ...back.attachments], kept?.held ?? []);
          putBackWaiting(view, waiting);
        };
        const next = await branchSettings();
        if (id) {
          void queryClient.invalidateQueries({ queryKey: ['sessions'] });
          saveSessionChoice(id, next);
          fill(id);
          onOpen(id);
        } else if (cwd) {
          carried.set(`new:${cwd}`, next);
          fill(`new:${cwd}`);
          onStartIn({ cwd }, true);
        }
      })
      .catch((error: Error) => setSendError({ text: error.message, note: isDemoNote(error) }));
  };
  // Fork from here, on a reply: a new session up to the end of it.
  const forkReply = (upTo: string) => {
    if (!sessionId) return;
    api.fork(sessionId, { upTo })
      .then(async (id) => {
        if (!id) return;
        void queryClient.invalidateQueries({ queryKey: ['sessions'] });
        saveSessionChoice(id, await branchSettings());
        onOpen(id);
      })
      .catch((error: Error) => setSendError({ text: error.message, note: isDemoNote(error) }));
  };
  const showContext = () => setContextAt(root.current?.querySelector('[data-context-ring]') ?? null);
  // ⌃B, as in Claude Desktop, and /tasks, as Claude Code names it: what runs in the background here,
  // its list open with the keys in it, or closed again from there; with nothing running, said so.
  const showBackground = () => {
    const run = getView(viewId).run;
    if ((run?.tasks?.length ?? 0) + (run?.scheduled?.length ?? 0) === 0) {
      setNote('Nothing runs in the background here.');
      return;
    }
    if (backgroundBar.current?.contains(document.activeElement)) {
      setBackgroundOpen(false);
      composer.current?.focus();
      return;
    }
    // Folded under a card Claude waits on, they unfold first.
    setUnfoldedFor(getView(viewId).run?.permissions?.[0]?.id);
    setBackgroundOpen(true);
    requestAnimationFrame(() => backgroundBar.current?.querySelector<HTMLElement>('button')?.focus());
  };
  const act = useRef({ fork, archive, rename, showPane, togglePane, showContext, showBackground, send, settings: shown, models });
  act.current = { fork, archive, rename, showPane, togglePane, showContext, showBackground, send, settings: shown, models };
  const linesWords = lines ? [lines.added > 0 ? `+${lines.added}` : '', lines.removed > 0 ? `−${lines.removed}` : ''].filter(Boolean).join(' ') : '';
  const contextWords = context ? `${context.percent}%` : '';
  const pinned = Boolean(session?.pinned);
  const archived = Boolean(session?.archived);
  const commandItems = useMemo<CommandItem[]>(() => {
    if (!sessionId) return [];
    const mine: CommandItem[] = [];
    const add = (item: CommandItem) => mine.push(item);
    if (!sideChat) add({ id: 'side-chat', group: 'session', label: 'Side chat', icon: MessagesSquare, name: 'btw', description: 'Ask in side chat', key: 'sideChat', needsWords: true, run: (words) => side.show(words) });
    add({ id: 'fork', group: 'session', label: 'Fork', icon: GitFork, name: 'branch', description: 'Fork from here · new session', key: 'fork', run: () => act.current.fork() });
    // /rewind, as Claude Code names it (lib/actions): which message to go back to before.
    const rewinding = sideChat ? undefined : commandOf(SESSION_ACTIONS, 'rewind', { title: '', archived: false, pinned: false, from: 'title', rewind: () => setPicking(true) }, hasKeyboard() ? 'pointer' : 'touch');
    if (rewinding) add({ group: 'session', aliases: ['checkpoint', 'undo'], ...rewinding, run: () => rewinding.run() });
    add({ id: 'rename', group: 'session', label: 'Rename', icon: Pencil, name: 'rename', description: 'Rename this session', key: 'rename', run: (words) => act.current.rename(words) });
    add({ id: 'export', group: 'session', label: 'Export', icon: Download, name: 'export', description: 'Export', run: () => exportSession(sessionId, session?.title) });
    if (cwd) add({ id: 'changes', group: 'session', label: 'Changes', icon: FileDiff, name: 'diff', description: linesWords ? `Changes · ${linesWords}` : 'Changes', key: 'changes', run: () => act.current.showPane('changes') });
    add({ id: 'context', group: 'session', label: 'Context', icon: Gauge, name: 'context', description: contextWords ? `Context · ${contextWords}` : 'Context', run: () => act.current.showContext() });
    if (!sideChat) {
      add({ id: 'mcp', group: 'session', label: 'MCP servers', icon: Plug, name: 'mcp', description: 'MCP servers', run: () => setMcpOpen(true) });
      add({ id: 'model', group: 'session', label: 'Model', icon: Cpu, name: 'model', description: 'Model, effort and speed', key: 'model', run: () => composer.current?.openSheet('model') });
      add({ id: 'effort', group: 'session', label: 'Effort', icon: Gauge, name: 'effort', description: 'Effort', key: 'effort', run: () => composer.current?.openSheet('model') });
      add({
        id: 'fast', group: 'session', label: 'Fast mode', icon: Zap, name: 'fast', description: 'Fast mode on or off', key: 'fastMode',
        run: () => {
          const { settings: now, models: offered } = act.current;
          if (modelOf(offered, now)?.supportsFast) changeSettings({ ...now, fast: !now.fast });
          else composer.current?.openSheet('model');
        },
      });
      add({ id: 'mode', group: 'session', label: 'Mode', icon: ShieldCheck, description: 'Permission mode', key: 'mode', run: () => composer.current?.openSheet('mode') });
    }
    if (!sideChat) add({ id: 'tasks', group: 'session', label: 'Background tasks', icon: Activity, name: 'tasks', aliases: ['bashes'], description: 'Background tasks', key: 'backgroundTasks', run: () => act.current.showBackground() });
    add({ id: 'usage', group: 'session', label: 'Usage and activity', icon: BarChart3, name: 'usage', description: 'Usage and activity', run: () => setUsageOpen(true) });
    if (session) {
      add({ id: 'pin', group: 'pelican', label: pinned ? 'Unpin' : 'Pin', icon: pinned ? PinOff : Pin, run: () => void changeListed(queryClient, session, { pinned: !pinned }).catch(() => undefined) });
      add({ id: 'archive', group: 'pelican', label: archived ? 'Unarchive' : 'Archive', icon: archived ? ArchiveRestore : Archive, key: 'archive', run: () => act.current.archive(!archived) });
    }
    if (cwd) {
      add({ id: 'files', group: 'pelican', label: 'Files', icon: Folder, key: 'files', run: () => act.current.showPane('files') });
      add({ id: 'terminal', group: 'pelican', label: 'Terminal', icon: SquareTerminal, key: 'terminal', run: () => act.current.showPane('terminal') });
    }
    if (cwd && !sideChat) {
      add({
        id: 'new-session', group: 'pelican', label: 'New session', icon: Plus, name: 'new', aliases: ['clear', 'reset'], description: 'New session in this folder', key: 'newSession',
        run: () => void act.current.send('/new', [], 'steer', 'chat'),
      });
    }
    return mine;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, sideChat, cwd, session?.title, linesWords, contextWords, pinned, archived, Boolean(session)]);
  useCommandPart('chat', commandItems);
  const commandContext = useMemo(() => ({ ...(cwd ? { cwd } : {}), putInBox: (text: string) => composer.current?.putText(text) }), [cwd]);
  useCommandContext(commandContext);

  // Desktop's keys for this session: ⌥⌘R renames it, ⌥⌘O forks it, ⌥⌘A archives it, ⇧⌘F shows its
  // files, ⌃B its background tasks (Ctrl+Alt+B off a Mac), while no sheet or menu is open. A key
  // typed in the terminal is the shell's (tmux's Ctrl+B).
  const archivedNow = useRef(archived);
  archivedNow.current = archived;
  useEffect(() => {
    if (!sessionId) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.defaultPrevented || composing(e) || document.querySelector('dialog[open]:not([data-closing])')) return;
      if (isKey(e, 'rename')) act.current.rename('');
      else if (isKey(e, 'fork')) act.current.fork();
      else if (isKey(e, 'archive')) act.current.archive(!archivedNow.current);
      else if (isKey(e, 'files') && cwd) act.current.togglePane('files');
      else if (isKey(e, 'backgroundTasks') && !sideChat && !(e.target instanceof Element && e.target.closest('[data-terminal]'))) act.current.showBackground();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sessionId, cwd, sideChat]);

  return (
    <PathLinksContext.Provider value={links}>
    <RunInTerminal.Provider value={runInTerminal}>
    <TerminalShell.Provider value={terminalShell}>
    <CommentsChat.Provider value={viewId}>
    <div ref={root} className={`relative flex h-full min-h-0 flex-col [@media(max-height:380px)]:scroll-pt-12 [@media(max-height:380px)]:scroll-pb-[calc(var(--composer-h,0px)+5rem)] [@media(max-height:380px)]:overflow-y-auto ${workspace.docked || side.docked ? 'pr-(--pane-w)' : ''}`} {...(sideChat ? {} : dropHandlers)}>
      <header className="flex shrink-0 items-center gap-0.5 border-b border-line bg-bg/95 px-2 py-1.5 backdrop-blur">
        {!wide && (
          <button type="button" aria-label="Back to sessions" onClick={onBack} className="relative grid size-10 shrink-0 place-items-center rounded-full after:absolute after:-inset-0.5 hover:bg-hover">
            <ChevronLeft className="size-5" />
          </button>
        )}
        {lead}
        <h2 className="flex min-w-0 flex-1">
          {/* The title with ▾ is the session's one menu; a session that has not started has none. */}
          <button
            ref={titleButton}
            type="button"
            onClick={(e) => sessionId && setMenu({ keys: e.detail === 0 })}
            aria-haspopup={sessionId ? 'menu' : undefined}
            aria-expanded={sessionId ? Boolean(menu) : undefined}
            className={`block max-w-full min-w-0 rounded-lg px-2 py-1 text-left ${wide ? 'pl-3' : ''} ${sessionId ? 'hover:bg-hover' : 'cursor-default'} ${menu ? 'bg-hover' : ''}`}
          >
            <div className="flex min-w-0 items-center gap-1">
              <span className="truncate text-[15px] font-medium">{title || ' '}</span>
              {sessionId && <ChevronDown aria-hidden className="size-4 shrink-0 text-faint" />}
            </div>
            <div className="flex min-w-0 items-center gap-2 overflow-hidden text-[12px] text-faint">
              <StatusBadge status={status} runningIn={otherAtWork ? session?.runningIn : undefined} tasks={working} />
              {/* A long path gives way from its start, keeping the folder's name, and leaves the branch its room. */}
              <span dir="rtl" className="min-w-0 truncate text-left font-mono" title={cwd}><bdi dir="ltr">{cwd ? (wide ? subtitle : baseName(cwd)) : ''}</bdi></span>
              {/* On a phone the line has room for the branch only when nothing else is going on. */}
              {session?.gitBranch && (wide || (status === 'idle' && working === 0)) && (
                <span className="flex max-w-[45%] min-w-0 shrink-0 items-center gap-0.5"><GitBranch className="size-3 shrink-0" /><span className="truncate">{session.gitBranch}</span></span>
              )}
            </div>
          </button>
        </h2>
        {cwd && wide && (
          <>
            <PaneButton ref={workspace.toggle} icon={FileDiff} label="Changes" keyId="changes" pressed={paneShown && paneTab === 'changes'} onClick={() => togglePane('changes')}>
              {lines && (lines.added > 0 || lines.removed > 0) && <Lines added={lines.added} removed={lines.removed} />}
            </PaneButton>
            <PaneButton icon={Folder} label="Files" keyId="files" pressed={paneShown && paneTab === 'files'} onClick={() => togglePane('files')} />
            <PaneButton icon={SquareTerminal} label="Terminal" keyId="terminal" pressed={paneShown && paneTab === 'terminal'} onClick={() => togglePane('terminal')} />
          </>
        )}
        {cwd && !wide && (
          // One button on a phone: the lines changed, or a folder while nothing has; the three panes behind it.
          <button
            ref={workspace.toggle}
            type="button"
            aria-label={lines && (lines.added > 0 || lines.removed > 0) ? `Changes, ${lines.added} lines added, ${lines.removed} removed` : 'Changes, files and terminal'}
            onClick={() => makeWay(() => workspace.show())}
            className="relative flex h-10 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-muted after:absolute after:-inset-0.5 hover:bg-hover hover:text-fg"
          >
            {lines && (lines.added > 0 || lines.removed > 0) ? <><FileDiff className="size-[18px] shrink-0" /><Lines added={lines.added} removed={lines.removed} /></> : <Folder className="size-[18px]" />}
          </button>
        )}
      </header>
      {/* Wide, the list beside says it; one line is enough. */}
      {!wide && <OfflineLine state={offline} {...(machine ? { machine } : {})} onRetry={retry} />}

      <div className="flex min-h-0 flex-1 flex-col [@media(max-height:380px)]:min-h-[80%]">
        {sessionId || view.messages.length > 0 ? (
          <QuoteTargetContext.Provider value={quoteTarget}>
          <MessageList
            sessionId={viewId}
            // Can't reach the computer: the line under the header says so, and offers to retry.
            view={offline === 'unreachable' && view.error ? { ...view, error: undefined } : view}
            cwd={cwd}
            {...(machine ? { machine } : {})}
            mode={viewOf(prefs, sessionId)}
            {...(sessionId && !sideChat ? { onRewind: requestRewind, onUndoRewind: undoRewind, onFork: forkFrom, onForkReply: forkReply } : {})}
            {...(sessionId ? { onRetry: sendAgain, ...(sideChat ? {} : { onCompact: () => void send('/compact', [], prefs.sendWhileBusy, 'chat') }) } : {})}
          />
          </QuoteTargetContext.Provider>
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center">
            <div className="min-w-0 max-w-full">
              <div className="text-[17px] font-medium">What should Claude do?</div>
              <StartIn start={newCwd ? { cwd: newCwd } : { scratch: true }} {...(home ? { home } : {})} onStart={startIn} />
            </div>
          </div>
        )}
      </div>

      {/* Never taller than about half the screen, so the conversation, the composer and Stop stay in view;
          where the screen is short (a phone's keyboard up), shorter still, unless Claude waits for an
          answer, which then takes the room it needs. It gives way before the message box does, and
          scrolls, Claude's card keeping its head and its buttons in view (PermissionCard). On a phone
          on its side the whole chat scrolls instead, the message box at its foot. */}
      {/* A field of the card that takes the keys (a question's Other…) scrolls into view clear of its head and foot. */}
      <div data-dock className={`max-h-[55%] min-h-0 scroll-pt-12 scroll-pb-20 overflow-y-auto overscroll-contain px-3 ${request ? '[@media(min-height:380.02px)_and_(max-height:600px)]:max-h-[70%]' : '[@media(min-height:380.02px)_and_(max-height:600px)]:max-h-[40%]'} [@media(max-height:380px)]:max-h-none [@media(max-height:380px)]:shrink-0 [@media(max-height:380px)]:overflow-visible`}>
        {request && (
          <section aria-label={askedFor(request, cwd, true)} className="mx-auto max-w-3xl">
            {permissions.length > 1 && <div className="px-1 pb-1 text-right text-[11.5px] text-faint tabular-nums">1 of {permissions.length}</div>}
            <PermissionCard key={request.id} sessionId={sessionId!} request={request} cwd={cwd} />
          </section>
        )}
        {folded ? (
          <FoldedBars tasks={showTasks ? tasks : []} background={inBackground(view.run?.tasks?.length ?? 0, view.run?.scheduled?.length ?? 0)} onUnfold={() => setUnfoldedFor(request?.id)} />
        ) : (
          <>
        {showTasks && <TasksBar tasks={tasks} />}
        {sessionId && inBackgroundNow && (
          <BackgroundTasks
            ref={backgroundBar}
            sessionId={sessionId}
            tasks={view.run?.tasks ?? []}
            scheduled={view.run?.scheduled ?? []}
            open={backgroundOpen}
            setOpen={setBackgroundOpen}
            onCancel={(check) => void send(cancelCheck(check), [], prefs.sendWhileBusy, 'chat')}
          />
        )}
          </>
        )}
        {prefs.suggestions && view.run?.suggestion && !busy && (
          <div className="mx-auto mb-2 flex max-w-3xl">
            <button type="button" onClick={() => setDraftText({ text: view.run!.suggestion!, key: Date.now() })} className="relative flex min-h-9 min-w-0 items-center gap-1.5 rounded-full px-2 py-1 text-left text-[13px] text-muted after:absolute after:-inset-y-1 after:inset-x-0 hover:bg-hover hover:text-fg">
              <CornerDownRight className="size-3.5 shrink-0 text-faint" />
              <span className="truncate">{view.run.suggestion}</span>
            </button>
          </div>
        )}
        {limitNotice(limits) && <Notice tone={limitReached(limits) ? 'error' : 'info'}>{limitNotice(limits)}</Notice>}
        {/* Another app has the session: the status says it (Working in Claude Desktop, Needs you in
            the terminal), the empty message box says what sending does, and the session menu's foot
            names an app it is open in. No tip says it again. */}
        {modelList?.signedIn === false && (
          <Notice tone="error">
            Claude Code is not signed in on {machine || 'this machine'}. Run <code className="font-mono">claude</code> in a terminal there, sign in, then come back.
          </Notice>
        )}
        {view.run?.modeChanged && view.run.modeChanged !== modeSeen && (
          <Notice onDismiss={() => setModeSeen(view.run?.modeChanged)}>{MODE_INFO[view.run.modeChanged].now}</Notice>
        )}
        {failedMcp.length > 0 && failedMcp.join('\n') !== mcpSeen && (
          // Where tools are added, the session's MCP servers; a line here when one fails while Claude runs.
          <Notice tone="error" onDismiss={() => setMcpSeen(failedMcp.join('\n'))}>
            {failedMcp.length === 1 ? `The MCP server ${failedMcp[0]} failed.` : `${failedMcp.length} MCP servers failed.`}{' '}
            <button type="button" onClick={() => setMcpOpen(true)} className="font-medium text-fg underline decoration-faint underline-offset-2">MCP servers</button>
          </Notice>
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
            onEdit={(prompt) => void api.unqueue(sessionId, prompt.uuid).then(() => {
              // What waited with it waits again above the box; its words go back in.
              const back = readMessage(prompt.text);
              putBackWaiting(viewId, back.items);
              if (back.text) setDraftText({ text: back.text, key: Date.now(), append: true });
            }, () => undefined)}
          />
        )}
      </div>

      <Composer
        ref={composer}
        busy={busy}
        settings={shown}
        onSettings={changeSettings}
        models={modelList?.models}
        {...(defaults ? { defaults } : {})}
        sheetNotes={{
          // For a new session, where its folder's or managed settings decide; for any, what a pick saves.
          ...(!sessionId && defaults ? { model: modelNote(defaults, models, shown.model), mode: settings.permissionMode === undefined ? modeNote(defaults, optionOf(shown)) : undefined } : {}),
          modelFooter: <SavedForNewSessions problem={saveProblem} />,
        }}
        onSend={(text, attachments, mode) => void send(text, attachments, mode, 'box')}
        {...(sessionId && !sideChat ? {
          onShell: (command: string) => void shell(command),
          onSideChat: (question: string) => {
            // The quotes waiting here go with the question; comments and files stay for this session.
            if (sideBox) for (const item of takeWaiting(viewId, (i) => i.kind === 'quote')) addWaiting(sideBox, item);
            side.show(question);
          },
        } : {})}
        {...(cwd ? {
          // A comment written on a diff shows there; a file, lines of one, or a comment on a file, in Files.
          onShowItem: (item: WaitingItem) => makeWay(() => showWorkspace(item.kind === 'comment' && item.from.what === 'diff'
            ? { tab: 'changes', path: item.path ?? item.text }
            : { tab: 'files', path: item.path ?? item.text, ...(item.lines ? { line: item.lines[0] } : {}) })),
        } : {})}
        side={sideChat}
        onStop={() => sessionId && void api.interrupt(sessionId)}
        stopping={Boolean(view.run?.stopping)}
        // On a computer the box takes the keys as soon as a chat opens. On a phone only a new
        // session, opened to type in, does: a session opened to read must not raise the keyboard
        // over the conversation.
        autoFocus={!sessionId || hasKeyboard()}
        placeholder={(otherAtWork && elsewherePlaceholder(otherAtWork)) || (sideChat ? 'Ask a side question' : sessionId ? 'Reply to Claude' : 'Message Claude')}
        draftKey={viewId}
        {...(ring ? { trailing: ring } : {})}
        {...(sessionId && !sideChat ? { mcpSession: sessionId, onMcp: () => setMcpOpen(true) } : {})}
        onCommandMenu={() => showCommandMenu(true)}
        {...(cwd ? { cwd } : {})}
        {...(draft ? { draft } : {})}
      />

      {dropping && (
        <div className="pointer-events-none absolute inset-2 z-30 grid place-items-center rounded-2xl border-2 border-dashed border-faint bg-bg/85 text-[14px] text-muted">
          Drop to attach
        </div>
      )}

      {/* Beside the conversation on a computer: the pane, and the side chat under it or in its place. */}
      <PaneColumn
        stacked={side.stacked}
        pane={cwd && (
        <Workspace
          open={paneShown}
          docked={workspace.docked}
          busy={busy && permissions.length === 0}
          {...(request ? { needsYou: askedFor(request, cwd, true) } : {})}
          onClose={() => workspace.setOpen(false)}
          cwd={cwd}
          {...(sessionId ? { sessionId, ...(sideChat ? { requests: false } : { onRewind: requestRewind }) } : {})}
          {...(sessionId && !sideChat ? {
            // Commit changes and Create PR: sent at once, as Desktop sends them, or put in the message
            // box first; on a phone the conversation comes back to show it. While Claude works a
            // request waits for the end of the turn, as a queued message, whatever Settings says for
            // what is typed: never steered into the work at hand. Its button says so, with Take back.
            onRequest: async (text: string, how: 'send' | 'box') => {
              if (!workspace.docked) workspace.setOpen(false);
              if (how === 'box') setDraftText({ text, key: Date.now(), append: true, block: true });
              else await send(text, [], 'queue', 'request');
            },
            queued: view.run?.queued ?? [],
            onUnqueue: (uuid: string) => void api.unqueue(sessionId, uuid).catch(() => undefined),
          } : {})}
          onAddToMessage={(text, how) => {
            if (!workspace.docked) workspace.setOpen(false);
            // A quote from a file waits above the message box, as one from a reply does; a request goes in the box.
            const quote = how === 'quote' ? olderQuote(text, { what: 'file' }) : undefined;
            if (quote) addWaiting(viewId, quote);
            else if (how !== 'quote') setDraftText({ text, key: Date.now(), append: true, ...(how === 'block' ? { block: true } : {}) });
          }}
          onSendNow={(item) => {
            // A quote taken in a pane, sent at once with its note, as the note box's Send now sends
            // one (a steer while Claude works): lines of a file as a comment on them, as Desktop's
            // Add comment on a file is.
            if (!workspace.docked) workspace.setOpen(false);
            void send(item.path ? messageWith([item], '') : sendNowMessage(item.text, item.note ?? ''), [], 'steer', { reply: item });
          }}
          onSendComments={() => {
            // Nothing waiting: there was nothing, or it is on its way (a second tap of Send now).
            if (waitingOf(viewId).length === 0) return;
            if (!workspace.docked) workspace.setOpen(false);
            void send('', [], prefs.sendWhileBusy, 'comments');
          }}
          askTrust={askTrust}
        />
        )}
        side={sessionId && <SideChat state={side} sessionId={sessionId} settings={shown} {...(cwd ? { cwd } : {})} {...(machine ? { machine } : {})} {...(demo ? { demo } : {})} />}
      />
      <TrustSheet ask={trustAsk} {...(cwd ? { folder: cwd } : {})} {...(home ? { home } : {})} onDone={() => setTrustAsk(undefined)} />
      {sessionId && !sideChat && (
        <RewindDialog
          open={Boolean(rewind?.shown)}
          text={rewind?.text ?? ''}
          preview={rewind?.preview ?? 'pending'}
          {...(cwd ? { cwd } : {})}
          working={rewindWork.working}
          {...(rewindWork.problem ? { problem: rewindWork.problem } : {})}
          onCancel={closeRewind}
          onRewind={(restore) => rewind && void doRewind(rewind, restore, true)}
        />
      )}
      {sessionId && !sideChat && (
        <RewindPicker
          open={picking}
          points={rewindPoints}
          onClose={() => setPicking(false)}
          onPick={(point) => {
            setPicking(false);
            requestRewind(point);
          }}
        />
      )}
      {sessionId && (
        <SessionMenu
          open={Boolean(menu)}
          onClose={() => setMenu(undefined)}
          sessionId={sessionId}
          {...(session ? { session } : {})}
          from="title"
          at={titleButton.current}
          focusFirst={Boolean(menu?.keys)}
          {...(cwd ? { cwd } : {})}
          busy={busy}
          view={{
            value: viewOf(prefs, sessionId),
            options: VIEW_OPTIONS.map(({ value, label }) => ({ value, label })),
            choose: (value) => setSessionView(sessionId, viewMode(value)),
          }}
          {...(cwd && !hasKeyboard() ? { header: (pick: (run: () => void) => void) => <PaneTiles {...(lines ? { lines } : {})} onPick={(tab) => pick(() => showPane(tab))} /> } : {})}
          {...(!sideChat ? { onSideChat: () => side.show() } : {})}
          onRename={() => setRenaming(true)}
          onFork={fork}
          onForked={onOpen}
          onPin={(next) => session && void changeListed(queryClient, session, { pinned: next }).catch(() => undefined)}
          onArchive={archive}
          onRenamed={refresh}
          onDeleted={() => {
            void queryClient.invalidateQueries({ queryKey: ['sessions'] });
            onBack();
          }}
          onProblem={(problem: MenuProblem) => setSendError(problem)}
        />
      )}
      {sessionId && (
        <ContextPanel
          open={contextAt !== undefined}
          onClose={() => setContextAt(undefined)}
          at={contextAt ?? null}
          sheet={!hasKeyboard()}
          sessionId={sessionId}
          {...(context ? { context } : {})}
          {...(!sideChat ? { onCompact: () => {
            setContextAt(undefined);
            void send('/compact', [], prefs.sendWhileBusy, 'chat');
          } } : {})}
          onUsage={() => {
            setContextAt(undefined);
            setUsageOpen(true);
          }}
        />
      )}
      {sessionId && <RenameSheet open={renaming} onClose={() => setRenaming(false)} sessionId={sessionId} title={session?.title ?? title} onRenamed={refresh} />}
      {sessionId && !sideChat && <McpSheet open={mcpOpen} onClose={() => setMcpOpen(false)} sessionId={sessionId} {...(machine ? { machine } : {})} />}
      {usageOpen && (
        <Suspense fallback={null}>
          <UsageSheet open={usageOpen} onClose={() => setUsageOpen(false)} limits={planBars} onOpenSession={(id) => {
            setUsageOpen(false);
            onOpen(id);
          }} />
        </Suspense>
      )}
    </div>
    </CommentsChat.Provider>
    </TerminalShell.Provider>
    </RunInTerminal.Provider>
    </PathLinksContext.Provider>
  );
}
