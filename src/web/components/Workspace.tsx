import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, MoreHorizontal, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { GitFile, QueuedPrompt } from '../../shared/protocol';
import { api, type TrustChoice, type TrustQuestion } from '../lib/api';
import { entries, PATH_ACTIONS } from '../lib/actions';
import { announce } from '../lib/announce';
import { addWaiting, useWaiting } from '../lib/drafts';
import { baseName } from '../lib/format';
import { ariaKeys, closesPane, composing, hasKeyboard, isKey, keyText } from '../lib/keyboard';
import { useMedia } from '../lib/media';
import { setPrefs, usePrefs } from '../lib/prefs';
import { fileItem, TOO_MANY_REPLIES, type WaitingItem } from '../lib/quote';
import { useComments, useCommentsChat } from '../lib/review';
import { wantTerminalFocus } from '../lib/terminals';
import { folderOf, goTo, goUp, leave, useWorkspaceStep, type WorkspaceStep, type WorkspaceTab } from '../lib/workspace-route';
import { SendComments } from './Comments';
import { ActionMenu } from './ActionMenu';
import { PaneQuote, SelectionFoot, type SelectionFootAt } from './FileViewer';
import { useDockedMark } from './PaneColumn';
import { PathLabel } from './PathLabel';
import { downloadFile } from './PathMenu';
import type { RewindPoint } from './Rewind';
import { QuoteSheet, waitingCount } from './WaitingItems';
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

/**
 * A tab asked for by name since the view last closed (the header's Changes, a tile, ⌃⇧D, /diff):
 * the one to show, also where it has little to say, as a tab tapped in the view is.
 */
let asked = false;

/** Forgets the tab last looked at: the view opens on Changes, as in a page just loaded (the tests, each a page of its own). */
export function forgetLastTab(): void {
  lastTab = 'changes';
  asked = false;
}

/** The lines a list of changed files adds and removes, as the header's Changes counts them: "+31 −2". */
export function lineCount(files: readonly GitFile[]): { added: number; removed: number } {
  return { added: files.reduce((sum, f) => sum + (f.added ?? 0), 0), removed: files.reduce((sum, f) => sum + (f.removed ?? 0), 0) };
}

/** "+31 −2", in the add and delete colors; nothing for no lines. */
export function LineCount({ added, removed }: { added: number; removed: number }) {
  if (added === 0 && removed === 0) return null;
  return (
    <span className="font-mono text-[12px] tabular-nums">
      {added > 0 && <span className="text-add">+{added}</span>}
      {added > 0 && removed > 0 && ' '}
      {removed > 0 && <span className="text-del">−{removed}</span>}
    </span>
  );
}

/**
 * Changes, Files and Terminal, the view's tabs: a light track with the one shown raised, so the
 * only black on the screen is its one action; Changes with its lines, as the header counts them.
 */
function PaneTabs({ tab, onChange, lines }: { tab: WorkspaceTab; onChange: (tab: WorkspaceTab) => void; lines: { added: number; removed: number } | undefined }) {
  const options: Array<{ value: WorkspaceTab; label: string }> = [{ value: 'changes', label: 'Changes' }, { value: 'files', label: 'Files' }, { value: 'terminal', label: 'Terminal' }];
  // Changes with its lines takes the room they need, so a phone shows its name whole; the others share the rest.
  const counted = Boolean(lines && (lines.added > 0 || lines.removed > 0));
  return (
    <div className={`grid gap-0.5 rounded-full bg-chip p-0.5 ${counted ? 'grid-cols-[minmax(max-content,1.4fr)_1fr_1fr]' : 'auto-cols-fr grid-flow-col'}`}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === tab}
          onClick={() => onChange(option.value)}
          className={`flex h-11 min-w-0 items-center justify-center gap-1.5 rounded-full px-2 text-[14px] pointer-fine:h-8 pointer-fine:text-[13.5px] ${option.value === tab ? 'bg-panel font-medium text-fg shadow-[0_1px_3px_rgba(0,0,0,0.10)]' : 'text-muted hover:text-fg'}`}
        >
          <span className="truncate">{option.label}</span>
          {option.value === 'changes' && lines && <span className="shrink-0 font-normal"><LineCount {...lines} /></span>}
        </button>
      ))}
    </div>
  );
}

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
    asked = Boolean(to);
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
  // ⌃⇧D shows Changes, or hides the pane while it shows them, as Desktop's Changes key does.
  const showsChanges = open && shownTab(step) === 'changes';
  useEffect(() => {
    if (!available) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || !isKey(e, 'changes')) return;
      e.preventDefault();
      if (showsChanges) hide();
      else show({ tab: 'changes' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [available, showsChanges, show, hide]);
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
export function Workspace({ open, docked = false, busy = false, needsYou, onClose, cwd, sessionId, onRewind, requests = true, onRequest, queued, onUnqueue, onAddToMessage, onSendComments, askTrust = noTrust, onSendNow }: {
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
  /** Rewind to here, on a turn's prompt (the chat asks first). */
  onRewind?: (point: RewindPoint) => void;
  /** Commit changes and Create PR, as requests to Claude; none for a side chat, whose Claude only reads. */
  requests?: boolean;
  /** A request to Claude from Changes' foot: sent now (queued while Claude works), or put in the message box first (⌘-click, a long press). */
  onRequest?: (text: string, how: 'send' | 'box') => void;
  /** What waits for the end of Claude's turn, and taking one back: a request queued says so on its button. */
  queued?: QueuedPrompt[];
  onUnqueue?: (uuid: string) => void;
  /** Adds text to the message being written: a file to mention; `block`, on lines of its own (a quote, a request). */
  /** `block`: on lines of its own (a request); `quote`: a quote, which waits above the message box. */
  onAddToMessage: (text: string, how?: 'block' | 'quote') => void;
  /** Sends the line comments to Claude now (they go with the next message otherwise). */
  onSendComments?: () => void;
  /** The trust sheet, for a terminal in a folder nobody trusted that brings programs: the answer, or none. */
  askTrust?: (trust: TrustQuestion) => Promise<TrustChoice | undefined>;
  /** Sends a quote taken here at once, with its note: the in-place sheet's Send now on a phone. */
  onSendNow?: (item: WaitingItem) => void;
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
  // A quote taken here (lines of a file, the terminal's output): beside the conversation it waits
  // above the message box at once, as Desktop's Attach as context does; on a phone, where the box
  // is out of sight, it opens in place as a sheet, for a note, and the view stays.
  const [quoting, setQuoting] = useState<WaitingItem>();
  const quoteHere = useCallback((item: WaitingItem) => {
    if (!docked) {
      setQuoting(item);
      return;
    }
    announce(addWaiting(chat, item) ? 'Quoted in your message' : TOO_MANY_REPLIES);
  }, [docked, chat]);
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
  // All of the changes, by Claude Code's /diff (the header's count is the same): the branch, the
  // default list, and what the foot offers.
  const allShown = !step.scope || step.scope === 'base';
  const status = useQuery({ queryKey: ['git', cwd, 'base'], queryFn: () => api.git(cwd, 'base'), enabled: open, refetchInterval: looking && allShown ? (busy ? 5_000 : 30_000) : false });
  const turns = useQuery({ queryKey: ['changes', sessionId], queryFn: () => api.changes(sessionId!), enabled: open && Boolean(sessionId), staleTime: 30_000 });
  const git = status.data?.repo ? status.data : undefined;

  // Not a repository and no turn that changed files: there is nothing to compare, so the view
  // starts in the files. Changes, tapped or asked for, still says why it is empty, until the view closes, which
  // takes its step out of the address: the side chat, in its place beside the conversation for a
  // while, gives it back as it was.
  const nothingToCompare = status.data && !status.data.repo && !status.data.untrusted && turns.data?.turns.length === 0;
  const closed = !routed;
  useEffect(() => {
    if (!closed) return;
    tapped.current = false;
    asked = false;
  }, [closed]);
  useEffect(() => {
    if (open && nothingToCompare && tab === 'changes' && !shown && !tapped.current && !asked) goTo({ tab: 'files' }, false);
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

  const changedFiles = useMemo(() => new Set(git?.files.map((f) => f.path) ?? []), [git]);
  // The shown file's path menu, as everywhere a path is: under ⋯ beside its name.
  const [pathMenu, setPathMenu] = useState<{ at: Element; keys: boolean }>();
  const shownFile = shown && git?.files.find((f) => f.path === shown.path);
  const gone = shownFile?.status === 'deleted';
  const pathTarget = shown && {
    path: shown.path,
    cwd,
    ...(!gone ? {
      attach: () => {
        if (addWaiting(chat, fileItem(shown.path))) announce(`${baseName(shown.path)} goes with your message`);
      },
      download: () => downloadFile(cwd, shown.path),
      ...(shown.kind === 'diff' ? { openInFiles: () => go({ tab: 'files', path: shown.path }) } : {}),
    } : {}),
    ...(shown.kind === 'file' && shownFile ? { changed: true, openInChanges: () => go({ tab: 'changes', path: shown.path }) } : {}),
  };
  const header = (
    <div className="pt-1 pb-2">
      {shown ? (
        <div className="flex min-w-0 items-center gap-2">
          {back}
          <div className="min-w-0 flex-1"><PathLabel path={shown.path} /></div>
          <button
            type="button"
            aria-label={`More for ${baseName(shown.path)}`}
            aria-haspopup="menu"
            aria-expanded={Boolean(pathMenu)}
            onClick={(e) => setPathMenu({ at: e.currentTarget, keys: e.detail === 0 })}
            className="-mr-1 grid size-10 shrink-0 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg"
          >
            <MoreHorizontal className="size-[18px]" />
          </button>
          <ActionMenu
            open={Boolean(pathMenu)}
            onClose={() => setPathMenu(undefined)}
            label={shown.path}
            title={<span className="font-mono">{baseName(shown.path)}</span>}
            entries={pathMenu && pathTarget ? entries(PATH_ACTIONS, pathTarget, 'menu', hasKeyboard() ? 'pointer' : 'touch') : []}
            at={pathMenu?.at ?? null}
            focusFirst={Boolean(pathMenu?.keys)}
          />
        </div>
      ) : (
        <PaneTabs tab={tab} onChange={switchTab} lines={git && lineCount(git.files)} />
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
          {...(requests && onRequest ? { onRequest } : {})}
          {...(queued ? { queued } : {})}
          {...(onUnqueue ? { onUnqueue } : {})}
        />
      )}
      {tab === 'files' && <WorkspaceFiles cwd={cwd} step={step} open={open} go={go} up={up} onAddToMessage={onAddToMessage} changed={changedFiles} />}
    </>
  );

  // The view's lowest row keeps clear of a phone's or a tablet's home indicator, also beside the
  // conversation: the bar saying Claude waits (a phone's view has it), else the comments, else a
  // selection's Quote and Copy, or the terminal's keys; the end of what scrolls, too. A computer
  // has no such edge (the inset is 0 there), so nothing moves.
  const waits = !docked && Boolean(needsYou);
  // On a phone the terminal's keys stay at the foot, by the keyboard: what waits shows above them.
  const footInTerminal = !docked && tab === 'terminal';
  // What waits goes with the next message, as comments do in Claude Desktop; Send now (⌘↵) sends it
  // on its own. Beside the conversation its chips are in view above the message box, so the foot
  // is only Send now; on a phone, where the view covers the box, it says what waits.
  const count = waitingCount(waiting);
  const footer = waiting.length > 0 && (
    <div className={`flex shrink-0 items-center gap-2 border-t border-line py-2 pr-2 pl-4 ${waits || footInTerminal ? '' : 'pb-safe'} ${docked ? 'justify-end' : ''}`}>
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
  const terminal = terminalShown && (
    <div className={tab === 'terminal' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
      <WorkspaceTerminal
        cwd={cwd}
        hidden={tab !== 'terminal'}
        lowest={(footInTerminal || waiting.length === 0) && !waits}
        {...(footInTerminal && footer ? { above: footer } : {})}
        askTrust={askTrust}
        onQuote={quoteHere}
      />
    </div>
  );
  const [foot, setFoot] = useState<HTMLDivElement | null>(null);
  const selectionFoot = useMemo<SelectionFootAt | undefined>(
    () => (foot ? { at: foot, ...(waiting.length === 0 && !waits ? { safe: true } : {}) } : undefined),
    [foot, waiting.length, waits],
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
  // Beside the conversation on a screen under 1280px, the session list makes way (styles.css); the
  // side chat, which can sit under it, marks the page too, and the mark stays while either does.
  useDockedMark(open && docked);

  if (!open) return null;
  if (docked) {
    return (
      <SendComments.Provider value={onSendComments}>
      <SelectionFoot.Provider value={selectionFoot}>
      <PaneQuote.Provider value={quoteHere}>
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
      </PaneQuote.Provider>
      </SelectionFoot.Provider>
      </SendComments.Provider>
    );
  }
  return createPortal(
    <SendComments.Provider value={onSendComments}>
    <SelectionFoot.Provider value={selectionFoot}>
    <PaneQuote.Provider value={quoteHere}>
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
      {!footInTerminal && footer}
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
      <QuoteSheet
        item={quoting}
        onClose={() => setQuoting(undefined)}
        onAdd={(item) => {
          if (!addWaiting(chat, item)) return false;
          announce(item.note ? 'Quoted with your note' : 'Quoted in your message');
          return true;
        }}
        {...(onSendNow ? { onSend: onSendNow } : {})}
      />
    </div>
    </PaneQuote.Provider>
    </SelectionFoot.Provider>
    </SendComments.Provider>,
    document.body,
  );
}
