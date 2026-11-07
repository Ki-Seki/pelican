import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Keyboard, Loader2, MessageSquare, Plus, Settings as SettingsIcon } from 'lucide-react';
import { Component, type ComponentProps, lazy, type ReactNode, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { SessionSummary } from '../shared/protocol';
import { Announcer } from './components/Announcer';
import { CommandMenu, commandMenuShown, showCommandMenu } from './components/CommandMenu';
import { Lightbox } from './components/Lightbox';
import { Login } from './components/Login';
import { type Offline, OfflineLine, offlineWords, retryNow, useOffline } from './components/Offline';
import { PreviewOverlay } from './components/Preview';
import { FolderPicker } from './components/NewSession';
import { SessionList } from './components/SessionList';
import { askSideChat } from './components/SideChat';
import { Sheet } from './components/Sheet';
import { shortcutsShown, ShortcutsSheet, showShortcuts } from './components/Shortcuts';
import { announce } from './lib/announce';
import { api, appBase, type AuthState, whenSignedOut } from './lib/api';
import { startDemo } from './lib/demo';
import { type CommandItem, useCommandPart } from './lib/commands';
import { forgetDrafts } from './lib/drafts';
import { isKey } from './lib/keyboard';
import { retried } from './lib/load';
import { whenSettled } from './lib/sheet-history';
import { useMedia } from './lib/media';
import {
  disableNotifications,
  enableNotifications,
  type NotificationState,
  notificationState,
  onNotificationOpen,
} from './lib/notifications';
import { applyTheme } from './lib/prefs';
import { socket } from './lib/socket';
import { defaultStart, newSessionQuery } from './lib/start';
import { STATIC_DEMO } from './lib/static-demo';
import { setWaitingCount } from './lib/title';
import { fitToVisibleViewport } from './lib/viewport';

// The conversation (Markdown, code highlighting, diffs) and Settings load when first needed: the
// first screen is the list, and a phone on a slow link shows it sooner without them. A link to a
// session starts loading the conversation at once; otherwise both load once the list is up.
const loadChat = () => import('./components/Chat');
const loadSettings = () => import('./components/Settings');
/** Loaded ahead of need; one that fails here is asked for again when it is needed. */
const prefetch = (load: () => Promise<unknown>) => void load().catch(() => undefined);
if (new URLSearchParams(location.search).has('s')) prefetch(loadChat);
const LazyChat = lazy(() => retried(loadChat).then((m) => ({ default: m.Chat })));
const LazySettings = lazy(() => retried(loadSettings).then((m) => ({ default: m.SettingsSheet })));

/**
 * A part of the page whose code did not arrive (the connection dropped as it was fetched): in its
 * place, a way to load the page again. React keeps a failed load, so only a reload brings it back;
 * without this the whole page went blank, and an app on the home screen has no reload button.
 */
class Loaded extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function NotLoaded() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      <p className="text-[14px] text-muted">This part of Pelican did not load.</p>
      <button type="button" onClick={() => location.reload()} className="h-10 rounded-full bg-fg px-4 text-[14px] font-medium text-bg">
        Reload
      </button>
    </div>
  );
}

const Chat = (props: ComponentProps<typeof LazyChat>) => (
  <Loaded fallback={<NotLoaded />}>
    <Suspense fallback={<div className="flex h-full items-center justify-center text-faint"><Loader2 className="size-5 animate-spin" /></div>}>
      <LazyChat {...props} />
    </Suspense>
  </Loaded>
);
const SettingsSheet = (props: ComponentProps<typeof LazySettings>) => (
  <Loaded fallback={<Sheet open={props.open} onClose={props.onClose} title="Settings"><NotLoaded /></Sheet>}>
    <Suspense fallback={null}><LazySettings {...props} /></Suspense>
  </Loaded>
);

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
    // After a sheet that just closed has taken its entry out of the history (lib/sheet-history).
    whenSettled(() => {
      if (replace) history.replaceState(null, '', url);
      else history.pushState(null, '', url);
    });
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

/** A sheet or menu that is open, and not on its way out (a key pressed just after one closed is the page's). */
const OPEN_DIALOG = 'dialog[open]:not([data-closing])';

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
  // The session list beside the conversation.
  const wide = useMedia('(min-width: 1024px)');
  const queryClient = useQueryClient();
  const { data: info } = useQuery({ queryKey: ['info'], queryFn: api.info, staleTime: Infinity });
  const [connected, setConnected] = useState(socket.connected);
  const [notifications, setNotifications] = useState<NotificationState>('off');
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Settings is there from the first time it opens: until then the list needs nothing of it.
  const [settingsUsed, setSettingsUsed] = useState(false);
  if (settingsOpen && !settingsUsed) setSettingsUsed(true);

  useEffect(() => socket.onConnection(setConnected), []);
  useEffect(() => {
    void notificationState().then(setNotifications);
  }, []);
  // Start loading the model list early: the first answer takes a couple of seconds.
  useEffect(() => {
    void queryClient.prefetchQuery({ queryKey: ['models'], queryFn: api.models, staleTime: 10 * 60_000 });
  }, [queryClient]);
  useEffect(() => {
    const timer = setTimeout(() => {
      prefetch(loadChat);
      prefetch(loadSettings);
    }, 1500);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => socket.on((event) => {
    if (event.type === 'sessions_changed') {
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      void queryClient.invalidateQueries({ queryKey: ['session'] });
    } else if (event.type === 'status') {
      queryClient.setQueryData<SessionSummary[]>(['sessions'], (list) =>
        list?.map((s) => (s.id === event.sessionId ? { ...s, status: event.status, tasks: event.tasks } : s)));
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

  // Desktop's keys for the whole page: ⌘K the command menu, ⇧⌘K finds a session (on a phone the
  // list comes first), ⇧⌘O starts one, ⇧⌘, opens Settings, ⌘/ lists the keys. A sheet that is open
  // keeps the others.
  const chatOpen = Boolean(sessionId || isNew);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (isKey(e, 'shortcuts')) {
        e.preventDefault();
        showShortcuts(!shortcutsShown());
        return;
      }
      if (isKey(e, 'commandMenu') && (commandMenuShown() || !document.querySelector(OPEN_DIALOG))) {
        e.preventDefault();
        showCommandMenu(!commandMenuShown());
        return;
      }
      if (document.querySelector(OPEN_DIALOG)) return;
      if (isKey(e, 'searchSessions')) {
        e.preventDefault();
        if (!wide && chatOpen) navigate('');
        setTimeout(() => {
          const search = document.getElementById('session-search');
          if (search instanceof HTMLInputElement) {
            search.focus();
            search.select();
          }
        }, 0);
      } else if (isKey(e, 'newSession')) {
        e.preventDefault();
        navigate(newSessionQuery(defaultStart(queryClient.getQueryData<SessionSummary[]>(['sessions']) ?? [])));
      } else if (isKey(e, 'settings')) {
        e.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [wide, chatOpen, navigate, queryClient]);

  // The page's own commands, in the / list and ⌘K (lib/commands); the open chat adds its session's.
  const pageCommands = useMemo<CommandItem[]>(() => [
    {
      id: 'new-session', group: 'pelican', label: 'New session', icon: Plus, key: 'newSession',
      run: () => navigate(newSessionQuery(defaultStart(queryClient.getQueryData<SessionSummary[]>(['sessions']) ?? []))),
    },
    { id: 'settings', group: 'pelican', label: 'Settings', icon: SettingsIcon, name: 'config', description: 'Settings', key: 'settings', run: () => setSettingsOpen(true) },
    { id: 'shortcuts', group: 'pelican', label: 'Keyboard shortcuts', icon: Keyboard, key: 'shortcuts', only: 'pointer', run: () => showShortcuts(true) },
  ], [navigate, queryClient]);
  useCommandPart('page', pageCommands);

  const toggleNotifications = () => {
    const next = notifications === 'on' ? disableNotifications() : enableNotifications();
    void next.then(setNotifications).catch((error: Error) => window.alert(`Could not turn on notifications: ${error.message}`));
  };

  const signOut = () => {
    // A device signed out gets no more notifications (they tell what Claude is doing), and keeps no drafts.
    forgetDrafts();
    void disableNotifications().catch(() => 'off').then(() => {
      setNotifications('off');
      return api.logout();
    }).finally(() => {
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
      onNew={(start) => navigate(newSessionQuery(start))}
      onSettings={() => setSettingsOpen(true)}
      onSideChat={(id) => {
        askSideChat(id);
        if (id !== sessionId) open(id);
      }}
      onGone={(id) => id === sessionId && navigate('')}
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
        onStartIn={(start, push) => navigate(newSessionQuery(start), !push)}
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

  const settings = settingsUsed && (
    <SettingsSheet
      open={settingsOpen}
      onClose={() => setSettingsOpen(false)}
      {...(info ? { info } : {})}
      notifications={notifications}
      onToggleNotifications={toggleNotifications}
      onSignOut={signOut}
      onOpenSession={(id) => {
        setSettingsOpen(false);
        open(id);
      }}
    />
  );

  if (wide) {
    // minmax(0, 1fr): the conversation's column never grows past the window to fit its content,
    // which pushed Changes and files, docked at its right edge, out of view.
    return (
      <div data-layout="wide" className="app-height grid grid-cols-[minmax(300px,360px)_minmax(0,1fr)] overflow-hidden">
        {/* data-list: folds away under 1280px while Changes and files is beside the conversation (styles.css). */}
        <aside data-list className="min-h-0 border-r border-line">{list}</aside>
        <main className="min-h-0 min-w-0">
          {main ?? (
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                <MessageSquare className="mx-auto size-8 text-faint" />
                <div className="mt-3 text-[15px] text-muted">Pick a session, or start a new one</div>
                <button type="button" onClick={() => navigate(newSessionQuery(defaultStart(queryClient.getQueryData<SessionSummary[]>(['sessions']) ?? [])))} className="mx-auto mt-4 flex h-10 items-center gap-1.5 rounded-full bg-fg px-4 text-[14px] font-medium text-bg">
                  <Plus className="size-4" /> New session
                </button>
              </div>
            </div>
          )}
        </main>
        {settings}
        <ShortcutsSheet />
        <CommandMenu sessions={sessions ?? []} onOpenSession={open} />
      </div>
    );
  }
  return (
    <div className="app-height overflow-hidden">
      {main ?? list}
      {settings}
      <ShortcutsSheet />
      <CommandMenu sessions={sessions ?? []} onOpenSession={open} />
    </div>
  );
}
