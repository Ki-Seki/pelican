/**
 * What a program prints stops no terminal of Pelican's, on a page (xterm.js) or in the server's copy
 * of the screen (xterm's headless terminal): xterm 6.0.0 throws on some output, and a throw in its
 * parser leaves a page's screen taking nothing more, and would stop Pelican, where an exception
 * nobody catches is fatal. xterm keeps what this reaches to itself; the version is pinned, and
 * test/terminal-guards.test.ts fails should it move.
 */

type Params = (number | number[])[];

/** A terminal, xterm.js's or the headless one, as far as the guards use it. */
type Guarded = {
  readonly cols: number;
  readonly buffer: { readonly active: { readonly cursorX: number; readonly cursorY: number; readonly length: number } };
  readonly parser: { registerCsiHandler(id: { prefix?: string; final: string }, callback: (params: Params) => boolean): unknown };
};

type XtermParams = { params: number[]; length: number };

type Core = {
  _bufferService: { buffer: { x: number } };
  _inputHandler: {
    parse(data: string | Uint8Array, promiseResult?: boolean): unknown;
    eraseInDisplay(params: XtermParams, respectProtect?: boolean): boolean;
    eraseInLine(params: XtermParams, respectProtect?: boolean): boolean;
    _parser: { reset(): void };
  };
};

const ONE: XtermParams = { params: [1], length: 1 };

/**
 * Guards `terminal` against the output xterm throws on. `onError` hears of a throw caught: the
 * rest of the output given with it is lost, and the next is taken as ever.
 */
export function guardOutput(terminal: Guarded, onError: (error: unknown) => void = () => undefined): void {
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
