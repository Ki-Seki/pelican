import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, GitBranch, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import type { Attachment, Block, ChatMessage, RunSettings, SessionSummary } from '../../shared/protocol';
import { api, apiUrl } from '../lib/api';
import { baseName, shortPath } from '../lib/format';
import { loadDefaults, saveDefaults } from '../lib/prefs';
import { socket } from '../lib/socket';
import { addLocalMessage, adoptView, getView, loadLatest, setRun, useSessionView } from '../lib/store';
import { Composer } from './Composer';
import { MessageList } from './MessageList';
import { PermissionCard } from './PermissionCard';
import { StatusBadge } from './SessionList';

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

export function Chat({
  sessionId,
  newCwd,
  home,
  wide,
  onBack,
  onOpen,
}: {
  sessionId?: string;
  newCwd?: string;
  home?: string;
  wide: boolean;
  onBack: () => void;
  onOpen: (id: string, replace?: boolean) => void;
}) {
  const viewId = sessionId ?? `new:${newCwd}`;
  const view = useSessionView(viewId);
  const queryClient = useQueryClient();
  const { data: models } = useQuery({ queryKey: ['models'], queryFn: api.models, staleTime: 10 * 60_000 });
  const { data: detail } = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => api.session(sessionId!),
    enabled: Boolean(sessionId),
    refetchInterval: 30_000,
  });
  const listed = queryClient.getQueryData<SessionSummary[]>(['sessions'])?.find((s) => s.id === sessionId);
  const session = detail?.session ?? listed;
  const [settings, setSettings] = useState<RunSettings>(loadDefaults);
  const [sendError, setSendError] = useState<string>();

  useEffect(() => {
    if (!sessionId) return;
    socket.subscribe(sessionId);
    void loadLatest(sessionId);
    return () => socket.unsubscribe(sessionId);
  }, [sessionId]);

  useEffect(() => {
    if (sessionId && detail?.run && !getView(sessionId).run) setRun(sessionId, detail.run);
  }, [sessionId, detail?.run]);

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
    const uuid = newId();
    const message = localMessage(uuid, text, attachments);
    const body = { text, attachments: attachments.map((a) => a.id), settings, uuid };
    try {
      if (sessionId) {
        addLocalMessage(sessionId, message);
        await api.send(sessionId, body);
      } else if (newCwd) {
        addLocalMessage(viewId, message);
        const { sessionId: created } = await api.create({ ...body, cwd: newCwd });
        adoptView(viewId, created);
        void queryClient.invalidateQueries({ queryKey: ['sessions'] });
        onOpen(created, true);
      }
    } catch (error) {
      setSendError((error as Error).message);
    }
  };

  const firstPrompt = view.messages.find((m) => m.role === 'user' && m.blocks.some((b) => b.type === 'text'));
  const firstText = firstPrompt?.blocks.find((b) => b.type === 'text');
  const title = session?.title ?? (firstText?.type === 'text' ? firstText.text.slice(0, 80) : newCwd ? 'New session' : '');
  const cwd = session?.cwd || view.run?.cwd || newCwd;
  const permissions = view.run?.permissions ?? [];
  const busy = Boolean(view.run?.busy);
  const status = view.run ? (permissions.length > 0 ? 'waiting' : busy ? 'running' : session?.status === 'live' ? 'live' : 'idle') : session?.status ?? 'idle';

  useEffect(() => {
    document.title = title ? `${title} · Pelican` : 'Pelican';
  }, [title]);

  const rename = () => {
    if (!sessionId || !session) return;
    const next = window.prompt('Rename session', session.title);
    if (next && next.trim() && next.trim() !== session.title) {
      void api.rename(sessionId, next.trim()).then(() => {
        void queryClient.invalidateQueries({ queryKey: ['session', sessionId] });
        void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      });
    }
  };

  const subtitle = useMemo(() => (cwd ? shortPath(cwd, home) : ''), [cwd, home]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-1 border-b border-line bg-bg/95 px-2 py-1.5 backdrop-blur">
        {!wide && (
          <button type="button" aria-label="Back to sessions" onClick={onBack} className="grid size-10 shrink-0 place-items-center rounded-full hover:bg-hover">
            <ChevronLeft className="size-5" />
          </button>
        )}
        <button type="button" onClick={rename} className={`min-w-0 flex-1 rounded-lg px-2 py-1 text-left ${wide ? 'pl-3' : ''}`}>
          <div className="truncate text-[15px] font-medium">{title || ' '}</div>
          <div className="flex min-w-0 items-center gap-2 overflow-hidden text-[12px] text-faint">
            <StatusBadge status={status} />
            <span className="min-w-0 truncate font-mono" title={cwd}>{cwd ? (wide ? subtitle : baseName(cwd)) : ''}</span>
            {session?.gitBranch && (
              <span className="flex min-w-0 shrink items-center gap-0.5 truncate"><GitBranch className="size-3 shrink-0" />{session.gitBranch}</span>
            )}
          </div>
        </button>
      </header>

      {sessionId || view.messages.length > 0 ? (
        <MessageList sessionId={viewId} view={view} cwd={cwd} />
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
        {sendError && (
          <div className="mx-auto mb-2 flex max-w-3xl items-center gap-2 rounded-xl border border-line bg-panel px-3 py-2 text-[13px] text-danger">
            <TriangleAlert className="size-4 shrink-0" />
            {sendError}
          </div>
        )}
      </div>

      <Composer
        busy={busy}
        settings={settings}
        onSettings={changeSettings}
        models={models}
        onSend={(text, attachments) => void send(text, attachments)}
        onStop={() => sessionId && void api.interrupt(sessionId)}
        autoFocus={!sessionId}
        placeholder={busy ? 'Queue a message' : sessionId ? 'Reply to Claude' : 'Message Claude'}
      />
    </div>
  );
}
