/**
 * A terminal's screen as output that draws it again, for a page that comes in (`ready`): the
 * scrollback, the alternate screen of a program such as vim, and the modes it set.
 *
 * The screen is written as xterm's own serializer writes it (@xterm/addon-serialize 0.14.0, by
 * the xterm.js authors, MIT: its string serializer, below), but for what that one drew otherwise:
 * a bold character after a dim one came back plain, as the SGR that ended dim (22) ended bold too;
 * a wrapped line of nothing but empty cells left a `-` at its start, as its moves by 0 went by 1,
 * and the next line's first cell took this one's background;
 * a line wrapped onto one that begins with empty cells lost its last character to the next line's
 * first; a cursor moved from past the last column landed a column off; colored empty cells at a
 * screen's end, and those of the first line to scroll in, came back in the usual colors; a mark in
 * a cell of its own joined the character before it; and the alternate screen's empty cells took the
 * colors a program last printed in. What the
 * serializer leaves out follows it (modesBeyondSnapshot). test/terminal-snapshot.test.ts compares,
 * over random output, a page that comes back with one that saw it all, and lists what neither
 * carries.
 *
 * Copyright (c) 2019 The xterm.js authors (the serializer). MIT.
 */
import type { IBuffer, IBufferCell, Terminal as Screen } from '@xterm/headless';

/** What a cell's attributes, and those a program prints in, are read through (xterm's IBufferCell, and its own AttributeData). */
type Attributes = Pick<IBufferCell,
  'isBold' | 'isDim' | 'isItalic' | 'isUnderline' | 'isBlink' | 'isInverse' | 'isInvisible' | 'isStrikethrough' | 'isOverline'
  | 'getFgColorMode' | 'getFgColor' | 'getBgColorMode' | 'getBgColor' | 'isFgRGB' | 'isFgPalette' | 'isBgRGB' | 'isBgPalette' | 'isAttributeDefault'>;

type ScreenBuffer = {
  scrollTop: number; scrollBottom: number; ybase: number;
  tabs: Record<number, boolean | undefined>;
  savedX: number; savedY: number; savedCurAttrData: Attributes;
};

type ScreenCore = {
  coreMouseService?: { activeEncoding?: string };
  coreService?: { isCursorHidden?: boolean; modes?: { insertMode?: boolean }; decPrivateModes?: { origin?: boolean; cursorStyle?: 'block' | 'underline' | 'bar'; cursorBlink?: boolean } };
  buffer?: ScreenBuffer;
  _bufferService?: { buffers: { normal: ScreenBuffer } };
  _inputHandler?: { _curAttrData?: Attributes; _parser?: { precedingJoinState?: number } };
  unicodeService?: { wcwidth(codepoint: number): number };
};

const coreOf = (screen: Screen) => (screen as unknown as { _core?: ScreenCore })._core;

// The serializer, as xterm's.

const equalFg = (a: Attributes, b: Attributes) => a.getFgColorMode() === b.getFgColorMode() && a.getFgColor() === b.getFgColor();
const equalBg = (a: Attributes, b: Attributes) => a.getBgColorMode() === b.getBgColorMode() && a.getBgColor() === b.getBgColor();
const equalFlags = (a: Attributes, b: Attributes) => a.isInverse() === b.isInverse() && a.isBold() === b.isBold() && a.isUnderline() === b.isUnderline()
  && a.isOverline() === b.isOverline() && a.isBlink() === b.isBlink() && a.isInvisible() === b.isInvisible() && a.isItalic() === b.isItalic()
  && a.isDim() === b.isDim() && a.isStrikethrough() === b.isStrikethrough();

/** The SGR parameters that take `old` to `cell`. */
function diffStyle(cell: Attributes, old: Attributes): number[] {
  const sgr: number[] = [];
  const fgChanged = !equalFg(cell, old);
  const bgChanged = !equalBg(cell, old);
  const flagsChanged = !equalFlags(cell, old);
  if (!fgChanged && !bgChanged && !flagsChanged) return sgr;
  if (cell.isAttributeDefault()) {
    if (!old.isAttributeDefault()) sgr.push(0);
    return sgr;
  }
  if (fgChanged) {
    const color = cell.getFgColor();
    if (cell.isFgRGB()) sgr.push(38, 2, (color >>> 16) & 0xff, (color >>> 8) & 0xff, color & 0xff);
    else if (cell.isFgPalette()) sgr.push(...(color >= 16 ? [38, 5, color] : [color & 8 ? 90 + (color & 7) : 30 + (color & 7)]));
    else sgr.push(39);
  }
  if (bgChanged) {
    const color = cell.getBgColor();
    if (cell.isBgRGB()) sgr.push(48, 2, (color >>> 16) & 0xff, (color >>> 8) & 0xff, color & 0xff);
    else if (cell.isBgPalette()) sgr.push(...(color >= 16 ? [48, 5, color] : [color & 8 ? 100 + (color & 7) : 40 + (color & 7)]));
    else sgr.push(49);
  }
  if (flagsChanged) {
    if (cell.isInverse() !== old.isInverse()) sgr.push(cell.isInverse() ? 7 : 27);
    // Bold and dim end together (22): when either ends, both do, and the one that stays comes back.
    if ((old.isBold() && !cell.isBold()) || (old.isDim() && !cell.isDim())) {
      sgr.push(22);
      if (cell.isBold()) sgr.push(1);
      if (cell.isDim()) sgr.push(2);
    } else {
      if (cell.isBold() && !old.isBold()) sgr.push(1);
      if (cell.isDim() && !old.isDim()) sgr.push(2);
    }
    if (cell.isUnderline() !== old.isUnderline()) sgr.push(cell.isUnderline() ? 4 : 24);
    if (cell.isOverline() !== old.isOverline()) sgr.push(cell.isOverline() ? 53 : 55);
    if (cell.isBlink() !== old.isBlink()) sgr.push(cell.isBlink() ? 5 : 25);
    if (cell.isInvisible() !== old.isInvisible()) sgr.push(cell.isInvisible() ? 8 : 28);
    if (cell.isItalic() !== old.isItalic()) sgr.push(cell.isItalic() ? 3 : 23);
    if (cell.isStrikethrough() !== old.isStrikethrough()) sgr.push(cell.isStrikethrough() ? 9 : 29);
  }
  return sgr;
}

/** The SGR parameters that set a cell's background alone. */
function backgroundSgr(cell: Attributes): string {
  const color = cell.getBgColor();
  if (cell.isBgRGB()) return `48;2;${(color >>> 16) & 0xff};${(color >>> 8) & 0xff};${color & 0xff}`;
  if (cell.isBgPalette()) return color >= 16 ? `48;5;${color}` : String(color & 8 ? 100 + (color & 7) : 40 + (color & 7));
  return '49';
}

/** A move right (C) or left (D), and none by 0, which a terminal takes as 1. */
const move = (by: number, forward: string, back: string) => (by > 0 ? `\x1b[${by}${forward}` : by < 0 ? `\x1b[${-by}${back}` : '');

/** The rows `start` to `end` of `buffer`, and its cursor, as xterm's StringSerializeHandler writes them. */
function serializeRows(buffer: IBuffer, screen: Screen, start: number, end: number): string {
  const rows: string[] = [];
  const separators: string[] = [];
  let current = '';
  let nullCells = 0;
  const cursorStyle = buffer.getNullCell();
  let cursorStyleRow = 0;
  let cursorStyleCol = 0;
  const background = buffer.getNullCell();
  let lastCursorRow = start;
  let lastCursorCol = 0;
  let lastContentRow = start;
  let lastContentCol = 0;
  const wcwidth = coreOf(screen)?.unicodeService?.wcwidth.bind(coreOf(screen)?.unicodeService);
  const thisRowLast = buffer.getNullCell();
  const thisRowLastSecond = buffer.getNullCell();
  const nextRowFirst = buffer.getNullCell();

  /** A line's cells on the screen: after a resize, xterm keeps some longer, past its right edge. */
  const width = (line: { length: number }) => Math.min(line.length, screen.cols);
  const rowEnd = (row: number, isLastRow: boolean) => {
    const line = buffer.getLine(row)!;
    // A colored empty cell at the line's end is filled, or its color would be missing: content,
    // which a screen with no scrollback keeps (the serializer left out such rows at its end).
    if (nullCells > 0 && !equalBg(cursorStyle, background)) {
      current += `\x1b[${nullCells}X`;
      lastContentRow = row;
      lastContentCol = width(line) - nullCells;
    }
    let separator = '';
    if (!isLastRow) {
      // The next line scrolls in, in the colors printed in now (BCE), from the last of the
      // screen's rows on (the serializer's count began a row later).
      if (row - start >= screen.rows - 1) buffer.getLine(cursorStyleRow)?.getCell(cursorStyleCol, background);
      const next = buffer.getLine(row + 1)!;
      if (!next.isWrapped) {
        separator = '\r\n';
        lastCursorRow = row + 1;
        lastCursorCol = 0;
      } else {
        const last = line.getCell(width(line) - 1, thisRowLast)!;
        const lastSecond = line.getCell(width(line) - 2, thisRowLastSecond)!;
        const first = next.getCell(0, nextRowFirst)!;
        const firstWide = first.getWidth() > 1;
        // Whether printing alone wraps here: the next line begins with a character, which wraps
        // (the serializer's own test, by JavaScript's precedence, took a move for one).
        let valid = false;
        if (first.getChars() !== '' && (firstWide ? nullCells <= 1 : nullCells <= 0)) {
          if ((last.getChars() || last.getWidth() === 0) && equalBg(last, first)) valid = true;
          if (firstWide && (lastSecond.getChars() || lastSecond.getWidth() === 0) && equalBg(last, first) && equalBg(lastSecond, first)) valid = true;
        }
        if (!valid) {
          // Characters enough to wrap, then the next line's start erased again, in its own
          // background (the serializer's took this line's), and the empty cells filled.
          const erase = equalBg(first, cursorStyle) ? '\x1b[1X' : `\x1b[${backgroundSgr(first)}m\x1b[1X\x1b[${backgroundSgr(cursorStyle)}m`;
          separator = `${'-'.repeat(nullCells + 1)}\x1b[1D${erase}`;
          if (nullCells > 0) {
            separator += `\x1b[A${move(width(line) - nullCells, 'C', 'D')}\x1b[${nullCells}X${move(-(width(line) - nullCells), 'C', 'D')}\x1b[B`;
          }
          lastContentRow = row + 1;
          lastContentCol = 0;
          lastCursorRow = row + 1;
          lastCursorCol = 0;
        }
      }
    }
    rows.push(current);
    separators.push(separator);
    current = '';
    nullCells = 0;
  };

  const nextCell = (cell: IBufferCell, row: number, col: number) => {
    // A cell of no width is the second half of a wide character.
    if (cell.getWidth() === 0) return;
    const empty = cell.getChars() === '';
    const sgr = diffStyle(cell, cursorStyle);
    // An empty cell's style changes with its background only, as its foreground is never drawn.
    const changed = empty ? !equalBg(cursorStyle, cell) : sgr.length > 0;
    if (changed) {
      if (nullCells > 0) {
        if (!equalBg(cursorStyle, background)) current += `\x1b[${nullCells}X`;
        current += `\x1b[${nullCells}C`;
        nullCells = 0;
      }
      lastContentRow = lastCursorRow = row;
      lastContentCol = lastCursorCol = col;
      current += `\x1b[${sgr.join(';')}m`;
      const line = buffer.getLine(row);
      if (line) {
        line.getCell(col, cursorStyle);
        cursorStyleRow = row;
        cursorStyleCol = col;
      }
    }
    if (empty) {
      nullCells += cell.getWidth();
      return;
    }
    if (nullCells > 0) {
      if (!equalBg(cursorStyle, background)) current += `\x1b[${nullCells}X`;
      current += `\x1b[${nullCells}C`;
      nullCells = 0;
    }
    const chars = cell.getChars();
    // A cell that begins with a mark (one printed after a sequence, or one too many) joins
    // nothing before it: a NUL, which xterm does nothing with, says so.
    if (wcwidth?.(chars.codePointAt(0)!) === 0) current += '\0';
    current += chars;
    lastContentRow = lastCursorRow = row;
    lastContentCol = lastCursorCol = col + cell.getWidth();
  };

  const cells = [buffer.getNullCell(), buffer.getNullCell()];
  for (let row = start; row <= end; row += 1) {
    const line = buffer.getLine(row);
    if (line) {
      for (let col = 0; col < width(line); col += 1) {
        const cell = line.getCell(col, cells[col % 2]);
        if (cell) nextCell(cell, row, col);
      }
    }
    rowEnd(row, row === end);
  }

  // Trailing empty rows are left out of a screen with no scrollback.
  let rowCount = rows.length;
  if (buffer.length - start <= screen.rows) {
    rowCount = lastContentRow + 1 - start;
    lastCursorCol = lastContentCol;
    lastCursorRow = lastContentRow;
  }
  let content = '';
  for (let i = 0; i < rowCount; i += 1) {
    content += rows[i];
    if (i + 1 < rowCount) content += separators[i];
  }
  // The cursor, and the attributes a program prints in: its column said outright, as a move from
  // past the last column starts from the last, where xterm puts the cursor back first.
  const cursorRow = buffer.baseY + buffer.cursorY;
  if (cursorRow !== lastCursorRow || buffer.cursorX !== lastCursorCol) {
    content += `${move(cursorRow - lastCursorRow, 'B', 'A')}\x1b[${Math.min(buffer.cursorX, screen.cols - 1) + 1}G`;
  }
  const attributes = coreOf(screen)?._inputHandler?._curAttrData;
  const sgr = attributes ? diffStyle(attributes, cursorStyle) : [];
  if (sgr.length > 0) content += `\x1b[${sgr.join(';')}m`;
  return content;
}

/** The modes xterm's serializer writes. */
function serializeModes(screen: Screen): string {
  const modes = screen.modes;
  let content = '';
  if (modes.applicationCursorKeysMode) content += '\x1b[?1h';
  if (modes.applicationKeypadMode) content += '\x1b[?66h';
  if (modes.bracketedPasteMode) content += '\x1b[?2004h';
  if (modes.insertMode) content += '\x1b[4h';
  if (modes.originMode) content += '\x1b[?6h';
  if (modes.reverseWraparoundMode) content += '\x1b[?45h';
  if (modes.sendFocusMode) content += '\x1b[?1004h';
  if (modes.wraparoundMode === false) content += '\x1b[?7l';
  const tracking = { none: '', x10: '\x1b[?9h', vt200: '\x1b[?1000h', drag: '\x1b[?1002h', any: '\x1b[?1003h' }[modes.mouseTrackingMode];
  return content + (tracking ?? '');
}

// What it leaves out.

/** xterm's color modes: one of the 16 (30-37, 90-97), one of the 256 (38;5), or RGB (38;2). */
const PALETTE16 = 0x1000000;
const PALETTE256 = 0x2000000;
const RGB = 0x3000000;

/** The SGR that sets exactly these attributes, the color's mode included. */
function sgrOf(a: Attributes): string {
  const params = ['0'];
  const flags: Array<[() => number, string]> = [[a.isBold, '1'], [a.isDim, '2'], [a.isItalic, '3'], [a.isUnderline, '4'], [a.isBlink, '5'], [a.isInverse, '7'], [a.isInvisible, '8'], [a.isStrikethrough, '9'], [a.isOverline, '53']];
  for (const [is, param] of flags) if (is.call(a)) params.push(param);
  const color = (mode: number, value: number, base: number) => {
    if (mode === RGB) params.push(`${base + 8};2;${(value >>> 16) & 255};${(value >>> 8) & 255};${value & 255}`);
    else if (mode === PALETTE256) params.push(`${base + 8};5;${value}`);
    else if (mode === PALETTE16) params.push(String(value < 8 ? base + value : base + 60 + value - 8));
  };
  color(a.getFgColorMode(), a.getFgColor(), 30);
  color(a.getBgColorMode(), a.getBgColor(), 40);
  return `\x1b[${params.join(';')}m`;
}

/** What each of xterm's two screens keeps of its own: rows that scroll, tab stops, a saved cursor. */
function screenState(screen: Screen, buffer: ScreenBuffer): string {
  const { cols, rows } = screen;
  let more = '';
  // xterm counts the saved row from the buffer's first line: a new screen's is that line, not the screen's first.
  const saved = { x: Math.min(buffer.savedX, cols - 1), y: Math.min(Math.max(buffer.savedY - buffer.ybase, 0), rows - 1), sgr: sgrOf(buffer.savedCurAttrData) };
  if (buffer.savedX !== 0 || buffer.savedY !== 0 || saved.sgr !== '\x1b[0m') more += `\x1b[${saved.y + 1};${saved.x + 1}H${saved.sgr}\x1b7`;
  const stops = Object.keys(buffer.tabs).map(Number).filter((x) => buffer.tabs[x] && x < cols).sort((a, b) => a - b);
  const usual = Array.from({ length: Math.ceil(cols / 8) }, (_, n) => n * 8);
  if (stops.join() !== usual.join()) more += `\x1b[3g${stops.map((x) => `\x1b[${x + 1}G\x1bH`).join('')}`;
  if (buffer.scrollTop !== 0 || buffer.scrollBottom !== rows - 1) more += `\x1b[${buffer.scrollTop + 1};${buffer.scrollBottom + 1}r`;
  return more;
}

/**
 * The cursor where it is on `shown`, after sequences that moved it (`moved`). Past the last
 * column (the next character wraps), the last character is printed again, as only printing puts
 * it there; right after a character (`joining`, what xterm keeps of it), that one is, so the marks
 * that follow join it, and REP repeats it, as on a page that saw it all. `current`: the attributes
 * printed in now.
 */
function placeCursor(screen: Screen, shown: IBuffer, { moved, origin, top, joining, inserting, current }: { moved: boolean; origin: boolean; top: number; joining: number; inserting: boolean; current: Attributes }): string {
  const { cols } = screen;
  const { cursorX: x, cursorY: y } = shown;
  const row = (origin ? y - top : y) + 1;
  const line = shown.getLine(shown.baseY + y);
  /** The cell that ends at `end`: where it starts, and it, or none (the cursor on a wide character's second half, after a resize). */
  const before = (end: number) => {
    const last = line?.getCell(end - 1);
    const start = last && last.getWidth() === 0 && end >= 2 ? end - 2 : end - 1;
    const cell = line?.getCell(start);
    return { start, cell: cell && start + cell.getWidth() === end ? cell : undefined };
  };
  // The character printed last has the attributes printed in now, unless a resize moved the cursor since.
  const last = (cell: IBufferCell | undefined) => Boolean(joining && cell?.getChars() && sgrOf(cell) === sgrOf(current));
  if (x >= cols && line) {
    const { start, cell } = before(cols);
    if (last(cell)) return `\x1b[${row};${start + 1}H${cell!.getChars()}`;
    if (cell?.getChars()) return `\x1b[${row};${start + 1}H${sgrOf(cell)}${cell.getChars()}${sgrOf(current)}\0`;
    // An empty cell there takes a space, as only a character puts the cursor past the last column;
    // on a line all empty, of one background, the line is then erased up to the cursor, which stays.
    const cells = Array.from({ length: cols }, (_, at) => line.getCell(at)!);
    const empty = cells.every((c) => c.getChars() === '' && c.getWidth() === 1 && equalBg(c, cells[0]!));
    const erase = empty ? `\x1b[0;${backgroundSgr(cells[0]!)}m\x1b[1K` : '';
    return `\x1b[${row};${cols}H${cell ? sgrOf(cell) : ''} ${erase}${sgrOf(current)}\0`;
  }
  if (joining && x > 0 && line && !inserting) {
    const { start, cell } = before(x);
    if (last(cell)) return `\x1b[${row};${start + 1}H${cell!.getChars()}`;
  }
  // Nothing joins what was printed before, as nothing would on the screen copied: a NUL, which xterm does nothing with.
  return `${moved ? `\x1b[${row};${x + 1}H` : ''}${joining ? '' : '\0'}`;
}

/**
 * What a program set that the serializer leaves out of a screen, as sequences to follow it: how
 * mouse reports are written (SGR, which lazygit, htop and less --mouse ask for), where the cursor
 * was saved (DECSC), the tab stops and the rows that scroll (apt keeps its progress bar under
 * them), the cursor's shape (neovim's bar while it inserts) and a hidden cursor; then the cursor,
 * which those moved, as the serializer's own origin mode does (placeCursor). xterm keeps these to
 * itself; the version is pinned, and test/terminal-snapshot.test.ts fails should they move.
 */
export function modesBeyondSnapshot(screen: Screen): string {
  const core = coreOf(screen);
  const buffer = core?.buffer;
  const modes = core?.coreService?.decPrivateModes;
  const current = core?._inputHandler?._curAttrData;
  if (!buffer || !current) return '';
  let more = '';
  const encoding = core?.coreMouseService?.activeEncoding;
  if (encoding === 'SGR') more += '\x1b[?1006h';
  else if (encoding === 'SGR_PIXELS') more += '\x1b[?1016h';
  // Rows and columns as they are on the screen, origin mode or not, while these are said.
  const state = screenState(screen, buffer);
  if (modes?.origin) more += `\x1b[?6l${state}\x1b[?6h`;
  else more += state;
  if (modes?.cursorStyle) {
    const shape = { block: 1, underline: 3, bar: 5 }[modes.cursorStyle];
    more += `\x1b[${modes.cursorBlink ? shape : shape + 1} q`;
  }
  if (core?.coreService?.isCursorHidden) more += '\x1b[?25l';
  const moved = Boolean(modes?.origin) || state !== '';
  if (moved) more += sgrOf(current);
  return more + placeCursor(screen, screen.buffer.active, {
    moved, origin: Boolean(modes?.origin), top: buffer.scrollTop, joining: core?._inputHandler?._parser?.precedingJoinState ?? 0,
    inserting: Boolean(core?.coreService?.modes?.insertMode), current,
  });
}

/** The screen, its `scrollback` lines above included, as output that draws it again. */
export function screenSnapshot(screen: Screen, scrollback: number): string {
  const core = coreOf(screen);
  const normal = screen.buffer.normal;
  const length = normal.length;
  let content = serializeRows(normal, screen, Math.max(0, length - Math.min(length, scrollback + screen.rows)), length - 1);
  const normalState = core?._bufferService?.buffers.normal;
  const current = core?._inputHandler?._curAttrData;
  if (screen.buffer.active.type === 'alternate' && normalState && current) {
    // What the normal screen keeps of its own, for when the program goes back to it, said while it
    // shows; then the alternate one, its empty cells in the usual colors, as the serializer counts
    // on, without saving the cursor again (1047, not 1049).
    const state = screenState(screen, normalState);
    content += `${state}${placeCursor(screen, normal, { moved: state !== '', origin: false, top: 0, joining: 0, inserting: false, current })}`;
    const alternate = screen.buffer.alternate;
    // Its rows from where they show: after a resize xterm may keep lines above them, never shown.
    content += `\x1b[0m\x1b[?1047h\x1b[H${serializeRows(alternate, screen, alternate.baseY, Math.min(alternate.length, alternate.baseY + screen.rows) - 1)}`;
  }
  return content + serializeModes(screen) + modesBeyondSnapshot(screen);
}
