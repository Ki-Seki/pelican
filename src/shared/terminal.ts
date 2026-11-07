// The terminal: a shell on the computer, shown beside the conversation as Claude Desktop shows
// one. Its routes, and what its socket carries; the server side is src/server/terminals.ts.
//
//   GET    /api/terminals?cwd&folder → TerminalList (the folder's terminals; all of them without cwd;
//                               with folder, how terminals name that one)
//   POST   /api/terminals       NewTerminal → 201 { terminal: TerminalInfo }
//                               403 off or the demo · 409 { needsTrust, brings } · 429 too many · 503 no PTY here
//   GET    /api/terminals/:id   → TerminalRunning, or 404: End asks first while a program runs
//   DELETE /api/terminals/:id   → { ok: true }: the shell is hung up (SIGHUP), as closing a window does
//   WS     api/terminal?id=…&cols=…&rows=…   (relative to the page, as api/ws)
//     → `ready` first, then the shell's output as binary frames, and size, program, exit, clear and tick
//     ← keystrokes and pastes as binary frames (at most TERMINAL_LIMITS.frame bytes each), resize, ack, colors, clear
//
// The server answers what programs ask of the terminal itself, from its copy of the screen: device
// attributes (CSI c, CSI > c), status and the cursor's position (CSI n, CSI ? n), a mode's state
// (CSI $ p, CSI ? $ p), a setting's (DCS $ q), and a color (OSC 4, 10, 11 and 12 with `?`), from
// the colors a page draws in (`colors`) or one a program set. A page must not answer them too, or
// a program gets an answer from each page, after the others: with xterm.js, a handler that
// swallows each of them (`terminal.parser.registerCsiHandler({ final: 'c' }, () => true)` and so
// on, for a color only the asking) keeps its own quiet.

import { revealHidden } from './hidden';

/** How a terminal's shell ended: its exit code, or the signal that ended it (`SIGHUP`). */
export type TerminalExit = { code: number | null; signal: string | null };

/** A terminal, as the list shows it. Terminals belong to the folder they started in. */
export type TerminalInfo = {
  id: string;
  /**
   * The folder it started in, its links followed (on a Mac, /tmp is /private/tmp), as a session
   * started there names it: whichever name a page opened it under, it is that folder's.
   */
  cwd: string;
  /** The program in front, for the tab's name: the shell's at its prompt, else what runs (vim, node). */
  program: string;
  /** Pages showing it now. */
  viewers: number;
  /** When it started, ms since epoch. */
  createdAt: number;
  /** Set once its shell has ended; the screen stays until the terminal is closed. */
  exit?: TerminalExit;
};

/**
 * GET /api/terminals/:id: a terminal, and whether a program runs in it now: another than its shell
 * in front, or a process of the shell's own, such as a job in the background (true when the
 * computer cannot say).
 */
export type TerminalRunning = { terminal: TerminalInfo; running: boolean };

/**
 * Whether this Pelican runs terminals and, when it does not, why, in a sentence to show as it is;
 * when it does, the shell a terminal runs, as a tab names it (zsh, bash, fish, pwsh): Run in
 * terminal offers a step's command only to the shell it is written for, PowerShell's to PowerShell.
 */
export type TerminalAvailability = { available: boolean; reason?: string; shell?: string };

/**
 * The colors a page draws a terminal in, each `#rrggbb`: its text, its background, its cursor,
 * and the 16 colors programs pick from (black, red, green, yellow, blue, magenta, cyan, white,
 * then their bright ones). The server answers a program that asks for one from these.
 */
export type TerminalColors = { foreground: string; background: string; cursor: string; ansi: string[] };

/** GET /api/terminals */
export type TerminalList = TerminalAvailability & {
  terminals: TerminalInfo[];
  /** The folder asked about (`folder=`), as terminals name it: its links followed. */
  folder?: string;
};

/** POST /api/terminals */
export type NewTerminal = {
  /** An absolute path: the session's folder, or one in it (Open in terminal). */
  cwd: string;
  cols: number;
  rows: number;
  /** The answer to the trust sheet, when the first try said the folder needs one (409, needsTrust). */
  trust?: 'trusted' | 'user-only';
  /** Run in terminal: typed into the shell, with Enter, once it is ready for it. */
  command?: string;
  /** The colors the page draws in, for a program that asks before a page shows the terminal. */
  colors?: TerminalColors;
};

/** What the server sends as text frames. What the shell prints comes as binary frames, in between. */
export type TerminalServerMessage =
  /**
   * First on every socket: the screen as it is (its scrollback, the alternate screen of a program
   * such as vim, and the modes it set), to write into a terminal of `cols` × `rows` before the
   * output that follows. Sent again only on a new socket.
   */
  | { type: 'ready'; id: string; cols: number; rows: number; snapshot: string; program: string; exit?: TerminalExit }
  /**
   * Draw the shell this size: another page said one, or (right after `ready`) one the screen sent
   * had yet to take.
   */
  | { type: 'size'; cols: number; rows: number }
  /** Another program is in front. */
  | { type: 'program'; program: string }
  /** The shell ended. */
  | ({ type: 'exit' } & TerminalExit)
  /**
   * Clear terminal, asked on a page: clear the screen and what scrolled off it here, keeping the
   * line the cursor is on as the first (xterm's clear), once the output before it is written, as the
   * server's copy does at the same place in the output.
   */
  | { type: 'clear' }
  /** Every 25 seconds, so a page can tell a quiet terminal from a socket that died. */
  | { type: 'tick' };

/** What a page sends as text frames; keystrokes and pastes go as binary frames. */
export type TerminalClientMessage =
  /**
   * This page's size (columns, rows): the shell takes the size of the page that last said one,
   * its user having typed in it or resized it. `shown`: said as the page showed the terminal again
   * (its tab picked again, its box as it was), by nobody's doing: the shell takes it only where no
   * other page shows the terminal, or this page's size is the one it has (nobody else's since),
   * and then says it back (`size`); otherwise it keeps the size it has, and says nothing.
   */
  | { type: 'resize'; cols: number; rows: number; shown?: true }
  /**
   * Output this page has written to its screen since its last ack, in bytes of the binary frames
   * (`ready` counts for nothing): one ack for each TERMINAL_LIMITS.ackBytes or more. The shell waits
   * while a page is far behind, and a page that acknowledges nothing for a while as it waits is
   * closed (TERMINAL_CLOSE.behind).
   */
  | { type: 'ack'; bytes: number }
  /**
   * The colors this page draws in, said on each connection and when they change: a program is
   * answered in those of the page last typed in, as the shell takes its size, else the last said.
   */
  | { type: 'colors'; colors: TerminalColors }
  /**
   * Clear terminal: the screen and its scrollback, as `clear` clears them, on every page and in the
   * server's copy, so a page that comes back, or another, shows it cleared; a program in front of
   * the shell (vim, htop) draws its screen again, as it does after Ctrl+L.
   */
  | { type: 'clear' };

export const TERMINAL_LIMITS = {
  /** Terminals one Pelican runs at once; ended ones make room. */
  terminals: 10,
  /** Pages one terminal shows on at once. */
  viewers: 8,
  /** The largest frame a page may send, in bytes (a longer paste goes in parts), and the largest output frame. */
  frame: 64 * 1024,
  /** A page acknowledges output in steps of at least this many bytes. */
  ackBytes: 16 * 1024,
  /** Lines of scrollback the server keeps of each terminal, and sends with `ready`. */
  scrollback: 2000,
  /** The command of Run in terminal, in characters. */
  command: 16 * 1024,
  cols: { min: 2, max: 500 },
  rows: { min: 2, max: 300 },
} as const;

/**
 * WebSocket close codes the server ends a terminal's socket with, and what they mean for the page.
 * When Pelican stops, its terminals end with it and their sockets close as a server going away
 * does (1001): a page connects again, as after any dropped connection, and once Pelican is back it
 * finds the terminal gone (Start again).
 */
export const TERMINAL_CLOSE = {
  /** The address had no terminal id, or a size out of range. */
  badRequest: 4400,
  /** The browser is no longer signed in (SIGNED_OUT_CLOSE): nothing it sends reaches the shell. */
  signedOut: 4401,
  /** Terminals are off here: the demo, or Pelican started with --no-terminal. */
  refused: 4403,
  /** No such terminal: it was closed, or Pelican has started again since (Start again). */
  gone: 4404,
  /** The page made no progress for a while as the shell waited for it: connect again for the screen as it is now. */
  behind: 4408,
  /** The terminal was closed, here or on another page, or after a long time unused. */
  closed: 4410,
  /** The terminal shows on as many pages as it can. */
  tooManyViewers: 4429,
} as const;

/**
 * How Run in terminal's command may be laid out, for its question to show all of it at once,
 * wrapped, its lines numbered and its blanks drawn (components/RunCommand): at most `lines` lines,
 * each at most `columns` wide (a tab reaching the next of every 8), with no run of more than
 * `blanks` columns of blanks (spaces, tabs, any other space), and at most `blankLines` blank lines
 * in a row. Past them, a run of blanks or of empty lines pushes what follows out of sight, as 300
 * spaces after `ls -la` hid a `; touch …` that ran, and a command too long to take in at a glance
 * is one whose question nobody reads to its end; such a command is not offered, and the server
 * refuses it too.
 */
export const COMMAND_LAYOUT = { lines: 50, columns: 500, blanks: 16, blankLines: 2 } as const;

/** A blank: a space, a tab, or a space of another width; never a newline (a command's lines are split at it). */
const BLANK = /[^\S\n]/;
export const isBlank = (char: string): boolean => BLANK.test(char);

/** Columns a character takes on a line at `column`: a tab reaches the next of every 8, anything else one. */
export const columnsOf = (char: string, column: number): number => (char === '\t' ? 8 - (column % 8) : 1);

/**
 * Why `command`'s layout would hide some of it from its question, as a sentence; undefined when its
 * question shows all of it (COMMAND_LAYOUT).
 */
export function layoutHides(command: string): string | undefined {
  const lines = command.split('\n');
  if (lines.length > COMMAND_LAYOUT.lines) return `It is ${lines.length} lines long, more than the ${COMMAND_LAYOUT.lines} a question about it shows`;
  let emptyRun = 0;
  for (const line of lines) {
    emptyRun = line.trim() === '' ? emptyRun + 1 : 0;
    if (emptyRun > COMMAND_LAYOUT.blankLines) return `It has more than ${COMMAND_LAYOUT.blankLines} blank lines in a row, which push what follows out of sight`;
    let column = 0;
    let blanks = 0;
    for (const char of line) {
      const width = columnsOf(char, column);
      column += width;
      blanks = BLANK.test(char) ? blanks + width : 0;
      if (blanks > COMMAND_LAYOUT.blanks) return `It has a run of more than ${COMMAND_LAYOUT.blanks} blanks, which push what follows out of sight`;
    }
    if (column > COMMAND_LAYOUT.columns) return `A line of it is ${column} columns wide, more than the ${COMMAND_LAYOUT.columns} a question about it shows`;
  }
  return undefined;
}

/**
 * Why Run in terminal may not type `command` into a shell, as a sentence; undefined when it may.
 * Not an empty one, or one longer than a terminal takes; not one with a control character other
 * than tab and newline (C0, DEL or C1), which a shell's line editor takes as a key: Ctrl+U clears
 * the line, Esc starts a sequence, a carriage return runs what is there, so an `echo` could run
 * something else. Nor one with a character that may make it read otherwise than it runs, as an
 * approval writes it out (hidden.ts, read as a shell reads it), or laid out so that its question
 * cannot show all of it (layoutHides): what the question shows is what runs.
 */
export function commandRefusal(command: string): string | undefined {
  if (command.trim() === '' || command.length > TERMINAL_LIMITS.command) return `The command must be some text, up to ${TERMINAL_LIMITS.command} characters`;
  if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(command)) return 'The command holds characters a shell would take as keys';
  if (revealHidden(command, { runs: 'shell' }).hidden) return 'The command holds characters that cannot be seen, or that read otherwise than they run';
  return layoutHides(command);
}

/** Whether Run in terminal may type `command` into a shell (commandRefusal). */
export const commandRunnable = (command: string): boolean => commandRefusal(command) === undefined;

/**
 * `data` (UTF-8) in pieces of at most `size` bytes, each cut between two characters: xterm 6.0.0
 * loses a character cut after a byte 0x80 (`—` is E2 80 94) when it takes the rest in the next piece.
 */
export function utf8Pieces<T extends Uint8Array>(data: T, size: number): T[] {
  if (data.length <= size) return [data];
  const pieces: T[] = [];
  for (let at = 0; at < data.length;) {
    let end = Math.min(at + size, data.length);
    // A byte 10xxxxxx goes on a character: the cut goes before the character.
    while (end < data.length && end > at && (data[end]! & 0xc0) === 0x80) end -= 1;
    if (end === at) end = Math.min(at + size, data.length);
    pieces.push(data.subarray(at, end) as T);
    at = end;
  }
  return pieces;
}

/** Whether a size is one a terminal takes. */
export const sizeAllowed = (cols: unknown, rows: unknown): boolean => Number.isInteger(cols) && Number.isInteger(rows)
  && (cols as number) >= TERMINAL_LIMITS.cols.min && (cols as number) <= TERMINAL_LIMITS.cols.max
  && (rows as number) >= TERMINAL_LIMITS.rows.min && (rows as number) <= TERMINAL_LIMITS.rows.max;

function parsed(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Colors as a page says them, or undefined for anything else. */
export function terminalColors(value: unknown): TerminalColors | undefined {
  const colors = value as Partial<TerminalColors> | undefined;
  if (!colors || typeof colors !== 'object' || !Array.isArray(colors.ansi) || colors.ansi.length !== 16) return undefined;
  const all = [colors.foreground, colors.background, colors.cursor, ...colors.ansi];
  if (!all.every((color) => typeof color === 'string' && HEX_COLOR.test(color))) return undefined;
  return { foreground: colors.foreground!, background: colors.background!, cursor: colors.cursor!, ansi: [...colors.ansi] };
}

/** A page's text frame, or undefined for anything else. */
export function terminalClientMessage(text: string): TerminalClientMessage | undefined {
  const value = parsed(text);
  if (value?.type === 'resize' && sizeAllowed(value.cols, value.rows)) {
    return { type: 'resize', cols: value.cols as number, rows: value.rows as number, ...(value.shown === true ? { shown: true as const } : {}) };
  }
  if (value?.type === 'ack' && Number.isSafeInteger(value.bytes) && (value.bytes as number) > 0) return { type: 'ack', bytes: value.bytes as number };
  if (value?.type === 'colors') {
    const colors = terminalColors(value.colors);
    return colors ? { type: 'colors', colors } : undefined;
  }
  if (value?.type === 'clear') return { type: 'clear' };
  return undefined;
}

const exitOf = (value: unknown): TerminalExit | undefined => {
  const exit = value as Partial<TerminalExit> | undefined;
  return exit && typeof exit === 'object' && (exit.code === null || Number.isInteger(exit.code)) && (exit.signal === null || typeof exit.signal === 'string')
    ? { code: exit.code ?? null, signal: exit.signal ?? null }
    : undefined;
};

/** The server's text frame, or undefined for anything else. */
export function terminalServerMessage(text: string): TerminalServerMessage | undefined {
  const value = parsed(text);
  switch (value?.type) {
    case 'ready': {
      if (typeof value.id !== 'string' || !sizeAllowed(value.cols, value.rows) || typeof value.snapshot !== 'string' || typeof value.program !== 'string') return undefined;
      const exit = exitOf(value.exit);
      return { type: 'ready', id: value.id, cols: value.cols as number, rows: value.rows as number, snapshot: value.snapshot, program: value.program, ...(exit ? { exit } : {}) };
    }
    case 'size':
      return sizeAllowed(value.cols, value.rows) ? { type: 'size', cols: value.cols as number, rows: value.rows as number } : undefined;
    case 'program':
      return typeof value.program === 'string' ? { type: 'program', program: value.program } : undefined;
    case 'exit': {
      const exit = exitOf(value);
      return exit ? { type: 'exit', ...exit } : undefined;
    }
    case 'tick':
      return { type: 'tick' };
    case 'clear':
      return { type: 'clear' };
    default:
      return undefined;
  }
}
