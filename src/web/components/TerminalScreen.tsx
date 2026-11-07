import '@xterm/xterm/css/xterm.css';

import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { type IMarker, type ITheme, Terminal } from '@xterm/xterm';
import { ArrowDown, Check, Copy, Loader2, TextQuote } from 'lucide-react';
import { forwardRef, memo, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';

import { type TerminalColors, TERMINAL_LIMITS, type TerminalExit } from '../../shared/terminal';
import { guardOutput } from '../../shared/terminal-guards';
import { loadWidths } from '../../shared/terminal-widths';
import { announce } from '../lib/announce';
import { api, checkSignedIn } from '../lib/api';
import { isApple, isKey } from '../lib/keyboard';
import { getPrefs, setPrefs } from '../lib/prefs';
import { showCursor } from '../lib/terminal-cursor';
import {
  asksForSecret, boundReadOut, bufferText, cleanPaste, cleanPastes, colorQuery, insertedText, keySequence, lineBeforeCursor, themeColors, viewportText,
} from '../lib/terminal-input';
import { type Connection, TerminalConnection } from '../lib/terminal-socket';

/** The output as text, around the rows on screen. */
export type ScreenText = { before: string; screen: string; after: string };

/** What the line field needs to know of the screen: a full-screen program, a password prompt, how arrows go. */
export type ScreenMode = { direct: boolean; secret: boolean; applicationCursor: boolean };

export type ScreenHandle = {
  /** The size the shell is drawn at here, for a terminal about to start. */
  size: () => { cols: number; rows: number };
  focus: () => void;
  /** Sends text as if typed, the screen scrolling down to where it goes; whether it went (not while the connection is down, which then says so at once). */
  input: (text: string) => boolean;
  /** Sends text as a paste: a shell that asked for bracketed pastes takes many lines without running them one by one. Whether it went. */
  paste: (text: string) => boolean;
  /** The output as text: the rows on screen now, and what is above and below them. */
  text: () => ScreenText;
  /** The colors it draws in, for a terminal about to start. */
  colors: () => TerminalColors | undefined;
  /** What the shell prints next, once it goes quiet, is read out to a screen reader (a line sent from the phone's field). */
  readNext: () => void;
};

/** What a screen reader hears of the output after a line: its first lines, and how many more there are. */
function spoken(text: string): string {
  const lines = text.split('\n');
  const said = lines.slice(0, 20).join('\n');
  return lines.length > 20 ? `${said}\nand ${lines.length - 20} more lines` : said;
}

/** The font size, the terminal's one setting, set with a pinch (or Ctrl and the wheel); its bounds. */
const FONT = { min: 8, max: 24 };

/**
 * Light and dark sets of the 16 colors programs pick from, GitHub's (Primer), whose yellow and
 * white stay readable on a light background; on top, xterm lifts any color whose contrast with its
 * background is under 4.5:1, as the rest of Pelican's text has at least.
 */
const LIGHT = {
  black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#4d2d00', blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
  brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#633c01', brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#8c959f',
};
const DARK = {
  black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922', blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
  brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
};

/** The page's own colors (styles.css), light or dark as the page is now. */
function pageTheme(): ITheme {
  const css = getComputedStyle(document.documentElement);
  const color = (name: string) => css.getPropertyValue(name).trim();
  const dark = css.colorScheme.includes('dark');
  return {
    background: color('--bg'),
    foreground: color('--fg'),
    cursor: color('--fg'),
    cursorAccent: color('--bg'),
    selectionBackground: dark ? 'rgba(255, 255, 255, 0.22)' : 'rgba(0, 0, 0, 0.14)',
    scrollbarSliderBackground: dark ? 'rgba(255, 255, 255, 0.16)' : 'rgba(0, 0, 0, 0.14)',
    scrollbarSliderHoverBackground: dark ? 'rgba(255, 255, 255, 0.28)' : 'rgba(0, 0, 0, 0.24)',
    scrollbarSliderActiveBackground: dark ? 'rgba(255, 255, 255, 0.36)' : 'rgba(0, 0, 0, 0.32)',
    ...(dark ? DARK : LIGHT),
  };
}

const monoFont = () => getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'monospace';
const fontSize = () => Math.min(FONT.max, Math.max(FONT.min, getPrefs().terminalFontSize));
const clampSize = (cols: number, rows: number) => ({
  cols: Math.min(TERMINAL_LIMITS.cols.max, Math.max(TERMINAL_LIMITS.cols.min, cols)),
  rows: Math.min(TERMINAL_LIMITS.rows.max, Math.max(TERMINAL_LIMITS.rows.min, rows)),
});

/**
 * One terminal's screen: xterm.js, drawn in the page's colors and font, and the connection to the
 * shell on the computer. The shell runs there; this draws what it prints, from the server's copy of
 * the screen first, and sends what is typed. It never answers what programs ask of the terminal
 * (where the cursor is, what it can do): the server's copy does, once, whatever pages show it.
 *
 * On a touch screen a tap never raises the keyboard (the line field below is where a phone types),
 * a swipe scrolls back, a long press opens the screen as text, and a pinch sets the size. Text
 * selected with a mouse can be quoted or copied.
 */
export const TerminalScreen = memo(forwardRef<ScreenHandle, {
  /** The terminal shown; none: an empty screen, sized for one about to start. */
  id?: string;
  /** Not on screen (another tab of the pane is): nothing is fitted until it shows again. */
  hidden: boolean;
  /** A touch screen, without a mouse: the line field and the key row type. */
  touch: boolean;
  label: string;
  onProgram: (id: string, program: string) => void;
  onExit: (id: string, exit: TerminalExit) => void;
  onConnection: (id: string, state: Connection) => void;
  onMode: (mode: ScreenMode) => void;
  onLongPress: () => void;
  onQuote: (text: string) => void;
}>(function TerminalScreen({ id, hidden, touch, label, onProgram, onExit, onConnection, onMode, onLongPress, onQuote }, ref) {
  const box = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | undefined>(undefined);
  const fitter = useRef<FitAddon | undefined>(undefined);
  const connection = useRef<TerminalConnection | undefined>(undefined);
  const [selection, setSelection] = useState('');
  const [copied, setCopied] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  /** Scrolled back on a touch screen, with no wheel to come back with: ↓ jumps to the newest output, stopping a swipe's glide. */
  const [scrolledBack, setScrolledBack] = useState(false);
  const stopGlide = useRef<() => void>(() => undefined);
  /** After a line sent from the phone's field: where its output starts, read out once the shell is quiet. */
  const reading = useRef<{ from: IMarker; quiet?: ReturnType<typeof setTimeout>; latest: ReturnType<typeof setTimeout> } | undefined>(undefined);
  /** Where the connection stands, and the timer that says Reconnecting once it has been down a moment. */
  const stateNow = useRef<Connection>(undefined);
  const slow = useRef<ReturnType<typeof setTimeout>>(undefined);
  // The latest callbacks, for xterm's listeners, made once.
  const events = useRef({ onProgram, onExit, onConnection, onMode, onLongPress });
  events.current = { onProgram, onExit, onConnection, onMode, onLongPress };
  const hiddenNow = useRef(hidden);
  hiddenNow.current = hidden;
  /** The shell was sized for another page since this one last fitted it. */
  const sizedElsewhere = useRef(false);

  /** Fits the screen to its box and tells the shell, unless the box is not on screen. */
  const fit = () => {
    const t = term.current;
    const dims = fitter.current?.proposeDimensions();
    if (!t || !dims || hiddenNow.current || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
    sizedElsewhere.current = false;
    const { cols, rows } = clampSize(dims.cols, dims.rows);
    if (cols === t.cols && rows === t.rows) return;
    t.resize(cols, rows);
    connection.current?.resize(cols, rows);
  };
  /** The page being typed in decides the size: another page may have said its own meanwhile. */
  const reclaim = () => {
    if (sizedElsewhere.current) fit();
  };
  /** Reads out what the shell printed after the line, once it went quiet (or after a few seconds). */
  const readOut = () => {
    const r = reading.current;
    const t = term.current;
    reading.current = undefined;
    if (!r) return;
    clearTimeout(r.quiet);
    clearTimeout(r.latest);
    const buffer = t?.buffer.active;
    if (buffer && buffer.type === 'normal' && !r.from.isDisposed) {
      const text = bufferText(buffer, r.from.line + 1, buffer.baseY + buffer.cursorY + 1);
      if (text.trim()) announce(spoken(text));
    }
    r.from.dispose();
  };
  /** Keys went nowhere, the connection coming back: Reconnecting shows now, not in a moment. */
  const unsent = () => {
    if (stateNow.current?.kind !== 'connecting') return;
    clearTimeout(slow.current);
    setReconnecting(true);
  };

  useLayoutEffect(() => {
    const el = box.current!;
    const t = new Terminal({
      fontFamily: monoFont(),
      fontSize: fontSize(),
      lineHeight: 1.2,
      scrollback: TERMINAL_LIMITS.scrollback,
      allowProposedApi: true,
      cursorBlink: false,
      // A phone types in the line field, so the screen never has the keys: its cursor still shows as one.
      cursorInactiveStyle: touch ? 'block' : 'outline',
      // On a computer, the rows as text a screen reader reads, and what follows a key said aloud.
      // It takes in output at half the speed: a phone, which has less to spare and never types
      // into the screen, keeps a copy of the rows instead (rowsAsText), and reads out what a line
      // printed (readNext).
      screenReaderMode: !touch,
      minimumContrastRatio: 4.5,
      theme: pageTheme(),
      // xterm would log an error for every character it does not take where it comes (a DEL), and
      // a browser with its console open keeps each one: output of millions would fill the page.
      logLevel: 'off',
      // A link opens with Cmd or Ctrl held, so a click can still select; a finger has no such key.
      linkHandler: { activate: (event, uri) => openLink(event, uri, touch), allowNonHttpProtocols: false },
    });
    const fitAddon = new FitAddon();
    t.loadAddon(fitAddon);
    t.loadAddon(new WebLinksAddon((event, uri) => openLink(event, uri, touch)));
    // The widths the server's copy counts cells with: an emoji takes two, and a cell at most 11
    // combining marks, so output reaching the page as it is printed grows no cell without bound.
    loadWidths(t, Unicode11Addon);
    // Output xterm throws on leaves the screen drawing what comes after it, not stopped there.
    guardOutput(t, () => t.refresh(0, t.rows - 1));
    // What programs ask of the terminal is the server's to answer (src/shared/terminal.ts), a
    // color too, from the colors this page says; a color a program sets is this page's to draw.
    const quiet = () => true;
    for (const query of [{ final: 'c' }, { prefix: '>', final: 'c' }, { final: 'n' }, { prefix: '?', final: 'n' }, { intermediates: '$', final: 'p' }, { prefix: '?', intermediates: '$', final: 'p' }]) {
      t.parser.registerCsiHandler(query, quiet);
    }
    t.parser.registerDcsHandler({ intermediates: '$', final: 'q' }, quiet);
    for (const ident of [4, 10, 11, 12]) {
      t.parser.registerOscHandler(ident, (data) => {
        const { asks, sets } = colorQuery(ident, data);
        if (sets) t.write(sets);
        return asks;
      });
    }
    t.attachCustomKeyEventHandler((e) => {
      // Ctrl+` is the page's: it hides the terminal; and so is Ctrl+Shift+`, a new terminal.
      if (isKey(e, 'terminal') || isKey(e, 'newTerminal')) return false;
      // Off Apple keyboards, Ctrl+C copies what is selected, as in VS Code (the browser's own copy,
      // which xterm answers with the selection); with nothing selected it is ^C.
      if (!isApple && e.ctrlKey && !e.altKey && !e.metaKey && e.code === 'KeyC' && t.hasSelection()) return false;
      return true;
    });
    t.open(el);
    term.current = t;
    fitter.current = fitAddon;
    showCursor(t);
    // A tap gives the screen the keys, never a phone's keyboard.
    if (touch) t.textarea?.setAttribute('inputmode', 'none');
    // Text a computer puts in without keys (an emoji picker, dictation), which xterm in screen
    // reader mode leaves in its field; and what it reads out of the output, bounded.
    const stopInserting = !touch && t.textarea ? insertedText(t.textarea, (text) => t.input(text, true)) : () => undefined;
    if (!touch) boundReadOut(t);
    const stopRows = touch ? rowsAsText(el, t) : () => undefined;

    t.onData((data) => {
      if (el.contains(document.activeElement)) reclaim();
      if (!connection.current?.input(data)) unsent();
    });
    t.onBinary((data) => connection.current?.input(Uint8Array.from(data, (char) => char.charCodeAt(0) & 0xff)));
    // A paste goes in without the control characters a page may have put on the clipboard.
    const stopCleaning = cleanPastes(el, (text) => t.paste(text));
    t.onSelectionChange(() => {
      if (!touch) setSelection(t.hasSelection() ? t.getSelection() : '');
    });

    // The line field follows the screen: a full-screen program takes every key, a password prompt hides them.
    let last = '';
    let looking = 0;
    const look = () => {
      looking = 0;
      const buffer = t.buffer.active;
      const direct = buffer.type === 'alternate';
      const mode = { direct, secret: !direct && asksForSecret(lineBeforeCursor(buffer)), applicationCursor: t.modes.applicationCursorKeysMode };
      const key = JSON.stringify(mode);
      if (key === last) return;
      last = key;
      events.current.onMode(mode);
    };
    const lookSoon = () => {
      looking ||= requestAnimationFrame(look);
    };
    t.onWriteParsed(lookSoon);
    t.buffer.onBufferChange(lookSoon);
    t.onWriteParsed(() => {
      const r = reading.current;
      if (!r) return;
      clearTimeout(r.quiet);
      r.quiet = setTimeout(readOut, 400);
    });
    // Scrolled back, or output piling up under a screen scrolled back.
    const back = () => {
      const buffer = t.buffer.active;
      setScrolledBack(touch && buffer.viewportY < buffer.baseY);
    };
    t.onScroll(back);
    t.onWriteParsed(back);

    // Its colors follow the page's, light or dark, and the server answers a program from them.
    const recolor = () => {
      t.options.theme = pageTheme();
      connection.current?.colors(themeColors(t.options.theme));
    };
    const scheme = matchMedia('(prefers-color-scheme: dark)');
    scheme.addEventListener('change', recolor);
    const themed = new MutationObserver(recolor);
    themed.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    let sizing = 0;
    const resized = new ResizeObserver(() => {
      cancelAnimationFrame(sizing);
      sizing = requestAnimationFrame(fit);
    });
    resized.observe(el);
    fit();

    const gestures = touch ? touchGestures(el, t, fit, () => events.current.onLongPress()) : undefined;
    stopGlide.current = () => gestures?.stop();
    // Ctrl and the wheel, which a trackpad's pinch is too, sets the size on a computer: a step a
    // notch, or a little way of pinching.
    let zoom = 0;
    t.attachCustomWheelEventHandler((e) => {
      if (!e.ctrlKey) return true;
      e.preventDefault();
      zoom -= e.deltaMode === 0 ? e.deltaY : e.deltaY * 40;
      if (Math.abs(zoom) >= 30) {
        if (setFontSize(t, (t.options.fontSize ?? 13) + Math.sign(zoom), fit)) saveFontSize(t);
        zoom = 0;
      }
      return false;
    });

    return () => {
      gestures?.detach();
      stopCleaning();
      stopInserting();
      stopRows();
      resized.disconnect();
      themed.disconnect();
      scheme.removeEventListener('change', recolor);
      cancelAnimationFrame(sizing);
      cancelAnimationFrame(looking);
      if (reading.current) {
        clearTimeout(reading.current.quiet);
        clearTimeout(reading.current.latest);
        reading.current = undefined;
      }
      connection.current?.stop();
      connection.current = undefined;
      term.current = undefined;
      t.dispose();
    };
    // Made once; what changes reaches it through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The connection to the terminal shown: its screen drawn afresh, then what it prints.
  useEffect(() => {
    const t = term.current;
    if (!t || !id) return undefined;
    let shown = true;
    // An ended shell's screen stays to be read, without a cursor waiting for keys nobody takes.
    const ended = (exit: TerminalExit) => {
      t.write('\x1b[?25l');
      t.options.disableStdin = true;
      events.current.onExit(id, exit);
    };
    t.options.disableStdin = false;
    const c = new TerminalConnection({
      url: (cols, rows) => api.terminalSocket(id, cols, rows),
      // Each connection says this page's own size, as it is fitted now, and its colors.
      size: () => {
        fit();
        return { cols: t.cols, rows: t.rows };
      },
      colors: () => themeColors(t.options.theme),
      events: {
        ready: (screen) => {
          // In the order the output came: what the last connection left is drawn, then all is
          // reset (ESC c, scrollback too), sized as the server's copy was, and reset again, as
          // xterm keeps room it made for an earlier size, which would move what comes later; then
          // its copy drawn, which puts back what ESC c leaves (colors, the cursor shown).
          t.write('\x1bc');
          t.write('', () => {
            const size = clampSize(screen.cols, screen.rows);
            if (size.cols !== t.cols || size.rows !== t.rows) sizedElsewhere.current = true;
            t.resize(size.cols, size.rows);
          });
          // Its cursor drawn, though the screen has not had the keys (a phone's never does).
          t.write(`\x1bc${screen.snapshot}`, () => showCursor(t));
          events.current.onProgram(id, screen.program);
          if (screen.exit) ended(screen.exit);
        },
        output: (data, written) => t.write(data, written),
        size: (cols, rows) => t.write('', () => {
          const size = clampSize(cols, rows);
          sizedElsewhere.current = true;
          t.resize(size.cols, size.rows);
        }),
        program: (program) => events.current.onProgram(id, program),
        exit: (exit) => ended(exit),
        signedOut: checkSignedIn,
        state: (state) => {
          if (!shown) return;
          stateNow.current = state;
          // Its shell gone with Pelican, the screen stays to be read, as an ended one does.
          if (state.kind === 'gone') {
            t.write('\x1b[?25l');
            t.options.disableStdin = true;
          }
          // A connection that comes back at once (a slow reader let go) is not worth a word; one
          // that does not is, from the moment it dropped, however many times it tries meanwhile.
          if (state.kind === 'connecting' && state.again) {
            slow.current ??= setTimeout(() => setReconnecting(true), 1200);
          } else {
            clearTimeout(slow.current);
            slow.current = undefined;
            setReconnecting(false);
          }
          events.current.onConnection(id, state);
        },
      },
    });
    connection.current = c;
    c.start();
    const comeBack = () => {
      if (document.visibilityState === 'visible') c.comeBack();
    };
    document.addEventListener('visibilitychange', comeBack);
    window.addEventListener('online', comeBack);
    return () => {
      shown = false;
      clearTimeout(slow.current);
      slow.current = undefined;
      stateNow.current = undefined;
      setReconnecting(false);
      document.removeEventListener('visibilitychange', comeBack);
      window.removeEventListener('online', comeBack);
      c.stop();
      if (connection.current === c) connection.current = undefined;
      // Taken away with the screen, the terminal is gone already.
      if (term.current === t) t.clearSelection();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Shown again after another tab: fitted to the box it has now.
  useEffect(() => {
    if (!hidden) fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hidden]);

  useImperativeHandle(ref, () => ({
    size: () => {
      fit();
      const t = term.current;
      return t ? { cols: t.cols, rows: t.rows } : { cols: 80, rows: 24 };
    },
    focus: () => term.current?.focus(),
    input: (text) => {
      if (!connection.current?.open) {
        unsent();
        return false;
      }
      reclaim();
      term.current?.input(text, true);
      return true;
    },
    paste: (text) => {
      if (!connection.current?.open) {
        unsent();
        return false;
      }
      reclaim();
      term.current?.paste(cleanPaste(text));
      return true;
    },
    text: () => {
      const t = term.current;
      if (!t) return { before: '', screen: '', after: '' };
      const buffer = t.buffer.active;
      return { before: bufferText(buffer, 0, buffer.viewportY), screen: viewportText(buffer, t.rows), after: bufferText(buffer, buffer.viewportY + t.rows) };
    },
    colors: () => (term.current ? themeColors(term.current.options.theme) : undefined),
    readNext: () => {
      const t = term.current;
      if (reading.current) {
        clearTimeout(reading.current.quiet);
        clearTimeout(reading.current.latest);
        reading.current.from.dispose();
        reading.current = undefined;
      }
      const from = t?.registerMarker(0);
      if (from) reading.current = { from, latest: setTimeout(readOut, 5000) };
    },
  }), []);

  return (
    <div className="relative min-h-0 flex-1">
      {/* The keys' hidden field is as large as Safari needs, or it zooms the page in when a tap gives it the keys. */}
      {/* xterm's layers stack inside it (isolate), so what lies over the screen is over all of them; */}
      {/* a shell sized by a larger page is cut at its edge (overflow-hidden), not drawn over the keys under it. */}
      {/* On a phone, what follows a line is read out by the page (readNext), and the rows are a copy (rowsAsText): xterm's screen reader mode is a computer's. */}
      <div
        ref={box}
        role="region"
        aria-label={label}
        data-terminal
        className={`absolute inset-0 isolate overflow-hidden [&_.xterm-helper-textarea]:text-[16px] ${touch ? 'touch-none select-none [-webkit-touch-callout:none] [&_.live-region]:hidden' : ''}`}
      />
      {reconnecting && (
        <div className="pointer-events-none absolute top-2 right-3 z-10 flex items-center gap-1.5 rounded-full border border-line bg-panel px-2.5 py-1 text-[12px] text-muted shadow-sm">
          <Loader2 className="size-3 animate-spin" /> Reconnecting
        </div>
      )}
      {scrolledBack && (
        <button
          type="button"
          aria-label="Jump to latest"
          onClick={() => {
            stopGlide.current();
            term.current?.scrollToBottom();
          }}
          className="animate-fade absolute right-3 bottom-2 z-10 grid size-9 place-items-center rounded-full border border-line bg-panel shadow-md after:absolute after:-inset-1"
        >
          <ArrowDown className="size-4" />
        </button>
      )}
      {selection.trim() && (
        <div className="absolute right-3 bottom-2 z-10 flex items-center rounded-full border border-line bg-panel p-0.5 text-[13px] shadow-lg">
          <button
            type="button"
            // The selection stays while the button is pressed.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onQuote(selection);
              term.current?.clearSelection();
            }}
            className="flex h-8 items-center gap-1.5 rounded-full px-3 hover:bg-hover"
          >
            <TextQuote className="size-3.5 text-muted" /> Quote
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void navigator.clipboard?.writeText(selection).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            })}
            className="flex h-8 items-center gap-1.5 rounded-full px-3 hover:bg-hover"
          >
            {copied ? <Check className="size-3.5 text-muted" /> : <Copy className="size-3.5 text-muted" />} Copy
          </button>
        </div>
      )}
    </div>
  );
}));

/**
 * The rows on screen, as text a screen reader reads, as xterm's screen reader mode gives them (a
 * list of rows), kept up to date at most four times a second while output comes. Returns what
 * stops it.
 */
function rowsAsText(el: HTMLElement, t: Terminal): () => void {
  const list = document.createElement('div');
  list.setAttribute('role', 'list');
  list.className = 'sr-only';
  el.appendChild(list);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last = 0;
  const update = () => {
    timer = undefined;
    last = performance.now();
    const buffer = t.buffer.active;
    while (list.children.length > t.rows) list.lastChild!.remove();
    while (list.children.length < t.rows) list.appendChild(document.createElement('div')).setAttribute('role', 'listitem');
    for (let y = 0; y < t.rows; y += 1) {
      const text = buffer.getLine(buffer.viewportY + y)?.translateToString(true) || '\u00a0';
      const row = list.children[y]!;
      if (row.textContent !== text) row.textContent = text;
    }
  };
  const soon = () => {
    timer ??= setTimeout(update, Math.max(0, 250 - (performance.now() - last)));
  };
  const listening = [t.onWriteParsed(soon), t.onScroll(soon), t.onResize(soon)];
  update();
  return () => {
    clearTimeout(timer);
    for (const l of listening) l.dispose();
    list.remove();
  };
}

/** A link in the output: opened in a new tab, with Cmd or Ctrl held on a computer, on a tap on a phone. */
function openLink(event: MouseEvent, uri: string, touch: boolean): void {
  if (!touch && !(isApple ? event.metaKey : event.ctrlKey)) return;
  if (!/^https?:\/\//i.test(uri)) return;
  window.open(uri, '_blank', 'noopener,noreferrer');
}

/** A new size, within bounds, and the screen fitted to it (or not yet, while a pinch goes on); whether it changed. */
function setFontSize(t: Terminal, size: number, fit?: () => void): boolean {
  const next = Math.min(FONT.max, Math.max(FONT.min, Math.round(size)));
  if (next === t.options.fontSize) return false;
  t.options.fontSize = next;
  fit?.();
  return true;
}

/** The size, kept in this browser for every terminal. */
const saveFontSize = (t: Terminal) => setPrefs({ terminalFontSize: t.options.fontSize ?? 13 });

/**
 * A finger on the screen: a swipe scrolls back through the output (in a full-screen program, it
 * sends the arrows, as a wheel does there), with a little glide after it; a long press opens the
 * screen as text; two fingers set the size. A tap is left to xterm: it gives the screen the keys
 * (never the phone's keyboard), and a program that asked for the mouse gets it. `stop` ends a
 * glide, as ↓ does on its way to the newest output.
 */
export function touchGestures(el: HTMLElement, t: Terminal, fit: () => void, longPress: () => void): { detach: () => void; stop: () => void } {
  const fingers = new Map<number, { x: number; y: number }>();
  let lastY = 0;
  let lastT = 0;
  let travelled = 0;
  let velocity = 0;
  let carry = 0;
  let glide = 0;
  let press: ReturnType<typeof setTimeout> | undefined;
  let pinch: { distance: number; size: number } | undefined;

  const rowHeight = () => el.clientHeight / Math.max(1, t.rows);
  const scroll = (px: number) => {
    carry += px;
    const lines = Math.trunc(carry / rowHeight());
    if (!lines) return;
    carry -= lines * rowHeight();
    if (t.buffer.active.type === 'alternate') {
      // A finger moving down shows what is above, as the wheel turned up: up arrows.
      const key = keySequence(lines > 0 ? 'up' : 'down', { applicationCursor: t.modes.applicationCursorKeysMode });
      t.input(key.repeat(Math.min(Math.abs(lines), 5)), true);
    } else {
      t.scrollLines(-lines);
    }
  };
  const spread = () => {
    const [a, b] = [...fingers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };

  const down = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    cancelAnimationFrame(glide);
    clearTimeout(press);
    if (fingers.size === 2) {
      pinch = { distance: spread(), size: t.options.fontSize ?? 13 };
      return;
    }
    if (fingers.size > 2) return;
    lastY = e.clientY;
    lastT = e.timeStamp;
    travelled = 0;
    velocity = 0;
    carry = 0;
    press = setTimeout(() => {
      if (travelled < 8 && fingers.size === 1) longPress();
    }, 500);
  };
  const move = (e: PointerEvent) => {
    const finger = fingers.get(e.pointerId);
    if (!finger) return;
    finger.x = e.clientX;
    finger.y = e.clientY;
    if (pinch && fingers.size >= 2) {
      // The text follows the fingers, gently; the shell gets its new size once they let go,
      // rather than a redraw for every step.
      const distance = spread();
      if (pinch.distance > 0) setFontSize(t, pinch.size * Math.sqrt(distance / pinch.distance));
      return;
    }
    const dy = e.clientY - lastY;
    travelled += Math.abs(dy);
    if (travelled >= 8) clearTimeout(press);
    velocity = dy / Math.max(1, e.timeStamp - lastT);
    lastY = e.clientY;
    lastT = e.timeStamp;
    scroll(dy);
  };
  const up = (e: PointerEvent) => {
    if (!fingers.delete(e.pointerId)) return;
    clearTimeout(press);
    if (pinch) {
      if (fingers.size === 0) {
        pinch = undefined;
        fit();
        saveFontSize(t);
      }
      return;
    }
    // Let go while moving, the scrollback glides on and slows down; a full-screen program's does not.
    if (travelled < 8 || t.buffer.active.type === 'alternate') return;
    let v = velocity * 16;
    const step = () => {
      if (Math.abs(v) < 0.5) return;
      scroll(v);
      v *= 0.94;
      glide = requestAnimationFrame(step);
    };
    glide = requestAnimationFrame(step);
  };
  // A long press is the screen as text, not the system's menu.
  const menu = (e: Event) => e.preventDefault();
  // A finger moving on the screen is the screen's alone. Chrome on Android otherwise takes a flick
  // for a fling of its own, and the next tap anywhere on the page, for a second, for stopping it:
  // a key of the row, ↓ or Enter tapped right after a flick did nothing.
  const own = (e: TouchEvent) => {
    if (e.cancelable) e.preventDefault();
  };

  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('contextmenu', menu);
  el.addEventListener('touchmove', own, { passive: false });
  return {
    detach: () => {
      clearTimeout(press);
      cancelAnimationFrame(glide);
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('contextmenu', menu);
      el.removeEventListener('touchmove', own);
    },
    stop: () => cancelAnimationFrame(glide),
  };
}
