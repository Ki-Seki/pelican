import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { api, type TrustChoice, type TrustQuestion } from '../lib/api';
import { useWaiting } from '../lib/drafts';
import { baseName } from '../lib/format';
import { ariaKeys, closesPane, composing, hasKeyboard, isKey, keyText } from '../lib/keyboard';
import { useMedia } from '../lib/media';
import { setPrefs, usePrefs } from '../lib/prefs';
import type { WaitingItem } from '../lib/quote';
import { useComments, useCommentsChat } from '../lib/review';
import { wantTerminalFocus } from '../lib/terminals';
import { folderOf, goTo, goUp, leave, useWorkspaceStep, type WorkspaceStep, type WorkspaceTab } from '../lib/workspace-route';
import { SendComments } from './Comments';
import { SelectionFoot, type SelectionFootAt } from './FileViewer';
import { PathLabel } from './PathLabel';
import { Segmented } from './Sheet';
import { waitingCount } from './WaitingItems';
import { WorkspaceChanges, WorkspaceFiles, WorkspaceTerminal } from './WorkspaceTabs';

/**
 * From this width Changes and files sits beside the conversation instead of over it; under the
 * second, the session list folds away while it does (styles.css), so the conversation keeps room.
 */
const DOCKS = '(min-width: 1024px)';
const ROOMY = '(min-width: 1280px)';

/** The keys that show and hide the pane, and that send line comments, as this computer writes them. */
export const PANE_KEYS = keyText('changes') ?? '';
const SEND_KEYS = keyText('commentsSend') ?? '';

/** The tab last looked at in this page, for the next time the view opens without a step of its own. */
let lastTab: WorkspaceTab = 'changes';

/** Without a trust sheet to ask with, a folder that needs trusting starts no terminal. */
const noTrust = async (): Promise<TrustChoice | undefined> => undefined;

/** The tab the view shows, or would show on opening: the address's, else the one last looked at. */
export const shownTab = (step: WorkspaceStep | undefined): WorkspaceTab => step?.tab ?? lastTab;

/**
 * Whether Changes and files is open, and where. On a computer it is a pane beside the conversation
 * that stays open from one session to the next (remembered in this browser), shown and hidden with
 * Cmd/Ctrl+Shift+D as in Claude Desktop, and closed with Cmd/Ctrl+\ from inside it. On a phone it
 * is a view of its own over the conversation, open while the address holds one of its steps, so
 * the back gesture closes it. `show` opens it, at a step when given one (a file named in the
 * conversation). `toggle` is for the button that shows and hides it: closed while it had the
 * keys, the pane gives them to that button.
 */
export function useWorkspacePane(available: boolean) {
  const dockable = useMedia(DOCKS);
  const roomy = useMedia(ROOMY);
  const { workspacePane } = usePrefs();
  const step = useWorkspaceStep();
  const open = available && (dockable ? workspacePane : Boolean(step));
  const show = useCallback((to?: WorkspaceStep) => {
    if (dockable) {
      setPrefs({ workspacePane: true });
      if (to) goTo(to, false);
    } else {
      goTo(to ?? { tab: lastTab }, true);
    }
  }, [dockable]);
  const hide = useCallback(() => {
    if (!dockable) {
      leave();
      return;
    }
    setPrefs({ workspacePane: false });
    goTo(undefined, false);
  }, [dockable]);
  const setOpen = useCallback((next: boolean) => (next ? show() : hide()), [show, hide]);
  useEffect(() => {
    if (!available) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (isKey(e, 'changes')) {
        e.preventDefault();
        setOpen(!open);
      } else if (isKey(e, 'searchSessions') && open && dockable && !roomy) {
        // Finding a session needs the list, which the pane has folded away: it goes, and the list
        // comes back for the search (App focuses it).
        hide();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [available, open, setOpen, hide, dockable, roomy]);
  const docked = dockable && open;
  const toggle = useRef<HTMLButtonElement>(null);
  const wasDocked = useRef(docked);
  useEffect(() => {
    const was = wasDocked.current;
    wasDocked.current = docked;
    const lost = !document.activeElement || document.activeElement === document.body;
    if (was && !docked && lost) toggle.current?.focus({ preventScroll: true });
  }, [docked]);
  return { open, setOpen, show, hide, dockable, docked, folded: docked && !roomy, toggle };
}

/**
 * On a phone, the view covers the whole screen: what is behind it takes no taps and no reading,
 * focus moves in, and goes back where it was when the view closes.
 */
function useCovering(active: boolean, view: React.RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    if (!active) return undefined;
    const root = document.getElementById('root');
    const opener = document.activeElement;
    root?.setAttribute('inert', '');
    view.current?.focus({ preventScroll: true });
    return () => {
      root?.removeAttribute('inert');
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [active, view]);
}

/**
 * What is in the session's folder: what changed, with each file's diff, and the files themselves.
 * Read only: comment on the changes, or ask Claude to change things. On a phone a view of its own
 * over the conversation, each step in the address; on a computer (`docked`) a pane beside it.
 */
export function Workspace({ open, docked = false, busy = false, needsYou, onClose, cwd, sessionId, onRewind, requests = true, onAddToMessage, onSendComments, askTrust = noTrust, onQuote }: {
  open: boolean;
  docked?: boolean;
  /** Claude is at work in the session, not waiting for an answer: what it changes shows within seconds. */
  busy?: boolean;
  /** Claude waits for an answer in the conversation, in a few words: a phone's view says so at its foot. */
  needsYou?: string;
  onClose: () => void;
  cwd: string;
  /** The session whose turns Changes can show, one by one (T1, T2…). */
  sessionId?: string;
  /** Rewind code: puts the files back as they were before a prompt (the chat asks first). */
  onRewind?: (uuid: string) => void;
  /** Commit, Push and Create PR, as requests to Claude; none for a side chat, whose Claude only reads. */
  requests?: boolean;
  /** Adds text to the message being written: a file to mention; `block`, on lines of its own (a quote, a request). */
  /** `block`: on lines of its own (a request); `quote`: a quote, which waits above the message box. */
  onAddToMessage: (text: string, how?: 'block' | 'quote') => void;
  /** Sends the line comments to Claude now (they go with the next message otherwise). */
  onSendComments?: () => void;
  /** The trust sheet, for a terminal in a folder nobody trusted that brings programs: the answer, or none. */
  askTrust?: (trust: TrustQuestion) => Promise<TrustChoice | undefined>;
  /** Puts a quote of the terminal above the message box, to go with the next message. */
  onQuote?: (item: WaitingItem) => void;
}) {
  const chat = useCommentsChat(cwd);
  const comments = useComments(chat);
  // Everything that waits to go with the next message: line comments, quotes, files.
  const waiting = useWaiting(chat);
  const commentsIn = useMemo(() => {
    const count = new Map<string, number>();
    for (const c of comments) count.set(c.path, (count.get(c.path) ?? 0) + 1);
    return count;
  }, [comments]);
  const routed = useWorkspaceStep();
  // The pane beside the conversation opens on the tab last used when the address names none.
  const step: WorkspaceStep = routed ?? { tab: lastTab };
  const tab = step.tab;
  const shown = step.path && !step.path.endsWith('/') ? { kind: tab === 'changes' ? 'diff' as const : 'file' as const, path: step.path } : undefined;
  /** A step further in: on a phone a step of its own in the history, beside the conversation in place. */
  const go = (to: WorkspaceStep) => goTo(to, !docked);
  const up = (to: WorkspaceStep) => (docked ? goTo(to, false) : goUp(to));
  // A tab tapped since the view opened is the one to show, also where it has little to say.
  const tapped = useRef(false);
  const switchTab = (to: WorkspaceTab) => {
    lastTab = to;
    tapped.current = true;
    // Picked on a computer, the terminal takes the keys, to type in at once.
    if (to === 'terminal' && hasKeyboard()) wantTerminalFocus();
    goTo({ tab: to }, false);
  };
  // The terminal stays connected while another tab shows, ready at once when it comes back;
  // until it is first shown, it is not loaded at all.
  const [terminalShown, setTerminalShown] = useState(false);
  if (open && tab === 'terminal' && !terminalShown) setTerminalShown(true);
  if (!open && terminalShown) setTerminalShown(false);

  // Read again while it is looked at, and only then: every 5 s while Claude works, every 30 s
  // otherwise, never while it waits for an answer or the view is closed. In a large repository
  // each read costs about a second of the computer's time; the conversation reads the same status
  // once more as each turn ends, for the count on its button.
  const looking = open && tab === 'changes';
  const status = useQuery({ queryKey: ['git', cwd], queryFn: () => api.git(cwd), enabled: open, refetchInterval: looking && !step.scope ? (busy ? 5_000 : 30_000) : false });
  const turns = useQuery({ queryKey: ['changes', sessionId], queryFn: () => api.changes(sessionId!), enabled: open && Boolean(sessionId), staleTime: 30_000 });
  const git = status.data?.repo ? status.data : undefined;

  // Not a repository and no turn that changed files: there is nothing to compare, so the view
  // starts in the files. Changes, tapped, still says why it is empty, until the view closes, which
  // takes its step out of the address: the side chat, in its place beside the conversation for a
  // while, gives it back as it was.
  const nothingToCompare = status.data && !status.data.repo && !status.data.untrusted && turns.data?.turns.length === 0;
  const closed = !routed;
  useEffect(() => {
    if (closed) tapped.current = false;
  }, [closed]);
  useEffect(() => {
    if (open && nothingToCompare && tab === 'changes' && !shown && !tapped.current) goTo({ tab: 'files' }, false);
  }, [open, nothingToCompare, tab, shown]);

  const back = shown ? (
    <button
      type="button"
      onClick={() => up(shown.kind === 'diff' ? { tab: 'changes', ...(step.scope ? { scope: step.scope } : {}) } : { tab: 'files', ...(folderOf(shown.path) ? { path: folderOf(shown.path) } : {}) })}
      className="-ml-1 flex h-10 min-w-0 shrink-0 items-center gap-1 rounded-full pr-2 text-[13px] text-muted hover:text-fg"
    >
      <ChevronLeft className="size-4 shrink-0" />
      <span className="max-w-[9rem] truncate">{shown.kind === 'diff' ? 'Changes' : (folderOf(shown.path).slice(0, -1).split('/').pop() || baseName(cwd))}</span>
    </button>
  ) : null;

  const header = (
    <div className="pt-1 pb-2">
      {shown ? (
        <div className="flex min-w-0 items-center gap-2">
          {back}
          <div className="min-w-0 flex-1"><PathLabel path={shown.path} /></div>
        </div>
      ) : (
        <Segmented<WorkspaceTab>
          value={tab}
          onChange={switchTab}
          options={[
            { value: 'changes', label: git && git.files.length > 0 ? `Changes · ${git.files.length}` : 'Changes' },
            { value: 'files', label: 'Files' },
            { value: 'terminal', label: 'Terminal' },
          ]}
        />
      )}
    </div>
  );

  const body = (
    <>
      {tab === 'changes' && (
        <WorkspaceChanges
          cwd={cwd}
          {...(sessionId ? { sessionId } : {})}
          step={step}
          looking={looking}
          busy={busy}
          status={status}
          commentsIn={commentsIn}
          go={go}
          setScope={(to) => goTo(to, false)}
          {...(onRewind ? { onRewind } : {})}
          {...(requests ? { onRequest: (text: string) => onAddToMessage(text, 'block') } : {})}
        />
      )}
      {tab === 'files' && <WorkspaceFiles cwd={cwd} step={step} open={open} go={go} up={up} onAddToMessage={onAddToMessage} />}
    </>
  );

  // The view's lowest row keeps clear of a phone's or a tablet's home indicator, also beside the
  // conversation: the bar saying Claude waits (a phone's view has it), else the comments, else a
  // selection's Quote and Copy, or the terminal's keys; the end of what scrolls, too. A computer
  // has no such edge (the inset is 0 there), so nothing moves.
  const waits = !docked && Boolean(needsYou);
  const terminal = terminalShown && (
    <div className={tab === 'terminal' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
      <WorkspaceTerminal
        cwd={cwd}
        hidden={tab !== 'terminal'}
        lowest={waiting.length === 0 && !waits}
        askTrust={askTrust}
        onQuote={(item) => onQuote?.(item)}
      />
    </div>
  );
  const [foot, setFoot] = useState<HTMLDivElement | null>(null);
  const selectionFoot = useMemo<SelectionFootAt | undefined>(
    () => (foot ? { at: foot, ...(waiting.length === 0 && !waits ? { safe: true } : {}) } : undefined),
    [foot, waiting.length, waits],
  );

  // What waits goes with the next message, as comments do in Claude Desktop; Send now (⌘↵) sends it
  // on its own. Beside the conversation its chips are in view above the message box, so the foot
  // is only Send now; on a phone, where the view covers the box, it says what waits.
  const count = waitingCount(waiting);
  const footer = waiting.length > 0 && (
    <div className={`flex shrink-0 items-center gap-2 border-t border-line py-2 pr-2 pl-4 ${waits ? '' : 'pb-safe'} ${docked ? 'justify-end' : ''}`}>
      {!docked && (
        <span className="min-w-0 flex-1 text-[13px] leading-snug text-muted">
          {count.said}<span className="text-faint"> {count.one ? 'waits' : 'wait'} for your next message</span>
        </span>
      )}
      {onSendComments && (
        <button type="button" onClick={onSendComments} aria-keyshortcuts={ariaKeys('commentsSend')} title={`Send now (${SEND_KEYS})`} className="flex h-11 shrink-0 items-center gap-1.5 rounded-full bg-fg px-4 text-[14px] font-medium text-bg pointer-fine:h-9">
          Send now
          {docked && SEND_KEYS && <span aria-hidden className="text-[11.5px] font-normal opacity-60">{SEND_KEYS}</span>}
        </button>
      )}
    </div>
  );
  // ⌘↵ anywhere in Changes and files sends the comments, as in Claude Desktop; beside the
  // conversation, ⌘\ closes it, as it closes the side chat there. Keys pressed in a sheet opened
  // from here reach this too (React passes them up its own tree): those are the sheet's.
  const own = (e: React.KeyboardEvent) => e.currentTarget.contains(e.target as Node);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!own(e) || e.defaultPrevented || composing(e.nativeEvent)) return;
    if (docked && closesPane(e)) {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && waiting.length > 0 && onSendComments) {
      e.preventDefault();
      onSendComments();
    }
  };

  const view = useRef<HTMLDivElement>(null);
  useCovering(open && !docked, view);
  // Beside the conversation on a screen under 1280px, the session list makes way (styles.css).
  useLayoutEffect(() => {
    if (!open || !docked) return undefined;
    document.documentElement.dataset.pane = 'docked';
    return () => {
      delete document.documentElement.dataset.pane;
    };
  }, [open, docked]);

  if (!open) return null;
  if (docked) {
    return (
      <SendComments.Provider value={onSendComments}>
      <SelectionFoot.Provider value={selectionFoot}>
      <aside aria-label="Changes and files" data-workspace onKeyDown={onKeyDown} className="absolute inset-y-0 right-0 flex w-(--pane-w) max-w-full flex-col border-l border-line bg-bg">
        <div data-makes-room="short" className="flex shrink-0 items-center gap-1 pt-1.5 pr-2 pl-5">
          <div className="min-w-0 flex-1 truncate text-[13px] font-medium text-muted">{baseName(cwd)}</div>
          <button type="button" aria-label="Close" title={`Close (${PANE_KEYS})`} onClick={onClose} className="grid size-10 shrink-0 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg">
            <X className="size-[18px]" />
          </button>
        </div>
        <div data-makes-room="short" className="shrink-0 px-4">{header}</div>
        {tab !== 'terminal' && <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-2 pb-[max(1rem,env(safe-area-inset-bottom))]">{body}</div>}
        {terminal}
        <div ref={setFoot} className="shrink-0" />
        {footer}
      </aside>
      </SelectionFoot.Provider>
      </SendComments.Provider>
    );
  }
  return createPortal(
    <SendComments.Provider value={onSendComments}>
    <SelectionFoot.Provider value={selectionFoot}>
    <div
      ref={view}
      role="region"
      aria-label="Changes and files"
      data-workspace
      tabIndex={-1}
      onKeyDown={(e) => {
        onKeyDown(e);
        if (own(e) && e.key === 'Escape' && !e.defaultPrevented && !composing(e.nativeEvent)) {
          e.preventDefault();
          onClose();
        }
      }}
      className="app-height animate-fade fixed inset-x-0 top-0 z-30 flex flex-col bg-bg outline-none"
    >
      <div className="pt-safe shrink-0">
        <div data-makes-room="short" className="flex items-center gap-0.5 px-2 py-1.5">
          <button type="button" aria-label="Back to the conversation" onClick={onClose} className="relative grid size-10 shrink-0 place-items-center rounded-full after:absolute after:-inset-0.5 hover:bg-hover">
            <ChevronLeft className="size-5" />
          </button>
          <h2 className="min-w-0 flex-1 truncate px-1 text-[15px] font-medium">{baseName(cwd)}</h2>
        </div>
        <div data-makes-room="short" className="px-3">{header}</div>
      </div>
      {tab !== 'terminal' && <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-2 pb-[max(1rem,env(safe-area-inset-bottom))]">{body}</div>}
      {terminal}
      <div ref={setFoot} className="shrink-0" />
      {footer}
      {/* Said aloud when it comes: the page behind, where Pelican says such things, is covered. */}
      <div aria-live="polite" className="shrink-0">
        {needsYou && (
          <button type="button" onClick={onClose} className="pb-safe flex min-h-12 w-full items-center gap-2.5 border-t border-line bg-panel px-4 pt-2 text-left text-[14px]">
            <span className="size-2 shrink-0 rounded-full bg-wait" />
            <span className="min-w-0 flex-1 truncate">{needsYou}</span>
            <ChevronRight className="size-4 shrink-0 text-faint" />
          </button>
        )}
      </div>
    </div>
    </SelectionFoot.Provider>
    </SendComments.Provider>,
    document.body,
  );
}
