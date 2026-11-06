// The guards every terminal of Pelican has (src/shared/terminal-guards.ts): output xterm throws on
// stops neither a page's screen nor the server's copy, and is drawn as xterm draws the rest.
import xtermHeadless, { type Terminal } from '@xterm/headless';
import { describe, expect, it } from 'vitest';

import { guardOutput } from '../src/shared/terminal-guards';

const { Terminal: HeadlessTerminal } = xtermHeadless;

type Parsing = { _core: { _inputHandler: { parse: (data: string | Uint8Array, promiseResult?: boolean) => unknown } } };

/** A terminal as Pelican's are, or (plain) as xterm is, whose throws are caught and kept here rather than lost in its timer. */
function screen({ plain = false, cols = 40, rows = 10 } = {}) {
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
    guardOutput(t, (error) => thrown.push((error as Error).message));
  }
  return { t, thrown };
}

const write = (t: Terminal, text: string) => new Promise<void>((resolve) => t.write(text, resolve));

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
});
