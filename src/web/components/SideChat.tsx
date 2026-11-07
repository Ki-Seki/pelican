import { useQuery } from '@tanstack/react-query';
import { ChevronDown, SquarePen, X } from 'lucide-react';
import { type KeyboardEvent, type RefObject, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import type { ChatMessage, RunSettings, SendMode, SessionSummary } from '../../shared/protocol';
import { shortTitle } from '../../shared/titles';
import type { MenuEntry } from '../lib/actions';
import { api, isDemoNote, isUnreachable } from '../lib/api';
import { addWaiting, clearDraft, putBackWaiting, takeWaiting } from '../lib/drafts';
import { newId } from '../lib/ids';
import { closesPane, composing, hasKeyboard, isKey, keyText } from '../lib/keyboard';
import { useMedia } from '../lib/media';
import { messageWith, promptGist, sendNowMessage, type WaitingItem } from '../lib/quote';
import { socket } from '../lib/socket';
import { addLocalMessage, adoptView, loadLatest, removeLocalMessage, useSessionView } from '../lib/store';
import { useWorkspaceStep } from '../lib/workspace-route';
import { ActionMenu } from './ActionMenu';
import { Composer, type ComposerDraft, type ComposerHandle } from './Composer';
import { MessageList } from './MessageList';
import { useDockedMark } from './PaneColumn';
import { type QuoteTarget, QuoteTargetContext } from './Quotes';
import { Sheet } from './Sheet';

/**
 * From this width the side chat sits beside the conversation, in the column Changes, Files and the
 * Terminal sit in (PaneColumn), and under the second, the session list folds away while it does
 * (styles.css) and the column has room for one of them at a time; on narrower screens it is a
 * sheet over the conversation.
 */
const BESIDE = '(min-width: 1024px)';
const ROOMY = '(min-width: 1280px)';

/** The keys that open and close it, as in Claude Desktop. */
export const SIDE_CHAT_KEYS = keyText('sideChat') ?? '';

/** What the side chat says it does, under its title. */
const READS = 'Reads this session · changes nothing';

/** The side chat's message box (its draft, and the passages that wait in it), one for each session's side chats. */
export const sideBoxOf = (sessionId: string) => `side:${sessionId}`;

/** A side chat of a session's, as its ▾ lists them. */
export type SideChatEntry = {
  id: string;
  /** Its first question, in a few words, which names it; none before it asked one. */
  question?: string;
  /** The message its own conversation starts at, after the copy of the session's. */
  start?: string;
  /** When it was last used: the latest comes first, and is the one the side chat opens on. */
  at: number;
};

/** Picked for a session: a side chat to be made by its first question, from the session as it is then. */
const NEW = 'new';

/**
 * What this page knows of a session's side chats beyond the server's list (the session summaries,
 * which say which session each copies, and its first question): those made or asked in here, until
 * the list says as much, and the one picked for each session (in the ▾, or by starting a new one),
 * which shows while the page is open. Unpicked, a session's side chat opens on its latest.
 */
const made = new Map<string, SideChatEntry[]>();
const picked = new Map<string, string>();
let changes = 0;
const changeListeners = new Set<() => void>();
const changed = () => {
  changes += 1;
  for (const listener of changeListeners) listener();
};
const subscribeChanges = (listener: () => void) => {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
};

/** Shows this side chat of the session's (its id), a new one (NEW), or, with none, the latest. */
function pickSideChat(sessionId: string, id: string | undefined): void {
  if (picked.get(sessionId) === id) return;
  if (id) picked.set(sessionId, id);
  else picked.delete(sessionId);
  changed();
}

/** Notes what this page made or asked of a side chat, before the server's list says so. */
function noteSideChat(sessionId: string, entry: SideChatEntry): void {
  const before = made.get(sessionId)?.find((e) => e.id === entry.id);
  made.set(sessionId, [{ ...before, ...entry }, ...(made.get(sessionId) ?? []).filter((e) => e.id !== entry.id)]);
  changed();
}

/** Forgets what this page picked and made: each test a page of its own. */
export function forgetSideChats(): void {
  made.clear();
  picked.clear();
  changed();
}

/**
 * A session's side chats, the latest first: those the server lists (not archived), and those made
 * here that it does not list yet, with what was asked here since it last looked.
 */
export function sideChatsOf(sessionId: string, sessions: readonly SessionSummary[] | undefined): SideChatEntry[] {
  const listed = new Map<string, SessionSummary>();
  for (const session of sessions ?? []) if (session.sideChatOf === sessionId) listed.set(session.id, session);
  const all = new Map<string, SideChatEntry>();
  for (const session of listed.values()) {
    if (session.archived) continue;
    all.set(session.id, { id: session.id, at: session.lastActivity, ...(session.sideQuestion ? { question: session.sideQuestion } : {}), ...(session.sideStart ? { start: session.sideStart } : {}) });
  }
  for (const here of made.get(sessionId) ?? []) {
    const known = listed.get(here.id);
    if (known?.archived) continue;
    const there = all.get(here.id);
    all.set(here.id, there ? { ...there, ...here, at: Math.max(there.at, here.at) } : here);
  }
  return [...all.values()].sort((a, b) => b.at - a.at);
}

/** A question as it names its side chat: what was typed, else the passage it was asked with, in a few words, as the server names it. */
const nameOf = (said: string) => shortTitle(promptGist(said)) || undefined;

/** Sessions whose side chat was asked for from elsewhere (a row's menu in the list), until their chat opens it. */
const asked = new Set<string>();
const askListeners = new Set<(id: string) => void>();

/**
 * Asks for a session's side chat: its chat opens it, now if it is open, else once it is. With a
 * side chat's id (a side chat's row in the list), on that one.
 */
export function askSideChat(sessionId: string, sideChatId?: string): void {
  if (sideChatId) pickSideChat(sessionId, sideChatId);
  asked.add(sessionId);
  for (const listener of askListeners) listener(sessionId);
}

/** Opens the side chat (`show`) when it is asked for this session from elsewhere. */
export function useSideChatAsked(sessionId: string | undefined, show: () => void): void {
  useEffect(() => {
    if (!sessionId) return undefined;
    const take = (id: string) => {
      if (id === sessionId && asked.delete(id)) show();
    };
    take(sessionId);
    askListeners.add(take);
    return () => {
      askListeners.delete(take);
    };
  }, [sessionId, show]);
}

/** Changes, Files and the Terminal, as Chat has them (Workspace's useWorkspacePane): the pane the side chat shares its column with. */
type Pane = { open: boolean; setOpen: (open: boolean) => void; dockable: boolean };

export type SideChatState = {
  /** Open for this session: shown, or, under 1280px, waiting behind the pane asked for since. */
  open: boolean;
  /** Beside the conversation, in the column it shares with the pane. */
  docked: boolean;
  /** Under the pane in that column, from 1280px, where there is room for both. */
  stacked: boolean;
  /** Under 1280px, where the column holds one of them, in front of the pane, which waits behind it. */
  hidesPane: boolean;
  /** Under 1280px, open but behind the pane asked for since, as it was: Cmd/Ctrl+; brings it forward. */
  behind: boolean;
  /** Of the two beside the conversation, the one asked for last: what Cmd/Ctrl+\ closes from the conversation. */
  front: 'side' | 'pane';
  /**
   * Opens it. Given a question, asks it there: in the side chat shown, or, when it was closed, in a
   * new one, from the session as it is now (as a question with /btw is asked).
   */
  show: (question?: string) => void;
  /**
   * Start a side chat with a passage (a selection, a reply, a command's output), which waits in its
   * box for the question: a new one when it was closed; Send to side chat, the one open, otherwise.
   */
  start: (item: WaitingItem) => void;
  close: () => void;
  /**
   * Makes way for what is asked for in the pane: a file named in the conversation or in an answer,
   * a turn's changes, a tab. Beside the conversation the pane opens over the side chat (from
   * 1280px) or in front of it; a sheet first plays its way out, as it holds the rest of the page
   * until it has gone.
   */
  makeWay: (then: () => void) => void;
  /** A question to ask as it opens, new each time (`key`). */
  question?: { text: string; key: number };
  /** In the sheet, to know when the sheet has gone. */
  sheet: RefObject<HTMLDivElement | null>;
};

/**
 * Whether the session's side chat is open, and where. Cmd/Ctrl+; opens and closes it, as in
 * Claude Desktop. On a computer it sits in the column beside the conversation: alone, all of it;
 * with the pane open, from 1280px under it, and under that in its place, the one asked for last in
 * front and the other waiting behind it (the pane's button, a path or ⌃⇧D bring the pane forward,
 * Cmd/Ctrl+; the side chat), each coming back as the other closes.
 */
export function useSideChat(sessionId: string | undefined, available: boolean, pane: Pane, keysBack?: () => void): SideChatState {
  const beside = useMedia(BESIDE);
  const roomy = useMedia(ROOMY);
  const [open, setOpen] = useState(false);
  const [front, setFront] = useState<'side' | 'pane'>('side');
  const [question, setQuestion] = useState<{ text: string; key: number }>();
  // What had the keys when it opened, to have them again when it closes (a sheet does this itself).
  const opener = useRef<Element | null>(null);
  const toggle = useCallback((next: boolean) => {
    setOpen((was) => {
      if (next && !was) opener.current = document.activeElement;
      return next;
    });
    if (next) setFront('side');
  }, []);
  const isOpen = available && open;
  const openNow = useRef(isOpen);
  openNow.current = isOpen;
  const show = useCallback((text?: string) => {
    const words = text?.trim();
    if (words && !openNow.current && sessionId) pickSideChat(sessionId, NEW);
    toggle(true);
    if (words) setQuestion({ text: words, key: Date.now() });
  }, [toggle, sessionId]);
  const start = useCallback((item: WaitingItem) => {
    if (!sessionId) return;
    if (!openNow.current) pickSideChat(sessionId, NEW);
    addWaiting(sideBoxOf(sessionId), item);
    toggle(true);
  }, [toggle, sessionId]);
  const close = useCallback(() => toggle(false), [toggle]);

  const { open: paneOpen, setOpen: setPaneOpen, dockable } = pane;
  const shared = isOpen && beside && dockable && paneOpen;
  const stacked = shared && roomy;
  const hidesPane = shared && !roomy && front === 'side';
  const behind = shared && !roomy && front === 'pane';
  const docked = isOpen && beside && !behind;
  const sheeted = isOpen && !beside;

  const sheet = useRef<HTMLDivElement>(null);
  const shown = useRef({ sheeted });
  shown.current = { sheeted };
  const makeWay = useCallback((then: () => void) => {
    if (!shown.current.sheeted) {
      setFront('pane');
      then();
      return;
    }
    const dialog = sheet.current?.closest('dialog');
    toggle(false);
    if (dialog?.open) dialog.addEventListener('close', () => then(), { once: true });
    else then();
  }, [toggle]);

  // Closed, the keys go back to what had them, or to the message box when that has gone (the
  // session menu it was opened from).
  const giveKeys = useRef(keysBack);
  giveKeys.current = keysBack;
  useEffect(() => {
    if (open) return;
    const back = opener.current;
    opener.current = null;
    const lost = !document.activeElement || document.activeElement === document.body;
    if (!lost || !back) return;
    if (back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true });
    else giveKeys.current?.();
  }, [open]);

  useEffect(() => {
    if (!available) return undefined;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.repeat) return;
      if (!isKey(e, 'sideChat')) return;
      // A sheet that is open keeps the keys, unless it is the side chat's own.
      if (!open && document.querySelector('dialog[open]')) return;
      e.preventDefault();
      // Waiting behind the pane, it comes in front; shown, it closes.
      if (behind) setFront('side');
      else toggle(!open);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [available, open, behind, toggle]);

  // The pane asked for while the side chat is in front of it (under 1280px), by its key, which
  // shows it (or a tab of it) without making way: it comes in front. Its key hides it while it
  // shows Changes, which it did behind the side chat: then it opens again, as it was asked for.
  const tab = useWorkspaceStep()?.tab;
  const before = useRef({ paneOpen, tab, hidesPane });
  useEffect(() => {
    const was = before.current;
    before.current = { paneOpen, tab, hidesPane };
    if (!isOpen || !beside || roomy || front !== 'side') return;
    if (was.paneOpen === paneOpen && (!paneOpen || was.tab === tab)) return;
    if (!paneOpen && !was.hidesPane) return;
    setFront('pane');
    if (!paneOpen) setPaneOpen(true);
  }, [paneOpen, tab, hidesPane, isOpen, beside, roomy, front, setPaneOpen]);

  return { open: isOpen, docked, stacked, hidesPane, behind, front, show, start, close, makeWay, sheet, ...(question ? { question } : {}) };
}

const pendingMessage = (uuid: string, text: string): ChatMessage => ({ uuid, role: 'user', blocks: [{ type: 'text', text }], timestamp: Date.now(), pending: true });

/**
 * How a side chat is called, on screen and to a screen reader: "Side chat · Why not a class on
 * html?" once it asked a question, cut short at its end; the name of its sheet and its ▾ too.
 */
function SideChatName({ question }: { question: string | undefined }) {
  return (
    <span className="min-w-0 truncate">
      <span className="font-medium text-fg">Side chat</span>
      {question && <>{' · '}<span>{question}</span></>}
    </span>
  );
}

/**
 * The side chat itself: questions about the session, answered by a Claude that reads the copy of
 * it made for the first question (server: side-chat.ts), with only that exchange shown. The
 * session goes on as it was, also while Claude works in it. A session's side chats are the
 * server's to list (its summaries say which session each copies, and its first question, which
 * names it), so a phone and a computer see the same ones, also after a reload: it opens on the
 * latest, and its name's ▾ has the others and New side chat.
 */
export function SideChat({
  state, sessionId, settings, cwd, machine, demo,
}: {
  state: SideChatState;
  sessionId: string;
  /** The session's model, effort and speed, which the side chat takes; its mode is its own. */
  settings: RunSettings;
  cwd?: string;
  machine?: string;
  demo?: boolean;
}) {
  useSyncExternalStore(subscribeChanges, () => changes);
  // The server's list, which every page of this computer reads: watched while the side chat is open.
  const { data: sessions } = useQuery({ queryKey: ['sessions'], queryFn: api.sessions, enabled: state.open });
  const entries = sideChatsOf(sessionId, sessions);
  const choice = picked.get(sessionId);
  const current = choice === NEW ? undefined : entries.find((e) => e.id === choice) ?? entries[0];
  // Before the first answer has a side chat to go to, its question waits in a view of its own.
  const waitingView = `side-new:${sessionId}`;
  const viewId = current?.id ?? waitingView;
  // Watched only while open: closed, it keeps no place among the views the page holds on to.
  const view = useSessionView(state.open ? viewId : undefined);
  const busy = Boolean(current && view.run?.busy);
  const draftKey = sideBoxOf(sessionId);
  const [error, setError] = useState<{ text: string; note: boolean }>();
  const [giveBack, setGiveBack] = useState<ComposerDraft>();
  const asking = useRef(false);
  // Its ▾, open under its name; from the keys, with its first item ready for the arrows.
  const [menuAt, setMenuAt] = useState<{ at: HTMLElement; keys: boolean }>();

  // Only the side chat's own conversation: the copy of the session's comes before its first
  // question. Not loaded yet (a long side chat), the older pages load until it is.
  const at = current?.start ? view.messages.findIndex((m) => m.uuid === current.start || m.sourceUuid === current.start) : -1;
  const own = useMemo(() => {
    if (!current) return { ...view, offset: 0 };
    if (at < 0) return { ...view, messages: [], offset: current.start && view.loaded ? view.offset : 0 };
    return { ...view, messages: view.messages.slice(at), offset: 0 };
  }, [view, current, at]);

  const currentId = current?.id;
  useEffect(() => {
    if (!state.open || !currentId) return undefined;
    // The demo's server changes nothing; the page plays it out (lib/demo).
    if (!demo) socket.subscribe(currentId);
    void loadLatest(currentId);
    return () => {
      if (!demo) socket.unsubscribe(currentId);
    };
  }, [state.open, currentId, demo]);

  /**
   * Asks a question, with what waits above the side chat's box (a passage it was started with), or
   * sends `now`, a quote with its note from the note box, as one reply. Either way, what does not
   * go comes back: words to the box, a quote with its note to wait above it.
   */
  const ask = async (text: string, mode: SendMode = 'steer', now?: WaitingItem) => {
    // The first question is still making the side chat: this one waits in the box.
    if (asking.current) {
      if (now) putBackWaiting(draftKey, [now]);
      else setGiveBack({ text, key: Date.now(), back: true });
      return;
    }
    setError(undefined);
    const uuid = newId();
    const taken = now ? [now] : takeWaiting(draftKey);
    const said = now ? sendNowMessage(now.text, now.note ?? '') : messageWith(taken, text);
    const giveItBack = (failure: unknown) => {
      setError({ text: (failure as Error).message, note: isDemoNote(failure) || isUnreachable(failure) });
      putBackWaiting(draftKey, taken);
      if (!now) setGiveBack({ text, key: Date.now(), back: true });
    };
    if (current) {
      // Its first question never reached the side chat (its Claude did not start), or is not in its
      // conversation, read to its start: this one starts its conversation.
      const starts = at < 0 && (!current.start || (view.loaded && view.offset === 0));
      const name = starts ? nameOf(said) : undefined;
      // Asked in, it is the latest, also before the server's list says so.
      noteSideChat(sessionId, { ...current, at: Date.now(), ...(starts ? { start: uuid } : {}), ...(name ? { question: name } : {}) });
      addLocalMessage(current.id, pendingMessage(uuid, said));
      try {
        await api.send(current.id, { text: said, attachments: [], settings, uuid, ...(busy ? { mode } : {}) });
        if (!now) clearDraft(draftKey, text);
      } catch (failure) {
        removeLocalMessage(current.id, uuid);
        giveItBack(failure);
      }
      return;
    }
    asking.current = true;
    addLocalMessage(waitingView, pendingMessage(uuid, said));
    try {
      const { sessionId: id } = await api.side(sessionId, { question: said, settings, uuid });
      const name = nameOf(said);
      noteSideChat(sessionId, { id, start: uuid, at: Date.now(), ...(name ? { question: name } : {}) });
      adoptView(waitingView, id);
      // Shown from now on, unless another was picked meanwhile.
      if (picked.get(sessionId) === NEW || !picked.has(sessionId)) pickSideChat(sessionId, id);
      if (!now) clearDraft(draftKey, text);
    } catch (failure) {
      removeLocalMessage(waitingView, uuid);
      giveItBack(failure);
    } finally {
      asking.current = false;
    }
  };

  // Quotes taken from its answers wait in its own box; Send now in the note box asks at once.
  const askRef = useRef(ask);
  askRef.current = ask;
  const quoteTarget = useMemo<QuoteTarget>(() => ({
    chat: draftKey,
    side: true,
    sendNow: (item) => void askRef.current('', 'steer', item),
  }), [draftKey]);

  // A question it was opened with (/btw and a question) is asked at once.
  const askedWith = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!state.open || !state.question || askedWith.current === state.question.key) return;
    askedWith.current = state.question.key;
    void askRef.current(state.question.text);
  }, [state.open, state.question]);

  /** Shows another of the session's side chats, or a new one (NEW), from the session as it is now; on a computer its box has the keys. */
  const box = useRef<ComposerHandle>(null);
  const choose = (id: string) => {
    pickSideChat(sessionId, id);
    setError(undefined);
    if (hasKeyboard()) box.current?.focus();
  };

  // Beside the conversation on a screen under 1280px, the session list makes way (styles.css).
  useDockedMark(state.docked);

  // Its ▾: the session's other side chats, the latest first, each by its first question, then New
  // side chat (unless it shows a new one already).
  const others = entries.filter((e) => e.id !== current?.id);
  const menu: MenuEntry[] = [
    ...others.map((e): MenuEntry => ({ id: e.id, label: e.question ?? 'Side chat', run: () => choose(e.id) })),
    ...(current ? [{ id: NEW, label: 'New side chat', icon: SquarePen, rule: others.length > 0, run: () => choose(NEW) }] : []),
  ];
  const name = (
    <span className="flex min-w-0 items-center gap-0.5">
      {menu.length > 0 ? (
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={Boolean(menuAt)}
          onClick={(e) => setMenuAt({ at: e.currentTarget, keys: e.detail === 0 })}
          className={`-ml-1.5 flex h-11 min-w-0 items-center gap-1 rounded-lg px-1.5 text-left hover:bg-hover pointer-fine:h-8 ${menuAt ? 'bg-hover' : ''}`}
        >
          <SideChatName question={current?.question} />
          <ChevronDown aria-hidden className="size-4 shrink-0 text-faint" />
        </button>
      ) : (
        <SideChatName question={current?.question} />
      )}
    </span>
  );
  const sideChats = (
    <ActionMenu
      open={Boolean(menuAt)}
      onClose={() => setMenuAt(undefined)}
      label="Side chats"
      entries={menu}
      at={menuAt?.at ?? null}
      keys={false}
      focusFirst={Boolean(menuAt?.keys)}
    />
  );

  const stop = () => current && void api.interrupt(current.id);
  const body = (
    <>
      <div className="flex min-h-0 flex-1 flex-col">
        {own.messages.length > 0 || busy || own.offset > 0 ? (
          <QuoteTargetContext.Provider value={quoteTarget}>
            <MessageList sessionId={viewId} view={own} cwd={cwd} {...(machine ? { machine } : {})} mode="normal" />
          </QuoteTargetContext.Provider>
        ) : (
          <div className="flex-1" />
        )}
      </div>
      {error && (
        <div role="status" className={`mx-3 mb-1.5 rounded-xl px-3 py-2 text-[12.5px] leading-snug ${error.note ? 'text-muted' : 'border border-line bg-panel text-danger'}`}>{error.text}</div>
      )}
      {/* Beside the conversation it is at the foot of the screen, as the conversation's box is; a sheet keeps clear of the edge itself. */}
      <Composer
        ref={box}
        side
        atBottom={state.docked}
        busy={busy}
        settings={settings}
        onSettings={() => {}}
        models={undefined}
        onSend={(text, _attachments, mode) => void ask(text, mode)}
        onStop={stop}
        stopping={Boolean(view.run?.stopping)}
        autoFocus={hasKeyboard()}
        placeholder="Ask a side question"
        draftKey={draftKey}
        {...(cwd ? { cwd } : {})}
        {...(giveBack ? { draft: giveBack } : {})}
      />
    </>
  );

  if (state.docked) {
    return (
      <aside
        aria-label="Side chat"
        data-stacked={state.stacked || undefined}
        className="absolute inset-y-0 right-0 flex w-(--pane-w) flex-col border-l border-line bg-bg"
        onKeyDown={(e: KeyboardEvent) => {
          // Keys pressed in a menu opened from here (its ▾) reach this too (React passes them up its own tree): those are the menu's.
          if (!e.currentTarget.contains(e.target as Node) || e.defaultPrevented || composing(e.nativeEvent)) return;
          // Esc stops the answer, or puts the side chat away; Cmd/Ctrl+\ closes it, as a pane in Desktop.
          if (e.key !== 'Escape' && !closesPane(e)) return;
          e.preventDefault();
          if (e.key === 'Escape' && busy) stop();
          else state.close();
        }}
        // Files dropped here are not for the conversation's message box beside it.
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = 'none';
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <div className={`flex shrink-0 items-center gap-1 pr-2 pl-5 ${state.stacked ? 'pt-2.5' : 'pt-1.5'}`}>
          <h2 className="flex min-w-0 flex-1 text-[13px] text-muted">{name}</h2>
          <button type="button" aria-label="Close" title={`Close (${SIDE_CHAT_KEYS})`} onClick={state.close} className="grid size-10 shrink-0 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg">
            <X className="size-[18px]" />
          </button>
        </div>
        {/* Under the pane, where its height is shared, the name says enough. */}
        {!state.stacked && <p className="shrink-0 px-5 pb-1 text-[12px] text-faint">{READS}</p>}
        {body}
        {sideChats}
      </aside>
    );
  }
  // Under 1280px, behind the pane asked for since: it waits there as it was.
  if (state.behind) return null;
  return (
    <Sheet
      open={state.open}
      onClose={state.close}
      title={name}
      size="large"
      trailing={(
        <button type="button" aria-label="Close" onClick={state.close} className="-my-1.5 -mr-2 grid size-11 shrink-0 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg">
          <X className="size-[18px]" />
        </button>
      )}
      header={<p className="truncate pb-1 text-[12px] text-faint">{READS}</p>}
    >
      <div ref={state.sheet} className="-mx-2 -mb-2 flex h-full min-h-0 flex-col">{body}</div>
      {sideChats}
    </Sheet>
  );
}
