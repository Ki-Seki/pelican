/**
 * What a program prints stops no terminal of Pelican's, on a page (xterm.js) or in the server's copy
 * of the screen (xterm's headless terminal), and grows neither without bound. As it is, xterm 6.0.0
 * - throws on some output, and a throw in its parser leaves a page's screen taking nothing more,
 *   and would stop Pelican, where an exception nobody catches is fatal;
 * - does what a sequence says as many times as it says, up to 2^31: scrolling, inserting and
 *   deleting lines, moving by tab stops and repeating a character (REP), so 15 bytes kept Pelican
 *   busy for minutes, or took gigabytes, though past a screen's worth nothing more changes;
 * - keeps every link a program prints (OSC 8) until its line scrolls away, and a line drawn again
 *   and again in place never does, so links printed over one line filled the memory;
 * - keeps the window's title as a program set it, up to 10 million characters;
 * - takes a piece of output whole, and some sequences work over the whole screen each time: a reset
 *   (RIS), DECALN, erasing it (ED), scrolling it, inserting or deleting lines or columns, the
 *   alternate screen, up to a millisecond or two each at 500 by 300, so a piece of 512 characters
 *   of them held Pelican, or a page, for 100 to 400 ms, and 100 KB of them for minutes
 *   (outputPieces cuts output into pieces of bounded work, and a reset right after a reset, which
 *   changes nothing, is not done again);
 * - keeps parsing the output it was given after it is disposed (dropPendingOutput lets it go).
 * xterm keeps what this reaches to itself; the version is pinned, and test/terminal-guards.test.ts
 * fails should it move.
 */

type Params = (number | number[])[];

/** A terminal, xterm.js's or the headless one, as far as the guards use it. */
type Guarded = {
  readonly cols: number;
  readonly rows: number;
  readonly buffer: { readonly active: { readonly cursorX: number; readonly cursorY: number; readonly length: number } };
  readonly parser: {
    registerCsiHandler(id: { prefix?: string; final: string }, callback: (params: Params) => boolean): unknown;
    registerOscHandler(ident: number, callback: (data: string) => boolean): unknown;
  };
};

type XtermParams = { params: number[]; length: number };

/** A link as xterm keeps it: where it goes, and the id a program gave it, if any. */
type LinkData = { id?: string; uri: string };

type Core = {
  _bufferService: { buffer: { x: number } };
  _writeBuffer: { _writeBuffer: unknown[]; _callbacks: unknown[]; _pendingData: number; _bufferOffset: number };
  _inputHandler: {
    parse(data: string | Uint8Array, promiseResult?: boolean): unknown;
    eraseInDisplay(params: XtermParams, respectProtect?: boolean): boolean;
    eraseInLine(params: XtermParams, respectProtect?: boolean): boolean;
    scrollUp(params: XtermParams): boolean;
    scrollDown(params: XtermParams): boolean;
    insertLines(params: XtermParams): boolean;
    deleteLines(params: XtermParams): boolean;
    cursorForwardTab(params: XtermParams): boolean;
    cursorBackwardTab(params: XtermParams): boolean;
    repeatPrecedingCharacter(params: XtermParams): boolean;
    _parser: { reset(): void };
    /** Set while a parse waits on an async handler, to go on with the same output (none of Pelican's are). */
    _parseStack: { paused: boolean };
  };
  _oscLinkService: {
    registerLink(data: LinkData): number;
    addLineToLink(linkId: number, y: number): void;
    getLinkData(linkId: number): LinkData | undefined;
  };
};

/**
 * The links a page keeps, the latest (an older one's text stays, no longer a link), and the
 * longest address and id a link may have, as VTE has them: a longer one is printed as plain text.
 */
export const LINKS = { kept: 2048, uri: 2083, id: 250 } as const;

const ONE: XtermParams = { params: [1], length: 1 };

/** A string of its own: a part of a sequence's text would keep all of the text in memory. */
const own = (text: string): string => JSON.parse(JSON.stringify(text)) as string;

/**
 * Guards `terminal` against the output xterm throws on, or does too much with. `onError` hears of
 * a throw caught: the rest of the output given with it is lost, and the next is taken as ever.
 * `links`: how many links (OSC 8) it keeps, the latest; none on the server's copy, where nothing
 * follows a link and the screen a page gets carries none.
 */
export function guardOutput(terminal: Guarded, onError: (error: unknown) => void = () => undefined, { links = LINKS.kept }: { links?: number } = {}): void {
  const core = (terminal as unknown as { _core: Core })._core;
  const input = core._inputHandler;
  // Erasing above (ED 1, and DECSED 1) with the cursor at the end of the last line, on a screen
  // with no scrollback yet (a terminal just opened, or just cleared): xterm reads the line under it
  // by its place on the screen, finds none, and throws. Here the same erase goes up to the cell
  // before the last, which reads no line under it, and the line is then erased up to the cursor.
  const eraseAbove = (respectProtect: boolean) => (params: Params) => {
    const at = terminal.buffer.active;
    if (params[0] !== 1 || at.cursorX + 1 < terminal.cols || at.cursorY + 1 < at.length) return false;
    const cursor = core._bufferService.buffer;
    const x = cursor.x;
    cursor.x = terminal.cols - 2;
    input.eraseInDisplay(ONE, respectProtect);
    cursor.x = x;
    input.eraseInLine(ONE, respectProtect);
    return true;
  };
  terminal.parser.registerCsiHandler({ final: 'J' }, eraseAbove(false));
  terminal.parser.registerCsiHandler({ prefix: '?', final: 'J' }, eraseAbove(true));

  // A count past what can change anything: scrolling (SU, SD), inserting or deleting lines (IL, DL)
  // more times than the screen has rows leaves the same blank rows as once per row; moving by tab
  // stops (CHT, CBT) more times than it has columns, the cursor where once per column leaves it.
  // REP repeats a character at most a line's worth of times: what a program draws with it (a rule,
  // a run of spaces) is within a line, and a line's worth costs no more than erasing one.
  const counted: Array<[string, (params: XtermParams) => boolean, () => number]> = [
    ['S', (params) => input.scrollUp(params), () => terminal.rows],
    ['T', (params) => input.scrollDown(params), () => terminal.rows],
    ['L', (params) => input.insertLines(params), () => terminal.rows],
    ['M', (params) => input.deleteLines(params), () => terminal.rows],
    ['I', (params) => input.cursorForwardTab(params), () => terminal.cols],
    ['Z', (params) => input.cursorBackwardTab(params), () => terminal.cols],
    ['b', (params) => input.repeatPrecedingCharacter(params), () => terminal.cols],
  ];
  for (const [final, act, most] of counted) {
    terminal.parser.registerCsiHandler({ final }, (params) => {
      const count = params[0];
      if (typeof count !== 'number' || count <= most()) return false;
      return act({ params: [most()], length: 1 });
    });
  }

  // The title (OSC 0, 1 and 2): Pelican shows none, and keeps none.
  for (const ident of [0, 1, 2]) terminal.parser.registerOscHandler(ident, () => true);

  // Links (OSC 8): the latest `links`, each where it goes and its id, and nothing more of them.
  const service = core._oscLinkService;
  const kept = new Map<number, { data: LinkData; key?: string }>();
  const byKey = new Map<string, number>();
  let next = 1;
  service.registerLink = (data) => {
    if (links <= 0 || data.uri.length > LINKS.uri || (data.id?.length ?? 0) > LINKS.id) return 0;
    // A link with an id is one link wherever it is printed with that id and address, as in xterm.
    const copy: LinkData = data.id === undefined ? { uri: own(data.uri) } : { id: own(data.id), uri: own(data.uri) };
    const key = copy.id === undefined ? undefined : `${copy.id};;${copy.uri}`;
    const known = key === undefined ? undefined : byKey.get(key);
    if (known !== undefined) {
      const entry = kept.get(known)!;
      kept.delete(known);
      kept.set(known, entry);
      return known;
    }
    const id = next;
    next += 1;
    kept.set(id, key === undefined ? { data: copy } : { data: copy, key });
    if (key !== undefined) byKey.set(key, id);
    while (kept.size > links) {
      const [oldest, entry] = kept.entries().next().value!;
      kept.delete(oldest);
      if (entry.key !== undefined) byKey.delete(entry.key);
    }
    return id;
  };
  // xterm marks each line a link is on, to let it go when the lines go; here the count does.
  service.addLineToLink = () => undefined;
  service.getLinkData = (id) => kept.get(id)?.data;

  // A reset (RIS) right after a reset changes nothing, and costs as much as the first: one is done,
  // in a run of them, also across two pieces of output. Whatever else throws is caught.
  const parse = input.parse.bind(input);
  let afterReset = false;
  input.parse = (data, promiseResult) => {
    let taken = data;
    // Output given anew (xterm goes on with the same output after an async handler, which leaves it be).
    if (!input._parseStack?.paused && data.length > 0) {
      taken = withoutRepeatedResets(data, afterReset);
      afterReset = endsWithReset(taken);
    }
    try {
      return parse(taken, promiseResult);
    } catch (error) {
      input._parser.reset();
      onError(error);
      return undefined;
    }
  };
}

const ESC = 0x1b;
const RIS = 0x63;

/** Whether output ends in a reset, ESC c (in whatever state xterm's parser was, ESC starts a sequence anew). */
function endsWithReset(data: string | Uint8Array): boolean {
  const n = data.length;
  if (n < 2) return false;
  return typeof data === 'string' ? data.charCodeAt(n - 2) === ESC && data.charCodeAt(n - 1) === RIS : data[n - 2] === ESC && data[n - 1] === RIS;
}

/** Output with each reset (ESC c) that comes right after one, here or at the end of the last output (`afterReset`), left out. */
function withoutRepeatedResets<T extends string | Uint8Array>(data: T, afterReset: boolean): T {
  const code = (at: number) => (typeof data === 'string' ? data.charCodeAt(at) : (data as Uint8Array)[at]!);
  const isReset = (at: number) => at + 1 < data.length && code(at) === ESC && code(at + 1) === RIS;
  // Most output has none: it goes as it is.
  let at = afterReset && isReset(0) ? 0 : -1;
  for (let i = 0; at < 0 && i + 3 < data.length; i += 1) if (isReset(i) && isReset(i + 2)) at = i + 2;
  if (at < 0) return data;
  const kept: number[] = [];
  let from = 0;
  let previous = afterReset;
  for (let i = 0; i < data.length;) {
    if (isReset(i)) {
      if (previous) {
        kept.push(from, i);
        from = i + 2;
      }
      previous = true;
      i += 2;
    } else {
      previous = false;
      i += 1;
    }
  }
  kept.push(from, data.length);
  if (typeof data === 'string') {
    let out = '';
    for (let i = 0; i < kept.length; i += 2) out += data.slice(kept[i], kept[i + 1]);
    return out as T;
  }
  const bytes = data as Uint8Array;
  const out = new Uint8Array(kept.reduce((sum, value, i) => (i % 2 ? sum + value - kept[i - 1]! : sum), 0));
  for (let i = 0, to = 0; i < kept.length; i += 2) {
    out.set(bytes.subarray(kept[i], kept[i + 1]), to);
    to += kept[i + 1]! - kept[i]!;
  }
  return out as T;
}

/**
 * Lets go of the output a terminal was given and has not parsed yet: a terminal closed, or a screen
 * taken away, parses nothing more of what it was sent (xterm would, after it is disposed too).
 */
export function dropPendingOutput(terminal: unknown): void {
  const writing = (terminal as { _core?: Partial<Core> })._core?._writeBuffer;
  if (!writing || !Array.isArray(writing._writeBuffer) || !Array.isArray(writing._callbacks)) return;
  writing._writeBuffer.length = 0;
  writing._callbacks.length = 0;
  writing._pendingData = 0;
  writing._bufferOffset = 0;
}

/**
 * Output in pieces, each taken in whole by xterm and soon done, so what else waits (the rest of
 * Pelican, a page's taps) is answered in between: at most PIECE.characters characters (bytes, for
 * a page's UTF-8), each cut between two characters, and at most as many of the sequences that work
 * over the whole screen (screenWide) as cost about PIECE.work at this size (screenWork): at 500 by
 * 300 a few, at 80 by 24 more than a piece holds.
 */
export const PIECE = { characters: 512, work: 4_000_000 } as const;

/**
 * About what one sequence that works over the whole screen costs at a size, in steps: scrolling the
 * screen by its rows takes, for each row, a row's worth of cells and a pass over every line kept
 * (the screen's and the scrollback's), the worst of them (2 ns or so a step on a laptop).
 */
export const screenWork = (cols: number, rows: number, scrollback = 2000): number => rows * (rows + cols + scrollback);

/** How many sequences that work over the whole screen a piece holds at most, at a size. */
export const wideMost = (cols: number, rows: number): number => Math.max(1, Math.floor(PIECE.work / screenWork(cols, rows)));

/** A piece of output, and how many sequences in it work over the whole screen (screenWide). */
export type OutputPiece<T> = { data: T; wide: number };

/**
 * `data` in pieces (PIECE), each with the number of sequences in it that work over the whole
 * screen: a reset (ESC c), DECALN (ESC # 8), erasing the screen (CSI J, CSI ? J), scrolling it or
 * inserting or deleting lines (CSI S, T, L, M, ^), inserting or deleting columns (CSI ' } and ' ~),
 * or a mode that redraws or swaps it (the alternate screen, 47, 1047 and 1049, DECCOLM 3 and
 * DECSCNM 5). Anything else costs a row's worth at most. A sequence cut between two pieces of
 * output counts where it starts.
 */
export function outputPieces<T extends string | Uint8Array>(data: T, cols: number, rows: number): Array<OutputPiece<T>> {
  const most = wideMost(cols, rows);
  const text = typeof data === 'string' ? (data as string) : undefined;
  const bytes = text === undefined ? (data as Uint8Array) : undefined;
  const length = data.length;
  const pieces: Array<OutputPiece<T>> = [];
  let start = 0;
  let wide = 0;
  const cut = (end: number) => {
    pieces.push({ data: (text !== undefined ? text.slice(start, end) : bytes!.subarray(start, end)) as T, wide });
    start = end;
    wide = 0;
  };
  /** Whether a cut at `at` falls inside a character: a UTF-16 pair's second half, or a UTF-8 byte 10xxxxxx. */
  const within = (at: number) => (text !== undefined
    ? (text.charCodeAt(at) & 0xfc00) === 0xdc00 && (text.charCodeAt(at - 1) & 0xfc00) === 0xd800
    : (bytes![at]! & 0xc0) === 0x80);
  let state = GROUND;
  let prefix = 0;
  let intermediate = 0;
  let param = 0;
  let wideMode = false;
  for (let at = 0; at < length;) {
    if (at - start >= PIECE.characters) {
      let end = at;
      while (end > start && within(end)) end -= 1;
      cut(end === start ? at : end);
    }
    // A C1 control is one code unit in text, and C2 and a byte 80 to 9F in UTF-8.
    let code: number;
    let size = 1;
    if (text !== undefined) {
      code = text.charCodeAt(at);
    } else {
      code = bytes![at]!;
      if (code === 0xc2 && at + 1 < length && bytes![at + 1]! >= 0x80 && bytes![at + 1]! <= 0x9f) {
        code = bytes![at + 1]!;
        size = 2;
      } else if (code >= 0x80) {
        code = 0xa0;
      }
    }
    let done = false;
    if (code === 0x18 || code === 0x1a) {
      state = GROUND;
    } else if (code === ESC && state !== STRING) {
      state = ESCAPED;
    } else if (state === GROUND) {
      if (code === 0x9b) state = enterCsi();
      else if (code === 0x90 || code === 0x98 || code === 0x9d || code === 0x9e || code === 0x9f) state = STRING;
    } else if (state === ESCAPED || state === STRING_ESCAPED) {
      if (code === 0x5b) state = enterCsi();
      else if (state === STRING_ESCAPED && code === 0x5c) state = GROUND;
      else if (code === 0x5d || code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f) state = STRING;
      else if (code === 0x63) {
        done = true;
        state = GROUND;
      } else if (code === 0x23) state = ESCAPED_HASH;
      else if (code >= 0x20 && code <= 0x2f) state = ESCAPED_MORE;
      else if (code >= 0x30) state = GROUND;
    } else if (state === ESCAPED_HASH) {
      done = code === 0x38;
      state = code >= 0x20 && code <= 0x2f ? ESCAPED_MORE : GROUND;
    } else if (state === ESCAPED_MORE) {
      if (code >= 0x30) state = GROUND;
    } else if (state === CSI) {
      if (code >= 0x30 && code <= 0x39) {
        param = Math.min(param * 10 + code - 0x30, 99_999);
      } else if (code === 0x3b || code === 0x3a) {
        wideMode ||= WIDE_MODES.has(param);
        param = 0;
      } else if (code >= 0x3c && code <= 0x3f) {
        prefix ||= code;
      } else if (code >= 0x20 && code <= 0x2f) {
        intermediate = code;
      } else if (code >= 0x40 && code <= 0x7e) {
        wideMode ||= WIDE_MODES.has(param);
        done = code === 0x4a
          || (prefix === 0 && intermediate === 0 && (code === 0x4c || code === 0x4d || code === 0x53 || code === 0x54 || code === 0x5e))
          || (intermediate === 0x27 && (code === 0x7d || code === 0x7e))
          || (prefix === 0x3f && wideMode && (code === 0x68 || code === 0x6c));
        state = GROUND;
      }
    } else if (state === STRING) {
      if (code === ESC) state = STRING_ESCAPED;
      else if (code === 0x07 || code === 0x9c) state = GROUND;
    }
    at += size;
    if (done) {
      wide += 1;
      if (wide >= most && at < length) cut(at);
    }
  }
  if (start < length || pieces.length === 0) cut(length);
  return pieces;

  function enterCsi() {
    prefix = 0;
    intermediate = 0;
    param = 0;
    wideMode = false;
    return CSI;
  }
}

const GROUND = 0;
const ESCAPED = 1;
const ESCAPED_HASH = 2;
const ESCAPED_MORE = 3;
const CSI = 4;
const STRING = 5;
const STRING_ESCAPED = 6;
/** Private modes that redraw or swap the whole screen: DECCOLM, DECSCNM, and the alternate screen. */
const WIDE_MODES = new Set([3, 5, 47, 1047, 1049]);
