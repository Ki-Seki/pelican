/**
 * How wide each character is drawn in a terminal, on the pages (xterm.js) and in the server's copy
 * of the screen (xterm's headless terminal) alike: Unicode 11's widths (@xterm/addon-unicode11), so
 * an emoji takes two cells, with one bound. xterm adds a character of no width (a combining mark, a
 * joiner, a variation selector) to the cell before it, with no limit, and goes on doing so across
 * what it ignores (a DEL, U+009C, a sequence such as `ESC [ 1 < m`), none of which starts a cell:
 * one letter could take millions, in the copy, in the screen a page gets, and in a phone's page.
 * Here a cell takes at most MARKS_PER_CHARACTER of them, and at most UNITS_PER_CELL UTF-16 code
 * units in all, and the next starts a cell of its own.
 *
 * The count is kept where xterm asks whether a character joins the cell before: it hands the
 * widths, with each character, what they said of the one before it, until something starts a cell
 * afresh, and the bits above the width are the widths' own. A character joins only when they say
 * so, from that, so no cell takes more, whatever comes between the marks. xterm keeps those bits
 * to itself; the version is pinned, and test/terminal-widths.test.ts fails should they move.
 */

/**
 * Marks a character keeps: more than any script stacks on one (Zalgo text stacks thousands), and
 * few enough that a cell stays one flat string. xterm adds each mark to its cell's string, and V8
 * keeps a string of fewer than 13 code units as one, of about 40 bytes, but makes each mark joined
 * past that a node of a rope: a 500x300 terminal with its 2,000 lines of scrollback, Zalgo
 * everywhere, takes 50 MB with 11 marks a cell, 362 MB with 16.
 */
export const MARKS_PER_CHARACTER = 11;

/**
 * The most UTF-16 code units a cell holds, its character's and its marks': those past U+FFFF take
 * two each (a variation selector of the supplement, a flag's tags), and a cell of 11 of them would
 * be a rope again (419 MB at 500x300). 14 is the longest emoji drawn in one cell: a flag of England,
 * Scotland or Wales, a black flag and six tags, seven code points, which so stays whole.
 */
export const UNITS_PER_CELL = 14;

/** xterm's IUnicodeVersionProvider, as @xterm/xterm and @xterm/headless both declare it. */
export type Widths = {
  readonly version: string;
  wcwidth(codepoint: number): 0 | 1 | 2;
  charProperties(codepoint: number, preceding: number): number;
};

/**
 * What xterm reads of a character's properties: whether it joins the cell before, its width, and
 * above them the widths' own: here how many characters joined the cell, and its code units.
 */
const JOINS = 1;
const WIDTH_SHIFT = 1;
const STATE_SHIFT = 3;
const UNITS_SHIFT = 8;
const COUNT = 0x1f;
const XTERMS = (1 << STATE_SHIFT) - 1;

/** A cell of its own, one column wide, with nothing joined to it yet, of `units` code units. */
const alone = (units: number) => (1 << WIDTH_SHIFT) | (units << UNITS_SHIFT);

/**
 * The widths of `base`, with at most MARKS_PER_CHARACTER characters joined to a cell, and at most
 * UNITS_PER_CELL code units in it. One more starts a cell one column wide, and those after it join
 * that one. So does a character of no width with nothing to join (the first, or one after a
 * control character or a sequence): xterm would move on a column all the same, but leave a cell of
 * no width, which it draws as nothing and leaves out of the screen a page gets, so that page would
 * draw what follows a column to the left.
 */
export function boundedWidths(base: Widths): Widths {
  return {
    version: `${base.version}-bounded`,
    wcwidth: (codepoint) => base.wcwidth(codepoint),
    charProperties(codepoint, preceding) {
      const properties = base.charProperties(codepoint, preceding);
      const units = codepoint > 0xffff ? 2 : 1;
      if (properties & JOINS) {
        const joined = ((preceding >>> STATE_SHIFT) & COUNT) + 1;
        const length = ((preceding >>> UNITS_SHIFT) & COUNT) + units;
        if (joined > MARKS_PER_CHARACTER || length > UNITS_PER_CELL) return alone(units);
        return (properties & XTERMS) | (joined << STATE_SHIFT) | (length << UNITS_SHIFT);
      }
      return ((properties >>> WIDTH_SHIFT) & 3) === 0 ? alone(units) : (properties & XTERMS) | (units << UNITS_SHIFT);
    },
  };
}

/** A terminal, xterm.js's or the headless one: what the widths are set through. */
type Unicode = { unicode: { register(widths: Widths): void; activeVersion: string } };

/**
 * Gives `terminal` the widths every terminal of Pelican draws with: Unicode 11's, from the addon
 * (`Unicode11Addon` of @xterm/addon-unicode11, whose `activate` hands them to the terminal it is
 * given), bounded.
 */
export function loadWidths(terminal: Unicode, Unicode11Addon: new () => { activate(terminal: never): void }): void {
  let unicode11: Widths | undefined;
  const taker: Unicode = {
    unicode: {
      register: (widths) => {
        unicode11 = widths;
      },
      activeVersion: '',
    },
  };
  new Unicode11Addon().activate(taker as never);
  if (!unicode11) throw new Error('The Unicode 11 addon gave no widths');
  const widths = boundedWidths(unicode11);
  terminal.unicode.register(widths);
  terminal.unicode.activeVersion = widths.version;
}
