// The guards every terminal of Pelican has (src/shared/terminal-guards.ts): output xterm throws on
// stops neither a page's screen nor the server's copy, and is drawn as xterm draws the rest; a
// count far past the screen does what a screen's worth does, at once; links and titles keep to a
// bound, however many a program prints.
import v8 from 'node:v8';
import vm from 'node:vm';

import xtermHeadless, { type Terminal } from '@xterm/headless';
import { describe, expect, it } from 'vitest';

import { guardOutput, LINKS } from '../src/shared/terminal-guards';

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
});
