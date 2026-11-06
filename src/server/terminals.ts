import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, constants } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import serializeAddon from '@xterm/addon-serialize';
import unicode11Addon from '@xterm/addon-unicode11';
import xtermHeadless, { type Terminal as Screen } from '@xterm/headless';
import type { RawData, WebSocket } from 'ws';

import {
  sizeAllowed, TERMINAL_CLOSE, TERMINAL_LIMITS, terminalClientMessage,
  type TerminalAvailability, type TerminalColors, type TerminalExit, type TerminalInfo, type TerminalServerMessage,
} from '../shared/terminal.js';
import { config } from './config.js';
import { heartbeat } from './heartbeat.js';
import { loadPty, ptyFailure, ptyMissing, type Pty } from './pty.js';

/**
 * Terminals: a shell on this computer per terminal, shown on any number of pages (up to
 * TERMINAL_LIMITS.viewers), each over a WebSocket of its own (server.ts), so output never holds up
 * a permission prompt on the session's socket.
 *
 * The shell belongs to the server, not to a page: it runs on when the page closes or the phone
 * sleeps, in memory, until it is closed, ends, sits unused for 12 hours with nothing running, or
 * Pelican stops. A copy of its screen (xterm's headless terminal) takes in everything it prints,
 * so a page that comes back gets the screen as it is, scrollback, a full-screen program such as
 * vim and the modes it set included, and goes on from there.
 *
 * Output goes out as binary frames: the first chunk, and the first after a key (its echo), at
 * once; what follows gathered for a few milliseconds. Pages acknowledge what they have drawn;
 * while one is far behind, the PTY is paused, so the program waits as it would for a slow screen,
 * Ctrl+C gets through at once, and memory stays flat however fast the program prints and however
 * slowly a phone reads.
 */

const { Terminal: HeadlessTerminal } = xtermHeadless;
const { SerializeAddon } = serializeAddon;
const { Unicode11Addon } = unicode11Addon;
type Serializer = InstanceType<typeof SerializeAddon>;

/** Times and amounts the terminals keep to; tests shorten them. */
export const terminalTiming = {
  /** After the first chunk, output is gathered this long into one frame (or up to a frame's size). */
  batchMs: 8,
  /** The shell waits while a page has this many bytes of output not yet acknowledged, or waiting in its socket… */
  high: 128 * 1024,
  /** …until every page is below this. */
  low: 16 * 1024,
  /** The copy of the screen may fall this far behind the shell before the shell waits for it too, and goes on below the second. */
  copyHigh: 1024 * 1024,
  copyLow: 256 * 1024,
  /** A page that makes no progress this long while the shell waits for it is let go (TERMINAL_CLOSE.behind). */
  stallMs: 10_000,
  /** How long a page's first screen may wait for a place between two escape sequences to be cut at. */
  cutMs: 500,
  /** How soon after output, or Enter, the program in front is looked at. */
  programMs: 300,
  /** Run in terminal: the shell is ready once its first output has been quiet this long, or after the second. */
  promptQuietMs: 150,
  promptWaitMs: 5000,
  /** A terminal nobody has shown or used this long, where nothing runs, is closed… */
  idleMs: 12 * 3600_000,
  /** …as found by a look this often. */
  idleCheckMs: 10 * 60_000,
};

/** How long a closed terminal's shell has to hang up its jobs before Pelican lets go of its PTY. */
const HANGUP_MS = 1000;

/** Too many terminals run already (TERMINAL_LIMITS.terminals), and none of them has ended. */
export class TooManyTerminals extends Error {}

/** Variables of the terminal, or the service, that Pelican itself runs in: they say nothing true of this one. */
const OUTER = new Set([
  'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'TERM_SESSION_ID', 'LC_TERMINAL', 'LC_TERMINAL_VERSION', 'COLORFGBG',
  'COLUMNS', 'LINES', 'TERMCAP', 'WINDOWID', 'TMUX', 'TMUX_PANE', 'STY', 'WINDOW', 'VTE_VERSION', 'WT_SESSION',
  'WT_PROFILE_ID', 'TERMINAL_EMULATOR', '__CFBundleIdentifier', 'XPC_SERVICE_NAME', 'XPC_FLAGS', 'INVOCATION_ID',
  'JOURNAL_STREAM', 'NOTIFY_SOCKET', 'LISTEN_PID', 'LISTEN_FDS', 'LISTEN_FDNAMES', 'MANAGERPID', 'SYSTEMD_EXEC_PID',
  'SHLVL', 'OLDPWD', '_', 'CLAUDE_CODE_SSE_PORT',
]);
const OUTER_PREFIX = /^(ITERM_|KITTY_|WEZTERM_|ALACRITTY_|GHOSTTY_|VSCODE_|KONSOLE_|GNOME_TERMINAL_)/;
/**
 * Pelican's own settings, npm's when npm started Pelican, the mark Claude Code leaves on what it
 * runs, and what the Agent SDK sets in Pelican's own process: its version, with each query (which
 * `claude` would take to say it is an Agent SDK client), and a setting for Windows' cmd.
 */
const PELICANS = /^(PELICAN_|npm_|CLAUDE_AGENT_SDK_)|^(CLAUDECODE|NoDefaultCurrentDirectoryInExePath)$/;

/**
 * The shell's environment: Pelican's, without its own settings (PELICAN_*), npm's (npm_*),
 * Claude Code's mark (CLAUDECODE, which would stop `claude` from starting there), the Agent SDK's
 * (CLAUDE_AGENT_SDK_*) and what describes the terminal or service Pelican runs in; with
 * `launch`, what launchFor gives Claude
 * Code and `!` commands in the folder (in one kept to the user's settings only, git settings that
 * turn the repository's own programs off), so the shell runs as Claude does there.
 */
export function shellEnvironment(base: NodeJS.ProcessEnv, launch: Record<string, string> | undefined, shell: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined || PELICANS.test(name) || OUTER.has(name) || OUTER_PREFIX.test(name)) continue;
    env[name] = value;
  }
  // VS Code's terminals hand git a password helper that answers only inside VS Code.
  if (base.VSCODE_GIT_ASKPASS_MAIN) delete env.GIT_ASKPASS;
  Object.assign(env, launch);
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.SHELL = shell;
  // A service starts with no locale (launchd sets none): the shell would read UTF-8 as bytes.
  if (!env.LC_ALL && !env.LC_CTYPE && !env.LANG) env.LANG = process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
  return env;
}

const runnable = (file: string | null | undefined): Promise<boolean> =>
  file && path.isAbsolute(file) ? access(file, constants.X_OK).then(() => true, () => false) : Promise.resolve(false);

/** The user's shell: $SHELL, else the one the account names, else sh. */
export async function loginShell(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  let account: string | null | undefined;
  try {
    account = os.userInfo().shell;
  } catch {
    account = undefined;
  }
  for (const candidate of [env.SHELL, account]) if (await runnable(candidate)) return candidate!;
  return '/bin/sh';
}

/** For tests: a shell to start, with these arguments, instead of the user's login shell. */
export const testShell: { file?: string; args?: string[] } = {};

/** A program's name as a tab shows it: `/usr/bin/vim` and a login shell's `-zsh` as vim and zsh. */
const programName = (raw: string) => path.basename(raw.trim()).replace(/^-/, '').slice(0, 64);

const signalName = (signal: number) => Object.entries(os.constants.signals).find(([, n]) => n === signal)?.[0] ?? String(signal);

/**
 * Whether the copy's parser is between escape sequences, so a screen cut there, and the output
 * after it, read as the whole did. xterm keeps its parser's state to itself; the version is pinned,
 * and test/terminals.test.ts fails should this stop telling.
 */
function betweenSequences(screen: Screen): boolean {
  const state = (screen as unknown as { _core?: { _inputHandler?: { _parser?: { currentState?: unknown } } } })._core?._inputHandler?._parser?.currentState;
  return state === undefined || state === 0;
}

/**
 * Characters drawn as part of the one before them: combining marks, joiners and selectors (those
 * of no width, as the Unicode 11 widths count them). xterm adds each to the cell before it, with
 * no limit, until a character of its own or an escape sequence comes.
 */
const ZERO_WIDTH_RUN = /[\p{Mn}\p{Me}\p{Cf}\u1160-\u11ff\u1734\u{1171e}]+/gu;
/** Marks one character keeps: more than any script stacks on one (Zalgo text stacks thousands). */
export const MARKS_PER_CHARACTER = 16;

/**
 * Output with each run of zero-width characters cut to MARKS_PER_CHARACTER, so a file of one
 * letter and millions of marks grows neither the copy nor a page by more than a cell, and the
 * screen sent with `ready` stays small. `carried` is the run the output before ended in;
 * `run` the one this ends in.
 */
export function capMarks(text: string, carried: number): { text: string; run: number } {
  // Nothing from U+0300 on (the first mark): nothing to cut, and the run, if any, has ended.
  if (!/[^\u0000-\u02ff]/.test(text)) return { text, run: text ? 0 : carried };
  let kept = '';
  let from = 0;
  let run = 0;
  for (const match of text.matchAll(ZERO_WIDTH_RUN)) {
    const before = match.index === 0 ? carried : 0;
    const marks = [...match[0]];
    const room = Math.max(0, MARKS_PER_CHARACTER - before);
    if (marks.length > room) {
      kept += text.slice(from, match.index) + marks.slice(0, room).join('');
      from = match.index + match[0].length;
    }
    run = match.index + match[0].length === text.length ? before + marks.length : 0;
  }
  return { text: from === 0 ? text : kept + text.slice(from), run };
}

type ScreenCore = {
  coreMouseService?: { activeEncoding?: string };
  coreService?: { isCursorHidden?: boolean; decPrivateModes?: { origin?: boolean; cursorStyle?: 'block' | 'underline' | 'bar'; cursorBlink?: boolean } };
  buffer?: { scrollTop?: number; scrollBottom?: number };
};

/**
 * What a program set that xterm's serializer leaves out of a screen, as sequences to follow it:
 * how mouse reports are written (SGR, which lazygit, htop and less --mouse ask for), a hidden
 * cursor, the cursor's shape (neovim's bar while it inserts), and the rows that scroll (apt keeps
 * its progress bar under them). Setting the rows, and the serializer's own origin mode, put the
 * cursor home, so it goes back where it was. xterm keeps these to itself; the version is pinned,
 * and test/terminals.test.ts fails should they move.
 */
export function modesBeyondSnapshot(screen: Screen): string {
  const core = (screen as unknown as { _core?: ScreenCore })._core;
  const modes = core?.coreService?.decPrivateModes;
  let more = '';
  const encoding = core?.coreMouseService?.activeEncoding;
  if (encoding === 'SGR') more += '\x1b[?1006h';
  else if (encoding === 'SGR_PIXELS') more += '\x1b[?1016h';
  const top = core?.buffer?.scrollTop ?? 0;
  const bottom = core?.buffer?.scrollBottom ?? screen.rows - 1;
  const region = top !== 0 || bottom !== screen.rows - 1;
  if (region) more += `\x1b[${top + 1};${bottom + 1}r`;
  if (region || modes?.origin) {
    const { cursorX, cursorY } = screen.buffer.active;
    more += `\x1b[${(modes?.origin ? cursorY - top : cursorY) + 1};${Math.min(cursorX, screen.cols - 1) + 1}H`;
  }
  if (modes?.cursorStyle) {
    const shape = { block: 1, underline: 3, bar: 5 }[modes.cursorStyle];
    more += `\x1b[${modes.cursorBlink ? shape : shape + 1} q`;
  }
  if (core?.coreService?.isCursorHidden) more += '\x1b[?25l';
  return more;
}

/**
 * What a program asks of the terminal's colors or sets them to (OSC 4, 10, 11 and 12, and 104, 110,
 * 111 and 112 to put them back), as xterm reads it for its own colors: a report (0), a color set
 * (1) or put back (2), by xterm's index: 0 to 255, then 256 the text, 257 the background, 258 the
 * cursor; no index puts back all 256. A headless copy draws no colors, so xterm does nothing more
 * with these, and keeps the event to itself; the version is pinned, and test/terminals.test.ts
 * fails should it stop telling.
 */
export type ColorRequest = { type: 0 | 1 | 2; index?: number; color?: [number, number, number] };

export function onColorRequests(screen: Screen, listener: (requests: ColorRequest[]) => void): boolean {
  const handler = (screen as unknown as { _core?: { _inputHandler?: { onColor?: unknown } } })._core?._inputHandler;
  if (typeof handler?.onColor !== 'function') return false;
  (handler.onColor as (listener: (requests: ColorRequest[]) => void) => unknown)(listener);
  return true;
}

const COLOR_INDEX = { foreground: 256, background: 257, cursor: 258 } as const;

const rgbOf = (hex: string): [number, number, number] => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)) as [number, number, number];

/** A color as the pages draw it (xterm's own 256 colors past the 16 they say), or none while no page has said its colors. */
function drawnColor(colors: TerminalColors | undefined, index: number): [number, number, number] | undefined {
  if (index >= 16 && index < 232) {
    const steps = [0x00, 0x5f, 0x87, 0xaf, 0xd7, 0xff];
    const at = index - 16;
    return [steps[Math.floor(at / 36) % 6]!, steps[Math.floor(at / 6) % 6]!, steps[at % 6]!];
  }
  if (index >= 232 && index < 256) {
    const grey = 8 + (index - 232) * 10;
    return [grey, grey, grey];
  }
  if (!colors) return undefined;
  if (index === COLOR_INDEX.foreground) return rgbOf(colors.foreground);
  if (index === COLOR_INDEX.background) return rgbOf(colors.background);
  if (index === COLOR_INDEX.cursor) return rgbOf(colors.cursor);
  const ansi = colors.ansi[index];
  return ansi ? rgbOf(ansi) : undefined;
}

/** A color's report, as xterm.js gives one: `OSC 11 ; rgb:fafa/fafa/fafa ST`. */
export function colorReport(index: number, [r, g, b]: [number, number, number]): string {
  const channel = (value: number) => value.toString(16).padStart(2, '0').repeat(2);
  const ident = index === COLOR_INDEX.foreground ? '10' : index === COLOR_INDEX.background ? '11' : index === COLOR_INDEX.cursor ? '12' : `4;${index}`;
  return `\x1b]${ident};rgb:${channel(r)}/${channel(g)}/${channel(b)}\x1b\\`;
}

type Viewer = {
  ws: WebSocket;
  /** Output sent that the page has not acknowledged, in bytes. */
  unacked: number;
  /**
   * Until it has its first screen: where in the output it came in, the output since, and until when
   * its screen may wait for a clean place to be cut at.
   */
  joining?: { at: number; held: Buffer[]; bytes: number; until: number; timer: NodeJS.Timeout };
  /** While the shell waits for it: what it owed and had waiting at the last look, and since when neither went down. */
  stuck?: { owed: number; buffered: number; since: number };
  /** Whether the sign-in its socket opened with still signs anyone in. */
  signedIn: () => boolean;
  stopBeating: () => void;
};

class Term {
  readonly id = randomUUID();
  readonly createdAt = Date.now();
  readonly viewers = new Set<Viewer>();
  program: string;
  exit?: TerminalExit;
  /** When it was last shown, typed into or printed something. */
  lastActive = Date.now();
  /** Whether anything was ever typed into it, or run in it (Run in terminal): one never used makes room for another. */
  used = false;
  closed = false;
  /** The server's copy of the screen. */
  private readonly screen: Screen;
  private readonly serializer: Serializer;
  /** The shell's size; the copy takes a new one where it comes in the output. */
  private cols: number;
  private rows: number;
  /** Output not sent yet, and the timer while more is gathered. */
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private gathering?: NodeJS.Timeout;
  /** Bytes the shell printed, and how many of them the copy has taken in. */
  private received = 0;
  private parsed = 0;
  /** A key came from a page: what the shell prints next (its echo) goes out at once. */
  private keyed = false;
  /** The zero-width characters the output so far ended in (capMarks). */
  private marks = 0;
  /** The PTY is paused (flow control), and looked at again while it is. */
  private paused = false;
  private watching?: NodeJS.Timeout;
  private programLook?: NodeJS.Timeout;
  /** The colors the pages draw in, as the last to say them did, and those a program set since, by xterm's index. */
  private colors?: TerminalColors;
  private readonly setColors = new Map<number, [number, number, number]>();

  constructor(readonly cwd: string, private readonly pty: Pty, shell: string, cols: number, rows: number, colors?: TerminalColors) {
    this.cols = cols;
    this.rows = rows;
    this.colors = colors;
    this.program = programName(shell);
    this.screen = new HeadlessTerminal({ cols, rows, scrollback: TERMINAL_LIMITS.scrollback, allowProposedApi: true, logLevel: 'off' });
    // Characters as wide as the pages draw them (TerminalScreen takes the same widths): an emoji
    // takes two cells there, and the screen a page gets back places what follows it, and the
    // cursor, by counting cells.
    this.screen.loadAddon(new Unicode11Addon());
    this.screen.unicode.activeVersion = '11';
    this.serializer = new SerializeAddon();
    this.screen.loadAddon(this.serializer);
    // The copy answers what programs ask of the terminal (device attributes, the cursor's
    // position, a mode's state, a color), once, however many pages show it, or none: answers from
    // each page would come twice, or not at all, and after the copy's, where a program that asked
    // for a color and then for device attributes has stopped reading.
    this.screen.onData((answer) => this.answer(answer));
    onColorRequests(this.screen, (requests) => this.colorRequests(requests));
    pty.onData((text) => this.output(text));
    pty.onExit(({ exitCode, signal }) => this.ended(exitCode, signal));
  }

  get pid(): number {
    return this.pty.pid;
  }

  /** The terminal's answer to what a program asked of it. */
  private answer(text: string): void {
    if (!this.exit && !this.closed) this.pty.write(text);
  }

  /** Colors asked for are answered as the pages draw them; one a program set is that one until put back. */
  private colorRequests(requests: ColorRequest[]): void {
    for (const { type, index, color } of requests) {
      if (type === 1 && index !== undefined && color) {
        this.setColors.set(index, color);
      } else if (type === 2) {
        if (index !== undefined) this.setColors.delete(index);
        else for (const set of [...this.setColors.keys()]) if (set < 256) this.setColors.delete(set);
      } else if (type === 0 && index !== undefined) {
        const rgb = this.setColors.get(index) ?? drawnColor(this.colors, index);
        if (rgb) this.answer(colorReport(index, rgb));
      }
    }
  }

  info(): TerminalInfo {
    return { id: this.id, cwd: this.cwd, program: this.program, viewers: this.viewers.size, createdAt: this.createdAt, ...(this.exit ? { exit: this.exit } : {}) };
  }

  /** How its flow control stands, for tests. */
  state() {
    return {
      paused: this.paused,
      received: this.received,
      parsed: this.parsed,
      viewers: [...this.viewers].map((v) => ({ unacked: v.unacked, buffered: v.ws.bufferedAmount, joining: Boolean(v.joining) })),
    };
  }

  private output(printed: string): void {
    if (this.closed) return;
    const { text, run } = capMarks(printed, this.marks);
    this.marks = run;
    this.lastActive = Date.now();
    if (!text) return;
    const bytes = Buffer.from(text, 'utf8');
    this.received += bytes.length;
    this.screen.write(text, () => {
      this.parsed += bytes.length;
      this.cut();
    });
    this.pending.push(bytes);
    this.pendingBytes += bytes.length;
    // The first output goes at once, and the first after a key, so typing never waits; what
    // follows is gathered for a few milliseconds, or up to a frame's size.
    if (this.pendingBytes >= TERMINAL_LIMITS.frame || this.keyed) {
      this.keyed = false;
      this.flush();
    } else if (!this.gathering) {
      this.flush();
      this.gathering = setTimeout(() => this.gathered(), terminalTiming.batchMs);
    }
    if (this.received - this.parsed > terminalTiming.copyHigh) this.pressure();
    this.lookAtProgramSoon();
  }

  /** The end of a gathering: what came goes out, and the next is gathered while output goes on. */
  private gathered(): void {
    this.gathering = undefined;
    if (this.pendingBytes === 0) return;
    this.flush();
    this.gathering = setTimeout(() => this.gathered(), terminalTiming.batchMs);
  }

  /** Sends what is pending to the pages that have their screen, and keeps it for those still waiting for one. */
  private flush(): void {
    if (this.pendingBytes === 0) return;
    const data = this.pending.length === 1 ? this.pending[0]! : Buffer.concat(this.pending, this.pendingBytes);
    this.pending = [];
    this.pendingBytes = 0;
    for (const viewer of this.viewers) {
      if (viewer.joining) {
        viewer.joining.held.push(data);
        viewer.joining.bytes += data.length;
      } else {
        this.sendOutput(viewer, data);
      }
    }
    this.pressure();
  }

  private sendOutput(viewer: Viewer, data: Buffer): void {
    if (viewer.ws.readyState !== viewer.ws.OPEN) return;
    for (let at = 0; at < data.length; at += TERMINAL_LIMITS.frame) viewer.ws.send(data.subarray(at, at + TERMINAL_LIMITS.frame), { binary: true });
    viewer.unacked += data.length;
  }

  private send(viewer: Viewer, message: TerminalServerMessage): void {
    if (viewer.ws.readyState === viewer.ws.OPEN) viewer.ws.send(JSON.stringify(message));
  }

  /** To every page that has its screen, after the output before it. */
  private tell(message: TerminalServerMessage, except?: Viewer): void {
    this.flush();
    for (const viewer of this.viewers) if (viewer !== except && !viewer.joining) this.send(viewer, message);
  }

  /**
   * Flow control. The shell waits (its PTY is paused, so what it prints blocks) while a page owes
   * acknowledgements for, or has waiting in its socket, more than `high` bytes, or while the copy of
   * the screen lags; it goes on once all are below `low`. A page that makes no progress at all for
   * `stallMs` meanwhile (a phone asleep with its socket open) is let go, and repaints from the copy
   * when it comes back, rather than holding up the shell and every other page.
   */
  private pressure(): void {
    if (this.closed) return;
    const now = Date.now();
    const lag = this.received - this.parsed;
    let behind = lag > terminalTiming.copyHigh;
    let caughtUp = lag < terminalTiming.copyLow;
    for (const viewer of this.viewers) {
      const owed = viewer.unacked + (viewer.joining?.bytes ?? 0);
      const buffered = viewer.ws.bufferedAmount;
      if (owed > terminalTiming.high || buffered > terminalTiming.high) {
        const moved = !viewer.stuck || owed < viewer.stuck.owed || buffered < viewer.stuck.buffered;
        viewer.stuck = { owed, buffered, since: moved ? now : viewer.stuck!.since };
        if (now - viewer.stuck.since > terminalTiming.stallMs) {
          this.leave(viewer);
          viewer.ws.close(TERMINAL_CLOSE.behind, 'Behind');
          continue;
        }
        behind = true;
      } else {
        viewer.stuck = undefined;
      }
      if (owed >= terminalTiming.low || buffered >= terminalTiming.low) caughtUp = false;
    }
    if (behind && !this.paused && !this.exit) {
      this.paused = true;
      this.pty.pause();
      // ws says nothing when a socket drains: look again while the shell waits.
      this.watching = setInterval(() => this.pressure(), 50);
    } else if (this.paused && (caughtUp || this.exit)) {
      this.paused = false;
      clearInterval(this.watching);
      this.watching = undefined;
      this.pty.resume();
    }
  }

  /**
   * A page that came in gets its first screen once the copy has taken in the output up to where it
   * came in: cut where no escape sequence is half read, or wherever it is once `cutMs` is up. The
   * output after the cut follows.
   */
  private cut(): void {
    if (this.closed) return;
    const now = Date.now();
    let clean: boolean | undefined;
    const due: Viewer[] = [];
    for (const viewer of this.viewers) {
      if (!viewer.joining || this.parsed < viewer.joining.at) continue;
      clean ??= betweenSequences(this.screen);
      if (clean || now >= viewer.joining.until) due.push(viewer);
    }
    if (due.length === 0) return;
    // What is still gathering joins what the pages hold, so all that follows the cut is there.
    this.flush();
    const snapshot = this.serializer.serialize({ scrollback: TERMINAL_LIMITS.scrollback }) + modesBeyondSnapshot(this.screen);
    // The end goes with the screen only once the copy has all the output before it.
    const final = this.exit && this.parsed === this.received ? this.exit : undefined;
    for (const viewer of due) {
      if (!viewer.joining || !this.viewers.has(viewer)) continue;
      const { at, held, timer } = viewer.joining;
      clearTimeout(timer);
      viewer.joining = undefined;
      this.send(viewer, { type: 'ready', id: this.id, cols: this.screen.cols, rows: this.screen.rows, snapshot, program: this.program, ...(final ? { exit: final } : {}) });
      // A size the copy has yet to come to in the output.
      if (this.screen.cols !== this.cols || this.screen.rows !== this.rows) this.send(viewer, { type: 'size', cols: this.cols, rows: this.rows });
      let skip = this.parsed - at;
      for (const chunk of held) {
        if (skip >= chunk.length) {
          skip -= chunk.length;
          continue;
        }
        this.sendOutput(viewer, skip > 0 ? chunk.subarray(skip) : chunk);
        skip = 0;
      }
      if (this.exit && !final) this.send(viewer, { type: 'exit', ...this.exit });
    }
    this.pressure();
  }

  /**
   * A page's socket: it gets the screen as it is, then the output. Its size becomes the shell's
   * when no other page shows the terminal; otherwise the shell keeps the size of the page last
   * typed in or resized, and this one is told it until its own user types or resizes (a page that
   * connects again by itself, after a phone slept or its network changed, takes nothing away).
   */
  attach(ws: WebSocket, cols: number, rows: number, signedIn: () => boolean): void {
    if (this.viewers.size >= TERMINAL_LIMITS.viewers) {
      ws.close(TERMINAL_CLOSE.tooManyViewers, 'Open on too many pages');
      return;
    }
    // The pages showing it already have all output so far: the new one comes in here.
    this.flush();
    const joining: NonNullable<Viewer['joining']> = { at: this.received, held: [], bytes: 0, until: Date.now() + terminalTiming.cutMs, timer: undefined as unknown as NodeJS.Timeout };
    const viewer: Viewer = { ws, unacked: 0, joining, signedIn, stopBeating: () => undefined };
    // Once its time is up, the screen goes, cut wherever the copy is. Timers keep a clock of their
    // own, which may run a millisecond ahead of Date.now(): this one says the time is up.
    joining.timer = setTimeout(() => {
      joining.until = 0;
      this.cut();
    }, terminalTiming.cutMs);
    const alone = this.viewers.size === 0;
    this.viewers.add(viewer);
    this.lastActive = Date.now();
    checkSignIns();
    if (!this.exit && alone) this.resize(cols, rows, viewer);
    // Called once the copy has taken in all output so far, the new size included.
    this.screen.write('', () => this.cut());
    // A tick goes once its screen has: `ready` is always first.
    viewer.stopBeating = heartbeat(ws, () => {
      if (!viewer.joining) this.send(viewer, { type: 'tick' });
    });
    ws.on('message', (data, binary) => this.heard(viewer, data, binary));
    ws.on('close', () => {
      if (!this.viewers.has(viewer)) return;
      this.leave(viewer);
      this.pressure();
    });
  }

  /** A page no longer shows it (no flow control here: the callers see to it). */
  private leave(viewer: Viewer): void {
    if (!this.viewers.delete(viewer)) return;
    if (viewer.joining) clearTimeout(viewer.joining.timer);
    viewer.stopBeating();
    this.lastActive = Date.now();
  }

  /** Lets go of the pages whose sign-in has gone since their socket opened (TERMINAL_CLOSE.signedOut). */
  letGoOfSignedOut(): void {
    for (const viewer of [...this.viewers]) if (!viewer.signedIn()) this.signOut(viewer);
  }

  private signOut(viewer: Viewer): void {
    this.leave(viewer);
    viewer.ws.close(TERMINAL_CLOSE.signedOut, 'Signed out');
    this.pressure();
  }

  private heard(viewer: Viewer, data: RawData, binary: boolean): void {
    // A page let go takes nothing more, and one whose sign-in has gone since it opened is let go
    // here and now, before its key reaches the shell.
    if (!this.viewers.has(viewer)) return;
    if (!viewer.signedIn()) {
      this.signOut(viewer);
      return;
    }
    if (binary) {
      if (this.exit || this.closed) return;
      const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      this.pty.write(bytes);
      this.keyed = true;
      this.used = true;
      this.lastActive = Date.now();
      // Enter may start a program that prints nothing for a while.
      if (bytes.includes(13)) this.lookAtProgramSoon();
      return;
    }
    const message = terminalClientMessage(String(data));
    if (message?.type === 'ack') {
      viewer.unacked = Math.max(0, viewer.unacked - message.bytes);
      this.pressure();
    } else if (message?.type === 'resize' && !this.exit) {
      this.resize(message.cols, message.rows, viewer);
    } else if (message?.type === 'colors') {
      this.colors = message.colors;
    }
  }

  /** The shell takes the size of the page that last said one; the others are told. */
  private resize(cols: number, rows: number, from: Viewer): void {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    try {
      this.pty.resize(cols, rows);
    } catch {
      // It has just ended.
    }
    // The copy takes the size where it comes in the output, as the pages do.
    this.screen.write('', () => this.screen.resize(cols, rows));
    this.tell({ type: 'size', cols, rows }, from);
  }

  private ended(code: number, signal: number | undefined): void {
    if (this.closed || this.exit) return;
    this.exit = signal ? { code: null, signal: signalName(signal) } : { code, signal: null };
    clearTimeout(this.programLook);
    this.tell({ type: 'exit', ...this.exit });
    this.pressure();
  }

  private lookAtProgramSoon(): void {
    if (this.programLook || this.exit || this.closed) return;
    this.programLook = setTimeout(() => {
      this.programLook = undefined;
      this.lookAtProgram();
    }, terminalTiming.programMs);
  }

  /** The program in front, as the PTY says; the pages are told when it changed. */
  lookAtProgram(): void {
    if (this.exit || this.closed) return;
    let name: string;
    try {
      name = programName(this.pty.process);
    } catch {
      return;
    }
    if (!name || name === this.program) return;
    this.program = name;
    this.tell({ type: 'program', program: name });
  }

  /**
   * Run in terminal: types `command`, and Enter, once the shell is ready for it, its first output
   * (the prompt) gone quiet. A shell that takes pastes (zsh, bash 5.1 and later, fish) gets it as
   * one, as if pasted: its lines go in together, and run with the Enter after them.
   */
  typeWhenReady(command: string): void {
    this.used = true;
    let done = false;
    let quiet: NodeJS.Timeout | undefined;
    const type = () => {
      if (done) return;
      done = true;
      listening.dispose();
      clearTimeout(quiet);
      clearTimeout(latest);
      if (this.exit || this.closed) return;
      this.pty.write(this.screen.modes.bracketedPasteMode ? `\x1b[200~${command}\x1b[201~\r` : `${command}\r`);
      this.lookAtProgramSoon();
    };
    const listening = this.pty.onData(() => {
      clearTimeout(quiet);
      quiet = setTimeout(type, terminalTiming.promptQuietMs);
    });
    const latest = setTimeout(type, terminalTiming.promptWaitMs);
  }

  /**
   * Closes it: the pages showing it are told, and the shell is hung up, as closing a window does.
   * The shell gets SIGHUP while its terminal is still there, so it hangs up its jobs too (a shell
   * that finds its terminal gone first just exits, and leaves them running); a moment later
   * Pelican lets go of the PTY, and what ignored the hangup has no terminal any more. With
   * `stopping`, Pelican is: its pages lose the connection as a server going away (1001), come
   * back once Pelican does, and find the terminal gone, to start again.
   */
  close(stopping = false): void {
    if (this.closed) return;
    this.closed = true;
    terminals.delete(this.id);
    for (const viewer of [...this.viewers]) {
      this.leave(viewer);
      if (stopping) viewer.ws.close(1001, 'Pelican stopped');
      else viewer.ws.close(TERMINAL_CLOSE.closed, 'Closed');
    }
    clearTimeout(this.gathering);
    clearInterval(this.watching);
    clearTimeout(this.programLook);
    if (this.paused) this.pty.resume();
    if (this.exit) return;
    try {
      this.pty.kill('SIGHUP');
    } catch {
      // Gone already.
    }
    setTimeout(() => {
      try {
        this.pty.destroy?.();
      } catch {
        // Gone already.
      }
    }, HANGUP_MS).unref();
  }
}

const terminals = new Map<string, Term>();
let sweeping: NodeJS.Timeout | undefined;

/**
 * A page's socket lives on after the request that opened it: every second, while any page shows a
 * terminal, the pages whose sign-in signs nobody in any more (a new token or password, which
 * Pelican notices within a second, or a cookie that expired) are let go.
 */
const SIGN_IN_CHECK_MS = 1000;
let checkingSignIns: NodeJS.Timeout | undefined;

function checkSignIns(): void {
  if (checkingSignIns) return;
  checkingSignIns = setInterval(() => {
    for (const term of terminals.values()) term.letGoOfSignedOut();
    if ([...terminals.values()].some((term) => term.viewers.size > 0)) return;
    clearInterval(checkingSignIns);
    checkingSignIns = undefined;
  }, SIGN_IN_CHECK_MS);
  checkingSignIns.unref();
}

/** Why this Pelican runs no terminals at all: the demo, or --no-terminal. */
function refusal(): string | undefined {
  if (config.demo) return 'This is the demo, so nothing runs here. Start Pelican without --demo for a terminal.';
  if (!config.terminal) return 'The terminal is off: Pelican was started with --no-terminal.';
  return undefined;
}

/** Whether the refusal is this Pelican's own (403), rather than the computer's (503). */
export const terminalsRefused = (): boolean => refusal() !== undefined;

/** Whether terminals run here, and why not, found without loading anything (for /api/info). */
export function terminalAvailability(): TerminalAvailability {
  const reason = refusal() ?? ptyFailure() ?? ptyMissing();
  return reason ? { available: false, reason } : { available: true };
}

/** The same, for sure: the PTY is loaded, the first time a page asks for terminals. */
export async function terminalsReady(): Promise<TerminalAvailability> {
  const refused = refusal();
  if (refused) return { available: false, reason: refused };
  try {
    await loadPty();
    return { available: true };
  } catch (error) {
    return { available: false, reason: (error as Error).message };
  }
}

/** The terminals of a folder (all of them, without one), oldest first, with the program in front now. */
export function listTerminals(cwd?: string): TerminalInfo[] {
  const shown = [...terminals.values()].filter((t) => cwd === undefined || t.cwd === cwd);
  for (const term of shown) term.lookAtProgram();
  return shown.map((t) => t.info());
}

/**
 * Starts the user's shell, as a login shell, in `cwd` (checked by the caller, with launchFor's
 * `env`), and types `command` into it once it is ready. An ended terminal makes room when as many
 * run as may, else one never used (unused); otherwise TooManyTerminals.
 */
export async function openTerminal(cwd: string, size: { cols: number; rows: number }, options: { env?: Record<string, string>; command?: string; colors?: TerminalColors } = {}): Promise<TerminalInfo> {
  const refused = refusal();
  if (refused) throw new Error(refused);
  const spawn = await loadPty();
  const file = testShell.file ?? (await loginShell());
  const args = testShell.file ? (testShell.args ?? []) : ['-l'];
  // Looked at again after each wait: another terminal may have opened meanwhile.
  while (terminals.size >= TERMINAL_LIMITS.terminals) {
    const room = [...terminals.values()].find((t) => t.exit) ?? (await unused());
    if (!room) throw new TooManyTerminals(`At most ${TERMINAL_LIMITS.terminals} terminals run at once. Close one to open another.`);
    room.close();
  }
  const pty = spawn(file, args, { name: 'xterm-256color', cols: size.cols, rows: size.rows, cwd, env: shellEnvironment(process.env, options.env, file) });
  const term = new Term(cwd, pty, file, size.cols, size.rows, options.colors);
  terminals.set(term.id, term);
  if (options.command) term.typeWhenReady(options.command);
  if (!sweeping) {
    sweeping = setInterval(() => void closeIdleTerminals(), terminalTiming.idleCheckMs);
    sweeping.unref();
  }
  return term.info();
}

/**
 * The terminal that has waited longest of those nobody ever typed into or ran a command in, that
 * no page shows, and where nothing runs: a shell the Terminal tab started by itself, in a folder
 * looked at once. It makes room, as an ended one does, rather than leave a folder with none.
 */
async function unused(): Promise<Term | undefined> {
  const idle = [...terminals.values()].filter((t) => !t.used && !t.closed && t.viewers.size === 0).sort((a, b) => a.lastActive - b.lastActive);
  if (idle.length === 0) return undefined;
  const parents = await processParents();
  if (!parents) return undefined;
  const busy = new Set(parents.values());
  return idle.find((t) => !t.used && !t.closed && t.viewers.size === 0 && !busy.has(t.pid));
}

/** Closes a terminal, hanging its shell up; false when there is no such terminal. */
export function closeTerminal(id: string): boolean {
  const term = terminals.get(id);
  term?.close();
  return Boolean(term);
}

/** Every terminal ends with Pelican. */
export function closeAllTerminals(): void {
  for (const term of [...terminals.values()]) term.close(true);
  clearInterval(sweeping);
  sweeping = undefined;
  clearInterval(checkingSignIns);
  checkingSignIns = undefined;
}

/**
 * A page's socket for a terminal (`api/terminal?id&cols&rows`), once server.ts has checked its
 * host, origin and sign-in as for every socket; `stillSignedIn` checks that sign-in again, before
 * each key reaches the shell.
 */
export function attachTerminal(ws: WebSocket, query: URLSearchParams, stillSignedIn: () => boolean = () => true): void {
  // A frame too large or malformed closes this socket; unheard, the error would stop the server.
  ws.on('error', () => ws.terminate());
  if (refusal()) {
    ws.close(TERMINAL_CLOSE.refused, 'No terminal here');
    return;
  }
  const id = query.get('id') ?? '';
  const cols = Number(query.get('cols'));
  const rows = Number(query.get('rows'));
  if (!id || !sizeAllowed(cols, rows)) {
    ws.close(TERMINAL_CLOSE.badRequest, 'Which terminal, at what size?');
    return;
  }
  const term = terminals.get(id);
  if (!term) {
    ws.close(TERMINAL_CLOSE.gone, 'No such terminal');
    return;
  }
  term.attach(ws, cols, rows, stillSignedIn);
}

/** For tests: how a terminal's flow control stands. */
export const terminalState = (id: string) => terminals.get(id)?.state();

/** Each process's parent, from ps; undefined when ps cannot say. */
function processParents(): Promise<Map<number, number> | undefined> {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid='], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve(undefined);
      const parents = new Map<number, number>();
      for (const line of String(stdout).split('\n')) {
        const [pid, ppid] = line.trim().split(/\s+/).map(Number);
        if (Number.isInteger(pid) && Number.isInteger(ppid)) parents.set(pid!, ppid!);
      }
      resolve(parents);
    });
  });
}

/**
 * Closes the terminals nobody has shown or used for `idleMs` where nothing runs: ended, or a shell
 * with no process of its own (a job left in the background counts). When that cannot be told, the
 * terminal stays.
 */
export async function closeIdleTerminals(now = Date.now()): Promise<void> {
  const idle = [...terminals.values()].filter((t) => t.viewers.size === 0 && now - t.lastActive >= terminalTiming.idleMs);
  if (idle.length === 0) return;
  const parents = idle.some((t) => !t.exit) ? await processParents() : undefined;
  const busy = new Set(parents?.values());
  for (const term of idle) {
    if (term.closed || term.viewers.size > 0 || now - term.lastActive < terminalTiming.idleMs) continue;
    if (term.exit || (parents && !busy.has(term.pid))) term.close();
  }
}
