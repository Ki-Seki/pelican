import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronLeft, GitBranch, Info, ListChecks, MoreHorizontal, TriangleAlert, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import type { Attachment, Block, ChatMessage, RunSettings, RunState, SessionSummary } from '../../shared/protocol';
import { api, apiUrl } from '../lib/api';
import { baseName, shortPath } from '../lib/format';
import { loadDefaults, markSeen, saveDefaults, usePrefs } from '../lib/prefs';
import { socket } from '../lib/socket';
import {
  addLocalMessage,
  adoptView,
  clearDraft,
  getDraft,
  getView,
  loadLatest,
  removeLocalMessage,
  setDraft,
  setRun,
  useSessionView,
} from '../lib/store';
import { currentTasks, type Todo } from '../lib/tools';
import { Composer } from './Composer';
import { MessageList } from './MessageList';
import { PermissionCard } from './PermissionCard';
import { StatusBadge } from './SessionList';
import { SessionMenu } from './SessionMenu';
import { TodoList } from './ToolCall';

export const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`.replace('.', ''));

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
      {percent}%
    </button>
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
        <div className="relative">
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

const EDIT_NOTE = 'A branch of the conversation from just before this prompt. Edit it and send; the original session stays as it was.';
const EDIT_FIRST_NOTE = 'A new session in the same folder. Edit the prompt and send; the original session stays as it was.';

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
  const [settings, setSettings] = useState<RunSettings>(loadDefaults);
  const [initialDraft] = useState(() => getDraft(viewId));
  const [draft, setDraftText] = useState(() => (initialDraft ? { text: initialDraft.text, key: 1 } : undefined));
  const [note, setNote] = useState(initialDraft?.note);
  const [sendError, setSendError] = useState<string>();
  const [menuOpen, setMenuOpen] = useState(false);

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

  // A session already running here keeps its own settings.
  const runSettings = view.run?.settings;
  const runKey = JSON.stringify(runSettings ?? null);
  useEffect(() => {
    if (runSettings) setSettings((current) => ({ ...current, ...runSettings }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, runKey]);

  const changeSettings = (next: RunSettings) => {
    setSettings(next);
    saveDefaults(next);
    if (sessionId && view.run && next.permissionMode !== settings.permissionMode) {
      void api.setMode(sessionId, next.permissionMode).catch(() => undefined);
    }
  };

  const send = async (text: string, attachments: Attachment[]) => {
    setSendError(undefined);
    setNote(undefined);
    if (demo) {
      setSendError('This is the demo, so nothing is sent. Run Pelican on your own machine to talk to Claude.');
      setDraftText({ text, key: Date.now() });
      return;
    }
    const uuid = newId();
    addLocalMessage(viewId, localMessage(uuid, text, attachments));
    const body = { text, attachments: attachments.map((a) => a.id), settings, uuid };
    try {
      if (sessionId) {
        await api.send(sessionId, body);
      } else if (newCwd || scratch) {
        const { sessionId: created } = await api.create({ ...body, ...(scratch ? { scratch: true } : { cwd: newCwd }) });
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
  const permissions = view.run?.permissions ?? [];
  const status = view.run ? (permissions.length > 0 ? 'waiting' : busy ? 'running' : session?.status === 'live' ? 'live' : 'idle') : session?.status ?? 'idle';

  // Edit and resend: branch just before the prompt, open the branch, and put the prompt in its composer.
  const edit = (uuid: string, text: string) => {
    if (!sessionId) return;
    if (busy) {
      setSendError('Stop Claude before editing an earlier prompt.');
      return;
    }
    setSendError(undefined);
    void api.fork(sessionId, { before: uuid })
      .then((id) => {
        if (id) {
          setDraft(id, { text, note: EDIT_NOTE });
          void queryClient.invalidateQueries({ queryKey: ['sessions'] });
          onOpen(id);
        } else if (cwd) {
          setDraft(`new:${cwd}`, { text, note: EDIT_FIRST_NOTE });
          onStartIn(cwd);
        }
      })
      .catch((error: Error) => setSendError(error.message));
  };

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
    <div className="flex h-full min-h-0 flex-col">
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
        {view.run?.context && <ContextMeter context={view.run.context} onClick={() => setMenuOpen(true)} />}
        {sessionId && (
          <button type="button" aria-label="Session menu" onClick={() => setMenuOpen(true)} className="grid size-10 shrink-0 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg">
            <MoreHorizontal className="size-5" />
          </button>
        )}
      </header>

      {sessionId || view.messages.length > 0 ? (
        <MessageList sessionId={viewId} view={view} cwd={cwd} mode={prefs.view} {...(sessionId ? { onEdit: edit } : {})} />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center">
          <div>
            <div className="text-[17px] font-medium">What should Claude do?</div>
            <div className="mt-1 font-mono text-[12.5px] text-faint">{subtitle}</div>
          </div>
        </div>
      )}

      <div className="shrink-0 px-3">
        {permissions.map((request) => (
          <PermissionCard key={request.id} sessionId={sessionId!} request={request} cwd={cwd} />
        ))}
        {showTasks && <TasksBar tasks={tasks} />}
        {session?.status === 'live' && !view.run && (
          <Notice tone="live">
            Claude is working on this session {session.runningIn ? `in ${session.runningIn}` : 'elsewhere'} right now. Sending here runs a second Claude on the same conversation.
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
        onSend={(text, attachments) => void send(text, attachments)}
        onStop={() => sessionId && void api.interrupt(sessionId)}
        autoFocus={!sessionId || Boolean(initialDraft)}
        placeholder={busy ? 'Queue a message' : sessionId ? 'Reply to Claude' : 'Message Claude'}
        {...(cwd ? { cwd } : {})}
        {...(draft ? { draft } : {})}
      />

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
