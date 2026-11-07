// The widths every terminal of Pelican draws with (src/shared/terminal-widths.ts): Unicode 11's,
// with at most 11 marks joined to a cell and 14 UTF-16 code units in it, whatever a program puts
// between them, so a cell stays a small string; and ordinary text, in any script, emoji and flags
// of seven code points included, drawn as a plain xterm draws it.
import v8 from 'node:v8';
import vm from 'node:vm';

import serializeAddon from '@xterm/addon-serialize';
import unicode11Addon from '@xterm/addon-unicode11';
import xtermHeadless, { type Terminal } from '@xterm/headless';
import { describe, expect, it } from 'vitest';

import { boundedWidths, loadWidths, MARKS_PER_CHARACTER, UNITS_PER_CELL, type Widths } from '../src/shared/terminal-widths';

const { Terminal: HeadlessTerminal } = xtermHeadless;
const { SerializeAddon } = serializeAddon;
const { Unicode11Addon } = unicode11Addon;

/** A terminal as Pelican's are, or (plain) one with the Unicode 11 widths alone. */
function screen({ plain = false, cols = 80, rows = 24 } = {}) {
  const t = new HeadlessTerminal({ cols, rows, scrollback: 2000, allowProposedApi: true, logLevel: 'off' });
  if (plain) {
    t.loadAddon(new Unicode11Addon());
    t.unicode.activeVersion = '11';
  } else {
    loadWidths(t, Unicode11Addon);
  }
  const serializer = new SerializeAddon();
  t.loadAddon(serializer);
  return { t, serializer };
}

const write = (t: Terminal, text: string) => new Promise<void>((resolve) => t.write(text, resolve));

/** Output in the pieces a PTY hands it over in. */
async function feed(t: Terminal, text: string, size = 4096) {
  for (let at = 0; at < text.length; at += size) await write(t, text.slice(at, at + size));
}

/** Every cell of the buffer in use: what it holds and how wide it is, row by row, and the cursor. */
function cells(t: Terminal) {
  const buffer = t.buffer.active;
  const rows: string[][] = [];
  for (let y = 0; y < buffer.length; y += 1) {
    const line = buffer.getLine(y)!;
    const row: string[] = [];
    for (let x = 0; x < line.length; x += 1) {
      const cell = line.getCell(x)!;
      row.push(`${cell.getChars()}/${cell.getWidth()}`);
    }
    rows.push(row);
  }
  return { rows, cursor: [buffer.cursorX, buffer.cursorY, buffer.baseY] };
}

/** The most code points any cell holds. */
function heaviest(t: Terminal): number {
  const buffer = t.buffer.active;
  let most = 0;
  for (let y = 0; y < buffer.length; y += 1) {
    const line = buffer.getLine(y)!;
    for (let x = 0; x < line.length; x += 1) most = Math.max(most, [...line.getCell(x)!.getChars()].length);
  }
  return most;
}

const marks = (n: number, mark = '\u0301') => mark.repeat(n);

/** The most marks a cell takes, and the most it holds with its letter. */
const MARKS = MARKS_PER_CHARACTER;
const FULL = MARKS + 1;

/** What a program can put between marks: every control, and every kind of sequence, also one cut in two. */
const BETWEEN: Record<string, string> = {
  ...Object.fromEntries(Array.from({ length: 32 }, (_, code) => [`C0 ${code.toString(16)}`, String.fromCharCode(code)]).filter(([, c]) => c !== '\u001b' && c !== '\u0018' && c !== '\u001a')),
  'CAN and SUB, which end a sequence': '\u0018\u001a',
  'ESC alone, before a mark': '\u001b',
  DEL: '\u007f',
  ...Object.fromEntries(Array.from({ length: 32 }, (_, code) => [`C1 ${(0x80 + code).toString(16)}`, String.fromCharCode(0x80 + code)])
    // A C1 that opens a string or a sequence is closed again, as ESC's do below.
    .map(([name, c]) => [name, ['\u0090', '\u0098', '\u009d', '\u009e', '\u009f'].includes(c!) ? `${c}x\u009c` : c === '\u009b' ? `${c}m` : c])),
  'ESC 7 (save the cursor)': '\u001b7',
  'ESC with a final xterm does not know': '\u001b~',
  'ESC with an intermediate': '\u001b(B',
  SGR: '\u001b[m',
  'CSI with a private marker out of place (ignored)': '\u001b[1<m',
  'CSI xterm does not know': '\u001b[5;5z',
  'CSI with more parameters than it takes': `\u001b[${'1;'.repeat(40)}m`,
  'OSC ended by BEL': '\u001b]0;title\u0007',
  'OSC ended by ST': '\u001b]2;title\u001b\\',
  'OSC xterm does not know': '\u001b]777;notify;a;b\u0007',
  'DCS string': '\u001bP1$r0m\u001b\\',
  'APC string': '\u001b_payload\u001b\\',
  'PM string': '\u001b^payload\u001b\\',
  'SOS string': '\u001bXpayload\u001b\\',
};

describe('the widths', () => {
  it('give a cell at most 11 marks, whatever a program puts between them', async () => {
    for (const [name, between] of Object.entries(BETWEEN)) {
      const { t } = screen();
      await feed(t, `a${`${marks(MARKS)}${between}`.repeat(200)}`);
      expect(heaviest(t), name).toBeLessThanOrEqual(FULL);
    }
  });

  it('give a cell at most 11 marks across a sequence cut in two between pieces of output', async () => {
    const { t } = screen();
    for (let n = 0; n < 200; n += 1) {
      await write(t, `${n === 0 ? 'a' : ''}${marks(MARKS)}\u001b[`);
      await write(t, '1<m');
    }
    expect(heaviest(t)).toBe(FULL);
  });

  it('give a cell at most 14 code units: six marks past U+FFFF, two units each, on a letter', async () => {
    // Variation selectors of the supplement (U+E0100…), which a program can print without end.
    const astral = (n: number) => '\u{e0100}'.repeat(n);
    const { t } = screen();
    await write(t, `a${astral(20)}b\r\n\u{1f600}${astral(7)}c`);
    const rows = cells(t).rows;
    // 1 + 2 * 6 = 13 units; a seventh would make 15: it starts a cell of its own, which takes six more.
    expect(rows[0]!.slice(0, 5)).toEqual([`a${astral(6)}/1`, `${astral(7)}/1`, `${astral(7)}/1`, 'b/1', '/1']);
    // A character of two units takes six too: 2 + 12 = 14.
    expect(rows[1]!.slice(0, 4)).toEqual([`\u{1f600}${astral(6)}/2`, '/0', `${astral(1)}/1`, 'c/1']);
    expect(Math.max(...rows.flat().map((cell) => cell.slice(0, cell.lastIndexOf('/')).length))).toBeLessThanOrEqual(UNITS_PER_CELL);
  });

  it('keep the screen, and the screen a page gets, as large as its cells, however many marks come', async () => {
    // Two million marks in runs of 11, a DEL after each; and one run of two million.
    for (const output of [`a${`${marks(MARKS)}\u007f`.repeat(Math.ceil(2_000_000 / MARKS))}`, `a${marks(2_000_000)}`]) {
      const { t, serializer } = screen({ cols: 20, rows: 5 });
      await feed(t, output, 64 * 1024);
      expect(heaviest(t)).toBe(FULL);
      // The lines it keeps, each of 20 cells of at most 12 code points: no more, however much came.
      expect(serializer.serialize({ scrollback: 2000 }).length).toBeLessThanOrEqual((2000 + 5) * (20 * FULL + 20));
      // A plain xterm puts all of them on the letter.
      const plain = screen({ plain: true, cols: 20, rows: 5 });
      await feed(plain.t, output.slice(0, 200_000), 64 * 1024);
      expect(heaviest(plain.t)).toBeGreaterThan(100_000);
    }
  }, 60_000);

  it('keep memory flat however many marks come, whatever is between them, where a plain xterm’s grows with them', async () => {
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc') as () => void;
    const grows = async (t: Terminal, run: string, first: number, then: number) => {
      await feed(t, `a${run.repeat(first)}`, 64 * 1024);
      gc();
      const before = process.memoryUsage().heapUsed;
      await feed(t, run.repeat(then), 64 * 1024);
      gc();
      return process.memoryUsage().heapUsed - before;
    };
    const MB = 1024 * 1024;
    for (const between of ['', '\u007f', '\u009c', '\u001b[1<m', '\u001b_payload\u001b\\']) {
      // A million marks fill the lines a screen of 20 columns keeps; three million more add nothing.
      expect(await grows(screen({ cols: 20, rows: 5 }).t, `${marks(16)}${between}`, 62_500, 187_500), JSON.stringify(between)).toBeLessThan(4 * MB);
    }
    expect(await grows(screen({ plain: true, cols: 20, rows: 5 }).t, `${marks(16)}\u007f`, 15_000, 45_000)).toBeGreaterThan(16 * MB);
  }, 120_000);

  it('keep each cell one small string, of marks or of what lies past U+FFFF, where 16 marks made each a rope', async () => {
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc') as () => void;
    const cols = 100;
    const rows = 50;
    /** The heap a screen takes, by the cell, once every line it keeps is full of `cell`, column after column. */
    const perCell = async (plain: boolean, cell: (x: number) => string) => {
      gc();
      const before = process.memoryUsage().heapUsed;
      const { t } = screen({ plain, cols, rows });
      const line = `${Array.from({ length: cols }, (_, x) => cell(x)).join('')}\r\n`;
      for (let y = 0; y < rows + 2000; y += 1) await write(t, line);
      gc();
      const used = process.memoryUsage().heapUsed - before;
      expect(t.buffer.active.length).toBe(rows + 2000);
      return used / ((rows + 2000) * cols);
    };
    const letter = (x: number) => String.fromCharCode(0x61 + (x % 26));
    // Zalgo: each letter with as many marks as a cell takes, each mark another.
    const zalgo = (n: number) => (x: number) => letter(x) + Array.from({ length: n }, (_, k) => String.fromCharCode(0x300 + ((x + k) % 0x70))).join('');
    const astral = (x: number) => letter(x) + Array.from({ length: 6 }, (_, k) => String.fromCodePoint(0xe0100 + ((x + k) % 0xf0))).join('');
    // About 60 bytes a cell, the string and xterm's own: a 500x300 screen of Zalgo, 50 MB.
    expect(await perCell(false, zalgo(MARKS))).toBeLessThan(90);
    expect(await perCell(false, astral)).toBeLessThan(90);
    // 16 marks a cell, as before: hundreds of bytes each, 362 MB at 500x300.
    expect(await perCell(true, zalgo(16))).toBeGreaterThan(150);
  }, 120_000);

  it('start a cell of its own with the 12th mark, one column wide, which takes the next 11', async () => {
    const { t } = screen();
    await write(t, `a${marks(30)}b\r\n\u4e2d${marks(12, '\u0300')}c\r\na${marks(11)}\u007f${marks(3)}\u009c${marks(10)}d`);
    const rows = cells(t).rows;
    expect(rows[0]!.slice(0, 4)).toEqual([`a${marks(11)}/1`, `${marks(12)}/1`, `${marks(7)}/1`, 'b/1']);
    // A wide character keeps its two cells, then the one too many starts one.
    expect(rows[1]!.slice(0, 4)).toEqual([`\u4e2d${marks(11, '\u0300')}/2`, '/0', '\u0300/1', 'c/1']);
    expect(rows[2]!.slice(0, 4)).toEqual([`a${marks(11)}/1`, `${marks(12)}/1`, `${marks(1)}/1`, 'd/1']);
  });

  it('are Unicode 11’s for every character, and join as they do up to 11, after any character', () => {
    let unicode11: Widths | undefined;
    new Unicode11Addon().activate({ unicode: { register: (widths: Widths) => (unicode11 = widths) } } as never);
    const bounded = boundedWidths(unicode11!);
    // What xterm hands back of the character before: none, one 1 or 2 wide, alone or with 1 or 10
    // marks, and the code units of its cell (bits 8 and up).
    const before = [0, (1 << 1) | (1 << 8), (2 << 1) | (2 << 8), (1 << 1) | 1 | (1 << 3) | (2 << 8), (2 << 1) | 1 | (10 << 3) | (11 << 8)];
    const differ: string[] = [];
    for (let codepoint = 0; codepoint <= 0x10ffff; codepoint += 1) {
      if (codepoint >= 0xd800 && codepoint <= 0xdfff) continue;
      if (bounded.wcwidth(codepoint) !== unicode11!.wcwidth(codepoint)) differ.push(`U+${codepoint.toString(16)}`);
      for (const preceding of before) {
        // The joins and widths are Unicode 11's; the bits above them, the count, are the widths' own.
        const own = unicode11!.charProperties(codepoint, preceding & 7) & 7;
        // But one of no width with nothing to join: a cell one column wide, not a cell of no width.
        const expected = own === 0 ? 1 << 1 : own;
        if ((bounded.charProperties(codepoint, preceding) & 7) !== expected) differ.push(`U+${codepoint.toString(16)} after ${preceding}`);
      }
    }
    expect(differ).toEqual([]);
    expect(bounded.charProperties(0x301, 0) & 7).toBe(1 << 1);
    expect(unicode11!.charProperties(0x301, 0)).toBe(0);
    // With 11 on the cell, the next that would join starts a cell, one column wide; one that would not, as ever.
    const full = (1 << 1) | 1 | (11 << 3) | (12 << 8);
    expect(bounded.charProperties(0x301, full) & 0xff).toBe(1 << 1);
    expect(bounded.charProperties(0x61, full) & 7).toBe(unicode11!.charProperties(0x61, full) & 7);
    expect(bounded.charProperties(0x301, bounded.charProperties(0x301, full)) & 0xff).toBe((1 << 1) | 1 | (1 << 3));
    // So does one that would make the cell longer than 14 code units, with room for marks left.
    const long = (1 << 1) | 1 | (6 << 3) | (13 << 8);
    expect(bounded.charProperties(0xe0100, long) & 0xff).toBe(1 << 1);
    expect(bounded.charProperties(0x301, long) & 0xff).toBe((1 << 1) | 1 | (7 << 3));
    expect(bounded.charProperties(0xe0100, (1 << 1) | 1 | (5 << 3) | (12 << 8)) & 0xff).toBe((1 << 1) | 1 | (6 << 3));
  }, 30_000);

  it('draw text as a plain xterm does: accents, Indic, Thai, Hangul, Arabic, Hebrew, emoji with joiners, flags, Zalgo of 11', async () => {
    const text = [
      'cafe\u0301 Vie\u0323\u0302t',
      // Devanagari, Bengali, Tamil
      '\u0915\u094d\u0937\u0924\u094d\u0930\u093f\u092f \u09ac\u09be\u0982\u09b2\u09be \u0ba4\u0bae\u0bbf\u0bb4\u0bcd',
      // Thai, with its vowels and tone marks above and below
      '\u0e2a\u0e27\u0e31\u0e2a\u0e14\u0e35\u0e04\u0e23\u0e31\u0e1a \u0e19\u0e49\u0e33\u0e1c\u0e36\u0e49\u0e07',
      // Hangul from conjoining jamo, and as syllables
      '\u1100\u1161\u11a8 \ud55c\uae00',
      // Arabic with its vowel marks, Hebrew with points
      '\u0628\u0650\u0633\u0652\u0645\u0650 \u05e9\u05b8\u05c1\u05dc\u05d5\u05b9\u05dd',
      // A family, a rainbow flag, a skin tone, a country's flag, a keycap, a text-style heart
      '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466} \u{1f3f3}\ufe0f\u200d\u{1f308} \u{1f44d}\u{1f3fd} \u{1f1ef}\u{1f1f5} 1\ufe0f\u20e3 \u2764\ufe0e',
      // The flags of England, Scotland and Wales: a black flag and six tags, seven code points in one cell
      '\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f} \u{1f3f4}\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f} \u{1f3f4}\u{e0067}\u{e0062}\u{e0077}\u{e006c}\u{e0073}\u{e007f}',
      // A family with skin tones, people holding hands, a transgender flag
      '\u{1f468}\u{1f3fb}\u200d\u{1f469}\u{1f3fd}\u200d\u{1f467}\u{1f3ff}\u200d\u{1f466}\u{1f3fe} \u{1f9d1}\u{1f3fd}\u200d\u{1f91d}\u200d\u{1f9d1}\u{1f3ff} \u{1f3f3}\ufe0f\u200d\u26a7\ufe0f',
      // Zalgo, 11 marks on each letter, above, through and below
      [...'zalgo'].map((letter) => `${letter}\u0300\u0301\u0302\u0303\u0334\u0335\u0336\u0316\u0317\u0318\u0319`).join(''),
      '\u4e2d\u6587 \u65e5\u672c\u8a9e \u{20000}',
    ].join('\r\n');
    const bounded = screen();
    const plain = screen({ plain: true });
    await write(bounded.t, text);
    await write(plain.t, text);
    expect(cells(bounded.t)).toEqual(cells(plain.t));
    // The flags are each one cell of seven code points, as a plain xterm draws them.
    expect(cells(bounded.t).rows[6]![0]).toBe('\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}/2');
  });

  it('draw as a plain xterm does whatever joins no more than 11 to a cell, of at most 14 code units', async () => {
    // Random text of every kind of character: letters, wide ones, marks and joiners, controls.
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return seed / 2 ** 32;
    };
    let unicode11: Widths | undefined;
    new Unicode11Addon().activate({ unicode: { register: (widths: Widths) => (unicode11 = widths) } } as never);
    const pick = (width: number) => {
      for (;;) {
        const codepoint = random() < 0.7 ? 0x20 + Math.floor(random() * 0x3000) : Math.floor(random() * 0x30000);
        if (codepoint < 0x20 || (codepoint >= 0x7f && codepoint < 0xa0)) continue;
        if (codepoint >= 0xd800 && codepoint <= 0xdfff) continue;
        if (unicode11!.wcwidth(codepoint) === width) return String.fromCodePoint(codepoint);
      }
    };
    let text = '';
    for (let n = 0; n < 20_000; n += 1) {
      const r = random();
      if (r < 0.05) text += ['\r\n', '\t', '\u001b[m', '\u001b[1;31m', '\b'][Math.floor(random() * 5)];
      else {
        // A character and up to 11 that join it, as long as the cell stays within 14 code units.
        let cell = pick(r < 0.2 ? 2 : 1);
        for (let n = Math.floor(random() * random() * (MARKS + 1)); n > 0; n -= 1) {
          const mark = pick(0);
          if (cell.length + mark.length > UNITS_PER_CELL) break;
          cell += mark;
        }
        text += cell;
      }
    }
    const bounded = screen({ cols: 50 });
    const plain = screen({ plain: true, cols: 50 });
    await feed(bounded.t, text);
    await feed(plain.t, text);
    expect(cells(bounded.t)).toEqual(cells(plain.t));
  }, 30_000);
});
