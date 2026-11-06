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
 * - keeps the window's title as a program set it, up to 10 million characters.
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

  // Whatever else throws.
  const parse = input.parse.bind(input);
  input.parse = (data, promiseResult) => {
    try {
      return parse(data, promiseResult);
    } catch (error) {
      input._parser.reset();
      onError(error);
      return undefined;
    }
  };
}
