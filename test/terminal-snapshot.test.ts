// The screen a page that comes in gets (src/server/terminal-snapshot.ts): written into a fresh
// xterm, it must equal an xterm that saw all the output, every cell and its attributes, the cursor
// (past the last column too), the modes and what xterm keeps of each of its two screens; and the
// output that follows must draw the same on both. Over random output, seeded (FUZZ_CASES=20000 for
// a long run), and for each thing xterm's own serializer drew otherwise.
//
// What a page that comes back is not given, and the comparison leaves out (see `check`):
// - charsets (G0 to G3, and which is in use), which the stream here never changes;
// - an empty cell's attributes but its background (one insert mode, ICH or an overwritten wide
//   character leaves), as the serializer writes empty cells by their background alone;
// - underline styles and colors, and links (OSC 8), which the serializer never wrote either;
// - that a screen's first line continues one that scrolled off;
// - with the cursor past the last column over an empty cell, on a line not all empty in one
//   background, that the cell is empty: it takes a space, as only a character puts the cursor there;
// - with insert mode on, what the next mark joins and what REP repeats (the character before the
//   cursor cannot be printed again without inserting), and after a resize moved the cursor;
// - a saved cursor (DECSC) whose row has scrolled off the screen, or whose column is past it, and
//   the alternate screen's, from an earlier time it showed, while the normal one shows;
// - tab stops, and cells, past the right edge, which xterm keeps from a wider screen and shows
//   again only once it widens;
// - states xterm itself leaves broken, which no output builds: a wide character's second half
//   overwritten (wraparound off), a wide character in the last column after a resize, a narrow one
//   widened by a mark joined after a resize, an alternate screen of fewer lines than rows, room and
//   lines it keeps for the alternate screen after a resize (above its rows, while the normal one
//   showed, or for a scrollback it then grows), origin mode with the cursor outside the rows that
//   scroll after a resize; and output it
//   throws on, which the guards (terminal-guards.ts) keep from stopping anything.
// A resize after a page came back reflows what xterm keeps out of sight as well (the first line's
// continuing, cells past the right edge), so what follows is compared where no resize comes.
import unicode11Addon from '@xterm/addon-unicode11';
import xtermHeadless, { type IBufferCell, type Terminal } from '@xterm/headless';
import { describe, expect, it } from 'vitest';

import { screenSnapshot } from '../src/server/terminal-snapshot';
import { guardOutput } from '../src/shared/terminal-guards';
import { loadWidths } from '../src/shared/terminal-widths';

const { Terminal: HeadlessTerminal } = xtermHeadless;
const { Unicode11Addon } = unicode11Addon;

const SCROLLBACK = 40;

/** A terminal as Pelican's are, whose throws are kept here. */
function make(cols: number, rows: number, thrown: string[]) {
  const t = new HeadlessTerminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true, logLevel: 'off' });
  loadWidths(t, Unicode11Addon);
  guardOutput(t, (error) => thrown.push(String(error)));
  return t;
}

const write = (t: Terminal, text: string) => new Promise<void>((resolve) => t.write(text, resolve));

/** Output, and the resizes between it. */
type Step = string | { cols: number; rows: number };

async function run(t: Terminal, steps: Step[]) {
  let text = '';
  for (const step of steps) {
    if (typeof step === 'string') {
      text += step;
      continue;
    }
    if (text) await write(t, text);
    text = '';
    t.resize(step.cols, step.rows);
  }
  if (text) await write(t, text);
}

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(items: readonly T[]): T => items[int(items.length)]!;
  return { next, int, pick };
}

const WIDE = ['\u4e2d', '\u6587', '\u65e5', '\u672c', '\u8a9e', '\ud55c', '\uae00', '\uff21', '\u{1f680}', '\u{1f600}', '\u{1f44d}', '\u2764\ufe0f'];

/**
 * Random output: printable text, wide characters, marks (on a letter, and alone), controls, cursor
 * moves, erases, inserts and deletes, scrolling, rows that scroll, origin mode, insert mode,
 * wraparound, the alternate screen, the cursor's visibility and shape, mouse modes, tab stops, SGR,
 * a saved cursor, other modes, and resizes.
 */
function stream(seed: number, length: number, size: { cols: number; rows: number }): Step[] {
  const r = rng(seed);
  const csi = (s: string) => `\u001b[${s}`;
  const n = (max: number) => 1 + r.int(max);
  const steps: Step[] = [];
  for (let i = 0; i < length; i += 1) {
    const k = r.int(100);
    if (k < 28) steps.push(Array.from({ length: n(12) }, () => String.fromCharCode(0x21 + r.int(94))).join(''));
    else if (k < 32) steps.push(Array.from({ length: n(4) }, () => r.pick(WIDE)).join(''));
    else if (k < 34) steps.push(`${String.fromCharCode(0x61 + r.int(26))}${Array.from({ length: n(3) }, () => String.fromCharCode(0x300 + r.int(0x70))).join('')}`);
    else if (k < 35) steps.push(Array.from({ length: n(3) }, () => String.fromCharCode(0x300 + r.int(0x70))).join(''));
    else if (k < 40) steps.push(r.pick(['\r', '\n', '\r\n', '\b', '\t', '\u0007', ' ']));
    else if (k < 45) steps.push(csi(`${n(size.rows + 2)};${n(size.cols + 2)}H`));
    else if (k < 48) steps.push(csi(`${n(3)}${r.pick(['A', 'B', 'C', 'D', 'G', 'd', 'E', 'F', '`', 'a', 'e'])}`));
    else if (k < 51) steps.push(csi(`${r.int(4)}${r.pick(['J', 'K'])}`));
    else if (k < 54) steps.push(csi(`${n(3)}${r.pick(['@', 'P', 'X', 'L', 'M', 'S', 'T', 'b'])}`));
    else if (k < 57) steps.push(r.pick(['\u001bD', '\u001bM', '\u001bE']));
    else if (k < 60) steps.push(r.next() < 0.3 ? csi('r') : csi(`${n(size.rows)};${n(size.rows)}r`));
    else if (k < 62) steps.push(csi(`?6${r.pick(['h', 'l'])}`));
    else if (k < 64) steps.push(csi(`4${r.pick(['h', 'l'])}`));
    else if (k < 65) steps.push(csi(`?7${r.pick(['h', 'l', 'h'])}`));
    else if (k < 67) steps.push(csi(`?${r.pick(['1049', '1049', '47', '1047'])}${r.pick(['h', 'l'])}`));
    else if (k < 69) steps.push(r.next() < 0.5 ? csi(`?25${r.pick(['h', 'l'])}`) : csi(`${r.int(7)} q`));
    else if (k < 71) steps.push(csi(`?${r.pick(['9', '1000', '1002', '1003', '1006', '1016', '1005', '1015'])}${r.pick(['h', 'l'])}`));
    else if (k < 74) steps.push(r.pick(['\u001bH', csi('g'), csi('3g'), csi(`${n(2)}I`), csi(`${n(2)}Z`)]));
    else if (k < 82) {
      const params = ['0', '1', '2', '3', '4', '5', '7', '8', '9', '53', '22', '23', '24', '27', '29', `${30 + r.int(8)}`, `${40 + r.int(8)}`, `${90 + r.int(8)}`, `38;5;${r.int(256)}`, `48;2;${r.int(256)};${r.int(256)};${r.int(256)}`, '39', '49'];
      steps.push(csi(`${Array.from({ length: n(3) }, () => r.pick(params)).join(';')}m`));
    } else if (k < 85) steps.push(r.pick(['\u001b7', '\u001b8']));
    else if (k < 88) steps.push(csi(`?${r.pick(['1', '2004', '1004', '45', '66'])}${r.pick(['h', 'l'])}`));
    else if (k < 90) steps.push({ cols: 8 + r.int(30), rows: 3 + r.int(10) });
    else steps.push(Array.from({ length: n(6) }, () => String.fromCharCode(0x61 + r.int(26))).join(''));
  }
  return steps;
}

type Core = {
  _bufferService: { buffer: Kept; buffers: { normal: Kept; alt: Kept } };
  _inputHandler: { _curAttrData: Attributes; _parser: { precedingJoinState: number } };
  _charsetService: unknown;
  coreService: { isCursorHidden: boolean; decPrivateModes: { cursorStyle?: string; cursorBlink?: boolean } };
  coreMouseService: { activeProtocol: string; activeEncoding: string };
};
type Attributes = { fg: number; bg: number };
type Kept = {
  scrollTop: number; scrollBottom: number; ybase: number; savedX: number; savedY: number; savedCurAttrData: Attributes;
  tabs: Record<number, boolean | undefined>; lines: { maxLength: number };
};
const coreOf = (t: Terminal) => (t as unknown as { _core: Core })._core;

/** A color as it is drawn: one of the palette's (whether set as 31 or 38;5;1, the same), an RGB one, or the default. */
const colorOf = (mode: number, value: number) => (mode === 0 ? '' : mode === 0x3000000 ? `#${value.toString(16)}` : `P${value & 0xff}`);
/** Attributes as xterm keeps them (AttributeData's fg and bg), read as drawn. */
function attributesOf({ fg, bg }: Attributes): string {
  const flags = [[fg, 0x4000000, 'inverse'], [fg, 0x8000000, 'bold'], [fg, 0x10000000, 'underline'], [fg, 0x20000000, 'blink'], [fg, 0x40000000, 'invisible'], [fg, 0x80000000, 'strike'],
    [bg, 0x4000000, 'italic'], [bg, 0x8000000, 'dim'], [bg, 0x40000000, 'overline']] as const;
  return `${colorOf(fg & 0x3000000, fg & 0xffffff)}/${colorOf(bg & 0x3000000, bg & 0xffffff)}/${flags.filter(([v, bit]) => (v & bit) !== 0).map(([, , name]) => name).join('+')}`;
}

function cellOf(c: IBufferCell): string {
  // The second half of a wide character, drawn by the first: its attributes never show.
  if (c.getWidth() === 0) return 'wide';
  // An empty cell: only its background shows, and only that is carried.
  if (c.getChars() === '') return c.getBgColorMode() === 0 ? 'empty' : `empty{${colorOf(c.getBgColorMode(), c.getBgColor())}}`;
  const flags = [c.isBold() && 'bold', c.isDim() && 'dim', c.isItalic() && 'italic', c.isUnderline() && 'underline', c.isBlink() && 'blink', c.isInverse() && 'inverse',
    c.isInvisible() && 'invisible', c.isStrikethrough() && 'strike', c.isOverline() && 'overline'].filter(Boolean).join('+');
  return `${JSON.stringify(c.getChars())}${c.getWidth() === 2 ? '/2' : ''}{${colorOf(c.getFgColorMode(), c.getFgColor())}/${colorOf(c.getBgColorMode(), c.getBgColor())}/${flags}}`;
}

/** All of a terminal that shows, or shows once more output comes. */
function stateOf(t: Terminal, leaveOut: { firstWrap: boolean; wraps: boolean }) {
  const core = coreOf(t);
  const screenOf = (kept: Kept, shown: Terminal['buffer']['active']) => {
    // The alternate screen has no scrollback: lines xterm keeps above it after a resize never show.
    const first = shown.type === 'alternate' ? shown.baseY : 0;
    const lines: string[] = [];
    for (let y = first; y < shown.length; y += 1) {
      const line = shown.getLine(y)!;
      const cells: string[] = [];
      for (let x = 0; x < Math.min(line.length, t.cols); x += 1) cells.push(cellOf(line.getCell(x)!));
      const wrapped = line.isWrapped && !leaveOut.wraps && !(leaveOut.firstWrap && y === first);
      lines.push(`${wrapped ? '+' : ' '}${cells.join(' ')}`);
    }
    return {
      lines,
      cursor: [shown.cursorX, shown.cursorY, shown.type === 'alternate' ? 0 : shown.baseY],
      region: [kept.scrollTop, kept.scrollBottom],
      tabs: Object.keys(kept.tabs).map(Number).filter((x) => kept.tabs[x] && x < t.cols).join(),
      // As a restore puts it: the column at most the last, the row on the screen.
      saved: [Math.min(kept.savedX, t.cols - 1), Math.min(Math.max(kept.savedY - kept.ybase, 0), t.rows - 1), attributesOf(kept.savedCurAttrData)],
    };
  };
  const active = t.buffer.active;
  return {
    size: [t.cols, t.rows],
    type: active.type,
    active: screenOf(core._bufferService.buffer, active),
    ...(active.type === 'alternate' ? { normal: screenOf(core._bufferService.buffers.normal, t.buffer.normal) } : {}),
    modes: t.modes,
    mouse: [core.coreMouseService.activeProtocol, core.coreMouseService.activeEncoding],
    cursor: [core.coreService.isCursorHidden, core.coreService.decPrivateModes.cursorStyle, core.coreService.decPrivateModes.cursorBlink],
    attributes: attributesOf(core._inputHandler._curAttrData),
    joins: core._inputHandler._parser.precedingJoinState,
  } as Record<string, unknown> & { active: Record<string, unknown>; normal?: Record<string, unknown> };
}

/** Where two states differ, said briefly. */
function differences(a: Record<string, unknown>, b: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[key];
    const y = b[key];
    if (JSON.stringify(x) === JSON.stringify(y)) continue;
    if (key === 'lines' && Array.isArray(x) && Array.isArray(y)) {
      const at = Math.max(0, x.findIndex((line, i) => line !== y[i]));
      out.push(`${prefix}lines[${at}] of ${x.length} and ${y.length}: ${String(x[at]).slice(0, 300)} | ${String(y[at]).slice(0, 300)}`);
    } else if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x)) {
      out.push(...differences(x as Record<string, unknown>, y as Record<string, unknown>, `${prefix}${key}.`));
    } else {
      out.push(`${prefix}${key}: ${JSON.stringify(x)} | ${JSON.stringify(y)}`);
    }
  }
  return out;
}

/** A state xterm leaves that no output builds again (the list above). */
function broken(t: Terminal): boolean {
  const widths = coreOf(t) as unknown as { unicodeService: { wcwidth(codepoint: number): number } };
  for (const buffer of [t.buffer.normal, t.buffer.alternate]) {
    for (let y = 0; y < buffer.length; y += 1) {
      const line = buffer.getLine(y)!;
      const length = Math.min(line.length, t.cols);
      for (let x = 0; x < length; x += 1) {
        const cell = line.getCell(x)!;
        const width = cell.getWidth();
        if (width === 2 && (x + 1 >= length || line.getCell(x + 1)!.getWidth() !== 0)) return true;
        if (width === 2 && widths.unicodeService.wcwidth(cell.getChars().codePointAt(0) ?? 0) !== 2) return true;
        if (width === 0 && (x === 0 || line.getCell(x - 1)!.getWidth() !== 2)) return true;
      }
    }
  }
  const alternate = t.buffer.alternate;
  if (t.buffer.active.type === 'alternate' && alternate.length < alternate.baseY + t.rows) return true;
  // Origin mode with the cursor outside the rows that scroll, where every move under it stays inside.
  const kept = coreOf(t)._bufferService.buffer;
  return t.modes.originMode && (t.buffer.active.cursorY < kept.scrollTop || t.buffer.active.cursorY > kept.scrollBottom);
}

/**
 * The output's first `cutAt` steps to the server's copy and to a page that sees it all; the copy's
 * screen to a page that comes in; then the rest to both. Their differences, or none.
 */
async function check(steps: Step[], cutAt: number, size: { cols: number; rows: number }): Promise<string[]> {
  const thrown: string[] = [];
  const all = make(size.cols, size.rows, thrown);
  const copy = make(size.cols, size.rows, thrown);
  await run(all, steps.slice(0, cutAt));
  await run(copy, steps.slice(0, cutAt));
  // Output xterm threw on (the guards keep it from stopping anything) leaves it broken too.
  if (broken(copy) || thrown.length > 0) return [];
  const late = make(copy.cols, copy.rows, thrown);
  await write(late, screenSnapshot(copy, SCROLLBACK));
  const core = coreOf(copy);
  const joins = core._inputHandler._parser.precedingJoinState !== 0;
  // Resized since the last character printed: what xterm keeps of that one is of nothing on the screen now.
  const printed = steps.slice(0, cutAt).findLastIndex((step) => typeof step === 'string' && /[^\u0000-\u001f\u007f-\u009f]/.test(step.replace(/\u001b(\[[0-9;?<=> ]*.|[^[])/g, '')));
  const resized = steps.slice(0, cutAt).findLastIndex((step) => typeof step !== 'string') > printed;
  const joinLost = joins && (copy.modes.insertMode || !copy.modes.wraparoundMode || resized);
  const offScreen = (kept: Kept) => kept.savedY - kept.ybase < 0 || kept.savedY - kept.ybase > copy.rows - 1 || kept.savedX > copy.cols - 1;
  const savedOff = offScreen(core._bufferService.buffer) || (copy.buffer.active.type === 'alternate' && offScreen(core._bufferService.buffers.normal));
  const alternate = core._bufferService.buffers.alt;
  const alternateSaved = copy.buffer.active.type === 'normal' && (alternate.savedX !== 0 || alternate.savedY !== 0 || alternate.savedCurAttrData.fg !== 0 || alternate.savedCurAttrData.bg !== 0);
  const pastEdge = [core._bufferService.buffers.normal, alternate].some((kept) => Object.keys(kept.tabs).some((x) => kept.tabs[Number(x)] && Number(x) >= copy.cols))
    || [copy.buffer.normal, copy.buffer.alternate].some((buffer) => Array.from({ length: buffer.length }, (_, y) => buffer.getLine(y)!).some((line) => line.length > copy.cols));
  // Lines xterm keeps in the alternate screen from a resize while the normal one showed, which a
  // new screen has none of, and which change where the cursor goes on a resize once it shows.
  const alternateKept = copy.buffer.alternate.baseY > 0 || alternate.lines.maxLength > copy.rows
    || (copy.buffer.active.type === 'normal' && copy.buffer.alternate.length !== make(copy.cols, copy.rows, []).buffer.alternate.length);
  const alternateShown = copy.buffer.active.type === 'alternate';
  const firstWrapped = Boolean(copy.buffer.normal.getLine(0)?.isWrapped || (alternateShown && copy.buffer.alternate.getLine(copy.buffer.alternate.baseY)?.isWrapped));
  // The cursor past the last column over an empty cell, on a line not all empty in one background: the cell takes a space.
  const spaced = [copy.buffer.active, ...(copy.buffer.active.type === 'alternate' ? [copy.buffer.normal] : [])].some((shown) => {
    const line = shown.getLine(shown.baseY + shown.cursorY);
    if (shown.cursorX < copy.cols || !line) return false;
    const cells = Array.from({ length: copy.cols }, (_, x) => line.getCell(x)!);
    const empty = (cell: IBufferCell) => cell.getChars() === '' && cell.getWidth() === 1;
    const oneBackground = cells.every((cell) => empty(cell) && cell.getBgColorMode() === cells[0]!.getBgColorMode() && cell.getBgColor() === cells[0]!.getBgColor());
    return empty(cells.at(-1)!) && !oneBackground;
  });
  if (spaced) return [];
  const compare = (wraps: boolean) => {
    const leaveOut = (state: ReturnType<typeof stateOf>) => {
      if (joinLost) delete state.joins;
      if (savedOff) delete state.active.saved;
      if (state.normal) delete state.normal.saved;
      return state;
    };
    return differences(leaveOut(stateOf(all, { firstWrap: true, wraps })), leaveOut(stateOf(late, { firstWrap: true, wraps })));
  };
  const first = compare(false);
  if (thrown.length > 0 || first.length > 0) return [...thrown, ...first.map((d) => `after the screen: ${d}`)];
  // What is listed above shows in the output that follows; so does how a resize joins the first line.
  if (joinLost || savedOff || alternateSaved || pastEdge || alternateKept) return [];
  // A resize reflows what xterm keeps out of sight as well (the list above), so the rest is
  // compared where none comes.
  const rest = steps.slice(cutAt);
  if (rest.some((step) => typeof step !== 'string')) return [];
  await run(all, rest);
  await run(late, rest);
  return [...thrown, ...compare(firstWrapped).map((d) => `after the rest: ${d}`)];
}

/** One case of the program to the copy, then the rest. */
const after = (cols: number, rows: number, program: string, rest = '') => check([program, rest].filter(Boolean), 1, { cols, rows });

describe('a page that comes back', () => {
  // The cursor past the last column, where the next character wraps.
  it('has the cursor past the last column, with rows that scroll, in origin mode or neither', async () => {
    const line = 'w'.repeat(80);
    expect(await after(80, 24, `\u001b[2;20r\u001b[10;1H${line}`, 'Z')).toEqual([]);
    expect(await after(80, 24, `\u001b[10;1H${line}`, 'Z')).toEqual([]);
    expect(await after(80, 24, `\u001b[?6h\u001b[10;1H${line}`, 'Z')).toEqual([]);
    expect(await after(80, 24, `\u001b[5;15r\u001b[?6h\u001b[3;1H${line}`, 'Z\r\nnext')).toEqual([]);
    // The line erased, all its cells empty, the cursor still past its end.
    expect(await after(80, 24, `\u001b[44m\u001b[10;1H${line}\u001b[2K\u001b[0m`, 'Z')).toEqual([]);
    // In insert mode, and with a wide character last.
    expect(await after(80, 24, `\u001b[2;20r\u001b[10;1H${'w'.repeat(78)}\u4e2d\u001b[4h`, 'Z')).toEqual([]);
    // Moved from there elsewhere.
    expect(await after(80, 24, `\u001b[2;1H${line}\u001b[1;40H`, 'Z')).toEqual([]);
  });

  it('has the modes a full-screen program set: mouse, cursor, rows that scroll, origin mode', async () => {
    expect(await after(80, 24, `${'line\r\n'.repeat(5)}\u001b[?1049h\u001b[?1002h\u001b[?1006h\u001b[?25l\u001b[1;20r\u001b[5;9Hhere`, `${'x\r\n'.repeat(30)}end`)).toEqual([]);
    expect(await after(80, 24, '\u001b[5;15r\u001b[?6h\u001b[3;7Hin', `${'A\r\nB\r\n'.repeat(12)}\u001b[1;1Htop`)).toEqual([]);
    expect(await after(80, 24, '\u001b[6 q$ ')).toEqual([]);
    expect(await after(80, 24, '\u001b[?1003h\u001b[?1016h')).toEqual([]);
    expect(await after(80, 24, `\u001b[1;23r\u001b[24;1HProgress: [###   ]\u001b[1;1H${'Get:1 x\r\n'.repeat(3)}`, 'Get:2 y\r\n'.repeat(30))).toEqual([]);
  });

  it('has where the cursor was saved and the tab stops, of the normal screen too while a program shows the other', async () => {
    expect(await after(80, 24, '\u001b[5;9H\u001b[1;31m\u001b7\u001b[0m\u001b[3g\u001b[5G\u001bH\u001b[30G\u001bH\u001b[1;1H', '\tA\tB\u001b8C')).toEqual([]);
    expect(await after(80, 24, '\u001b[3;12r\u001b[3g\u001b[7G\u001bH\u001b[4;4H\u001b7\u001b[?1047h\u001b[Hvim', '\u001b[?1047l\u001b8\tX\u001b[r')).toEqual([]);
  });

  it('draws what xterm’s serializer drew otherwise', async () => {
    // Bold after dim, and dim after bold and dim.
    expect(await after(40, 5, '\u001b[2mdim\u001b[22;1mbold\u001b[0m \u001b[1;2mboth\u001b[22;2mdim')).toEqual([]);
    // A wrapped line of empty cells; one wrapped onto a line that begins with empty cells.
    expect(await after(10, 5, `${'x'.repeat(15)}\u001b[1A\u001b[2K\u001b[2B\r`)).toEqual([]);
    expect(await after(10, 5, `${'x'.repeat(13)}\r\u001b[2X\r\n`)).toEqual([]);
    // Colored empty lines at the end of a screen with no scrollback, and lines scrolling in colored.
    expect(await after(20, 6, 'text\r\n\u001b[41m\u001b[K\r\n\u001b[K\u001b[0m\u001b[1;1H')).toEqual([]);
    expect(await after(20, 6, `\u001b[44m${'x\u001b[K\r\n'.repeat(9)}\u001b[0m`)).toEqual([]);
    // A mark in a cell of its own, after a sequence, joins nothing before it.
    expect(await after(20, 6, 'a\u001b[m\u0301b')).toEqual([]);
    // The alternate screen's empty cells in the usual colors, though a program prints in others.
    expect(await after(20, 6, '\u001b[?1049h\u001b[Hvim\u001b[44m')).toEqual([]);
  });

  it('joins the marks that follow to the character before the cursor, and REP repeats it', async () => {
    expect(await after(20, 6, 'cafe', '\u0301 ok')).toEqual([]);
    expect(await after(20, 6, '\u001b[1;32m\u4e2d', '\u0301\u0302')).toEqual([]);
    expect(await after(20, 6, '\u2500', '\u001b[9b')).toEqual([]);
    expect(await after(20, 6, `a${'\u0301'.repeat(16)}`, '\u0301\u0302')).toEqual([]);
  });

  it('is the screen of a page that saw it all, over random output, and so is what follows', async () => {
    const cases = Number(process.env.FUZZ_CASES ?? 400);
    const failed: string[] = [];
    for (let seed = 1; seed <= cases && failed.length < 5; seed += 1) {
      const r = rng(seed * 7 + 1);
      const size = { cols: 8 + r.int(30), rows: 3 + r.int(10) };
      const steps = stream(seed, 160, size);
      const cutAt = r.int(steps.length + 1);
      const found = await check(steps, cutAt, size);
      if (found.length > 0) failed.push(`seed ${seed} (${size.cols}x${size.rows}, cut at ${cutAt}): ${found.slice(0, 3).join(' || ')}`);
    }
    expect(failed).toEqual([]);
  }, 600_000);
});
