import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, ClipboardPaste, Copy, CornerDownLeft, Loader2, Plus, TextQuote } from 'lucide-react';
import { type ReactNode, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { TerminalExit, TerminalInfo, TerminalList } from '../../shared/terminal';
import { announce } from '../lib/announce';
import { api, ApiError, type TrustChoice } from '../lib/api';
import { baseName } from '../lib/format';
import { composing, hasKeyboard } from '../lib/keyboard';
import { terminalQuote } from '../lib/quote';
import { INSTALL_URL, STATIC_DEMO } from '../lib/static-demo';
import { cleanPaste, controlCharacter, keySequence, type RowKey } from '../lib/terminal-input';
import type { Connection } from '../lib/terminal-socket';
import { isShell, takeTerminalAsks, takeTerminalFocus, useTerminalAsks, useTerminalFocusWanted, within } from '../lib/terminals';
import { Sheet } from './Sheet';
import { type ScreenHandle, type ScreenMode, type ScreenText as ScreenTextParts, TerminalScreen } from './TerminalScreen';

/** The terminal last shown for a folder, in this tab of the browser, to show again. */
const shownKey = (cwd: string) => `pelican:terminal:${cwd}`;
const rememberShown = (cwd: string, id: string) => {
  try {
    sessionStorage.setItem(shownKey(cwd), id);
  } catch {
    // Private mode: it is remembered while the tab shows.
  }
};
const shownBefore = (cwd: string) => {
  try {
    return sessionStorage.getItem(shownKey(cwd)) ?? undefined;
  } catch {
    return undefined;
  }
};

/**
 * What this tab of the browser knows of a folder's terminals, kept while the view closes and
 * opens again: those the last list had, and those gone since that were not ended here.
 */
type Kept = { known: TerminalInfo[]; lost: TerminalInfo[] };
const keptKey = (cwd: string) => `pelican:terminal-tabs:${cwd}`;
const isInfo = (t: unknown): t is TerminalInfo => {
  const info = t as Partial<TerminalInfo> | null;
  return Boolean(info && typeof info.id === 'string' && typeof info.cwd === 'string' && typeof info.program === 'string' && typeof info.createdAt === 'number');
};
const keptBefore = (cwd: string): Kept => {
  try {
    const kept = JSON.parse(sessionStorage.getItem(keptKey(cwd)) ?? 'null') as Partial<Kept> | null;
    return { known: (kept?.known ?? []).filter(isInfo), lost: (kept?.lost ?? []).filter(isInfo) };
  } catch {
    return { known: [], lost: [] };
  }
};
const keep = (cwd: string, kept: Kept) => {
  try {
    sessionStorage.setItem(keptKey(cwd), JSON.stringify(kept));
  } catch {
    // Private mode: it is kept while the view shows.
  }
};

/**
 * The terminals this page knew that are no longer running, and were not ended here: Pelican
 * stopped since (terminals end with it), or they were closed elsewhere. Their tabs stay, saying
 * so, with Start again, until dealt with.
 */
function lostSince(kept: Kept, running: TerminalInfo[], endedHere: Set<string>): TerminalInfo[] {
  const runs = new Set(running.map((t) => t.id));
  const lost = new Map<string, TerminalInfo>();
  for (const t of [...kept.lost, ...kept.known]) if (!runs.has(t.id) && !endedHere.has(t.id) && !lost.has(t.id)) lost.set(t.id, t);
  return [...lost.values()];
}

/** How a shell's end reads under its last screen. */
function endedWords(exit: TerminalExit): string {
  if (exit.signal) return `The shell ended (${exit.signal})`;
  return exit.code ? `The shell ended with exit code ${exit.code}` : 'The shell ended';
}

/** The demo's line, with its way out on the site: a link to install. */
function Reason({ text }: { text: string }) {
  const at = STATIC_DEMO ? text.indexOf('Install Pelican') : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <a href={INSTALL_URL} className="font-medium text-fg underline decoration-faint underline-offset-2">Install Pelican</a>
      {text.slice(at + 'Install Pelican'.length)}
    </>
  );
}

const Centered = ({ children }: { children: ReactNode }) => (
  <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 pb-10 text-center text-[13px] leading-relaxed text-faint">{children}</div>
);

/**
 * The Terminal tab of Changes and files: the session folder's terminals, as Claude Desktop has
 * them beside the conversation, each a tab named after the program in front (zsh, npm, vim), with
 * + for another and End to hang the shown one up. The first opens by itself. A terminal runs on
 * the computer while pages come and go; Pelican stopping ends it, and its tab says so, with Start
 * again. On a computer you type into the screen; on a phone a tap never raises the keyboard: the
 * key row and the line field under the screen type, with the phone's own keyboard, dictation and
 * input methods.
 */
export function WorkspaceTerminal({ cwd, hidden, lowest, askTrust, onQuote }: {
  cwd: string;
  /** Another tab of the pane is shown: the terminal stays connected, ready to show again at once. */
  hidden: boolean;
  /** The lowest row of the view, clear of a phone's home indicator: on a phone, or beside the conversation. */
  lowest?: 'phone' | 'pane';
  /** The trust sheet, for a folder nobody trusted that brings programs: the answer, or none. */
  askTrust: (brings: string[]) => Promise<TrustChoice | undefined>;
  /** Puts a quote of the terminal's text above the message box. */
  onQuote: (quote: string) => void;
}) {
  const queryClient = useQueryClient();
  // A touch screen types with the line field, a keyboard into the screen: decided once, as a
  // tablet that also has a trackpad says one or the other as it is used.
  const [touch] = useState(() => window.matchMedia('(pointer: coarse)').matches);
  const list = useQuery({ queryKey: ['terminals'], queryFn: api.terminals, enabled: !hidden, refetchInterval: hidden ? false : 10_000, staleTime: 2_000 });
  // The folder's terminals as this tab of the browser knows them, and those gone since that were
  // not ended here (endedHere): their tabs stay, with Start again, also when the list comes back
  // before a terminal's socket says so, and while the view closes and opens again.
  const [kept, setKept] = useState(() => keptBefore(cwd));
  const endedHere = useRef(new Set<string>());
  // A list fetched since the view opened tells what is running for sure; one from before may be old.
  const fresh = Boolean(list.isFetchedAfterMount && list.data?.available);
  const running = useMemo(() => (list.data?.available ? list.data.terminals.filter((t) => within(t.cwd, cwd)) : []), [list.data, cwd]);
  const lost = useMemo(() => lostSince(fresh ? kept : { known: [], lost: kept.lost }, running, endedHere.current), [fresh, kept, running]);
  const tabs = useMemo(() => [...running, ...lost].sort((a, b) => a.createdAt - b.createdAt), [running, lost]);
  useEffect(() => {
    if (!fresh) return;
    setKept((before) => {
      const next = { known: running, lost: lostSince(before, running, endedHere.current) };
      return JSON.stringify(next) === JSON.stringify(before) ? before : next;
    });
  }, [fresh, running]);
  useEffect(() => keep(cwd, kept), [cwd, kept]);
  const [picked, setPicked] = useState(() => shownBefore(cwd));
  const shown = tabs.find((t) => t.id === picked) ?? tabs.at(-1);
  const shownLost = Boolean(shown && lost.some((t) => t.id === shown.id));
  const [mode, setMode] = useState<ScreenMode>({ direct: false, secret: false, applicationCursor: false });
  const [connection, setConnection] = useState<Connection>();
  const [attempt, setAttempt] = useState(0);
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [confirmEnd, setConfirmEnd] = useState(false);
  // A new terminal starts by itself only the first time: not after the last was ended here, or the
  // folder's trust was not given.
  const [byHand, setByHand] = useState(false);
  const [asText, setAsText] = useState<ScreenTextParts>();
  const screen = useRef<ScreenHandle>(null);
  const opening = useRef(false);
  const asks = useTerminalAsks();
  const focusWanted = useTerminalFocusWanted();
  const latest = useRef({ tabs, shown });
  latest.current = { tabs, shown };

  const show = useCallback((id: string) => {
    setPicked(id);
    rememberShown(cwd, id);
    setConfirmEnd(false);
    setConnection(undefined);
  }, [cwd]);

  /** The list as the page knows it, one terminal changed (or, with undefined, taken out). */
  const patch = useCallback((id: string, change: (terminal: TerminalInfo) => TerminalInfo | undefined) => {
    queryClient.setQueryData<TerminalList>(['terminals'], (old) => old && {
      ...old,
      terminals: old.terminals.flatMap((t) => (t.id === id ? [change(t)].filter((n): n is TerminalInfo => Boolean(n)) : [t])),
    });
  }, [queryClient]);

  /** A new terminal in `folder`, typing `command` there once its shell is ready; asks about the folder's trust first when it needs it. */
  const open = useCallback(async (folder: string, command?: string, focus = false) => {
    if (opening.current) return;
    opening.current = true;
    setStarting(true);
    setProblem(undefined);
    setByHand(false);
    try {
      let trust: TrustChoice | undefined;
      for (;;) {
        try {
          const size = screen.current?.size() ?? { cols: 80, rows: 24 };
          const colors = screen.current?.colors();
          const terminal = await api.openTerminal({ cwd: folder, ...size, ...(command ? { command } : {}), ...(trust ? { trust } : {}), ...(colors ? { colors } : {}) });
          queryClient.setQueryData<TerminalList>(['terminals'], (old) => ({
            available: true,
            ...old,
            terminals: [...(old?.terminals ?? []).filter((t) => t.id !== terminal.id), terminal],
          }));
          show(terminal.id);
          if (focus && !touch) requestAnimationFrame(() => screen.current?.focus());
          return;
        } catch (error) {
          if (error instanceof ApiError && error.trust && !trust) {
            trust = await askTrust(error.trust.brings);
            if (trust) continue;
            setByHand(true);
            return;
          }
          setProblem(error instanceof Error ? error.message : String(error));
          return;
        }
      }
    } finally {
      opening.current = false;
      setStarting(false);
    }
  }, [queryClient, show, askTrust, touch]);

  // Open in terminal and Run in terminal, asked for elsewhere; else the folder's first terminal,
  // once what is running here is known for sure.
  useEffect(() => {
    if (hidden || !list.data?.available || opening.current || starting) return;
    const taken = takeTerminalAsks(cwd);
    if (taken.length > 0) {
      void (async () => {
        for (const ask of taken) await open(ask.folder, ask.command, true);
      })();
      return;
    }
    if (tabs.length === 0 && !byHand && !problem && list.isFetchedAfterMount) void open(cwd, undefined, takeTerminalFocus());
  }, [hidden, list.data, list.isFetchedAfterMount, asks, tabs.length, byHand, problem, starting, cwd, open]);

  // The keys, when asked for (Ctrl+`, the tab picked on a computer), once there is a terminal to type in.
  useEffect(() => {
    if (!hidden && latest.current.shown && takeTerminalFocus()) screen.current?.focus();
  }, [hidden, shown?.id, focusWanted]);

  const onProgram = useCallback((id: string, program: string) => patch(id, (t) => ({ ...t, program })), [patch]);
  const onExit = useCallback((id: string, exit: TerminalExit) => patch(id, (t) => ({ ...t, exit })), [patch]);
  const onConnection = useCallback((id: string, state: Connection) => {
    if (id === latest.current.shown?.id) setConnection(state);
    if (state.kind === 'gone') {
      // Pelican stopped since, and the shell with it, or another page ended it: the tab stays, to start again.
      const was = latest.current.tabs.find((t) => t.id === id);
      if (was) setKept((before) => ({ ...before, lost: [...before.lost.filter((t) => t.id !== id), was] }));
      patch(id, () => undefined);
    } else if (state.kind === 'closed') {
      endedHere.current.add(id);
      patch(id, () => undefined);
      if (latest.current.tabs.length <= 1) setByHand(true);
    }
  }, [patch]);
  const quote = useCallback((text: string) => {
    const made = terminalQuote(text);
    if (!made) return;
    onQuote(made);
    announce('Quoted in your message');
  }, [onQuote]);
  const longPress = useCallback(() => setAsText(screen.current?.text()), []);

  /** Takes a terminal away: its shell hung up, unless it has ended already. */
  const forget = async (terminal: TerminalInfo) => {
    const wasLost = lost.some((t) => t.id === terminal.id);
    endedHere.current.add(terminal.id);
    setKept((before) => ({ known: before.known.filter((t) => t.id !== terminal.id), lost: before.lost.filter((t) => t.id !== terminal.id) }));
    patch(terminal.id, () => undefined);
    if (wasLost) return;
    await api.closeTerminal(terminal.id).catch((error: unknown) => {
      if (!(error instanceof ApiError && error.status === 404)) setProblem(error instanceof Error ? error.message : String(error));
    });
  };
  const end = (terminal: TerminalInfo) => {
    setConfirmEnd(false);
    const at = tabs.indexOf(terminal);
    const next = tabs[at - 1] ?? tabs[at + 1];
    if (next) show(next.id);
    else setByHand(true);
    void forget(terminal);
  };
  const startAgain = (terminal: TerminalInfo) => {
    // Its place is taken by the one started here, not by one starting by itself meanwhile.
    setByHand(true);
    void forget(terminal).then(() => open(terminal.cwd, undefined, true));
  };

  if (list.isLoading) return <Centered><Loader2 className="size-5 animate-spin" /></Centered>;
  // A list that came once stays through a refetch that failed (the offline line says so).
  if (list.error && !list.data) return <Centered><span className="text-danger">{(list.error as Error).message}</span></Centered>;
  if (list.data && !list.data.available) return <Centered><p className="max-w-xs"><Reason text={list.data.reason ?? 'There is no terminal here.'} /></p></Centered>;

  const shownRuns = Boolean(shown && !shown.exit && !shownLost);
  const ended = shown && !shownRuns;
  const crowded = connection?.kind === 'crowded';
  const label = (t: TerminalInfo) => (t.cwd === cwd ? t.program : `${t.program} · ${baseName(t.cwd)}`);
  const safe = lowest === 'phone' ? 'pb-safe' : lowest === 'pane' ? 'pb-[max(0.375rem,env(safe-area-inset-bottom))]' : 'pb-1.5';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {confirmEnd && shown ? (
        <div className="flex h-10 shrink-0 items-center gap-2 pr-2 pl-4 text-[13px]">
          <span className="min-w-0 flex-1 truncate">End <span className="font-mono">{shown.program}</span>? It is still running.</span>
          <button type="button" onClick={() => end(shown)} className="h-8 shrink-0 rounded-full bg-danger px-3.5 font-medium text-bg">End</button>
          <button type="button" onClick={() => setConfirmEnd(false)} className="h-8 shrink-0 rounded-full bg-chip px-3.5">Cancel</button>
        </div>
      ) : (
        <div className="flex h-10 shrink-0 items-center gap-0.5 pr-2 pl-3">
          <div role="tablist" aria-label="Terminals" className="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {tabs.map((t) => {
              const selected = t.id === shown?.id;
              const over = Boolean(t.exit) || lost.some((l) => l.id === t.id);
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  title={t.cwd}
                  onClick={(e) => {
                    show(t.id);
                    // Picked with a mouse on a computer, it takes the keys, to type in at once, as
                    // the Terminal tab and + do (a key on the tab keeps them on the tabs).
                    if (e.detail > 0 && hasKeyboard()) requestAnimationFrame(() => screen.current?.focus());
                  }}
                  className={`h-8 max-w-[11rem] shrink-0 truncate rounded-full px-3 font-mono text-[12.5px] pointer-coarse:h-9 ${selected ? 'bg-chip' : 'hover:bg-hover'} ${over ? 'text-faint' : selected ? 'text-fg' : 'text-muted hover:text-fg'}`}
                >
                  {label(t)}
                </button>
              );
            })}
            {starting && <Loader2 className="mx-2 size-3.5 shrink-0 animate-spin text-faint" />}
          </div>
          <button
            type="button"
            aria-label="New terminal"
            title="New terminal"
            disabled={starting}
            onClick={() => void open(cwd, undefined, true)}
            className="grid size-8 shrink-0 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg disabled:opacity-40 pointer-coarse:size-10"
          >
            <Plus className="size-4" />
          </button>
          {shown && (
            <button
              type="button"
              title="Hang up this terminal’s shell, as closing a window does"
              onClick={() => (shownRuns && !isShell(shown.program) ? setConfirmEnd(true) : end(shown))}
              className="h-8 shrink-0 rounded-full px-3 text-[13px] text-muted hover:bg-hover hover:text-fg pointer-coarse:h-10"
            >
              End
            </button>
          )}
          {/* The screen as text, for a keyboard and a screen reader, as a long press opens it on a phone: seen only once it has the focus. */}
          {shown && (
            <button
              type="button"
              onClick={longPress}
              className="sr-only h-8 shrink-0 rounded-full px-3 text-[13px] whitespace-nowrap text-muted hover:bg-hover hover:text-fg focus-visible:not-sr-only"
            >
              Screen as text
            </button>
          )}
        </div>
      )}
      {problem && (
        <div className="mx-4 mb-1.5 flex shrink-0 items-start gap-2 text-[12.5px] leading-snug text-muted">
          <span className="min-w-0 flex-1">{problem}</span>
          <button type="button" onClick={() => setProblem(undefined)} className="shrink-0 text-faint hover:text-fg">Dismiss</button>
        </div>
      )}

      {/* Always there, also before the first terminal starts: a terminal starts at the size it has. */}
      <div className={`relative flex min-h-0 flex-1 flex-col pr-2 pl-4 ${touch ? 'pb-1' : 'pb-2'}`}>
        <TerminalScreen
          key={attempt}
          ref={screen}
          {...(shown && !shownLost ? { id: shown.id } : {})}
          hidden={hidden}
          touch={touch}
          label={shown ? `Terminal: ${shown.program}` : 'Terminal'}
          onProgram={onProgram}
          onExit={onExit}
          onConnection={onConnection}
          onMode={setMode}
          onLongPress={longPress}
          onQuote={quote}
        />
        {!shown && !starting && (byHand || problem) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-bg">
            <button type="button" onClick={() => void open(cwd, undefined, true)} className="flex h-10 items-center gap-1.5 rounded-full bg-chip px-4 text-[14px] hover:bg-hover">
              <Plus className="size-4" /> New terminal
            </button>
          </div>
        )}
      </div>

      {ended && shown ? (
        <div className={`flex shrink-0 items-center gap-2 border-t border-line pt-2 pr-2 pl-4 text-[13px] text-muted ${safe}`}>
          <span className="min-w-0 flex-1 truncate">{shownLost || !shown.exit ? 'This terminal is no longer running' : endedWords(shown.exit)}</span>
          <button type="button" onClick={() => startAgain(shown)} className="h-9 shrink-0 rounded-full bg-fg px-4 font-medium text-bg">Start again</button>
        </div>
      ) : crowded ? (
        <div className={`flex shrink-0 items-center gap-2 border-t border-line pt-2 pr-2 pl-4 text-[13px] text-muted ${safe}`}>
          <span className="min-w-0 flex-1">This terminal shows on as many pages as it can.</span>
          <button type="button" onClick={() => setAttempt((n) => n + 1)} className="h-9 shrink-0 rounded-full bg-chip px-4 text-fg">Try again</button>
        </div>
      ) : touch && shown ? (
        <PhoneKeys screen={screen} mode={mode} program={shown.program} safe={safe} />
      ) : null}

      <ScreenText
        {...(asText ? { text: asText } : {})}
        title={shown?.program ?? 'Terminal'}
        onClose={() => setAsText(undefined)}
        onQuote={quote}
      />
    </div>
  );
}

/** The key row: keys a phone's keyboard lacks, and paste. Ctrl holds for the next key. */
const ROW: Array<{ key: RowKey | 'ctrl' | 'paste' | string; label: ReactNode; name: string; wide?: boolean }> = [
  { key: 'esc', label: 'esc', name: 'Escape', wide: true },
  { key: 'tab', label: 'tab', name: 'Tab', wide: true },
  { key: 'ctrl', label: 'ctrl', name: 'Control', wide: true },
  { key: 'up', label: <ArrowUp className="size-4" />, name: 'Up' },
  { key: 'down', label: <ArrowDown className="size-4" />, name: 'Down' },
  { key: 'left', label: <ArrowLeft className="size-4" />, name: 'Left' },
  { key: 'right', label: <ArrowRight className="size-4" />, name: 'Right' },
  { key: '|', label: '|', name: 'Pipe' },
  { key: '~', label: '~', name: 'Tilde' },
  { key: '/', label: '/', name: 'Slash' },
  { key: '-', label: '-', name: 'Dash' },
  { key: 'paste', label: <ClipboardPaste className="size-4" />, name: 'Paste' },
];
const ROW_KEYS = new Set<string>(['esc', 'tab', 'up', 'down', 'left', 'right']);

/**
 * How a phone types into the terminal. The line field takes the phone's own keyboard, so dictation
 * and input methods (Chinese, Japanese) work, and Enter sends the line; a key of the row sends
 * what is typed so far first, so Tab completes it and an arrow moves through it. A full-screen
 * program (vim, htop) gets every key as it is typed, and at a password prompt the field hides it.
 */
function PhoneKeys({ screen, mode, program, safe }: { screen: RefObject<ScreenHandle | null>; mode: ScreenMode; program: string; safe: string }) {
  const field = useRef<HTMLInputElement>(null);
  const [ctrl, setCtrl] = useState(false);
  const [typed, setTyped] = useState(false);
  const ctrlNow = useRef(ctrl);
  ctrlNow.current = ctrl;
  const modeNow = useRef(mode);
  modeNow.current = mode;
  const composingNow = useRef(false);
  const canPaste = typeof navigator !== 'undefined' && Boolean(navigator.clipboard?.readText);

  /** Whether it went: while the connection comes back nothing does, and what was typed stays in the field. */
  const send = (text: string) => screen.current?.input(text) ?? false;
  /** What the field holds goes to the shell first, without Enter (and without a control character pasted into it). */
  const flush = () => {
    const f = field.current;
    if (!f?.value) return true;
    if (!send(cleanPaste(f.value))) return false;
    f.value = '';
    setTyped(false);
    return true;
  };
  const key = (seq: string) => {
    if (flush()) send(seq);
    setCtrl(false);
  };
  const enter = () => {
    const f = field.current;
    setCtrl(false);
    // What the line prints is read out to a screen reader once the shell is quiet: nobody types
    // into the screen here, which is what xterm reads out after.
    screen.current?.readNext();
    if (!send(`${cleanPaste(f?.value ?? '')}\r`)) return;
    if (f) f.value = '';
    setTyped(false);
  };
  /** A character of the row: into the line being typed, or with Ctrl held, Ctrl and it. */
  const character = (char: string) => {
    if (ctrlNow.current) {
      const control = controlCharacter(char);
      if (control) key(control);
      setCtrl(false);
      return;
    }
    const f = field.current;
    if (!f || (modeNow.current.direct && !f.value && send(char))) return;
    f.setRangeText(char, f.selectionStart ?? f.value.length, f.selectionEnd ?? f.value.length, 'end');
    setTyped(true);
  };
  const tap = (k: string) => {
    if (k === 'ctrl') setCtrl((on) => !on);
    else if (k === 'paste') {
      void navigator.clipboard.readText().then((text) => {
        if (text && flush()) screen.current?.paste(text);
      }, () => undefined);
    } else if (ROW_KEYS.has(k)) key(keySequence(k as RowKey, { applicationCursor: modeNow.current.applicationCursor, ctrl: ctrlNow.current }));
    else character(k);
  };

  // A full-screen program gets each key as it is typed; a composition (an input method choosing
  // characters) once it is done. Ctrl held, the next character typed is Ctrl and it.
  const take = (f: HTMLInputElement) => {
    if (composingNow.current) return;
    if (ctrlNow.current && f.value) {
      const char = f.value.slice(-1);
      f.value = f.value.slice(0, -1);
      const control = controlCharacter(char);
      if (control) key(control);
      setCtrl(false);
      setTyped(Boolean(f.value));
      return;
    }
    if (modeNow.current.direct && f.value && send(cleanPaste(f.value))) f.value = '';
    setTyped(Boolean(f.value));
  };
  // Changing to a full-screen program, what waits in the field goes to the shell first.
  useEffect(() => {
    if (mode.direct) flush();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode.direct]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (composing(e.nativeEvent)) return;
    const f = e.currentTarget;
    const special = (seq: string) => {
      e.preventDefault();
      // Esc is the terminal's here: the view must not take it to close.
      e.stopPropagation();
      key(seq);
    };
    const { applicationCursor, direct, secret } = modeNow.current;
    // Enter is the form's to send: a phone's keyboard submits it, also where it names no key. A
    // password goes on the key itself, so no browser takes the field for a sign-in to save.
    if (e.key === 'Enter' && secret) {
      e.preventDefault();
      enter();
    } else if (e.key === 'Escape') special('\x1b');
    else if (e.key === 'Tab') special('\t');
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') special(keySequence(e.key === 'ArrowUp' ? 'up' : 'down', { applicationCursor }));
    else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && (direct || !f.value)) special(keySequence(e.key === 'ArrowLeft' ? 'left' : 'right', { applicationCursor }));
    else if (e.key === 'Backspace' && !f.value) {
      e.preventDefault();
      send('\x7f');
    } else if (e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
      const control = controlCharacter(e.key);
      if (control) special(control);
    }
  };

  const placeholder = mode.direct ? `Keys go to ${program}` : mode.secret ? 'Password' : 'Type a command';
  return (
    <div className={`shrink-0 border-t border-line pt-1.5 ${safe}`}>
      <div className="flex gap-1 px-2" role="toolbar" aria-label="Keys">
        {ROW.filter((k) => k.key !== 'paste' || canPaste).map((k) => (
          <button
            key={k.key}
            type="button"
            aria-label={k.name}
            aria-pressed={k.key === 'ctrl' ? ctrl : undefined}
            // The keyboard stays as it is, up or down: the field keeps the keys.
            onPointerDown={(e) => e.preventDefault()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => tap(k.key)}
            className={`grid h-9 min-w-0 place-items-center rounded-lg font-mono text-[12.5px] ${k.wide ? 'flex-[1.45]' : 'flex-1'} ${k.key === 'ctrl' && ctrl ? 'bg-fg text-bg' : 'bg-chip text-muted active:bg-hover'}`}
          >
            {k.label}
          </button>
        ))}
      </div>
      <form
        className="flex items-center gap-1.5 px-2 pt-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (modeNow.current.direct) key('\r');
          else enter();
        }}
      >
        <input
          ref={field}
          type={mode.secret ? 'password' : 'text'}
          aria-label={mode.direct ? `Keys for ${program}` : 'Command'}
          placeholder={placeholder}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint={mode.direct ? 'enter' : 'send'}
          onKeyDown={onKeyDown}
          onInput={(e) => take(e.currentTarget)}
          onCompositionStart={() => {
            composingNow.current = true;
          }}
          onCompositionEnd={(e) => {
            composingNow.current = false;
            take(e.currentTarget);
          }}
          className="h-10 min-w-0 flex-1 rounded-full bg-chip px-4 font-mono text-[16px] outline-none placeholder:font-sans placeholder:text-faint"
        />
        <button
          type="button"
          aria-label="Enter"
          onPointerDown={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => (mode.direct ? key('\r') : enter())}
          className={`grid size-10 shrink-0 place-items-center rounded-full ${typed ? 'bg-fg text-bg' : 'bg-chip text-muted'}`}
        >
          <CornerDownLeft className="size-4" />
        </button>
      </form>
    </div>
  );
}

/**
 * The screen as text, from a long press on a phone: selected there with the system's own handles,
 * as no finger can select on the screen itself. It opens where the screen was, with the output
 * before and after it to scroll to. Quote and Copy take what is selected, else the screen.
 */
function ScreenText({ text, title, onClose, onQuote }: { text?: ScreenTextParts; title: string; onClose: () => void; onQuote: (text: string) => void }) {
  const [selected, setSelected] = useState('');
  const [copied, setCopied] = useState(false);
  const body = useRef<HTMLPreElement>(null);
  const shown = useRef<HTMLSpanElement>(null);
  const open = Boolean(text);
  useEffect(() => {
    if (!open) return undefined;
    setSelected('');
    const onChange = () => {
      const selection = getSelection();
      const el = body.current;
      const inside = selection && !selection.isCollapsed && el && el.contains(selection.anchorNode) && el.contains(selection.focusNode);
      setSelected(inside ? selection.toString() : '');
    };
    document.addEventListener('selectionchange', onChange);
    // It opens where the screen was: at the end, unless it was scrolled back.
    const frame = requestAnimationFrame(() => shown.current?.scrollIntoView({ block: 'end' }));
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('selectionchange', onChange);
    };
  }, [open]);
  const target = selected.trim() ? selected : text?.screen ?? '';
  const count = selected.trim() ? selected.trim().split('\n').length : 0;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      size="large"
      done
      header={(
        <div className="flex items-center gap-1 pb-1.5">
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-faint">{count === 0 ? 'The screen' : count === 1 ? '1 line selected' : `${count} lines selected`}</span>
          <button
            type="button"
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => {
              onQuote(target);
              onClose();
            }}
            className="flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] hover:bg-hover"
          >
            <TextQuote className="size-3.5 text-muted" /> Quote
          </button>
          <button
            type="button"
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => void navigator.clipboard?.writeText(target).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            })}
            className="flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] hover:bg-hover"
          >
            {copied ? <Check className="size-3.5 text-muted" /> : <Copy className="size-3.5 text-muted" />} Copy
          </button>
        </div>
      )}
    >
      <pre ref={body} className="px-2 pb-2 font-mono text-[12px] leading-[1.5] break-words whitespace-pre-wrap select-text">
        {text?.before ? `${text.before}\n` : ''}
        <span ref={shown}>{text?.screen}</span>
        {text?.after ? `\n${text.after}` : ''}
      </pre>
    </Sheet>
  );
}
