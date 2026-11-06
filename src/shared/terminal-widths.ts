/**
 * How wide each character is drawn in a terminal, on the pages (xterm.js) and in the server's copy
 * of the screen (xterm's headless terminal) alike: Unicode 11's widths (@xterm/addon-unicode11), so
 * an emoji takes two cells, with one bound. xterm adds a character of no width (a combining mark, a
 * joiner, a variation selector) to the cell before it, with no limit, and goes on doing so across
 * what it ignores (a DEL, U+009C, a sequence such as `ESC [ 1 < m`), none of which starts a cell:
 * one letter could take millions, in the copy, in the screen a page gets, and in a phone's page.
 * Here a cell takes at most MARKS_PER_CHARACTER of them, and the next starts a cell of its own.
 *
 * The count is kept where xterm asks whether a character joins the cell before: it hands the
 * widths, with each character, what they said of the one before it, until something starts a cell
 * afresh, and the bits above the width are the widths' own. A character joins only when they say
 * so, from that, so no cell takes more, whatever comes between the marks. xterm keeps those bits
 * to itself; the version is pinned, and test/terminal-widths.test.ts fails should they move.
 */

/** Marks a character keeps: more than any script stacks on one (Zalgo text stacks thousands). */
export const MARKS_PER_CHARACTER = 16;

/** xterm's IUnicodeVersionProvider, as @xterm/xterm and @xterm/headless both declare it. */
export type Widths = {
  readonly version: string;
  wcwidth(codepoint: number): 0 | 1 | 2;
  charProperties(codepoint: number, preceding: number): number;
};

/** What xterm reads of a character's properties: whether it joins the cell before, its width, and above them the widths' own. */
const JOINS = 1;
const WIDTH_SHIFT = 1;
const STATE_SHIFT = 3;

/** A cell of its own, one column wide, with nothing joined to it yet. */
const ALONE = 1 << WIDTH_SHIFT;

/**
 * The widths of `base`, with at most MARKS_PER_CHARACTER characters joined to a cell. One more
 * starts a cell one column wide, and those after it join that one. So does a character of no width
 * with nothing to join (the first, or one after a control character or a sequence): xterm would
 * move on a column all the same, but leave a cell of no width, which it draws as nothing and leaves
 * out of the screen a page gets, so that page would draw what follows a column to the left.
 */
export function boundedWidths(base: Widths): Widths {
  return {
    version: `${base.version}-bounded`,
    wcwidth: (codepoint) => base.wcwidth(codepoint),
    charProperties(codepoint, preceding) {
      const properties = base.charProperties(codepoint, preceding);
      if (properties & JOINS) {
        const joined = (preceding >>> STATE_SHIFT) + 1;
        return joined > MARKS_PER_CHARACTER ? ALONE : (properties & ((1 << STATE_SHIFT) - 1)) | (joined << STATE_SHIFT);
      }
      return ((properties >>> WIDTH_SHIFT) & 3) === 0 ? ALONE : properties;
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
