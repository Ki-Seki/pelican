// The guards every terminal of Pelican has (src/shared/terminal-guards.ts): output xterm throws on
// stops neither a page's screen nor the server's copy, and is drawn as xterm draws the rest; a
// count far past the screen does what a screen's worth does, at once; links and titles keep to a
// bound, however many a program prints.
import v8 from 'node:v8';
import vm from 'node:vm';

import xtermHeadless, { type Terminal } from '@xterm/headless';
import { describe, expect, it } from 'vitest';

import { dropPendingOutput, guardOutput, LINKS, outputPieces, PIECE, screenWork, wideMost } from '../src/shared/terminal-guards';

const { Terminal: HeadlessTerminal } = xtermHeadless;

type Parsing = { _core: { _inputHandler: { parse: (data: string | Uint8Array, promiseResult?: boolean) => unknown } } };

/** A terminal as Pelican's are, or (plain) as xterm is, whose throws are caught and kept here rather than lost in its timer. */
function screen({ plain = false, cols = 40, rows = 10, links }: { plain?: boolean; cols?: number; rows?: number; links?: number } = {}) {
  const t = new HeadlessTerminal({ cols, rows, scrollback: 100, allowProposedApi: true, logLevel: 'off' });
  const thrown: string[] = [];
  if (plain) {
    const input = (t as unknown as Parsing)._core._inputHandler;
    const parse = input.parse.bind(input);
    input.parse = (data, promiseResult) => {
      try {
        return parse(data, promiseResult);
      } catch (error) {
        thrown.push((error as Error).message);
        return undefined;
      }
    };
  } else {
    guardOutput(t, (error) => thrown.push((error as Error).message), links === undefined ? {} : { links });
  }
  return { t, thrown };
}

type Links = { getLinkData(id: number): { id?: string; uri: string } | undefined };
type Inside = {
  _core: {
    _oscLinkService: Links & { _dataByLinkId: Map<number, unknown> };
    _inputHandler: { _windowTitle: string; _iconName: string; _curAttrData: { extended: { urlId: number } } };
    buffer: { markers: unknown[] };
  };
};
const inside = (t: Terminal) => (t as unknown as Inside)._core;
/** The link the cell at (x, y) of the screen is part of, as a page follows it, or none. */
const linkAt = (t: Terminal, x: number, y: number) => {
  const cell = t.buffer.active.getLine(y)?.getCell(x) as unknown as { extended?: { urlId: number }; bg: number } | undefined;
  const id = cell && cell.bg & 0x10000000 ? cell.extended?.urlId : undefined;
  return id ? inside(t)._oscLinkService.getLinkData(id) : undefined;
};

const write = (t: Terminal, text: string) => new Promise<void>((resolve) => t.write(text, resolve));

/** Output in the pieces it came in. */
async function feedIn(t: Terminal, pieces: string[]) {
  for (const piece of pieces) await write(t, piece);
}

function cells(t: Terminal) {
  const buffer = t.buffer.active;
  const rows: string[] = [];
  for (let y = 0; y < buffer.length; y += 1) {
    const line = buffer.getLine(y)!;
    rows.push(`${line.isWrapped ? '+' : ' '}${line.translateToString()}`);
  }
  return { rows, cursor: [buffer.cursorX, buffer.cursorY, buffer.baseY] };
}

/** A screen full of text, the cursor then where `to` puts it. */
const full = (rows: number, cols: number, to: string) => `${Array.from({ length: rows }, (_, y) => String.fromCharCode(0x41 + y).repeat(cols)).join('\r\n')}${to}`;

describe('the guards', () => {
  for (const [name, erase, all] of [['ED 1', '\u001b[1J', '\u001b[2J'], ['DECSED 1', '\u001b[?1J', '\u001b[?2J']]) {
    it(`let ${name} at the end of the last line of a screen with no scrollback erase all up to the cursor, where xterm throws`, async () => {
      // The cursor on the last cell, or past it (a character there would wrap).
      for (const to of ['\u001b[10;40H', '\u001b[10;1H'.concat('z'.repeat(40))]) {
        const plain = screen({ plain: true });
        await write(plain.t, `${full(10, 40, to)}${erase}`);
        expect(plain.thrown).toEqual(['Cannot set properties of undefined (setting \'isWrapped\')']);

        const guarded = screen();
        await write(guarded.t, `${full(10, 40, to)}${erase}`);
        // Up to the cursor is all the screen: as erasing all of it, the cursor staying where it is.
        const reference = screen({ plain: true });
        await write(reference.t, `${full(10, 40, to)}${all}`);
        expect(cells(guarded.t)).toEqual(cells(reference.t));
        expect(cells(guarded.t).rows.join('').trim()).toBe('');
        // And it takes what comes next.
        await write(guarded.t, 'next');
        await write(reference.t, 'next');
        expect(cells(guarded.t)).toEqual(cells(reference.t));
        expect(guarded.thrown).toEqual([]);
      }
    });
  }

  it('erase as xterm does wherever it does not throw: with scrollback, elsewhere on the screen, on the alternate screen', async () => {
    const cases = [
      // Scrollback: the line under the cursor is there, by xterm's count.
      `${full(14, 40, '\u001b[10;40H')}\u001b[1J`,
      `${full(10, 40, '\u001b[9;40H')}\u001b[1J`,
      `${full(10, 40, '\u001b[10;39H')}\u001b[1J`,
      `${full(10, 40, '\u001b[5;3H')}\u001b[1J\u001b[0J\u001b[2J`,
      `\u001b[?1049h${full(10, 40, '\u001b[10;40H')}\u001b[1J`,
      `\u001b[?1049h${full(10, 40, '\u001b[10;40H')}\u001b[?1J`,
    ];
    for (const output of cases) {
      const plain = screen({ plain: true });
      const guarded = screen();
      await write(plain.t, output);
      await write(guarded.t, output);
      expect(plain.thrown, JSON.stringify(output)).toEqual([]);
      expect(cells(guarded.t), JSON.stringify(output)).toEqual(cells(plain.t));
    }
  });

  it('let whatever else throws lose only the output it came with', async () => {
    const { t, thrown } = screen();
    t.parser.registerCsiHandler({ final: 'z' }, () => {
      throw new Error('broken');
    });
    await write(t, 'before\u001b[zlost');
    await write(t, ' after');
    expect(thrown).toEqual(['broken']);
    expect(cells(t).rows[0]!.trimEnd()).toBe(' before after');
  });

  describe('a count far past the screen', () => {
    const MOST = 2_147_483_647;
    const busy = (rows: number) => `${Array.from({ length: rows + 5 }, (_, y) => `line ${y}`).join('\r\n')}\u001b[2;${rows - 1}r`;
    // What a screen's worth does, as xterm does it, and the same count past anything there is.
    const cases: Array<[string, string, (rows: number, cols: number) => string, (rows: number, cols: number) => string]> = [
      ['scrolls up (SU)', 'S', (rows) => `\u001b[${rows}S`, () => `\u001b[${MOST}S`],
      ['scrolls down (SD)', 'T', (rows) => `\u001b[${rows}T`, () => `\u001b[${MOST}T`],
      ['inserts lines (IL)', 'L', (rows) => `\u001b[4;1H\u001b[${rows}L`, () => `\u001b[4;1H\u001b[${MOST}L`],
      ['deletes lines (DL)', 'M', (rows) => `\u001b[4;1H\u001b[${rows}M`, () => `\u001b[4;1H\u001b[${MOST}M`],
      ['moves by tab stops (CHT)', 'I', (_, cols) => `\u001b[3;5H\u001b[${cols}Ix`, () => `\u001b[3;5H\u001b[${MOST}Ix`],
      ['moves back by tab stops (CBT)', 'Z', (_, cols) => `\u001b[3;35H\u001b[${cols}Zx`, () => `\u001b[3;35H\u001b[${MOST}Zx`],
    ];
    for (const [name, , once, most] of cases) {
      it(`${name} as a screen's worth does, at once, where xterm would take minutes`, async () => {
        const plain = screen({ plain: true });
        const guarded = screen();
        await write(plain.t, `${busy(10)}${once(10, 40)}done`);
        const start = performance.now();
        await write(guarded.t, `${busy(10)}${most(10, 40)}done`);
        // Plain xterm takes a minute or more for each, a second gives room for a busy machine.
        expect(performance.now() - start).toBeLessThan(1000);
        expect(cells(guarded.t)).toEqual(cells(plain.t));
      });
    }

    it('repeats a character (REP) at most a line’s worth of times, wrapping as xterm does', async () => {
      const plain = screen({ plain: true });
      const guarded = screen();
      // Within a line's worth, as xterm does it; past it, a line's worth (xterm would print 2^31,
      // in a minute and 8 GB).
      for (const t of [plain.t, guarded.t]) await write(t, '\u2500\u001b[39b|\r\nab\u001b[40bc');
      expect(cells(guarded.t)).toEqual(cells(plain.t));
      const start = performance.now();
      await write(guarded.t, `\r\nz\u001b[${MOST}bEND`);
      expect(performance.now() - start).toBeLessThan(1000);
      await write(plain.t, '\r\nz\u001b[40bEND');
      expect(cells(guarded.t)).toEqual(cells(plain.t));
      expect(guarded.thrown).toEqual([]);
    });
  });

  describe('links (OSC 8)', () => {
    const link = (uri: string, text: string, id?: string) => `\u001b]8;${id === undefined ? '' : `id=${id}`};${uri}\u001b\\${text}\u001b]8;;\u001b\\`;

    it('are followed on a page as xterm follows them: by where they go, one with an id one link', async () => {
      const { t } = screen();
      await write(t, `${link('https://example.com/a', 'one')} ${link('https://example.com/b', 'two', 'x')}\r\n${link('https://example.com/b', 'more', 'x')}`);
      expect(linkAt(t, 0, 0)).toEqual({ uri: 'https://example.com/a' });
      expect(linkAt(t, 3, 0)).toBeUndefined();
      expect(linkAt(t, 4, 0)).toEqual({ id: 'x', uri: 'https://example.com/b' });
      // The same id and address, on another line: the same link.
      const id = (x: number, y: number) => (t.buffer.active.getLine(y)!.getCell(x) as unknown as { extended: { urlId: number } }).extended.urlId;
      expect(id(0, 1)).toBe(id(4, 0));
      // And none is open after its end.
      expect(inside(t)._inputHandler._curAttrData.extended.urlId).toBe(0);
    });

    it('are the latest 2048, however many a program prints over one line, where xterm keeps every one', async () => {
      let output = '';
      for (let n = 0; n < 20_000; n += 1) output += `${link(`https://example.com/${n}`, 'a')}\r`;
      const plain = screen({ plain: true });
      await write(plain.t, output);
      expect(inside(plain.t)._oscLinkService._dataByLinkId.size).toBe(20_000);
      expect(inside(plain.t).buffer.markers.length).toBe(20_000);
      const page = screen();
      await write(page.t, output);
      expect(inside(page.t).buffer.markers).toEqual([]);
      expect(linkAt(page.t, 0, 0)).toEqual({ uri: 'https://example.com/19999' });
      const links = inside(page.t)._oscLinkService;
      // The oldest are let go, their text staying as it is; the latest 2048 are kept.
      expect(links.getLinkData(20_000 - LINKS.kept)).toBeUndefined();
      expect(links.getLinkData(20_000 - LINKS.kept + 1)).toEqual({ uri: `https://example.com/${20_000 - LINKS.kept}` });
      // The server's copy keeps none.
      const copy = screen({ links: 0 });
      await write(copy.t, output);
      expect(linkAt(copy.t, 0, 0)).toBeUndefined();
      expect(inside(copy.t).buffer.markers).toEqual([]);
    });

    it('go to an address of at most 2083 characters, with an id of at most 250, as VTE has them; longer, the text is plain', async () => {
      const { t } = screen();
      await write(t, `${link(`https://e/${'a'.repeat(LINKS.uri - 10)}`, 'x')}${link(`https://e/${'a'.repeat(LINKS.uri - 9)}`, 'y')}${link('https://e/', 'z', 'i'.repeat(LINKS.id + 1))}`);
      expect(linkAt(t, 0, 0)?.uri).toHaveLength(LINKS.uri);
      expect(linkAt(t, 1, 0)).toBeUndefined();
      expect(linkAt(t, 2, 0)).toBeUndefined();
    });

    it('keep memory flat, however many come and however long the sequences they come in', async () => {
      v8.setFlagsFromString('--expose-gc');
      const gc = vm.runInNewContext('gc') as () => void;
      const heap = () => {
        gc();
        return process.memoryUsage().heapUsed;
      };
      const MB = 1024 * 1024;
      // 4096 links of 2000 characters each, 8 MB: xterm keeps them all.
      const long = (n: number) => `https://example.com/${n}/${'p'.repeat(1980)}`;
      const flood = (t: Terminal) => feedIn(t, Array.from({ length: 4096 }, (_, n) => `${link(long(n), 'a')}\r`));
      const plain = screen({ plain: true });
      let before = heap();
      await flood(plain.t);
      expect(heap() - before).toBeGreaterThan(8 * MB);
      const page = screen();
      before = heap();
      await flood(page.t);
      await flood(page.t);
      // At most 2048 kept, 4 MB of addresses, and nothing of the rest.
      expect(heap() - before).toBeLessThan(6 * MB);
      // A link's id is a part of the sequence it came in: kept as it is, it would keep all of it.
      before = heap();
      for (let n = 0; n < 64; n += 1) await write(page.t, `\u001b]8;id=${'i'.repeat(40)}${n}:${'q'.repeat(1_000_000)};https://e/${n}\u001b\\a\u001b]8;;\u001b\\\r`);
      expect(heap() - before).toBeLessThan(16 * MB);
      expect(linkAt(page.t, 0, 0)).toEqual({ id: `${'i'.repeat(40)}63`, uri: 'https://e/63' });
    }, 60_000);
  });

  it('keep no title, which Pelican never shows, however long', async () => {
    const { t } = screen();
    await write(t, `\u001b]0;${'t'.repeat(1_000_000)}\u0007\u001b]1;icon\u0007\u001b]2;title\u001b\\after`);
    expect(inside(t)._inputHandler._windowTitle).toBe('');
    expect(inside(t)._inputHandler._iconName).toBe('');
    expect(cells(t).rows[0]!.trimEnd()).toBe(' after');
  });

  it('do a reset (RIS) once in a run of them, also across two outputs, the screen as after one', async () => {
    const counted = (t: Terminal) => {
      const core = (t as unknown as { _core: { reset: () => void } })._core;
      const reset = core.reset.bind(core);
      const done = { resets: 0 };
      core.reset = () => {
        done.resets += 1;
        reset();
      };
      return done;
    };
    const { t } = screen();
    const resets = counted(t);
    await write(t, `\u001b[1;31mfirst${'\u001bc'.repeat(5000)}`);
    await write(t, `${'\u001bc'.repeat(3)}\u001b[?1049hsecond`);
    expect(resets.resets).toBe(1);
    const plain = screen({ plain: true });
    await write(plain.t, `\u001b[1;31mfirst${'\u001bc'.repeat(5)}`);
    await write(plain.t, `${'\u001bc'.repeat(3)}\u001b[?1049hsecond`);
    expect(cells(t)).toEqual(cells(plain.t));
    expect(t.buffer.active.type).toBe('alternate');
    // Something drawn between two, each is done: the screen is as xterm leaves it.
    await write(t, '\u001bcx\u001bcy\u001b\u001bcz');
    expect(resets.resets).toBe(4);
    expect(cells(t).rows[0]!.trimEnd()).toBe(' z');
    // In bytes as a page gets them, the same.
    const bytes = screen();
    const byteResets = counted(bytes.t);
    await new Promise<void>((resolve) => bytes.t.write(new TextEncoder().encode(`caf\u00e9${'\u001bc'.repeat(100)}ok`), resolve));
    expect(byteResets.resets).toBe(1);
    expect(cells(bytes.t).rows[0]!.trimEnd()).toBe(' ok');
  });

  it('let go of output not taken in yet, for a terminal closed or a screen taken away', async () => {
    const { t } = screen();
    // As xterm keeps it, for this to reach: the version is pinned, and this fails should it move.
    const writing = (t as unknown as { _core: { _writeBuffer: { _writeBuffer: unknown[]; _callbacks: unknown[] } } })._core._writeBuffer;
    expect(Array.isArray(writing._writeBuffer) && Array.isArray(writing._callbacks)).toBe(true);
    let called = 0;
    for (let n = 0; n < 50; n += 1) t.write(`line ${n}\r\n`, () => (called += 1));
    expect(writing._writeBuffer.length).toBe(50);
    dropPendingOutput(t);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(called).toBe(0);
    expect(cells(t).rows.join('').trim()).toBe('');
    // It takes output again as ever.
    await write(t, 'after');
    expect(cells(t).rows[0]!.trimEnd()).toBe(' after');
  });
});

describe('output in pieces', () => {
  /** Each piece's text, and how many sequences that work over the whole screen it holds. */
  const cut = (data: string, cols = 500, rows = 300) => outputPieces(data, cols, rows).map((piece) => [piece.data, piece.wide] as const);
  const wideIn = (data: string) => cut(data).reduce((sum, [, wide]) => sum + wide, 0);

  it('counts the sequences that work over the whole screen, and only those', () => {
    const wide = [
      '\u001bc', '\u001b#8', '\u001b[2J', '\u001b[J', '\u001b[?2J', '\u001b[300S', '\u001b[T', '\u001b[300L', '\u001b[5M', '\u001b[2^',
      "\u001b[500'}", "\u001b[3'~", '\u001b[?1049h', '\u001b[?47l', '\u001b[?1047h', '\u001b[?1;3h', '\u001b[?5h', '\u009b2J', '\u009b300S',
    ];
    for (const sequence of wide) expect(wideIn(`a${sequence}b`), JSON.stringify(sequence)).toBe(1);
    const light = [
      '\u001b[1;31m', '\u001b[H', '\u001b[2K', '\u001b[10@', '\u001b[500b', '\u001b[?25h', '\u001b[?2004h', '\u001b[1;24r', '\u001b[!p', '\u001bD', '\u001bM',
      '\u001b(B', '\u001b]0;a [2J title\u0007', '\u001bP$q2J\u001b\\', '\u001b]8;;https://e/?c\u001b\\', '\u001b[>4;1m', '\u001b[?1S', '\u001b[>0T', '\u0085', '\u008d',
    ];
    for (const sequence of light) expect(wideIn(`a${sequence}b`), JSON.stringify(sequence)).toBe(0);
    // A sequence cut off, or ended by another, counts where it starts; ESC in a string ends it.
    expect(wideIn('\u001b[3\u001b[2J')).toBe(1);
    expect(wideIn('\u001b]0;title\u001bc')).toBe(1);
    expect(wideIn('\u001b[2\u0018J')).toBe(0);
  });

  it('holds at most so many of them, as many as cost about the same work at the size, and at most 512 characters, cut between characters', () => {
    expect(wideMost(500, 300)).toBe(Math.floor(PIECE.work / screenWork(500, 300)));
    expect(wideMost(500, 300)).toBeGreaterThanOrEqual(1);
    expect(wideMost(80, 24)).toBeGreaterThan(50);
    const flood = 'x\u001bc'.repeat(1000);
    const pieces = cut(flood);
    expect(pieces.map(([data]) => data).join('')).toBe(flood);
    for (const [data, wide] of pieces) {
      expect(wide).toBeLessThanOrEqual(wideMost(500, 300));
      expect(data.length).toBeLessThanOrEqual(PIECE.characters);
    }
    // Text alone goes in pieces of 512, never cutting a character in two.
    const text = `${'a'.repeat(511)}\u{1f600}${'b'.repeat(600)}`;
    const parts = cut(text).map(([data]) => data);
    expect(parts.join('')).toBe(text);
    expect(parts[0]).toBe('a'.repeat(511));
    // So too in UTF-8, as a page gets it: no piece starts within a character.
    const bytes = new TextEncoder().encode(`${'\u00e9'.repeat(300)}\u001b[2J${'\u4e2d'.repeat(200)}`);
    const byteParts = outputPieces(bytes, 500, 300);
    expect(Buffer.concat(byteParts.map((piece) => piece.data))).toEqual(Buffer.from(bytes));
    for (const piece of byteParts) {
      expect(piece.data.length).toBeLessThanOrEqual(PIECE.characters);
      expect(piece.data[0]! & 0xc0).not.toBe(0x80);
    }
    expect(byteParts.reduce((sum, piece) => sum + piece.wide, 0)).toBe(1);
    // In UTF-8 a C1 introducer is two bytes, C2 9B; a 9B within a character is not one.
    expect(outputPieces(new TextEncoder().encode('\u009b2J'), 500, 300)[0]!.wide).toBe(1);
    expect(outputPieces(new TextEncoder().encode('\u201b2J'), 500, 300)[0]!.wide).toBe(0);
    // Nothing to cut: one piece, empty, for what waits on the output before it.
    expect(cut('')).toEqual([['', 0]]);
  });

  it('take a flood of them a little at a time, each piece soon done at 500 by 300', () => {
    /** How long a piece takes, the middle one of them (a pause to collect garbage aside), on a screen and its scrollback full of text, cut so. */
    const pieceTime = (flood: string, pieces: (data: string) => string[]) => {
      const t = new HeadlessTerminal({ cols: 500, rows: 300, scrollback: 2000, allowProposedApi: true, logLevel: 'off' });
      guardOutput(t);
      const now = (data: string) => (t as unknown as { _core: { writeSync: (data: string) => void } })._core.writeSync(data);
      now(`${'y'.repeat(499)}\r\n`.repeat(2300));
      const times: number[] = [];
      for (const data of pieces(flood)) {
        const start = performance.now();
        now(data);
        times.push(performance.now() - start);
      }
      t.dispose();
      return times.sort((a, b) => a - b)[Math.floor(times.length / 2)]!;
    };
    for (const sequence of ['\u001b[300S', 'x\u001bc', '\u001b#8', "\u001b[500'}"]) {
      const flood = sequence.repeat(Math.ceil(2048 / sequence.length));
      const bounded = pieceTime(flood, (data) => outputPieces(data, 500, 300).map((piece) => piece.data));
      const by512 = pieceTime(flood, (data) => data.match(/[^]{1,512}/g)!);
      // Pieces of 512 characters, as before: 30 to 100 ms each here. Now a few; as busy as the
      // computer is, a fraction of that.
      expect(bounded, JSON.stringify(sequence)).toBeLessThan(by512 / 3);
    }
  }, 60_000);
});
