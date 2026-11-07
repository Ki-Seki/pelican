import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Keyboard, Loader2, MessageSquare, PanelLeftClose, PanelLeftOpen, Plus, Settings as SettingsIcon } from 'lucide-react';
import { Component, type ComponentProps, lazy, type ReactNode, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { SessionSummary } from '../shared/protocol';
import { Announcer } from './components/Announcer';
import { CommandMenu, commandMenuShown, showCommandMenu } from './components/CommandMenu';
import { Lightbox } from './components/Lightbox';
import { Login } from './components/Login';
import { type Offline, OfflineLine, offlineWords, retryNow, useOffline } from './components/Offline';
import { PreviewOverlay } from './components/Preview';
import { FolderPicker } from './components/NewSession';
import { SessionList, UndoLine } from './components/SessionList';
import { askSideChat } from './components/SideChat';
import { Sheet } from './components/Sheet';
import { shortcutsShown, ShortcutsSheet, showShortcuts } from './components/Shortcuts';
import { announce } from './lib/announce';
import { api, appBase, type AuthState, whenSignedOut } from './lib/api';
import { startDemo } from './lib/demo';
import { type CommandItem, useCommandPart } from './lib/commands';
import { forgetDrafts } from './lib/drafts';
import { ariaKeys, isKey, withKey } from './lib/keyboard';
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
import { applyTheme, setPrefs, usePrefs } from './lib/prefs';
import { socket } from './lib/socket';
import { defaultStart, newSessionQuery } from './lib/start';
import { STATIC_DEMO } from './lib/static-demo';
import { setWaitingCount } from './lib/title';
import { useNewVersion } from './lib/update';
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

/** Whether a pane (Changes and files, or the side chat) sits beside the conversation: the page's mark of it. */
function usePaneDocked(): boolean {
  const [docked, setDocked] = useState(() => document.documentElement.dataset.pane === 'docked');
  useEffect(() => {
    const read = () => setDocked(document.documentElement.dataset.pane === 'docked');
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-pane'] });
    read();
    return () => observer.disconnect();
  }, []);
  return docked;
}

/** A sheet or menu that is open, and not on its way out (a key pressed just after one closed is the page's). */
const OPEN_DIALOG = 'dialog[open]:not([data-closing])';

/** How long the floating list stays once the pointer has left it, so a pointer passing over its edge does not close it. */
const PEEK_LEAVE_MS = 200;

/** The button that hides and shows the session list on a computer, with Desktop's ⌘B. */
function SidebarButton({ shown, onToggle, onPeek, onLeave }: { shown: boolean; onToggle: () => void; onPeek?: () => void; onLeave?: () => void }) {
  const label = shown ? 'Hide sidebar' : 'Show sidebar';
  const Icon = shown ? PanelLeftClose : PanelLeftOpen;
  return (
    <button
      type="button"
      aria-label={label}
      title={withKey(label, 'sidebar')}
      aria-keyshortcuts={ariaKeys('sidebar')}
      onClick={onToggle}
      onPointerEnter={(e) => e.pointerType === 'mouse' && onPeek?.()}
      onPointerLeave={(e) => e.pointerType === 'mouse' && onLeave?.()}
      className="grid size-10 shrink-0 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg"
    >
      <Icon className="size-[18px]" />
    </button>
  );
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
  // The session list beside the conversation.
  const wide = useMedia('(min-width: 1024px)');
  const queryClient = useQueryClient();
  const { data: info } = useQuery({ queryKey: ['info'], queryFn: api.info, staleTime: Infinity });
  // Back after Pelican started again as another version (an update): the page loads that version's app.
  useNewVersion();
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

  // The session list on a computer: shown beside the conversation, or hidden (⌘B, its button),
  // remembered in this browser. Where a pane beside the conversation leaves too little room for it
  // (under 1280px), it is hidden the same way until it is asked back. Hidden, it floats over the
  // conversation while the pointer is at the window's left edge or on its button (`peek`), or from
  // the keyboard (⇧⌘K), until the pointer leaves it, a session is picked, or Esc.
  const prefs = usePrefs();
  const roomy = useMedia('(min-width: 1280px)');
  const paneDocked = usePaneDocked();
  const [askedBack, setAskedBack] = useState(false);
  const folds = paneDocked && !roomy;
  if (!folds && askedBack) setAskedBack(false);
  const collapsed = wide && (prefs.sidebar === 'hidden' || (folds && !askedBack));
  const [peek, setPeek] = useState<'pointer' | 'keys'>();
  if (!collapsed && peek) setPeek(undefined);
  const leaving = useRef<ReturnType<typeof setTimeout>>(undefined);
  const peekNow = useCallback((by: 'pointer' | 'keys') => {
    clearTimeout(leaving.current);
    setPeek((was) => (was === 'keys' ? was : by));
  }, []);
  const peekLeave = useCallback(() => {
    clearTimeout(leaving.current);
    // A menu opened from it (a row's) keeps it, as a pointer on it does.
    leaving.current = setTimeout(() => setPeek((was) => (was === 'pointer' && !document.querySelector(OPEN_DIALOG) ? undefined : was)), PEEK_LEAVE_MS);
  }, []);
  useEffect(() => () => clearTimeout(leaving.current), []);
  const toggleSidebar = useCallback(() => {
    setPeek(undefined);
    if (collapsed) {
      if (prefs.sidebar === 'hidden') setPrefs({ sidebar: 'shown' });
      if (folds) setAskedBack(true);
    } else if (folds) {
      setAskedBack(false);
    } else {
      setPrefs({ sidebar: 'hidden' });
    }
  }, [collapsed, folds, prefs.sidebar]);
  const aside = useRef<HTMLElement>(null);
  // Floating, Esc, a click outside it, or picking a session puts it away.
  useEffect(() => {
    if (!peek) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector(OPEN_DIALOG)) return;
      e.preventDefault();
      setPeek(undefined);
    };
    const onIt = (target: EventTarget | null) => Boolean(aside.current?.contains(target as Node) || (target as Element | null)?.closest?.('[data-sidebar-button]'));
    const onDown = (e: PointerEvent) => {
      if (!onIt(e.target)) setPeek(undefined);
    };
    // The pointer moving anywhere off it puts it away as leaving it does, though it may never have
    // been on it: the list floats in under a pointer that can move straight off, or out of the window.
    let off = false;
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      if (onIt(e.target)) {
        off = false;
        clearTimeout(leaving.current);
      } else if (!off) {
        off = true;
        peekLeave();
      }
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('pointermove', onMove, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('pointermove', onMove, true);
    };
  }, [peek, peekLeave]);

  // Desktop's keys for the whole page: ⌘K the command menu, ⇧⌘K finds a session (on a phone the
  // list comes first; hidden, it floats in), ⇧⌘O starts one, ⇧⌘, opens Settings, ⌘B shows or hides
  // the list, ⌘/ lists the keys. A sheet that is open keeps the others.
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
        if (collapsed) peekNow('keys');
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
      } else if (isKey(e, 'sidebar') && wide) {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [wide, chatOpen, navigate, queryClient, collapsed, peekNow, toggleSidebar]);

  // The page's own commands, in the / list and ⌘K (lib/commands); the open chat adds its session's.
  const pageCommands = useMemo<CommandItem[]>(() => [
    {
      id: 'new-session', group: 'pelican', label: 'New session', icon: Plus, key: 'newSession',
      run: () => navigate(newSessionQuery(defaultStart(queryClient.getQueryData<SessionSummary[]>(['sessions']) ?? []))),
    },
    { id: 'settings', group: 'pelican', label: 'Settings', icon: SettingsIcon, name: 'config', description: 'Settings', key: 'settings', run: () => setSettingsOpen(true) },
    { id: 'shortcuts', group: 'pelican', label: 'Keyboard shortcuts', icon: Keyboard, key: 'shortcuts', only: 'pointer', run: () => showShortcuts(true) },
    ...(wide ? [{ id: 'sidebar', group: 'pelican' as const, label: collapsed ? 'Show sidebar' : 'Hide sidebar', icon: collapsed ? PanelLeftOpen : PanelLeftClose, key: 'sidebar' as const, only: 'pointer' as const, run: toggleSidebar }] : []),
  ], [navigate, queryClient, wide, collapsed, toggleSidebar]);
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
      onOpen={(id) => {
        setPeek(undefined);
        open(id);
      }}
      onNew={(start) => {
        setPeek(undefined);
        navigate(newSessionQuery(start));
      }}
      onSettings={() => setSettingsOpen(true)}
      onSideChat={(id) => {
        setPeek(undefined);
        askSideChat(id);
        if (id !== sessionId) open(id);
      }}
      onGone={(id) => id === sessionId && navigate('')}
      connected={connected}
      banner={banner}
      {...(wide ? { top: <SidebarButton shown={!collapsed} onToggle={toggleSidebar} /> } : {})}
    />
  );
  // While the list is hidden: in the conversation's header, and where a page has none.
  const sidebarButton = collapsed ? (
    <span data-sidebar-button className="contents">
      <SidebarButton shown={false} onToggle={toggleSidebar} onPeek={() => peekNow('pointer')} onLeave={peekLeave} />
    </span>
  ) : undefined;

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
        {...(sidebarButton ? { lead: sidebarButton } : {})}
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
        {sidebarButton && <div className="shrink-0 px-2 py-1.5">{sidebarButton}</div>}
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
      <div
        data-layout="wide"
        data-sidebar={collapsed ? 'hidden' : 'shown'}
        className={`app-height relative grid overflow-hidden ${collapsed ? 'grid-cols-[minmax(0,1fr)]' : 'grid-cols-[minmax(300px,360px)_minmax(0,1fr)]'}`}
      >
        <aside
          ref={aside}
          data-list
          aria-label="Sessions"
          {...(collapsed && !peek ? { inert: true, 'aria-hidden': true } : {})}
          onPointerEnter={() => collapsed && peekNow('pointer')}
          onPointerLeave={(e) => collapsed && e.pointerType === 'mouse' && peekLeave()}
          className={collapsed
            ? `absolute inset-y-0 left-0 z-40 w-[360px] max-w-[85vw] border-r border-line bg-bg shadow-[6px_0_28px_rgba(0,0,0,0.12)] transition-[translate,opacity] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none ${peek ? 'translate-x-0' : 'pointer-events-none -translate-x-full opacity-0'}`
            : 'min-h-0 border-r border-line'}
        >
          {list}
        </aside>
        {/* Hidden, the list floats in from the window's left edge. */}
        {collapsed && !peek && <div aria-hidden data-sidebar-edge className="absolute inset-y-0 left-0 z-30 w-2" onPointerEnter={(e) => e.pointerType === 'mouse' && peekNow('pointer')} />}
        <main className="relative min-h-0 min-w-0">
          {main ?? (
            <div className="flex h-full items-center justify-center">
              {sidebarButton && <div className="absolute top-1.5 left-2">{sidebarButton}</div>}
              <div className="text-center">
                <MessageSquare className="mx-auto size-8 text-faint" />
                <div className="mt-3 text-[15px] text-muted">Pick a session, or start a new one</div>
                <button type="button" onClick={() => navigate(newSessionQuery(defaultStart(queryClient.getQueryData<SessionSummary[]>(['sessions']) ?? [])))} className="mx-auto mt-4 flex h-10 items-center gap-1.5 rounded-full bg-fg px-4 text-[14px] font-medium text-bg">
                  <Plus className="size-4" /> New session
                </button>
              </div>
            </div>
          )}
          {/* The list's line with Undo, while the list that has it is out of sight. */}
          {collapsed && !peek && <UndoLine className="absolute bottom-0 left-0 z-20 w-[360px] max-w-full" />}
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
