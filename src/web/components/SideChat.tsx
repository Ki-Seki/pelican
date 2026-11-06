import { SquarePen, X } from 'lucide-react';
import { type KeyboardEvent, type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { ChatMessage, RunSettings, SendMode } from '../../shared/protocol';
import { api, isDemoNote, isUnreachable } from '../lib/api';
import { clearDraft, putBackWaiting, takeWaiting } from '../lib/drafts';
import { newId } from '../lib/ids';
import { closesPane, composing, hasKeyboard, isKey, keyText } from '../lib/keyboard';
import { useMedia } from '../lib/media';
import { messageWith, sendNowMessage, type WaitingItem } from '../lib/quote';
import { socket } from '../lib/socket';
import { addLocalMessage, adoptView, loadLatest, removeLocalMessage, useSessionView } from '../lib/store';
import { Composer, type ComposerDraft } from './Composer';
import { MessageList } from './MessageList';
import { type QuoteTarget, QuoteTargetContext } from './Quotes';
import { Sheet } from './Sheet';

/**
 * From this width the side chat sits beside the conversation, as Changes and files does, and under
 * the second the session list folds away while it does (styles.css); on narrower screens it is a
 * sheet over the conversation.
 */
const BESIDE = '(min-width: 1024px)';
const ROOMY = '(min-width: 1280px)';

/** The keys that open and close it, as in Claude Desktop. */
export const SIDE_CHAT_KEYS = keyText('sideChat') ?? '';

/** What the side chat says it does, under its title. */
const READS = 'Reads this session · changes nothing';

/**
 * The side chat of each session in this visit (this tab, reloads included): opened again, it goes
 * on where it was. Its first question marks where its own conversation starts, after the copy of
 * the session's.
 */
type Remembered = { id: string; first: string };
const KEY = 'pelican:side-chats';
const inMemory = new Map<string, Remembered>();

function rememberedAll(): Record<string, Remembered> | undefined {
  try {
    const all = JSON.parse(sessionStorage.getItem(KEY) ?? '{}') as unknown;
    return all && typeof all === 'object' ? (all as Record<string, Remembered>) : {};
  } catch {
    // No storage for this page (or it is broken): memory keeps them while the page is open.
    return undefined;
  }
}

function remembered(sessionId: string): Remembered | undefined {
  const all = rememberedAll();
  const found = all ? all[sessionId] : inMemory.get(sessionId);
  return found && typeof found.id === 'string' && typeof found.first === 'string' ? found : undefined;
}

function remember(sessionId: string, side: Remembered | undefined): void {
  const all = rememberedAll();
  try {
    if (!all) throw new Error('no storage');
    if (side) all[sessionId] = side;
    else delete all[sessionId];
    sessionStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    if (side) inMemory.set(sessionId, side);
    else inMemory.delete(sessionId);
  }
}

/** Changes and files, as Chat has it (Workspace's useWorkspacePane): where the side chat takes turns with it. */
type Pane = { open: boolean; setOpen: (open: boolean) => void; dockable: boolean };

export type SideChatState = {
  open: boolean;
  /** Beside the conversation, where Changes and files sits when it is docked. */
  docked: boolean;
  /** Docked on a screen too narrow for the session list as well: the list has folded away. */
  folded: boolean;
  /** Opens it; a question is asked there at once. */
  show: (question?: string) => void;
  close: () => void;
  /**
   * Puts it away for what is asked for in its place, then does that: a file named in the
   * conversation or in an answer, a turn's changes. Beside the conversation at once; a sheet first
   * plays its way out, as it holds the rest of the page until it has gone.
   */
  makeWay: (then: () => void) => void;
  /** A question to ask as it opens, new each time (`key`). */
  question?: { text: string; key: number };
  /** In the sheet, to know when the sheet has gone. */
  sheet: RefObject<HTMLDivElement | null>;
};

/**
 * Whether the session's side chat is open, and where. Cmd/Ctrl+; opens and closes it, as in
 * Claude Desktop. On a computer it takes the place of Changes and files beside the conversation,
 * one at a time: opening it puts that pane aside, closing it brings the pane back, and asking for
 * the pane (its button, Cmd/Ctrl+Shift+D) closes the side chat.
 */
export function useSideChat(available: boolean, pane: Pane, keysBack?: () => void): SideChatState {
  const beside = useMedia(BESIDE);
  const roomy = useMedia(ROOMY);
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState<{ text: string; key: number }>();
  // What had the keys when it opened, to have them again when it closes (a sheet does this itself).
  const opener = useRef<Element | null>(null);
  const toggle = useCallback((next: boolean) => {
    setOpen((was) => {
      if (next && !was) opener.current = document.activeElement;
      return next;
    });
  }, []);
  const show = useCallback((text?: string) => {
    toggle(true);
    if (text?.trim()) setQuestion({ text: text.trim(), key: Date.now() });
  }, [toggle]);
  const close = useCallback(() => toggle(false), [toggle]);
  const isOpen = available && open;
  const docked = isOpen && beside;

  const sheet = useRef<HTMLDivElement>(null);
  const shown = useRef({ isOpen, docked });
  shown.current = { isOpen, docked };
  const makeWay = useCallback((then: () => void) => {
    const dialog = shown.current.isOpen && !shown.current.docked ? sheet.current?.closest('dialog') : null;
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
      if (isKey(e, 'searchSessions') && docked && !roomy) {
        // Finding a session needs the list, which the side chat has folded away: it goes, and the
        // list comes back for the search (App focuses it).
        toggle(false);
        return;
      }
      if (!isKey(e, 'sideChat')) return;
      // A sheet that is open keeps the keys, unless it is the side chat's own.
      if (!open && document.querySelector('dialog[open]')) return;
      e.preventDefault();
      toggle(!open);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [available, open, docked, roomy, toggle]);

  // Asked for while the side chat is beside the conversation, Changes and files takes its place.
  const { open: paneIsOpen, setOpen: setPaneOpen, dockable } = pane;
  const paneWasOpen = useRef(paneIsOpen);
  useEffect(() => {
    const changed = paneWasOpen.current !== paneIsOpen;
    paneWasOpen.current = paneIsOpen;
    if (!changed || !docked || !dockable) return;
    toggle(false);
    if (!paneIsOpen) setPaneOpen(true);
  }, [paneIsOpen, setPaneOpen, dockable, docked, toggle]);

  return { open: isOpen, docked, folded: docked && !roomy, show, close, makeWay, sheet, ...(question ? { question } : {}) };
}

const pendingMessage = (uuid: string, text: string): ChatMessage => ({ uuid, role: 'user', blocks: [{ type: 'text', text }], timestamp: Date.now(), pending: true });

/**
 * The side chat itself: questions about the session, answered by a Claude that reads the copy of
 * it made for the first question (server: side-chat.ts), with only that exchange shown. The
 * session goes on as it was, also while Claude works in it.
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
  const [side, setSide] = useState(() => remembered(sessionId));
  // Before the first answer has a side chat to go to, its question waits in a view of its own.
  const waitingView = `side-new:${sessionId}`;
  const viewId = side?.id ?? waitingView;
  // Watched only while open: closed, it keeps no place among the views the page holds on to.
  const view = useSessionView(state.open ? viewId : undefined);
  const busy = Boolean(side && view.run?.busy);
  const draftKey = `side:${sessionId}`;
  const [error, setError] = useState<{ text: string; note: boolean }>();
  const [giveBack, setGiveBack] = useState<ComposerDraft>();
  const asking = useRef(false);

  // Only the side chat's own conversation: the copy of the session's comes before its first
  // question. Not loaded yet (a long side chat), the older pages load until it is.
  const at = side ? view.messages.findIndex((m) => m.uuid === side.first || m.sourceUuid === side.first) : -1;
  const own = useMemo(() => {
    if (!side) return { ...view, offset: 0 };
    if (at < 0) return { ...view, messages: [], offset: view.loaded ? view.offset : 0 };
    return { ...view, messages: view.messages.slice(at), offset: 0 };
  }, [view, side, at]);

  useEffect(() => {
    if (!state.open || !side) return undefined;
    // The demo's server changes nothing; the page plays it out (lib/demo).
    if (!demo) socket.subscribe(side.id);
    void loadLatest(side.id);
    return () => {
      if (!demo) socket.unsubscribe(side.id);
    };
  }, [state.open, side, demo]);

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
    if (side) {
      // Its first question never reached the side chat (its Claude did not start): this one starts its conversation.
      if (at < 0 && view.loaded && view.offset === 0) {
        const moved = { id: side.id, first: uuid };
        remember(sessionId, moved);
        setSide(moved);
      }
      addLocalMessage(side.id, pendingMessage(uuid, said));
      try {
        await api.send(side.id, { text: said, attachments: [], settings, uuid, ...(busy ? { mode } : {}) });
        if (!now) clearDraft(draftKey, text);
      } catch (failure) {
        removeLocalMessage(side.id, uuid);
        giveItBack(failure);
      }
      return;
    }
    asking.current = true;
    addLocalMessage(waitingView, pendingMessage(uuid, said));
    try {
      const { sessionId: id } = await api.side(sessionId, { question: said, settings, uuid });
      const made = { id, first: uuid };
      remember(sessionId, made);
      adoptView(waitingView, id);
      setSide(made);
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
  const asked = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!state.open || !state.question || asked.current === state.question.key) return;
    asked.current = state.question.key;
    void ask(state.question.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.open, state.question?.key]);

  /** A new side chat, from the session as it is now; the one before stays in the list, under the session. */
  const startAgain = () => {
    remember(sessionId, undefined);
    setSide(undefined);
    setError(undefined);
  };

  // Beside the conversation on a screen under 1280px, the session list makes way (styles.css).
  useLayoutEffect(() => {
    if (!state.docked) return undefined;
    document.documentElement.dataset.pane = 'docked';
    return () => {
      delete document.documentElement.dataset.pane;
    };
  }, [state.docked]);

  const stop = () => side && void api.interrupt(side.id);
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
        className="absolute inset-y-0 right-0 flex w-(--pane-w) flex-col border-l border-line bg-bg"
        onKeyDown={(e: KeyboardEvent) => {
          if (e.defaultPrevented || composing(e.nativeEvent)) return;
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
        <div className="flex shrink-0 items-center gap-1 pt-1.5 pr-2 pl-5">
          <h2 className="min-w-0 flex-1 truncate text-[13px] font-medium text-muted">Side chat</h2>
          {side && (
            <button type="button" aria-label="New side chat" title="New side chat, from the session as it is now" onClick={startAgain} className="grid size-10 shrink-0 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg">
              <SquarePen className="size-[17px]" />
            </button>
          )}
          <button type="button" aria-label="Close" title={`Close (${SIDE_CHAT_KEYS})`} onClick={state.close} className="grid size-10 shrink-0 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg">
            <X className="size-[18px]" />
          </button>
        </div>
        <p className="shrink-0 px-5 pb-1 text-[12px] text-faint">{READS}</p>
        {body}
      </aside>
    );
  }
  return (
    <Sheet
      open={state.open}
      onClose={state.close}
      title="Side chat"
      done
      size="large"
      header={(
        <div className="flex min-h-7 items-center gap-2 pb-1">
          <p className="min-w-0 flex-1 truncate text-[12px] text-faint">{READS}</p>
          {side && <button type="button" onClick={startAgain} className="-my-1 h-8 shrink-0 rounded-full px-3 text-[13px] text-muted hover:bg-hover hover:text-fg">New</button>}
        </div>
      )}
    >
      <div ref={state.sheet} className="-mx-2 -mb-2 flex h-full min-h-0 flex-col">{body}</div>
    </Sheet>
  );
}
