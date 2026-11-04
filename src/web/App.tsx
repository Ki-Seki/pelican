import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquare, Plus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import type { SessionSummary } from '../shared/protocol';
import { Chat } from './components/Chat';
import { FolderPicker } from './components/NewSession';
import { SessionList } from './components/SessionList';
import { api, appBase } from './lib/api';
import {
  disableNotifications,
  enableNotifications,
  type NotificationState,
  notificationState,
  onNotificationOpen,
} from './lib/notifications';
import { socket } from './lib/socket';

/**
 * Routes live in the query string (`?s=<id>`, `?new`, `?new&cwd=<path>`): the
 * page stays at the app's own folder, so relative asset URLs keep working, and
 * the AI Server entry page, which remembers an iframe's path and query, brings
 * you back to the same session after a reload.
 */
function useRoute() {
  const [search, setSearch] = useState(location.search);
  useEffect(() => {
    const onPop = () => setSearch(location.search);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const params = new URLSearchParams(search);
  const navigate = useCallback((query: string, replace = false) => {
    const url = `${appBase.pathname}${query}`;
    if (replace) history.replaceState(null, '', url);
    else history.pushState(null, '', url);
    setSearch(query);
  }, []);
  return {
    sessionId: params.get('s') ?? undefined,
    isNew: params.has('new'),
    newCwd: params.get('cwd') ?? undefined,
    navigate,
  };
}

function useWide() {
  const query = '(min-width: 1024px)';
  const [wide, setWide] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setWide(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return wide;
}

export function App() {
  const { sessionId, isNew, newCwd, navigate } = useRoute();
  const wide = useWide();
  const queryClient = useQueryClient();
  const { data: info } = useQuery({ queryKey: ['info'], queryFn: api.info, staleTime: Infinity });
  const [connected, setConnected] = useState(socket.connected);
  const [notifications, setNotifications] = useState<NotificationState>('off');

  useEffect(() => socket.onConnection(setConnected), []);
  useEffect(() => {
    void notificationState().then(setNotifications);
  }, []);
  // Start loading the model list early: the first answer takes a couple of seconds.
  useEffect(() => {
    void queryClient.prefetchQuery({ queryKey: ['models'], queryFn: api.models, staleTime: 10 * 60_000 });
  }, [queryClient]);

  useEffect(() => socket.on((event) => {
    if (event.type === 'sessions_changed') {
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      void queryClient.invalidateQueries({ queryKey: ['session'] });
    } else if (event.type === 'status') {
      queryClient.setQueryData<SessionSummary[]>(['sessions'], (list) =>
        list?.map((s) => (s.id === event.sessionId ? { ...s, status: event.status } : s)));
    }
  }), [queryClient]);

  const open = useCallback((id: string, replace = false) => navigate(`?s=${encodeURIComponent(id)}`, replace), [navigate]);
  useEffect(() => onNotificationOpen((id) => open(id)), [open]);

  const toggleNotifications = () => {
    const next = notifications === 'on' ? disableNotifications() : enableNotifications();
    void next.then(setNotifications).catch((error: Error) => window.alert(`Could not turn on notifications: ${error.message}`));
  };

  const list = (
    <SessionList
      machine={info?.machine ?? ''}
      selectedId={sessionId}
      onOpen={(id) => open(id)}
      onNew={() => navigate('?new')}
      connected={connected}
      notifications={notifications}
      onToggleNotifications={toggleNotifications}
    />
  );

  let main: React.ReactNode;
  if (sessionId || (isNew && newCwd)) {
    main = (
      <Chat
        key={sessionId ?? `new:${newCwd}`}
        sessionId={sessionId}
        newCwd={newCwd}
        home={info?.home}
        wide={wide}
        onBack={() => navigate('')}
        onOpen={open}
      />
    );
  } else if (isNew) {
    main = (
      <div className="flex h-full min-h-0 flex-col">
        {!wide && (
          <div className="shrink-0 px-2 py-1.5">
            <button type="button" className="h-10 rounded-full px-3 text-[14px] text-muted hover:bg-hover" onClick={() => navigate('')}>
              Cancel
            </button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <FolderPicker home={info?.home} onPick={(path) => navigate(`?new&cwd=${encodeURIComponent(path)}`)} />
        </div>
      </div>
    );
  }

  if (wide) {
    return (
      <div className="app-height grid grid-cols-[minmax(300px,360px)_1fr] overflow-hidden">
        <aside className="min-h-0 border-r border-line">{list}</aside>
        <main className="min-h-0">
          {main ?? (
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                <MessageSquare className="mx-auto size-8 text-faint" />
                <div className="mt-3 text-[15px] text-muted">Pick a session, or start a new one</div>
                <button type="button" onClick={() => navigate('?new')} className="mx-auto mt-4 flex h-10 items-center gap-1.5 rounded-full bg-fg px-4 text-[14px] font-medium text-bg">
                  <Plus className="size-4" /> New session
                </button>
              </div>
            </div>
          )}
        </main>
      </div>
    );
  }
  return <div className="app-height overflow-hidden">{main ?? list}</div>;
}
