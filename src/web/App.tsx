import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, MessageSquare, Plus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { SessionSummary } from '../shared/protocol';
import { Announcer } from './components/Announcer';
import { Chat } from './components/Chat';
import { Lightbox } from './components/Lightbox';
import { Login } from './components/Login';
import { type Offline, OfflineLine, offlineWords, retryNow, useOffline } from './components/Offline';
import { PreviewOverlay } from './components/Preview';
import { FolderPicker } from './components/NewSession';
import { SessionList } from './components/SessionList';
import { SettingsSheet } from './components/Settings';
import { shortcutsShown, ShortcutsSheet, showShortcuts } from './components/Shortcuts';
import { announce } from './lib/announce';
import { api, appBase, type AuthState, whenSignedOut } from './lib/api';
import { startDemo } from './lib/demo';
import { forgetDrafts } from './lib/drafts';
import { withMod } from './lib/keyboard';
import {
  disableNotifications,
  enableNotifications,
  type NotificationState,
  notificationState,
  onNotificationOpen,
} from './lib/notifications';
import { applyTheme } from './lib/prefs';
import { socket } from './lib/socket';
import { STATIC_DEMO } from './lib/static-demo';
import { setWaitingCount } from './lib/title';
import { fitToVisibleViewport } from './lib/viewport';

/**
 * Routes live in the query string (`?s=<id>`, `?new`, `?new&cwd=<path>`): the
 * page stays at the app's own folder, so relative URLs keep working under any
 * path prefix, and a page that frames Pelican can keep the route in its own URL.
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
    scratch: params.has('new') && params.has('scratch'),
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

/** The sign-in gate: shown until this browser signs in, unless the server asks no one to (--no-auth, the demo). */
export function App() {
  const queryClient = useQueryClient();
  const auth = useQuery({ queryKey: ['auth'], queryFn: api.auth, staleTime: Infinity, retry: 2 });

  useEffect(() => {
    applyTheme();
    // Asked again rather than patched: how browsers sign in may have changed (a password set or removed).
    whenSignedOut(() => void queryClient.resetQueries({ queryKey: ['auth'] }));
  }, [queryClient]);
  useEffect(() => fitToVisibleViewport(), []);

  if (auth.isPending) {
    return <div className="app-height flex items-center justify-center text-faint"><Loader2 className="size-5 animate-spin" /></div>;
  }
  if (auth.data?.required && !auth.data.signedIn) {
    return (
      <Login
        mode={auth.data.mode}
        onSignedIn={() => {
          queryClient.setQueryData<AuthState>(['auth'], (old) => old && { ...old, signedIn: true });
          void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'auth' });
          socket.reconnect();
        }}
      />
    );
  }
  return (
    <>
      <Main />
      <Lightbox />
      <PreviewOverlay />
      <Announcer />
    </>
  );
}

function Main() {
  const { sessionId, isNew, newCwd, scratch, navigate } = useRoute();
  const wide = useWide();
  const queryClient = useQueryClient();
  const { data: info } = useQuery({ queryKey: ['info'], queryFn: api.info, staleTime: Infinity });
  const [connected, setConnected] = useState(socket.connected);
  const [notifications, setNotifications] = useState<NotificationState>('off');
  const [settingsOpen, setSettingsOpen] = useState(false);

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

  // Both demos act out what they can in the page (lib/demo).
  useEffect(() => {
    if (info?.demo) startDemo(info);
  }, [info]);

  // The tab says how many sessions need you, from whatever the list last knew.
  const { data: sessions } = useQuery({ queryKey: ['sessions'], queryFn: api.sessions, enabled: false });
  const needYou = sessions?.filter((s) => s.status === 'waiting').length ?? 0;
  useEffect(() => setWaitingCount(needYou), [needYou]);

  // The computer out of reach, or live updates stopped: said in words, under the list's header.
  const offline = useOffline(true);
  const said = useRef<Offline>(undefined);
  useEffect(() => {
    if (offline && offline !== said.current) announce(`${offlineWords(offline, info?.machine)} Retrying.`);
    else if (!offline && said.current) announce('Connected again.');
    said.current = offline;
  }, [offline, info?.machine]);

  // ⌘K finds a session (on a phone the list comes first); ⌘/ lists the keys.
  const chatOpen = Boolean(sessionId || isNew);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!withMod(e) || e.repeat) return;
      const key = e.key.toLowerCase();
      if (key === '/') {
        e.preventDefault();
        showShortcuts(!shortcutsShown());
      } else if (key === 'k' && !document.querySelector('dialog[open]')) {
        e.preventDefault();
        if (!wide && chatOpen) navigate('');
        setTimeout(() => {
          const search = document.getElementById('session-search');
          if (search instanceof HTMLInputElement) {
            search.focus();
            search.select();
          }
        }, 0);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [wide, chatOpen, navigate]);

  const toggleNotifications = () => {
    const next = notifications === 'on' ? disableNotifications() : enableNotifications();
    void next.then(setNotifications).catch((error: Error) => window.alert(`Could not turn on notifications: ${error.message}`));
  };

  const signOut = () => {
    forgetDrafts();
    void api.logout().finally(() => {
      setSettingsOpen(false);
      // Everything but the sign-in state goes; that one is asked again, so the sign-in screen shows.
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'auth' });
      void queryClient.resetQueries({ queryKey: ['auth'] });
    });
  };

  const banner = (
    <>
      <OfflineLine state={offline} {...(info?.machine ? { machine: info.machine } : {})} onRetry={() => retryNow(queryClient)} />
      {info?.demo && (
        <div data-demo-banner className="mx-3 mb-1 rounded-xl bg-chip px-3 py-2 text-[12.5px] leading-snug text-muted">
          <span className="font-medium text-fg">Demo.</span> {STATIC_DEMO ? 'Pelican running in your browser, with made-up sessions; nothing you do here is sent anywhere.' : 'Sample sessions on a made-up machine; nothing you do here runs or changes anything.'}
        </div>
      )}
    </>
  );

  const list = (
    <SessionList
      machine={info?.machine ?? ''}
      selectedId={sessionId}
      onOpen={(id) => open(id)}
      onNew={() => navigate('?new')}
      onSettings={() => setSettingsOpen(true)}
      connected={connected}
      banner={banner}
    />
  );

  let main: React.ReactNode;
  if (sessionId || (isNew && (newCwd || scratch))) {
    main = (
      <Chat
        key={sessionId ?? `new:${scratch ? 'scratch' : newCwd}`}
        sessionId={sessionId}
        newCwd={newCwd}
        scratch={scratch}
        home={info?.home}
        machine={info?.machine}
        demo={info?.demo}
        wide={wide}
        onBack={() => navigate('')}
        onOpen={open}
        onStartIn={(cwd) => navigate(`?new&cwd=${encodeURIComponent(cwd)}`)}
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
          <FolderPicker
            home={info?.home}
            onPick={(path) => navigate(`?new&cwd=${encodeURIComponent(path)}`)}
            onScratch={() => navigate('?new&scratch')}
          />
        </div>
      </div>
    );
  }

  const settings = (
    <SettingsSheet
      open={settingsOpen}
      onClose={() => setSettingsOpen(false)}
      {...(info ? { info } : {})}
      notifications={notifications}
      onToggleNotifications={toggleNotifications}
      onSignOut={signOut}
    />
  );

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
        {settings}
        <ShortcutsSheet />
      </div>
    );
  }
  return (
    <div className="app-height overflow-hidden">
      {main ?? list}
      {settings}
      <ShortcutsSheet />
    </div>
  );
}
