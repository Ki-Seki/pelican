/**
 * Markdown for Export as Markdown. Words that read as text, whatever they hold; and a reply that
 * reads as the conversation shows it and keeps to itself: its headings under the speakers', its
 * HTML as text, as the conversation shows it, a picture as a link to it, which the conversation
 * never loads either, and nothing it leaves open taking what comes after it.
 */

/** Backticks around code, more of them than any run inside it, so nothing in it ends the code. */
export function fence(code: string, fewest: number): string {
  let longest = 0;
  for (const run of code.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  return '`'.repeat(Math.max(fewest, longest + 1));
}
export const inlineCode = (code: string) => (code.includes('`') ? `${fence(code, 1)} ${code} ${fence(code, 1)}` : `\`${code}\``);
export const codeBlock = (code: string) => `${fence(code, 3)}\n${code}\n${fence(code, 3)}`;
/** A command as typed: inline, or a block of its own when it has more lines, which would end inline code. */
export const asCode = (code: string) => (/[\r\n]/.test(code) ? codeBlock(code) : inlineCode(code));

/**
 * Where a Markdown reader with GitHub's extensions makes a link of bare text: an address that
 * starts with http://, https://, ftp:// (GitHub's and VS Code's preview) or www., or an email.
 * It does that to the text an escape leaves, so only code keeps one text. An email is looked for
 * only where a run of the characters it is made of starts, so a long run of them is read once.
 */
const BARE_LINK = /(?<![\p{L}\p{N}])(?:(?:(?:https?|ftp):\/\/|www\.)[^\s<`]*[^\s<`.,:;!?"')\]}*_~]|(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+)/giu;
/**
 * Each character that could make Markdown of text, escaped; a `<` as `&lt;`, since a bare link
 * just before it takes a backslash into its address, which leaves the `<` to start HTML.
 */
const escaped = (text: string) => text.replace(/[\\`*_[\]<>&~|]/g, (c) => (c === '<' ? '&lt;' : `\\${c}`));

/** Text of a line as it reads, none of it taken as Markdown: what would be escaped, and links as code. */
export function inlineText(text: string): string {
  let out = '';
  let at = 0;
  for (const link of text.matchAll(BARE_LINK)) {
    out += escaped(text.slice(at, link.index)) + inlineCode(link[0]);
    at = link.index + link[0].length;
  }
  return out + escaped(text.slice(at));
}

/**
 * A line of words as it reads: its indentation kept as spaces that stay, and nothing at its start
 * taken for a heading, a list, a quote, a rule or code.
 */
export function textLine(line: string): string {
  const [, indent = '', rest = ''] = /^([ \t]*)(.*)$/s.exec(line)!;
  const body = inlineText(rest).replace(/^(?:[#+=-]|\d+(?=[.)]))/, (start) => (/\d/.test(start) ? `${start}\\` : `\\${start}`));
  return `${indent.replace(/\t/g, '    ').replace(/ /g, '&nbsp;')}${body}`;
}

/** Words as the conversation shows them, read as text: a line for each line, a blank line between paragraphs. */
export function asText(text: string): string {
  const paragraphs: string[][] = [[]];
  for (const line of text.split(/\r\n?|\n/)) {
    if (line.trim()) paragraphs.at(-1)!.push(textLine(line.trimEnd()));
    else if (paragraphs.at(-1)!.length > 0) paragraphs.push([]);
  }
  return paragraphs.filter((lines) => lines.length > 0).map((lines) => lines.join('\\\n')).join('\n\n');
}

// A reply, read line by line as the CommonMark spec's own reader reads it (commonmark.js), with
// GitHub's footnotes and tables as the conversation's reader (micromark) has them, then the words
// of each block. Where readers part ways on a reply (that one, micromark under the conversation's
// react-markdown, and markdown-it in VS Code's preview), it is written so that they read it alike:
// indented code fenced, a blank line before a list item they would read apart, a footnote's words
// where only readers with footnotes take them for its words. test/export-markdown.test.ts tries
// thousands.
//
// A link's definition and a footnote belong to the whole document they are in, and the export is
// one document of many replies, as the conversation is not: there, each reply is read on its own.
// So no definition is kept: a link that uses one is written with its address, as the reader reads
// it, and the definition goes, as it shows nothing. A footnote is kept, as only a footnote reads as
// one, under a label of the reply's own; a `[^` that calls none of the reply's is written escaped.

/** A list item's marker: its kind, where it stands and how far in the item's lines go on. */
interface ListData {
  ordered: boolean;
  char: string;
  offset: number;
  padding: number;
}

/** A line of a paragraph, a table, code or HTML: where it goes in the reply written out, what stands before its words, and its words. */
interface Line {
  at: number;
  prefix: string;
  text: string;
  /** A lazy line, going on a paragraph whose containers it left. */
  lazy?: boolean;
  /** A line going on a paragraph from 4 columns in or more, where no table's head starts. */
  indented?: boolean;
  /** A lazy line written inside the containers it left, whose start may start a block there: see goesOn. */
  moved?: boolean;
}

/**
 * A paragraph: how many of its lines are links' definitions once words are known to follow them,
 * whether it became a heading, and the blank line that would stand before the item it starts
 * where that cuts a paragraph short.
 */
interface Paragraph {
  kind: 'paragraph';
  lines: Line[];
  taken?: number;
  heading?: boolean;
  cut?: string;
}

/**
 * A footnote's definition, as GitHub's readers take one: its label in the export, where its marker
 * and the blank line after it went in the reply written out, the line its words start on, the
 * paragraph they start, if they do, and where it ended.
 */
interface Footnote {
  kind: 'footnote';
  label: string;
  marker: number;
  blank: number;
  start: number;
  first?: Paragraph;
  end?: number;
}

/**
 * A table, as GitHub's readers take one: its head, its delimiter row and its rows. Neither the
 * spec's reader nor the reply's own blocks know tables, so what follows one is read as GitHub's
 * readers read it: anything but a row starts a block, as after no paragraph.
 */
interface Table {
  kind: 'table';
  lines: Line[];
}

/** An item: its marker, whether it holds nothing yet, the block it starts with, and where it ended in the reply written out. */
interface Item {
  kind: 'item';
  data: ListData;
  empty: boolean;
  first?: Block;
  end?: number;
}

type Block =
  | { kind: 'quote' }
  | { kind: 'list'; data: ListData }
  | Item
  | Paragraph
  | Table
  | { kind: 'fence'; char: string; length: number; offset: number }
  | { kind: 'code'; lines: Line[] }
  | { kind: 'html'; type: number; lines: Line[] }
  | Footnote;

/** A link's definition, as written: its address and its title, with what it is between; and the two as a link by reference to it is written with them, once worked out. */
interface Definition {
  destination: string;
  title: string | undefined;
  written?: string;
}

/** What a reply's words are read with: its own links' definitions and footnotes. */
interface Context {
  /** The reply's number in the export, which its footnotes' labels start with. */
  id: number;
  /** Each link's definition by its label as readers match one; the first of a label counts. */
  definitions: Map<string, Definition>;
  /** Each footnote's label in the export, by its label as readers match one. */
  notes: Map<string, string>;
  /**
   * How much more than the reply the export may write for it: the addresses written in for links
   * by reference, and the indentation a footnote's lines take. Past it, a link by reference is its
   * words, and what is left of the reply text: only a reply made to grow the file gets there.
   */
  room: number;
}

const space = (c: string | undefined) => c === ' ' || c === '\t';
/**
 * Whether a line is blank as readers take one: nothing on it but spaces and tabs. A no-break space,
 * which JavaScript's trim takes for a blank, is a character on the line to them.
 */
const blank = (line: string | undefined) => line !== undefined && /^[ \t]*$/.test(line);

/** A label as readers match it: case and runs of blanks aside (micromark's normalizeIdentifier). */
const normalize = (label: string) => label.replace(/[\t\n\r ]+/g, ' ').replace(/^ | $/g, '').toLowerCase().toUpperCase();

/** Where a line is read from: an offset in it and the column there, tabs every 4 columns, a tab partly taken as spaces. */
class Cursor {
  offset = 0;
  column = 0;
  partial = false;
  /** Where the line's indented code starts, before its 4 columns: where its container's words start. */
  code = 0;
  /** For each mark of a thematic break, the last character of the line that is neither it nor a blank. */
  other: Record<'*' | '-' | '_', number> | undefined;
  /** The last character of the line that is not a blank. */
  readonly last: number;
  /** The column where the line's containers end: the words of its block start there. */
  edge: number | undefined;
  next = 0;
  nextColumn = 0;
  indent = 0;
  blank = false;

  constructor(readonly line: string) {
    let last = line.length - 1;
    while (last >= 0 && space(line[last])) last -= 1;
    this.last = last;
  }

  get indented(): boolean {
    return this.indent >= 4;
  }

  findNextNonspace(): void {
    let i = this.offset;
    let columns = this.column;
    for (;;) {
      const c = this.line[i];
      if (c === ' ') columns += 1;
      else if (c === '\t') columns += 4 - (columns % 4);
      else break;
      i += 1;
    }
    this.blank = i >= this.line.length;
    this.next = i;
    this.nextColumn = columns;
    this.indent = columns - this.column;
  }

  advanceNextNonspace(): void {
    this.offset = this.next;
    this.column = this.nextColumn;
    this.partial = false;
  }

  advance(count: number, columns: boolean): void {
    while (count > 0 && this.offset < this.line.length) {
      if (this.line[this.offset] === '\t') {
        const toTab = 4 - (this.column % 4);
        if (columns) {
          this.partial = toTab > count;
          const step = Math.min(toTab, count);
          this.column += step;
          if (!this.partial) this.offset += 1;
          count -= step;
        } else {
          this.partial = false;
          this.column += toTab;
          this.offset += 1;
          count -= 1;
        }
      } else {
        this.partial = false;
        this.offset += 1;
        this.column += 1;
        count -= 1;
      }
    }
  }
}

/** The characters a block can start with, but for an indented one. */
const MAYBE_SPECIAL = /^[#`~*+_=<>0-9[-]/;
// Each tried where the line's next character is (lastIndex), never on a copy of the rest of it.
const ATX = /#{1,6}(?:[ \t]+|$)/y;
/** A fence's opening: a run of backquotes with none after it on the line, a line or paragraph separator (U+2028, U+2029) aside, or of tildes. */
const FENCE_OPEN = /`{3,}(?![^`]*`)|~{3,}/y;
/**
 * A line of words that starts as a fence of backquotes does, with a backquote after it only past a
 * line or paragraph separator (U+2028, U+2029): the spec's reader (commonmark.js) looks for one
 * with JavaScript's `.`, which stops there, and opens a fence that takes what follows; the others
 * read on, as this does, and take the line for words.
 */
const SEPARATED_FENCE = /^`{3,}[^`\u2028\u2029]*[\u2028\u2029]/;
/** Words that would start a line that way start with `&#32;`, a space every reader takes as more of the words. */
const unfenced = (words: string) => (SEPARATED_FENCE.test(words) ? `&#32;${words}` : words);
const FENCE_CLOSE = /(?:`{3,}|~{3,})(?=[ \t]*$)/y;
const SETEXT = /(?:=+|-+)[ \t]*$/y;
const BLOCK_NAMES = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const ATTRIBUTE = `(?:\\s+[a-zA-Z_:][a-zA-Z0-9:._-]*(?:\\s*=\\s*(?:[^"'=<>\`\\x00-\\x20]+|'[^']*'|"[^"]*"))?)`;
/** How an HTML block starts, by its kind (1 to 7), as CommonMark tells them apart. */
const HTML_OPEN = [
  /<(?:script|pre|textarea|style)(?:\s|>|$)/iy,
  /<!--/y,
  /<[?]/y,
  /<![A-Za-z]/y,
  /<!\[CDATA\[/y,
  new RegExp(`</?(?:${BLOCK_NAMES})(?:\\s|/?>|$)`, 'iy'),
  new RegExp(`(?:<[A-Za-z][A-Za-z0-9-]*${ATTRIBUTE}*\\s*/?>|</[A-Za-z][A-Za-z0-9-]*\\s*>)\\s*$`, 'y'),
];
/** What ends an HTML block of the first five kinds; the others end at a blank line. */
const HTML_CLOSE = [/<\/(?:script|pre|textarea|style)>/i, /-->/, /\?>/, />/, /\]\]>/];

/** A sticky pattern's match where a line's next character is. */
function matchAt(pattern: RegExp, line: string, at: number): RegExpExecArray | null {
  pattern.lastIndex = at;
  return pattern.exec(line);
}

/**
 * A thematic break from `at` to the end: three or more of one of `*`, `-` or `_`, spaces and tabs
 * between them. The line is read once, from its end, for all the places a line's blocks start.
 */
function thematicBreak(cur: Cursor, at: number): boolean {
  const mark = cur.line[at];
  if (mark !== '*' && mark !== '-' && mark !== '_') return false;
  if (cur.other === undefined) {
    // For each mark, the last character that is neither it nor a blank.
    cur.other = { '*': -1, '-': -1, _: -1 };
    for (const c of ['*', '-', '_'] as const) {
      for (let i = cur.line.length - 1; i >= 0; i -= 1) {
        if (cur.line[i] !== c && cur.line[i] !== ' ' && cur.line[i] !== '\t') {
          cur.other[c] = i;
          break;
        }
      }
    }
  }
  if (cur.other[mark] >= at) return false;
  let marks = 0;
  for (let i = at; i < cur.line.length; i += 1) if (cur.line[i] === mark) marks += 1;
  return marks >= 3;
}

/**
 * A GitHub footnote's label from the `[` at `at`, as GitHub's readers take one: `[^`, then no blank
 * or `[` (but escaped), at most 999 characters, then `]`; where it ends and the label.
 */
function footnoteLabel(text: string, at: number, to = text.length): { end: number; label: string } | undefined {
  if (text[at] !== '[' || text[at + 1] !== '^') return undefined;
  let size = 0;
  for (let i = at + 2; i < to; i += 1) {
    const c = text[i]!;
    if (size > 999 || c === '[' || c === ' ' || c === '\t' || c === '\n' || c === '\r') return undefined;
    if (c === ']') return size > 0 ? { end: i + 1, label: text.slice(at + 2, i) } : undefined;
    size += 1;
    if (c === '\\' && /[[\\\]]/.test(text[i + 1] ?? '')) {
      i += 1;
      size += 1;
    }
  }
  return undefined;
}

/** A GitHub footnote's definition starting here (`[^label]:`): where its marker ends and its label. */
function footnoteMarker(text: string, at = 0): { end: number; label: string } | undefined {
  const label = footnoteLabel(text, at);
  return label && text[label.end] === ':' ? { end: label.end + 1, label: label.label } : undefined;
}

/** A list item's marker where the line's next character is, as CommonMark reads one; the cursor then stands where its words start. */
function listMarker(cur: Cursor, container: string): ListData | undefined {
  if (cur.indent >= 4) return undefined;
  const rest = cur.line.slice(cur.next, cur.next + 12);
  let marker = /^[*+-]/.exec(rest);
  let ordered = false;
  if (!marker) {
    marker = /^(\d{1,9})([.)])/.exec(rest);
    if (!marker || (container === 'paragraph' && marker[1] !== '1')) return undefined;
    ordered = true;
  }
  const after = cur.line[cur.next + marker[0].length];
  if (after !== undefined && !space(after)) return undefined;
  if (container === 'paragraph' && cur.next + marker[0].length > cur.last) return undefined;
  const data: ListData = { ordered, char: ordered ? marker[2]! : marker[0], offset: cur.indent, padding: 0 };
  cur.advanceNextNonspace();
  cur.advance(marker[0].length, true);
  const startColumn = cur.column;
  const startOffset = cur.offset;
  do cur.advance(1, true);
  while (cur.column - startColumn < 5 && space(cur.line[cur.offset]));
  const spaces = cur.column - startColumn;
  if (spaces >= 5 || spaces < 1 || cur.offset >= cur.line.length) {
    data.padding = marker[0].length + 1;
    cur.column = startColumn;
    cur.offset = startOffset;
    if (space(cur.line[cur.offset])) cur.advance(1, true);
  } else {
    data.padding = marker[0].length + spaces;
  }
  return data;
}

/**
 * How many blocks may be open one in another. Every line is read through all of them, so a
 * reply nested deeper (no reply needs to) is written as text from the line that goes past them.
 */
const DEEPEST = 48;

/** What starts a line that goes on in these containers: a quote's `>`, an item's or a footnote's indentation. */
const inside = (chain: readonly Block[]) => chain.map((block) => (block.kind === 'quote' ? '> '
  : block.kind === 'item' ? ' '.repeat(block.data.offset + block.data.padding) : block.kind === 'footnote' ? '    ' : '')).join('');
/** A blank line that stays in these containers. */
const blankIn = (chain: readonly Block[]) => inside(chain).trimEnd();

/** The column a line's character stands at, tabs every 4 columns. */
function columnAt(line: string, at: number): number {
  let column = 0;
  for (let i = 0; i < at; i += 1) column += line[i] === '\t' ? 4 - (column % 4) : 1;
  return column;
}

/**
 * A line's rest from `from`, which stands at `column`, to go on another line: the tabs among the
 * markers and blanks it starts with as the spaces they stand for there, so its blocks stay as they are.
 */
function moved(line: string, from: number, column: number): string {
  let out = '';
  let i = from;
  for (; i < line.length && /[ \t>*+.)0-9-]/.test(line[i]!); i += 1) {
    const width = line[i] === '\t' ? 4 - (column % 4) : 1;
    out += line[i] === '\t' ? ' '.repeat(width) : line[i];
    column += width;
  }
  return out + line.slice(i);
}

/**
 * The words of a line that went on a paragraph, written where a block could start: as the first
 * line of one, once links' definitions above it are gone, or inside the containers a lazy line
 * left. What kept them from starting a block, their indentation or their place, is gone, so they
 * start with `&#32;`, a space every reader takes as more of the paragraph, where anything at their
 * start could start one. (A table's delimiter row, which would make a table of one, is escaped
 * wherever it goes on a paragraph: see inlineParagraph.)
 */
const goesOn = (text: string) => (/^[#>*+=_`~<[0-9-]/.test(text) ? `&#32;${text}` : text);

/** A run of `-`, which the spec's reader takes as a heading's underline where GitHub's readers take a rule. */
const DASHES = /^-+[ \t]*$/;

/**
 * A reply as the conversation shows it, kept to itself. Its headings sit two levels down, under
 * the speakers' (`===` and `---` ones as `###` and `####`), so none passes for one; its HTML is
 * text, as the conversation shows it, so none is a heading or hides what follows; a picture is a
 * link to it, as the conversation shows one, never loaded; a link by reference is written with its
 * address and a footnote under a label of the reply's own (`id`, its number in the export), so
 * nothing in it reaches another reply; a table is read as GitHub's readers read one, and what
 * follows it too, so nothing after it passes for a heading of the speakers'; and a code block it
 * leaves open is closed at its end. The rest is as written: what the reader takes as code stays
 * code.
 */
export function reply(said: string, id = 1): string {
  // NUL is U+FFFD to every reader, as CommonMark has it: in an address too, which it would end here.
  const text = said.replaceAll('\0', '\ufffd');
  const out: Array<string | undefined> = [];
  const open: Block[] = [];
  const context: Context = { id, definitions: new Map(), notes: new Map(), room: 2 * text.length + 100_000 };
  /** What is written once all the reply is read: a link's definition or a footnote may come after where it is used. */
  const later: Array<() => void> = [];
  const footnotes: Footnote[] = [];
  /** Where paragraphs that were links' definitions alone, in no container, were. */
  const gone: number[] = [];
  /** Items whose first line held links' definitions alone, by where that line is: it is their marker alone now. */
  const emptied: Array<{ at: number; item: Item }> = [];
  /** A blank line owed before the next line with something on it: after HTML written as text, which that line would otherwise join. */
  let owed: string | undefined;
  /** Whether the blank line owed is after a table, where the block that ended it may not need one. */
  let owedTable = false;
  /** Whether the line being read has nothing on it. */
  let empty = false;
  /** Whether the line just read was a heading with a `|` in it, which markdown-it may take for a table's head. */
  let pipeHeading = false;
  const emit = (line: string | undefined) => {
    if (owed !== undefined && !empty) out.push(owed);
    owed = undefined;
    out.push(line);
    return out.length - 1;
  };
  /**
   * The block a line starts after a table it ends: whether it keeps the blank line owed there. The
   * spec's reader, which has no tables, reads the table as a paragraph, which the block would go
   * on or make a heading of where it cannot cut one short; a block that can (a quote, a heading, a
   * fence, a rule of `*` or `_`, an item that is not empty, numbered 1 if numbered) needs none, nor
   * an item of a list the table was in, which all readers take as one; a blank line there would
   * make the list loose.
   */
  const settle = (keep: boolean) => {
    if (owedTable && !keep) owed = undefined;
    owedTable = false;
  };

  /** A paragraph's lines, written once the reply is read: the links' definitions it starts with go. */
  const paragraph = (block: Paragraph, chain: readonly Block[]) => {
    const taken = definitions(block.lines, context);
    const parent = chain.at(-1);
    later.push(() => {
      const { lines } = block;
      const first = lines[0]!;
      if (taken === lines.length) {
        // What is left is the markers its first line opened; an item they open is empty now, and
        // cuts no paragraph short: the blank line that stands before one instead.
        const kept = first.prefix.trimEnd();
        const marker = /(?:^|[ >])(?:[-+*]|\d{1,9}[.)])$/.test(kept);
        out[first.at] = block.cut !== undefined && marker ? `${block.cut}\n${kept}` : kept || undefined;
        if (!kept) gone.push(first.at);
        if (marker && parent?.kind === 'item') emptied.push({ at: first.at, item: parent });
        for (const line of lines.slice(1)) out[line.at] = undefined;
        return;
      }
      const rest = lines.slice(taken);
      if (taken > 0) {
        // Its words start where its definitions did, in the containers they started.
        for (const line of lines.slice(1, taken + 1)) out[line.at] = undefined;
        rest[0] = { at: first.at, prefix: first.prefix, text: rest[0]!.text, moved: true };
      }
      // The words an item starts with, a task's mark first, as GitHub's readers have it.
      const words = inlineParagraph(rest, context, taken === 0 && parent?.kind === 'item' && parent.first === block);
      rest.forEach((line, i) => {
        out[line.at] = line.prefix + words[i]!;
      });
    });
  };

  const finalize = (block: Block, chain: readonly Block[]) => {
    if (block.kind === 'paragraph') {
      paragraph(block, chain);
    } else if (block.kind === 'table') {
      later.push(() => {
        const words = inlineTable(block.lines, context);
        block.lines.forEach((line, i) => {
          out[line.at] = line.prefix + words[i]!;
        });
      });
      // What ends it but a blank line is a block that GitHub's readers start after it, and the
      // spec's reader would take for more of the paragraph it reads the table as.
      if (!empty) {
        owed = blankIn(chain);
        owedTable = true;
      }
    } else if (block.kind === 'item') {
      block.end = out.length;
    } else if (block.kind === 'code') {
      // Indented code, fenced: readers differ on what indentation makes code, never on a fence. The
      // first line keeps the markers it started its containers with, and the fence takes them; the
      // lines after it go on in those containers.
      const last = block.lines.findLastIndex((line) => !blank(line.text));
      const marks = fence(block.lines.slice(0, last + 1).map((line) => line.text).join('\n'), 3);
      const within = inside(chain);
      block.lines.forEach((line, i) => {
        const shown = blank(line.text) ? line.prefix.trimEnd() : `${i === 0 ? within : line.prefix}${line.text}`;
        out[line.at] = `${i === 0 ? `${line.prefix}${marks}\n` : ''}${shown}${i === last ? `\n${within}${marks}` : ''}`;
      });
    } else if (block.kind === 'html') {
      block.lines.forEach((line, i) => {
        const next = block.lines[i + 1];
        const words = blank(line.text) ? '' : textLine(line.text.replace(/[ \t]+$/, ''));
        out[line.at] = line.prefix + words + (words && next && !blank(next.text) ? '\\' : '');
      });
      owed = blankIn(chain);
    } else if (block.kind === 'footnote') {
      block.end = out.length;
    }
  };
  const closeFrom = (from: number) => {
    while (open.length > from) finalize(open.pop()!, open);
  };

  /**
   * The reply written out: the words written last, and a footnote whose words are one line, as one
   * is usually written, on its marker's line again, where a blank line or the reply's end follows
   * it. Readers without footnotes take that line for a paragraph, which a line right after it
   * would go on (`2)`) or make a heading of (`-`), where GitHub's readers start another block.
   */
  const written = () => {
    for (const write of later) write();
    // Of the blank lines a paragraph that is gone stood between, one stays.
    if (gone.length > 0) {
      const at = new Set(gone);
      let before = -1;
      let between = false;
      for (let i = 0; i < out.length; i += 1) {
        between ||= at.has(i);
        if (out[i] === undefined) continue;
        if (between && before >= 0 && out[before] === '' && out[i] === '') {
          out[i] = undefined;
        } else {
          before = i;
        }
        between = false;
      }
    }
    // An item that is its marker alone now goes on past the blank lines after it, as it did: its
    // marker and its next line with words, with none between, as an item can start.
    for (const { at, item } of emptied) {
      let next = at + 1;
      while (next < item.end! && (out[next] === undefined || /^[ \t>]*$/.test(out[next]!))) next += 1;
      if (next < item.end!) for (let i = at + 1; i < next; i += 1) out[i] = undefined;
    }
    for (const footnote of footnotes) {
      const first = footnote.first?.lines[0];
      if (!first || footnote.first!.heading || footnote.first!.lines.length > 1) continue;
      const words = out[first.at]?.slice(first.prefix.length);
      const after = out.slice(first.at + 1, footnote.end);
      const ends = footnote.end! >= out.length || after.some((line) => line !== undefined) || blank(out[footnote.end!]);
      if (words === undefined || blank(words) || after.some((line) => line !== undefined && !blank(line)) || !ends) continue;
      out[footnote.marker] = `${out[footnote.marker]} ${words}`;
      out[footnote.blank] = undefined;
      out[first.at] = undefined;
    }
    const all = out.filter((line): line is string => line !== undefined).join('\n');
    // Blank lines where definitions ended it are no end of the reply's own.
    return /\n[ \t]*$/.test(text) ? all : all.replace(/(?:\n[ \t]*)+$/, '');
  };

  const lines = text.split(/\r\n?|\n/);
  /** A footnote's words from its marker's line, read next as a line of their own. */
  let carried: string | undefined;
  // `index`: the next line of the reply; `read`: how many lines were read, footnotes' words among them.
  for (let index = 0, read = 0; index < lines.length || carried !== undefined; read += 1) {
    const raw = carried ?? lines[index++]!;
    carried = undefined;
    empty = blank(raw);
    const afterPipeHeading = pipeHeading;
    pipeHeading = false;
    owedTable = false;
    const cur = new Cursor(raw);
    let matched = 0;
    let fenceClosed = false;
    for (; matched < open.length; matched += 1) {
      cur.findNextNonspace();
      if (cur.edge === undefined && !['quote', 'list', 'item', 'footnote'].includes(open[matched]!.kind)) cur.edge = cur.column;
      const result = continues(open[matched]!, cur);
      if (result === 'no') break;
      if (result === 'closed') {
        fenceClosed = true;
        break;
      }
    }
    cur.edge ??= cur.column;
    if (fenceClosed) {
      open.length = matched;
      emit(tidy(raw, cur.edge));
      continue;
    }

    let container = matched - 1;
    let closed = matched === open.length;
    const kindOf = (at: number) => (at < 0 ? 'document' : open[at]!.kind);
    const closeUnmatched = () => {
      if (closed) return;
      closeFrom(matched);
      closed = true;
    };
    // A block added where the line is: what cannot hold it (a paragraph, a list for anything but an item) closes first.
    const add = (block: Block) => {
      closeUnmatched();
      while (open.length > 0 && !holds(open.at(-1)!, block)) finalize(open.pop()!, open);
      const parent = open.at(-1);
      if (parent?.kind === 'item') {
        if (parent.empty) parent.first = block;
        parent.empty = false;
      }
      open.push(block);
      container = open.length - 1;
    };
    /**
     * A block of one line, a heading or a rule, done with at once: the line, as it is written out,
     * or where it goes; `keep`, whether it keeps the blank line owed after a table it ends.
     */
    const single = (line: string | undefined, keep: boolean) => {
      closeUnmatched();
      while (open.length > 0 && !holds(open.at(-1)!, { kind: 'paragraph', lines: [] })) finalize(open.pop()!, open);
      const parent = open.at(-1);
      if (parent?.kind === 'item') parent.empty = false;
      container = open.length - 1;
      settle(keep);
      return emit(line);
    };
    /** Too deep, or grown too much, to read on: what was read is written out, and from this line on, text. */
    const giveUp = () => {
      const top = open[0];
      closeFrom(0);
      if (top?.kind === 'fence') out.push(top.char.repeat(top.length));
      out.push('', asText([raw, ...lines.slice(index)].join('\n')));
      return written();
    };

    let handled = false;
    /**
     * When the line's first new container cuts a paragraph short, the blank line that would stand
     * before it instead: micromark (the conversation's reader) then holds every list item after it
     * on the line to the rules for one that cuts a paragraph short (an ordered one starts at 1, and
     * none is empty), where the spec's own reader holds only the first to them. Before an item the
     * two read apart, the blank line is written, so that both read it as the spec's reader does.
     */
    let cutShort: string | undefined;
    /** The same, for a paragraph the line starts in an item it starts. */
    let owedFirst: string | undefined;
    let started = false;
    /** Whether a footnote would take more room than the reply has left. */
    let full = false;
    while (!['fence', 'code', 'html'].includes(kindOf(container)) && open.length <= DEEPEST) {
      cur.findNextNonspace();
      const c = raw[cur.next];
      if (!cur.indented && !MAYBE_SPECIAL.test(c ?? '')) {
        cur.advanceNextNonspace();
        break;
      }
      const here = kindOf(container);
      const tip = open.length === 0 ? 'document' : open.at(-1)!.kind;
      let match: RegExpExecArray | null;
      if (!cur.indented && c === '>') {
        if (!started && here === 'paragraph') owedFirst = cutShort = blankIn(open.slice(0, container));
        started = true;
        cur.advanceNextNonspace();
        cur.advance(1, false);
        if (space(raw[cur.offset])) cur.advance(1, true);
        cur.edge = cur.column;
        add({ kind: 'quote' });
        settle(false);
        continue;
      }
      let marker: ReturnType<typeof footnoteMarker>;
      if (!cur.indented && c === '[' && (marker = footnoteMarker(raw, cur.next))) {
        // A footnote's definition: its marker, under the reply's label, on a line of its own, a
        // blank line, then its words on the next line, inside it as all its lines after them are.
        // GitHub's readers take them for its words alike; readers without footnotes take the marker
        // for words and all that is in it for code, so none of it is a heading, HTML or a picture
        // there, whatever it is in the footnote. Its words' line is written inside all it is in,
        // which the room the reply has left pays for: a footnote in a footnote is 4 columns more.
        const room = inside(open).length + 4;
        if (room > context.room) {
          full = true;
          break;
        }
        context.room -= room;
        const normalized = normalize(marker.label);
        let label = context.notes.get(normalized);
        if (label === undefined) context.notes.set(normalized, (label = `${context.id}-${context.notes.size + 1}`));
        const footnote: Footnote = { kind: 'footnote', label, marker: -1, blank: -1, start: -1 };
        add(footnote);
        settle(true);
        footnotes.push(footnote);
        // Readers without footnotes would take it for more of the paragraph it cuts short.
        if (tip === 'paragraph') emit(blankIn(open.slice(0, -1)));
        footnote.marker = emit(`${spaces(raw.slice(0, cur.next))}[^${label}]:`);
        footnote.blank = emit(blankIn(open));
        let words = marker.end;
        while (space(raw[words])) words += 1;
        if (words < raw.length) {
          carried = inside(open) + moved(raw, words, columnAt(raw, words));
          footnote.start = read + 1;
        }
        handled = true;
        break;
      }
      if (!cur.indented && c === '#' && (match = matchAt(ATX, raw, cur.next))) {
        const hashes = match[0].trimEnd().length;
        const heading = `${spaces(raw.slice(0, cur.next))}${'#'.repeat(Math.min(6, hashes + 2))}`;
        const words = raw.slice(cur.next + hashes);
        pipeHeading = words.includes('|');
        const at = single(undefined, false);
        later.push(() => {
          out[at] = heading + inlineLine(words, context);
        });
        handled = true;
        break;
      }
      if (!cur.indented && (c === '`' || c === '~') && (match = matchAt(FENCE_OPEN, raw, cur.next))) {
        add({ kind: 'fence', char: match[0][0]!, length: match[0].length, offset: cur.indent });
        settle(false);
        // A `|` after the fence as `&#124;`, which reads as one: markdown-it (VS Code's preview)
        // takes a line with a `|` in it, escaped or not, for a table's head when the next looks
        // like its delimiter row, and no fence opens. An escaped one loses its backslash.
        const info = raw.slice(cur.next + match[0].length).replace(/\\*\|/g, (run) => `${run.slice(0, (run.length - 1) & ~1)}&#124;`);
        emit(spaces(raw.slice(0, cur.next)) + match[0] + info);
        handled = true;
        break;
      }
      if (!cur.indented && c === '<') {
        const type = HTML_OPEN.findIndex((open7, i) => matchAt(open7, raw, cur.next) !== null && (i < 6 || (here !== 'paragraph' && !(!closed && tip === 'paragraph'))));
        if (type >= 0) {
          add({ kind: 'html', type: type + 1, lines: [] });
          // Written as text, it would go on with the paragraph it cuts short: a blank line ends that first.
          if (tip === 'paragraph') emit(blankIn(open.slice(0, -1)));
          break;
        }
      }
      if (!cur.indented && here === 'paragraph' && (c === '=' || c === '-') && (match = matchAt(SETEXT, raw, cur.next))) {
        const above = open[container] as Paragraph;
        // Under links' definitions alone, it makes no heading: `===` is words there, `---` a rule.
        const taken = above.taken ?? definitions(above.lines);
        if (taken < above.lines.length) {
          closeUnmatched();
          open.pop();
          container = open.length - 1;
          definitions(above.lines, context);
          above.heading = true;
          pipeHeading = above.lines.some((line) => line.text.includes('|'));
          const [first, ...others] = above.lines;
          for (const line of others) out[line.at] = undefined;
          const level = match[0][0] === '=' ? '###' : '####';
          const rest = above.lines.slice(taken);
          later.push(() => {
            out[first!.at] = `${first!.prefix}${level} ${inlineParagraph(rest, context).map((line) => line.trim()).join(' ')}`;
          });
          handled = true;
          break;
        }
        above.taken = taken;
      }
      if (!cur.indented && thematicBreak(cur, cur.next)) {
        // Right under a heading with a `|`, markdown-it would take a rule of dashes for a table's
        // delimiter row: with spaces between them, it is a rule to every reader.
        const rule = raw.slice(cur.next);
        single(spaces(raw.slice(0, cur.next)) + (afterPipeHeading && /^-+[ \t]*$/.test(rule) ? rule.trimEnd().split('').join(' ') : rule), DASHES.test(rule));
        handled = true;
        break;
      }
      if (!cur.indented || here === 'list') {
        const marker = cur.line.slice(cur.next, cur.next + 11);
        const data = listMarker(cur, here);
        if (data) {
          const empty = cur.offset > cur.last;
          if (!started && here === 'paragraph') owedFirst = cutShort = blankIn(open.slice(0, container));
          else if (cutShort !== undefined && ((data.ordered && !/^1[.)]/.test(marker)) || empty)) {
            emit(cutShort);
            cutShort = undefined;
          }
          started = true;
          closeUnmatched();
          const list = open[container];
          if (list?.kind !== 'list' || list.data.ordered !== data.ordered || list.data.char !== data.char) add({ kind: 'list', data });
          cur.edge = cur.column;
          add({ kind: 'item', data, empty: true });
          settle(list?.kind !== 'list' && (empty || (data.ordered && !/^1[.)]/.test(marker))));
          continue;
        }
      }
      if (cur.indented && tip !== 'paragraph' && !cur.blank) {
        cur.code = cur.column;
        cur.advance(4, true);
        add({ kind: 'code', lines: [] });
        settle(false);
        break;
      }
      cur.advanceNextNonspace();
      break;
    }
    if (full || open.length > DEEPEST) return giveUp();
    if (handled) continue;

    const tip = open.at(-1);
    if (!closed && !cur.blank && tip?.kind === 'paragraph') {
      // A lazy line: it goes on the paragraph, whatever containers it left. Indented 4 columns or
      // more, markdown-it (VS Code's preview) takes it for code that ends them: a space written as
      // `&#32;` starts it instead, which every reader takes as more of the paragraph. In a
      // footnote, it is written inside the containers up to the footnote, as the footnote's lines
      // are, where readers without footnotes take it for code with them.
      const deep = cur.column - cur.edge >= 4;
      const note = open.findIndex((block) => block.kind === 'footnote');
      const prefix = note >= 0 ? inside(open.slice(0, note + 1)) : deep ? `${spaces(cut(raw, cur.edge)[0])}&#32;` : spaces(raw.slice(0, lineStart(cur)));
      if (note >= 0 && (context.room -= prefix.length) < 0) return giveUp();
      tip.lines.push({ at: emit(undefined), prefix, text: raw.slice(lineStart(cur)), lazy: true, indented: deep, moved: note >= 0 });
      continue;
    }
    closeUnmatched();
    const block = open[container];
    if (block?.kind === 'fence') {
      emit(tidy(raw, cur.edge));
    } else if (block?.kind === 'code') {
      block.lines.push({ at: emit(undefined), prefix: spaces(cut(raw, cur.code)[0]), text: cur.blank ? '' : cut(raw, cur.code + 4)[1] });
    } else if (block?.kind === 'html') {
      block.lines.push({ at: emit(undefined), prefix: spaces(raw.slice(0, lineStart(cur))), text: raw.slice(lineStart(cur)) });
      if (block.type <= 5 && HTML_CLOSE[block.type - 1]!.test(raw.slice(cur.offset))) {
        open.pop();
        finalize(block, open);
      }
    } else if (block?.kind === 'paragraph') {
      const line: Line = { at: emit(undefined), prefix: spaces(raw.slice(0, lineStart(cur))), text: raw.slice(lineStart(cur)), indented: cur.indent >= 4 };
      const head = block.lines.at(-1)!;
      const cells = line.indented ? undefined : delimiterCells(line.text);
      if (cells !== undefined && !head.indented && headCells(head.text) === cells) {
        // The paragraph's last line is a table's head, as GitHub's readers take it: the table cuts
        // the paragraph short. One read lazily is written inside the table's containers, as it is
        // read: lazy, it would go on nothing once links' definitions alone above it go, and
        // markdown-it (VS Code's preview) takes a lazy one for a table outside them, the lines
        // after it in the item for blocks of their own. But under words that stay, one like a
        // heading's underline (`===`) stays as it is, where it would make a heading of them.
        block.lines.pop();
        block.taken = undefined;
        const chain = open.slice(0, container);
        const under = definitions(block.lines) < block.lines.length && /^(?:=+|-+)[ \t]*$/.test(head.text);
        const top = head.lazy && !under ? { at: head.at, prefix: inside(chain), text: head.text } : head;
        open[container] = { kind: 'table', lines: [top, line] };
        if (block.lines.length > 0) paragraph(block, chain);
      } else {
        block.lines.push(line);
      }
    } else if (block?.kind === 'table') {
      block.lines.push({ at: emit(undefined), prefix: spaces(raw.slice(0, lineStart(cur))), text: raw.slice(lineStart(cur)) });
    } else if (!cur.blank) {
      cur.advanceNextNonspace();
      const created: Paragraph = { kind: 'paragraph', lines: [] };
      add(created);
      const parent = open.at(-2);
      if (parent?.kind === 'footnote' && parent.start === read) parent.first = created;
      if (parent?.kind === 'item' && owedFirst !== undefined) created.cut = owedFirst;
      created.lines.push({ at: emit(undefined), prefix: spaces(raw.slice(0, lineStart(cur))), text: raw.slice(lineStart(cur)) });
    } else {
      emit(spaces(raw));
    }
  }
  // A code block open at the end, not in a quote or a list (which what follows ends), is closed.
  const last = open[0];
  closeFrom(0);
  if (last?.kind === 'fence') out.push(last.char.repeat(last.length));
  return written();
}

/** A line cut at a column: what comes before it, and after, a tab across it as the spaces it stands for on each side. */
function cut(line: string, column: number): [string, string] {
  let at = 0;
  for (let i = 0; i < line.length; i += 1) {
    if (at >= column) return [line.slice(0, i), line.slice(i)];
    const next = line[i] === '\t' ? at + 4 - (at % 4) : at + 1;
    if (next > column) return [line.slice(0, i) + ' '.repeat(column - at), ' '.repeat(next - column) + line.slice(i + 1)];
    at = next;
  }
  return [line, ''];
}

/** Tabs, from the start of a line, as the spaces they stand for: readers count them apart, never spaces. */
function spaces(text: string): string {
  if (!text.includes('\t')) return text;
  let out = '';
  for (const c of text) out += c === '\t' ? ' '.repeat(4 - (out.length % 4)) : c;
  return out;
}

/** A line with what stands before its words, up to a column, its tabs as spaces; the rest as it is. */
function tidy(line: string, column: number): string {
  const [head, tail] = cut(line, column);
  return spaces(head) + tail;
}

/** Where a line's own words start: past its containers' markers, and past a tab they took only part of. */
const lineStart = (cur: Cursor) => cur.offset + (cur.partial ? 1 : 0);

/** Whether a block can hold another: a list holds items only, an item none but in a list, and a leaf nothing. */
function holds(parent: Block, child: Block): boolean {
  if (parent.kind === 'list') return child.kind === 'item';
  if (child.kind === 'item') return false;
  return parent.kind === 'quote' || parent.kind === 'item' || parent.kind === 'footnote';
}

/** Whether an open block goes on with this line, as CommonMark reads it: `closed` when the line is the fence that ends it. */
function continues(block: Block, cur: Cursor): 'yes' | 'no' | 'closed' {
  switch (block.kind) {
    case 'quote':
      if (cur.indented || cur.line[cur.next] !== '>') return 'no';
      cur.advanceNextNonspace();
      cur.advance(1, false);
      if (space(cur.line[cur.offset])) cur.advance(1, true);
      return 'yes';
    case 'list':
      return 'yes';
    case 'item':
      if (cur.blank) {
        if (block.empty) return 'no';
        cur.advanceNextNonspace();
        return 'yes';
      }
      if (cur.indent < block.data.offset + block.data.padding) return 'no';
      cur.advance(block.data.offset + block.data.padding, true);
      return 'yes';
    case 'footnote':
      // As GitHub's readers have it: a blank line, or one indented 4 columns.
      if (cur.blank) {
        cur.advanceNextNonspace();
        return 'yes';
      }
      if (cur.indent < 4) return 'no';
      cur.advance(4, true);
      return 'yes';
    case 'paragraph':
    case 'table':
      return cur.blank ? 'no' : 'yes';
    case 'fence': {
      const close = cur.indent <= 3 && cur.line[cur.next] === block.char ? matchAt(FENCE_CLOSE, cur.line, cur.next) : null;
      if (close && close[0].length >= block.length) return 'closed';
      for (let skip = block.offset; skip > 0 && space(cur.line[cur.offset]); skip -= 1) cur.advance(1, true);
      return 'yes';
    }
    case 'code':
      cur.code = cur.column;
      if (cur.indent >= 4) cur.advance(4, true);
      else if (cur.blank) cur.advanceNextNonspace();
      else return 'no';
      return 'yes';
    case 'html':
      return cur.blank && block.type >= 6 ? 'no' : 'yes';
  }
}

// Links' definitions, as micromark (the conversation's reader) reads them: at the start of a
// paragraph, one after another, each to the end of a line.

/** Where a `[…]` label from the `[` at `at` ends, past its `]`, as a reference's or a definition's: undefined if it is none. */
function labelEnd(text: string, at: number, to = text.length): number | undefined {
  let size = 0;
  let seen = false;
  for (let i = at + 1; i < to; i += 1) {
    const c = text[i]!;
    if (c === '[') return undefined;
    if (c === ']') return seen ? i + 1 : undefined;
    if (c === '\n') continue;
    if (++size > 999) return undefined;
    if (!space(c)) seen = true;
    if (c === '\\' && /[[\\\]]/.test(text[i + 1] ?? '')) {
      i += 1;
      size += 1;
    }
  }
  return undefined;
}

/** Past the blanks from `at`; `lines` with line endings among them. */
function blanksFrom(text: string, at: number, lines: boolean): number {
  let i = at;
  while (space(text[i]) || (lines && text[i] === '\n')) i += 1;
  return i;
}

/**
 * Where a link's address from `at` ends: in `<…>`, or bare, its parentheses balanced (no deeper
 * than `deepest`); `far` where it reaches `to` and `to` is not `end`, where the words end.
 */
function destinationEnd(text: string, at: number, deepest: number, to = text.length, end = to): number | 'far' | undefined {
  const far = to < end ? 'far' : undefined;
  let i = at;
  if (text[i] === '<') {
    for (i += 1; i < to; i += 1) {
      const c = text[i];
      if (c === '>') return i + 1;
      if (c === '<' || c === '\n') return undefined;
      if (c === '\\' && /[<>\\]/.test(text[i + 1] ?? '')) i += 1;
    }
    return far;
  }
  let depth = 0;
  for (; i < to; i += 1) {
    const c = text[i]!;
    if (depth === 0 && (c === ')' || c === ' ' || c === '\t' || c === '\n')) return i > at ? i : undefined;
    if (c === '(') {
      if (depth >= deepest) return undefined;
      depth += 1;
    } else if (c === ')') {
      depth -= 1;
    } else if (c <= ' ' || c === '\x7f') {
      return undefined;
    } else if (c === '\\' && /[()\\]/.test(text[i + 1] ?? '')) {
      i += 1;
    }
  }
  return far ?? (depth === 0 && i > at ? i : undefined);
}

/** Where a link's title from its `"`, `'` or `(` at `at` ends, past its closing one. */
function titleEnd(text: string, at: number, to = text.length): number | undefined {
  const close = text[at] === '(' ? ')' : text[at];
  for (let i = at + 1; i < to; i += 1) {
    if (text[i] === close) return i + 1;
    if (text[i] === '\\' && (text[i + 1] === close || text[i + 1] === '\\')) i += 1;
  }
  return undefined;
}

/** A link's definition from `at`, the start of a line: where it ends (that line's end), its label and what it defines. */
function definitionAt(text: string, at: number): { end: number; label: string; definition: Definition } | undefined {
  const close = text[at] === '[' ? labelEnd(text, at) : undefined;
  if (close === undefined || text[close] !== ':') return undefined;
  const start = blanksFrom(text, close + 1, true);
  const after = destinationEnd(text, start, Infinity);
  if (typeof after !== 'number') return undefined;
  const label = normalize(text.slice(at + 1, close - 1));
  const destination = text.slice(start, after);
  const title = blanksFrom(text, after, true);
  if (title > after && /["'(]/.test(text[title] ?? '')) {
    const end = titleEnd(text, title);
    const line = end === undefined ? undefined : blanksFrom(text, end, false);
    if (line !== undefined && (line === text.length || text[line] === '\n')) return { end: line, label, definition: { destination, title: text.slice(title, end) } };
  }
  const line = blanksFrom(text, after, false);
  return line === text.length || text[line] === '\n' ? { end: line, label, definition: { destination, title: undefined } } : undefined;
}

/**
 * How many of a paragraph's lines are links' definitions, from its first; with a context, each is
 * kept there for the reply's words, the first of a label counting.
 */
function definitions(lines: readonly Line[], context?: Context): number {
  if (!lines[0]?.text.startsWith('[')) return 0;
  const text = lines.map((line) => line.text).join('\n');
  let taken = 0;
  let at = 0;
  for (;;) {
    const found = definitionAt(text, at);
    if (!found) return taken;
    if (context && !context.definitions.has(found.label)) context.definitions.set(found.label, found.definition);
    for (; at <= found.end && taken < lines.length; taken += 1) at += lines[taken]!.text.length + 1;
    if (taken >= lines.length) return taken;
  }
}

// A reply's words: what the reader takes as code stays as written; elsewhere, HTML is text and a
// picture a link. Where the reader's code cannot be told for sure (a backquote in a link's
// address or a bare link, which the reader may take whole), none is taken as code from there on:
// the HTML in it is text then, which can only show as more. A table's cells are read apart, as
// the reader reads them.

const ASCII_PUNCTUATION = /[!-\/:-@[-`{-~]/;
const EMAIL_DOMAIN = '@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*';
/**
 * An autolink, as every reader takes one, micromark (the conversation's reader) the strictest: a
 * scheme, then no ASCII control character, space, `<` or `>`; or an email, with no `!` in its name.
 * NUL is none of them, as the reply is read with U+FFFD in its place, as readers read it.
 */
const AUTOLINK = new RegExp(`<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\\x00-\\x20<>\\x7f]*|[A-Za-z0-9.#$%&'*+/=?^_\`{|}~-]+${EMAIL_DOMAIN})>`, 'y');
/**
 * One that only some readers take for an autolink: with DEL, which the others allow, or a `!` in
 * an email's name, as the spec has it. Its `<` is written `&lt;`, so that none takes it for one,
 * and all read what is in it as the conversation does.
 */
const AUTOLINK_SOME = new RegExp(`<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\\x00-\\x20<>]*|[A-Za-z0-9.!#$%&'*+/=?^_\`{|}~-]+${EMAIL_DOMAIN})>`, 'y');
/**
 * A `<` some reader may take for HTML: a tag's name and what may go on a tag, a closing tag, a
 * comment, a declaration or an instruction. Any other is text in all of them, as written.
 */
const HTML_START = /<(?:[A-Za-z][A-Za-z0-9-]*(?:[\s>]|\/>|$)|\/[A-Za-z]|[!?])/y;
/** Where a bare link starts, for some reader: GitHub's and markdown-it (VS Code's preview) take `ftp://` too. */
const BARE_START = /(?:https?|ftp):\/\/|www\./iy;
/** Where one starts for micromark (the conversation's reader). */
const MICROMARK_BARE = /https?:\/\/|www\./iy;
/** A picture's words that are written as the words of a link to it: no brackets, backslashes, backquotes or line breaks. */
const SIMPLE_WORDS = /^[^[\]\\`\n]{0,1000}$/;
/**
 * A task's mark, where an item's words start: `[ ]` or `[x]`, then more words, as micromark reads
 * one before it reads a link there.
 */
const TASK = /\[[ \t\nxX]\](?:\n|[ \t]+[^])/y;
/** A line that starts a link's reference definition, which the reader takes whole: no `[` or `]` in its label but escaped. */
const DEFINITION = /^\[(?:[^[\]\\]|\\.){0,999}\]:/;
/** A line some reader may take for a table's delimiter row, if a `-` is in it: `|`, `:`, `-` and blanks alone. */
const DELIMITER_LIKE = /^[ \t]*[|:-][ \t|:-]*$/;

/**
 * The words of a paragraph's lines, each line's as it is written out. A line that defines a
 * footnote, as GitHub's extensions have it, starts with its `[` escaped: readers without them take
 * it for a paragraph, and read what it holds otherwise, so it is written as one for all of them.
 */
function inlineParagraph(lines: readonly Line[], context: Context, task = false): string[] {
  // A `>` that starts a line here is text (the line goes on a paragraph); markdown-it (VS Code's
  // preview) still takes one with any indentation for a quote that goes on: escaped, it is text
  // there too. And a line that looks like a table's delimiter row: past the first, the line above
  // it headed no table where it was (it was indented, or lazy, or some reader takes the row for
  // none), but where it is written it could; the first, markdown-it takes for one under a heading
  // with a `|`, which it tries as a table's head first.
  const written = lines.map(({ text, moved }) => {
    const words = moved ? goesOn(text) : text;
    return footnoteMarker(words) !== undefined || words.startsWith('>') || (DELIMITER_LIKE.test(words) && words.includes('-')) ? `\\${words}` : words;
  });
  // A lazy line that starts with a tag, which the spec's reader takes as more of the paragraph,
  // micromark (the conversation's reader) may take as HTML of its own: code reaching into it is not sure.
  const breaks: number[] = [];
  let at = 0;
  lines.forEach((line, i) => {
    if (line.lazy && written[i]!.startsWith('<')) breaks.push(at);
    at += written[i]!.length + 1;
  });
  const words = inline(written.join('\n'), { sure: true, breaks, context, task }).split('\n').map(unfenced);
  // A paragraph that starts, as written, as a link's reference definition does is text: no
  // reader defines a link where the reply's reader did not, as readers part ways on where one
  // ends. Its `[` opens no link there (one would be written with its address).
  if (DEFINITION.test(words[0]!)) words[0] = `\\${words[0]}`;
  return words;
}

/** The words of a heading's line. */
const inlineLine = (text: string, context: Context) => inline(text, { sure: true, context });

/**
 * A line as a table's delimiter row, as micromark (the conversation's reader) takes one: its cells
 * of `-`, a `:` at either end of one, between `|`s, with a `|` or a `:` in it; how many cells, or
 * undefined if it is none.
 */
function delimiterCells(text: string): number | undefined {
  let cells = 0;
  let marked = false;
  for (let i = 0; ;) {
    if (text[i] === '|') {
      marked = true;
      i += 1;
      while (space(text[i])) i += 1;
      if (i >= text.length) break;
    }
    if (text[i] === ':') {
      marked = true;
      i += 1;
    }
    if (text[i] !== '-') return undefined;
    while (text[i] === '-') i += 1;
    cells += 1;
    if (text[i] === ':') {
      marked = true;
      i += 1;
    }
    while (space(text[i])) i += 1;
    if (i >= text.length) break;
    if (text[i] !== '|') return undefined;
  }
  return marked ? cells : undefined;
}

/**
 * A line as a table's head, as micromark takes one: its cells, at each `|` (but `\|`), the outer
 * ones aside; how many, or undefined if it can head none (a `|` alone).
 */
function headCells(text: string): number | undefined {
  let marks = text[0] === '|' ? 0 : 1;
  let cells = 0;
  let open = text[0] !== '|';
  for (let i = 0; i < text.length;) {
    const c = text[i]!;
    if (space(c)) {
      i += 1;
      continue;
    }
    marks += 1;
    if (open) {
      open = false;
      cells += 1;
    }
    if (c === '|') {
      open = true;
      i += 1;
      continue;
    }
    while (i < text.length && text[i] !== '|' && !space(text[i])) i += text[i] === '\\' && (text[i + 1] === '\\' || text[i + 1] === '|') ? 2 : 1;
  }
  return marks > 1 ? cells : undefined;
}

/**
 * A table's lines, as written out: each row's cells read apart, as the reader reads them, and its
 * delimiter row as it is. The spec's reader, which has no tables, reads the table as a paragraph:
 * a row like a heading's underline (`===`, `--`) would make a heading of it there, and its head,
 * where it starts that paragraph, like a link's definition would define one; their first
 * character is escaped. A head on an item's first line starts with a `|`, as GitHub's readers
 * read it alike: markdown-it (VS Code's preview) tries a table before an item, so with the marker
 * as much a cell of it as the words after, it takes the whole line for a table's head, and what
 * follows in the item for blocks of their own, a code block that swallows the turns after it.
 */
function inlineTable(lines: readonly Line[], context: Context): string[] {
  return lines.map((line, i) => {
    if (i === 1) return line.text;
    const words = unfenced(inlineRow(line.moved ? goesOn(line.text) : line.text, context));
    if (i === 0 && !words.startsWith('|') && /(?:^|[ >])(?:[-+*]|\d{1,9}[.)])[ \t]*$/.test(line.prefix)) return `| ${words}`;
    return (i === 0 && DEFINITION.test(words)) || (i > 1 && /^(?:=+|-+)[ \t]*$/.test(words)) ? `\\${words}` : words;
  });
}

/** A table row's words: each cell's words read apart, as the reader reads them, at each `|` but an escaped one. */
function inlineRow(text: string, context: Context): string {
  let out = '';
  let start = 0;
  for (let i = 0; i <= text.length; i += 1) {
    if (text[i] === '\\' && (text[i + 1] === '\\' || text[i + 1] === '|')) {
      i += 1;
    } else if (i === text.length || text[i] === '|') {
      out += inline(text.slice(start, i), { sure: true, context }) + (text[i] ?? '');
      start = i + 1;
    }
  }
  return out;
}

/** Whether words end with a `!` that is not escaped, which makes a picture of a `[…]` right after it. */
const bangAtEnd = (words: string) => words.endsWith('!') && !escapedAt(words, words.length - 1);

/** Whether the character at `at` is escaped: an odd run of backslashes before it. */
function escapedAt(text: string, at: number): boolean {
  let run = 0;
  while (at - run - 1 >= 0 && text[at - run - 1] === '\\') run += 1;
  return run % 2 === 1;
}

// What a paragraph's words make, read as micromark (the conversation's reader) reads them in the
// export, where its HTML is text: its links and pictures, those by reference with the reply's
// definitions, and its footnote calls. Each is read on, from a `]`, up to 2,000 characters, and a
// paragraph's words for no more than about twice their length: past that, nothing more is read for
// a link, and a picture is not written as one.

/** A link or a picture read: where its `]` is, where it ends, and the definition one by reference uses. */
interface Link {
  picture: boolean;
  close: number;
  end: number;
  definition?: Definition;
  /** An address in `<…>`: where its `<` and `>` are. */
  pointed?: [number, number];
  /** A picture in the words of a link or another picture. */
  within?: boolean;
}

interface Reading {
  /** Each link and picture, by where it opens: a link's `[`, a picture's `!`. */
  links: Map<number, Link>;
  /** Each footnote call, by its `[`: where it ends, and its label. */
  calls: Map<number, { end: number; label: string }>;
  /**
   * Each `^` that starts a label (a `[`, or a `[` and blanks, before it) but calls none of the
   * reply's footnotes: escaped, it calls none in the export either, nor matches, in readers
   * without footnotes, another reply's footnote they take for a link's definition.
   */
  carets: Set<number>;
  /** Each `<` that starts a link's address in `<…>`, and where its `>` is. */
  addresses: Map<number, number>;
}

/** A paragraph's words read: its links, pictures and footnote calls. */
function readInline(text: string, context: Context, task: boolean): Reading {
  const reading: Reading = { links: new Map(), calls: new Map(), carets: new Set(), addresses: new Map() };
  // No `[`: no link, picture or call. A task's mark, which micromark reads before any, is neither.
  if (text.includes('[')) readSpan(text, task && matchAt(TASK, text, 0) ? 3 : 0, text.length, context, reading);
  return reading;
}

/** Where the `^` a label starts with is, from its `[` at `at`, past blanks, as readers match labels (blanks aside). */
function caretAt(text: string, at: number, to: number): number | undefined {
  let i = at + 1;
  while (i < to && /\s/.test(text[i]!)) i += 1;
  return i < to && text[i] === '^' ? i : undefined;
}

/** Whether a link by reference fits in the room the reply has left: its address and title are written in at each. */
function fits(definition: Definition, context: Context): boolean {
  const size = (definition.written ??= resolved(definition)).length;
  if (size > context.room) return false;
  context.room -= size;
  return true;
}

/**
 * Where an inline link's address and title end, past their `)`, from the `(` at `at`, as micromark
 * reads them, and where its address is: `far` past 2,000 characters; and how far it was read.
 */
function resourceEnd(text: string, at: number, to: number): { found?: { end: number; address: [number, number] }; far?: boolean; read: number } {
  const limit = Math.min(to, at + 2000);
  const far = { far: limit < to, read: limit - at };
  let i = blanksFrom(text, at + 1, true);
  if (i >= limit) return far;
  if (text[i] === ')') return { found: { end: i + 1, address: [i, i] }, read: i + 1 - at };
  const start = i;
  if (text[i] !== '<' && (text[i]! <= ' ' || text[i] === '\x7f')) return { read: i - at };
  const after = destinationEnd(text, i, 32, limit, to);
  if (after === 'far') return far;
  if (after === undefined) return { read: limit - at };
  i = blanksFrom(text, after, true);
  if (i > after && /["'(]/.test(text[i] ?? '')) {
    const end = titleEnd(text, i, limit);
    if (end === undefined) return far;
    i = blanksFrom(text, end, true);
  }
  if (i >= limit) return far;
  return text[i] === ')' ? { found: { end: i + 1, address: [start, after] }, read: i + 1 - at } : { read: i - at };
}

/** The words from `from` to `to` read. */
function readSpan(text: string, from: number, to: number, context: Context, reading: Reading): void {
  // The runs of backquotes of each length, for the run that ends code: the next of the same length.
  const runs = new Map<number, number[]>();
  for (let i = from; i < to;) {
    if (text[i] !== '`') {
      i += 1;
      continue;
    }
    let length = 1;
    while (i + length < to && text[i + length] === '`') length += 1;
    const list = runs.get(length) ?? [];
    list.push(i);
    runs.set(length, list);
    i += length;
  }
  const seen = new Map<number, number>();
  const closer = (at: number, length: number) => {
    const list = runs.get(length);
    if (!list) return undefined;
    let k = seen.get(length) ?? 0;
    while (k < list.length && list[k]! < at) k += 1;
    seen.set(length, k);
    return list[k];
  };
  // Where the last `[` or `]` before each place is, escaped ones aside: a label that holds one can be no definition's.
  const bracket = new Int32Array(to - from + 1).fill(-1);
  for (let i = from, last = -1, escape = false; i < to; i += 1) {
    bracket[i - from] = last;
    if (escape) escape = false;
    else if (text[i] === '\\') escape = true;
    else if (text[i] === '[' || text[i] === ']') last = i;
  }
  const stack: Array<{ at: number; picture: boolean; active: boolean; balanced: boolean }> = [];
  /** The links' `[`s that may still open one: a link found makes them all open none. */
  const active: Array<{ active: boolean }> = [];
  /** The pictures read, not yet known to be in a link's or a picture's words. */
  const pictures: Link[] = [];
  const pictureAt: number[] = [];
  let budget = 2 * (to - from) + 4000;
  for (let i = from; i < to;) {
    const c = text[i]!;
    if (c === '\\') {
      i += i + 1 < to && ASCII_PUNCTUATION.test(text[i + 1]!) ? 2 : 1;
    } else if (c === '`') {
      let length = 1;
      while (i + length < to && text[i + length] === '`') length += 1;
      const end = closer(i + length, length);
      i = end === undefined ? i + length : end + length;
    } else if (c === '<') {
      const link = matchAt(AUTOLINK, text, i);
      i += link && i + link[0].length <= to ? link[0].length : 1;
    } else if (c === '!' && text[i + 1] === '[' && i + 1 < to) {
      const caret = caretAt(text, i + 1, to);
      if (caret !== undefined) reading.carets.add(caret);
      stack.push({ at: i, picture: true, active: true, balanced: false });
      i += 2;
    } else if (c === '[') {
      const call = footnoteLabel(text, i, to);
      if (call && context.notes.has(normalize(call.label))) {
        reading.calls.set(i, call);
        i = call.end;
        continue;
      }
      const caret = caretAt(text, i, to);
      if (caret !== undefined) reading.carets.add(caret);
      const opener = { at: i, picture: false, active: true, balanced: false };
      stack.push(opener);
      active.push(opener);
      i += 1;
    } else if (c === ']') {
      while (stack.length > 0 && stack.at(-1)!.balanced) stack.pop();
      const opener = stack.at(-1);
      if (!opener || budget <= 0) {
        i += 1;
        continue;
      }
      if (!opener.active) {
        opener.balanced = true;
        i += 1;
        continue;
      }
      const start = opener.at + (opener.picture ? 2 : 1);
      // Its words as a label, if they can be one: no bracket in them, and at most 999 characters.
      const words = bracket[i - from] === opener.at + (opener.picture ? 1 : 0) && i - start <= 1000 ? normalize(text.slice(start, i)) : undefined;
      const defined = words === undefined ? undefined : context.definitions.get(words);
      let link: Link | undefined;
      if (text[i + 1] === '(' && i + 1 < to) {
        const { found, far, read } = resourceEnd(text, i + 1, to);
        budget -= read;
        if (far) budget = 0;
        else if (found) link = { picture: opener.picture, close: i, end: found.end, ...(text[found.address[0]] === '<' ? { pointed: [found.address[0], found.address[1] - 1] as [number, number] } : {}) };
        else if (defined) link = { picture: opener.picture, close: i, end: i + 1, definition: defined };
      } else if (text[i + 1] === '[' && i + 1 < to) {
        const end = labelEnd(text, i + 1, to);
        budget -= end === undefined ? 1 : end - i;
        const full = end === undefined ? undefined : context.definitions.get(normalize(text.slice(i + 2, end - 1)));
        if (full) link = { picture: opener.picture, close: i, end: end!, definition: full };
        else if (defined && text[i + 2] === ']') link = { picture: opener.picture, close: i, end: i + 3, definition: defined };
      } else if (defined) {
        link = { picture: opener.picture, close: i, end: i + 1, definition: defined };
      }
      // Past the room the reply has, a link by reference is read as its words, as with no definition.
      if (link?.definition && !fits(link.definition, context)) link = undefined;
      if (link) {
        stack.pop();
        reading.links.set(opener.at, link);
        // The pictures in its words.
        while (pictureAt.length > 0 && pictureAt.at(-1)! > opener.at) {
          pictureAt.pop();
          pictures.pop()!.within = true;
        }
        if (link.picture) {
          pictures.push(link);
          pictureAt.push(opener.at);
        }
        if (link.pointed) reading.addresses.set(link.pointed[0], link.pointed[1]);
        // No link holds another: the `[`s before it open none.
        if (!opener.picture) {
          for (const before of active) before.active = false;
          active.length = 0;
        }
        i = link.end;
      } else {
        opener.balanced = true;
        // `![^label]`: a `!` and a footnote call, when the reply has that footnote; blanks before the `^` aside, as a label's.
        if (opener.picture && words?.startsWith('^') && context.notes.has(words.slice(1))) reading.calls.set(opener.at + 1, { end: i + 1, label: words.slice(1) });
        i += 1;
      }
    } else {
      i += 1;
    }
  }
}

/** Characters of a link's address by reference, as written where they are text if it is not read as one. */
const ADDRESS: Record<string, string> = { ' ': '%20', '\t': '%09', '(': '\\(', ')': '\\)', '<': '%3C', '>': '%3E', '`': '%60', '|': '\\|', '[': '\\[', ']': '\\]', '!': '\\!', '\\': '\\\\' };
/** Characters of a link's title by reference, as written where they are text if it is not read as one. */
const TITLE: Record<string, string> = { '\n': '&#10;', '`': '&#96;', '|': '\\|', '<': '&lt;', '[': '\\[', ']': '\\]', '\\': '\\\\' };

/**
 * A link's address as written after its words: as an address, the same for a reader; as text, if
 * a reader does not take it for one, nothing in it that is code, HTML, a picture or a table's `|`.
 */
function address(written: string): string {
  const pointed = written.startsWith('<');
  const body = pointed ? written.slice(1, -1) : written;
  if (!body) return '<>';
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i]!;
    if (c === '\\' && ASCII_PUNCTUATION.test(body[i + 1] ?? '')) {
      i += 1;
      out += ADDRESS[body[i]!] ?? `\\${body[i]}`;
    } else {
      out += ADDRESS[c] ?? c;
    }
  }
  return out;
}

/** A link's title as written after its address: the same title, and as text, nothing in it that is code, HTML or a table's `|`. */
function title(written: string): string {
  const close = written.at(-1)!;
  let out = '';
  for (let i = 1; i < written.length - 1; i += 1) {
    const c = written[i]!;
    if (c === '\\' && ASCII_PUNCTUATION.test(written[i + 1] ?? '')) {
      i += 1;
      const d = written[i]!;
      out += d === '`' ? '&#96;' : d === '<' ? '&lt;' : `\\${d}`;
    } else {
      out += (close === ')' && (c === '(' || c === ')')) || c === close ? `\\${c}` : TITLE[c] ?? c;
    }
  }
  return `${written[0]}${out}${close}`;
}

/** What follows a link's words for a link by reference: its address and title, as `(…)`. */
const resolved = ({ destination, title: written }: Definition) => `${address(destination)}${written ? ` ${title(written)}` : ''}`;

/**
 * A paragraph's, a heading's or a table cell's words, HTML as text and pictures as links, outside
 * what the reader surely takes as code; links by reference with their addresses and footnotes with
 * the reply's labels. `sure`: whether code can be told there at all.
 */
function inline(text: string, { sure, breaks = [], context, task = false }: { sure: boolean; breaks?: readonly number[]; context: Context; task?: boolean }): string {
  // Nothing in words without these is written otherwise.
  if (!/[`<[\\]/.test(text)) return text;
  const n = text.length;
  const reading = readInline(text, context, task);
  // The runs of backquotes of each length, for finding the run that ends code: the next of the
  // same length, as the reader looks for it (asked for in order, from places further on each time).
  const byLength = new Map<number, number[]>();
  for (const run of text.matchAll(/`+/g)) {
    const list = byLength.get(run[0].length) ?? [];
    list.push(run.index);
    byLength.set(run[0].length, list);
  }
  const finder = () => {
    const seen = new Map<number, number>();
    return (from: number, length: number) => {
      const list = byLength.get(length);
      if (!list) return undefined;
      let i = seen.get(length) ?? 0;
      while (i < list.length && list[i]! < from) i += 1;
      seen.set(length, i);
      return list[i];
    };
  };
  const closer = finder();
  // Readers take whole what follows a link's words and a footnote call, as written or as it is
  // written in its place, so a run of backquotes there opens no code and ends none.
  const whole = new Map<number, number>();
  for (const link of reading.links.values()) {
    if (link.end > link.close + 1 && (!link.definition || !text.slice(link.close, link.end).includes('\n'))) whole.set(link.close + 1, link.end);
  }
  for (const [at, call] of reading.calls) whole.set(at, call.end);
  // Each run that starts code and finds nothing to end it, code read from the start: written
  // escaped, as the reader shows it, so that none misleads markdown-it (VS Code's preview), which
  // past one, or looking past one for a `]`, may lose the code before or after it. Where code is
  // not sure, so is this: a run some reader takes to end code then shows a backslash in it.
  const unpaired = new Set<number>();
  {
    const ahead = finder();
    for (let i = 0; i < n;) {
      const link = text[i] === '<' ? matchAt(AUTOLINK, text, i) : null;
      const taken = whole.get(i);
      if (taken !== undefined) {
        i = taken;
      } else if (text[i] === '\\' && ASCII_PUNCTUATION.test(text[i + 1] ?? '')) {
        i += 2;
      } else if (link) {
        i += link[0].length;
      } else if (text[i] === '`') {
        let length = 1;
        while (text[i + length] === '`') length += 1;
        const end = ahead(i + length, length);
        if (end === undefined) unpaired.add(i);
        i = end === undefined ? i + length : end + length;
      } else {
        i += 1;
      }
    }
  }
  // Where a bare link would end, at the latest: a blank (a `<` ends one too, but not once it is
  // written `&lt;`); and how many backquotes come before each place.
  const stop = new Int32Array(n + 1);
  stop[n] = n;
  // GitHub's reader goes on past any other character, a control character or a no-break space.
  for (let i = n - 1; i >= 0; i -= 1) {
    const code = text.charCodeAt(i);
    stop[i] = code === 32 || (code >= 9 && code <= 13) ? i : stop[i + 1]!;
  }
  const ticks = new Int32Array(n + 1);
  for (let i = 0; i < n; i += 1) ticks[i + 1] = ticks[i]! + (text[i] === '`' ? 1 : 0);
  const quoteIn = (from: number, to: number) => ticks[Math.min(to, n)]! - ticks[from]! > 0;

  /** How much the looks ahead below may read in all: twice the words. */
  let looking = 2 * n + 2000;

  /**
   * Where a bare link that starts at `at` ends, as micromark (the conversation's reader) reads
   * one, when HTML comes right after it: a `<` that is written `&lt;`, which the link would run on
   * through, as it runs on through a `&`. Undefined for any other: one that ends elsewhere, or that
   * could not be written in `<…>` as it is (with a backquote, a `&`, a backslash or a `>` in it),
   * or in a link's words, where micromark makes none.
   */
  let edge: Int32Array | undefined;
  let opens: Int32Array | undefined;
  let trimming = 2 * n + 100;
  const tags = text.includes('<');
  const bareBeforeTag = (at: number): number | undefined => {
    if (!tags) return undefined;
    MICROMARK_BARE.lastIndex = at;
    const start = MICROMARK_BARE.exec(text);
    if (!start) return undefined;
    const previous = text[at - 1];
    if (previous !== undefined && (/^w/i.test(start[0]) ? !/[\s(*_[\]~]/.test(previous) : /[A-Za-z]/.test(previous))) return undefined;
    if (!edge) {
      // The next blank or `<` from each place, and the `(`s, `)`s and `[`s less `]`s before it.
      edge = new Int32Array(n + 1);
      edge[n] = n;
      for (let k = n - 1; k >= 0; k -= 1) edge[k] = text[k] === '<' || /\s/.test(text[k]!) ? k : edge[k + 1]!;
      opens = new Int32Array(3 * (n + 1));
      for (let k = 0; k < n; k += 1) {
        opens[3 * (k + 1)] = opens[3 * k]! + (text[k] === '(' ? 1 : 0);
        opens[3 * (k + 1) + 1] = opens[3 * k + 1]! + (text[k] === ')' ? 1 : 0);
        opens[3 * (k + 1) + 2] = opens[3 * k + 2]! + (text[k] === '[' ? 1 : text[k] === ']' ? -1 : 0);
      }
    }
    const tag = edge[at]!;
    if (text[tag] !== '<' || reading.addresses.has(tag) || matchAt(AUTOLINK, text, tag) || !(matchAt(HTML_START, text, tag) || matchAt(AUTOLINK_SOME, text, tag))) return undefined;
    if (opens![3 * at + 2]! > 0) return undefined;
    // What GitHub's rules leave out at its end: these, a `)` it did not open, a `&name;`.
    let end = tag;
    while (end > at && trimming-- > 0) {
      const last = text[end - 1]!;
      if (/[!"'*,.:?\]_~]/.test(last)) end -= 1;
      else if (last === ')' && opens![3 * (end - 1) + 1]! - opens![3 * at + 1]! >= opens![3 * (end - 1)]! - opens![3 * at]!) end -= 1;
      else if (last === ';') end -= /&[A-Za-z]+;$/.exec(text.slice(Math.max(at, end - 40), end))?.[0].length ?? 1;
      else break;
    }
    if (trimming <= 0 || end <= at + start[0].length) return undefined;
    return /[`&\\>\x00-\x20\x7f]/.test(text.slice(at, end)) ? undefined : end;
  };
  /**
   * What a look ahead found, where the reader may take some words whole from `from` to `end`:
   * none of the code after it is sure if they hold a backquote, nor once the looks have read
   * their fill, which no paragraph's links come near.
   */
  const looked = (from: number, { end, read }: { end: number | undefined; read: number }) => {
    if ((looking -= read) < 0 || (end !== undefined && (end < 0 || quoteIn(from, end)))) sure = false;
  };

  const out: string[] = [];
  /** Where the words not yet written out start: they go out as they are. */
  let from = 0;
  /** The first of `breaks` past the place read. */
  let breakAt = 0;
  const put = (at: number, words: string, next: number) => {
    let before = text.slice(from, at);
    // A `!` just before a link written here would make a picture of it: one in the reply's words,
    // or at the end of what was written in their place just before, such as a picture's name.
    if (words.startsWith('[')) {
      if (before) {
        if (before.endsWith('!') && !escapedAt(text, at - 1)) before = `${before.slice(0, -1)}\\!`;
      } else {
        const last = out.findLastIndex((part) => part !== '');
        if (last >= 0 && bangAtEnd(out[last]!)) out[last] = `${out[last]!.slice(0, -1)}\\!`;
      }
    }
    // And one at the end of what is written here, of a `[` right after it in the reply's words.
    if (bangAtEnd(words) && text[next] === '[') words = `${words.slice(0, -1)}\\!`;
    out.push(before, words);
    from = next;
    return next;
  };
  /** A link's or a picture's address and title, from its `(` to its `)`, as written in the link: an address in `<…>` that may read as HTML written bare, and HTML in a title as text. */
  const resource = (link: Link) => {
    let written = '';
    for (let i = link.close + 2; i < link.end - 1; i += 1) {
      const pointed = link.pointed?.[0] === i ? link.pointed[1] : undefined;
      if (pointed !== undefined) {
        written += matchAt(HTML_START, text, i) ? address(text.slice(i, pointed + 1)) : text.slice(i, pointed + 1);
        i = pointed;
      } else if (text[i] === '\\' && ASCII_PUNCTUATION.test(text[i + 1] ?? '')) {
        written += text.slice(i, i + 2);
        i += 1;
      } else {
        written += text[i] === '<' && matchAt(HTML_START, text, i) ? '&lt;' : text[i];
      }
    }
    return written;
  };
  /** The links by reference whose words are being written, by where their `]` is. */
  const ends = new Map<number, Link>();
  let i = 0;
  while (i < n) {
    const c = text[i]!;
    const ending = c === ']' ? ends.get(i) : undefined;
    if (ending) {
      i = put(i, `](${ending.definition!.written!})`, ending.end);
    } else if (c === '\\' && i + 1 < n && ASCII_PUNCTUATION.test(text[i + 1]!)) {
      // An escaped `<` as `&lt;`: a bare link just before it would take the backslash into its address.
      i = text[i + 1] === '<' ? put(i, '&lt;', i + 2) : i + 2;
    } else if (c === '`') {
      let length = 1;
      while (text[i + length] === '`') length += 1;
      const end = sure ? closer(i + length, length) : undefined;
      // Which is code is not sure from here on where it reaches a line a reader may take apart.
      while (breaks[breakAt] !== undefined && breaks[breakAt]! <= i) breakAt += 1;
      if (end !== undefined && breaks[breakAt] !== undefined && breaks[breakAt]! < end) sure = false;
      if (end !== undefined && sure) i = end + length;
      else if (unpaired.has(i)) i = put(i, '\\`'.repeat(length), i + length);
      else i += length;
    } else if (c === '<') {
      const pointed = reading.addresses.get(i);
      const link = pointed === undefined ? matchAt(AUTOLINK, text, i) : null;
      if (pointed !== undefined) i = matchAt(HTML_START, text, i) ? put(i, address(text.slice(i, pointed + 1)), pointed + 1) : pointed + 1;
      else if (link) i += link[0].length;
      else if (matchAt(HTML_START, text, i) || matchAt(AUTOLINK_SOME, text, i)) i = put(i, '&lt;', i + 1);
      else i += 1;
    } else if (c === '!' && text[i + 1] === '[') {
      const link = reading.links.get(i);
      const words = link?.picture ? text.slice(i + 2, link.close) : undefined;
      // A reference's label on more than one line is kept as written: the address in its place would take a line from the paragraph.
      const lines = link?.definition && text.slice(link.close, link.end).includes('\n');
      if (link && words !== undefined && !lines && SIMPLE_WORDS.test(words)) {
        // In a link's words, as the conversation shows it there: its name, in that link.
        const written = pictureLink(words, link.definition ? link.definition.written! : resource(link));
        i = put(i, link.within && written.startsWith('[') ? written.slice(1, written.lastIndexOf('](')) : written, link.end);
      } else {
        // One this does not write as a link is its words, a link to it if it is one: never a picture.
        i = put(i, '\\!', i + 1);
        if (link?.definition && !lines) ends.set(link.close, link);
      }
    } else if (c === '[') {
      const call = reading.calls.get(i);
      const link = reading.links.get(i);
      if (call) {
        // A footnote call, by the label the reply's footnote has in the export; a `(` right after
        // it escaped, as readers without footnotes take `[^…](…)` for a link, which takes in a
        // backquote that opens code here.
        const label = `[^${context.notes.get(normalize(call.label))}]`;
        i = text[call.end] === '(' ? put(i, `${label}\\(`, call.end + 1) : put(i, label, call.end);
      } else {
        if (link?.definition && !text.slice(link.close, link.end).includes('\n')) ends.set(link.close, link);
        else if (!link && sure && text[i + 1] === '^' && !reading.carets.has(i + 1)) looked(i, bracketEnd(text, i));
        i += 1;
      }
    } else if (c === '^' && reading.carets.has(i)) {
      // A label's `^` that calls none of the reply's footnotes, escaped: it calls none in the export
      // either, nor matches another reply's footnote where a reader takes that for a link's definition.
      i = put(i, '\\^', i + 1);
    } else {
      if (sure && c === ']' && text[i + 1] === '(') looked(i, linkEnd(text, i + 1));
      else if (sure && c === ']' && text[i + 1] === '[') looked(i, bracketEnd(text, i + 1));
      else if (sure && (c === 'h' || c === 'H' || c === 'w' || c === 'W' || c === 'f' || c === 'F')) {
        const end = bareBeforeTag(i);
        if (end !== undefined) {
          // Written in `<…>`, it ends where the conversation ends it, as no `&lt;` would.
          i = put(i, `<${c === 'w' || c === 'W' ? 'http://' : ''}${text.slice(i, end)}>`, end);
          continue;
        }
        BARE_START.lastIndex = i;
        if (BARE_START.test(text)) looked(i, { end: stop[i], read: 0 });
      }
      i += 1;
    }
  }
  out.push(text.slice(from));
  return out.join('');
}

/**
 * Where a `[…]` that starts at `at` ends, past its `]`, for up to 1,000 characters: -1 past them,
 * undefined if it is no label; and how far it was read.
 */
function bracketEnd(text: string, at: number): { end: number | undefined; read: number } {
  const limit = Math.min(text.length, at + 1002);
  for (let i = at + 1; i < limit; i += 1) {
    const c = text[i];
    if (c === '\\') i += 1;
    else if (c === '[') return { end: undefined, read: i - at };
    else if (c === ']') return { end: i + 1, read: i - at };
  }
  return { end: limit < text.length ? -1 : undefined, read: limit - at };
}

/**
 * Where an inline link's address and title end, after the `(` at `at`, past their `)`, as
 * CommonMark reads them; -1 when that is more than 2,000 characters on, or not sure; undefined
 * when they are not an address and a title; and how far it was read.
 */
function linkEnd(text: string, at: number): { end: number | undefined; read: number } {
  const limit = Math.min(text.length, at + 2000);
  let i = at + 1;
  const found = (end: number | undefined) => ({ end, read: Math.min(i + 1, limit) - at });
  const cut = () => found(limit < text.length ? -1 : undefined);
  const blanks = () => {
    const from = i;
    let lines = 0;
    while (i < limit && (space(text[i]) || (text[i] === '\n' && lines++ === 0))) i += 1;
    return i > from;
  };
  blanks();
  if (text[i] === '<') {
    for (i += 1; i < limit && text[i] !== '>'; i += 1) {
      if (text[i] === '\n' || text[i] === '<') return found(undefined);
      if (text[i] === '\\') i += 1;
    }
    if (i >= limit) return cut();
    i += 1;
  } else {
    let depth = 0;
    for (; i < limit; i += 1) {
      const c = text[i]!;
      if (c === '\\' && ASCII_PUNCTUATION.test(text[i + 1] ?? '')) i += 1;
      else if (c === '(') depth += 1;
      else if (c === ')') {
        if (depth === 0) break;
        depth -= 1;
      } else if (c === ' ' || c === '\t' || c === '\n') {
        break;
      } else if (c < ' ' || c === '\x7f') {
        // Another control character: micromark takes it for no address, GitHub's reader and
        // commonmark.js for more of it, and markdown-it after a backslash.
        return found(-1);
      }
    }
    if (i >= limit) return cut();
    if (depth > 32) return found(-1);
    if (depth > 0) return found(undefined);
  }
  if (blanks() && /["'(]/.test(text[i] ?? '')) {
    const close = text[i] === '(' ? ')' : text[i];
    for (i += 1; i < limit && text[i] !== close; i += 1) {
      if (text[i] === '\\') i += 1;
      else if (close === ')' && text[i] === '(') return found(undefined);
      else if (text[i] === '\n' && /^\n[ \t]*\n/.test(text.slice(i, i + 200))) return found(undefined);
    }
    if (i >= limit) return cut();
    i += 1;
    blanks();
  }
  if (text[i] === ')') return found(i + 1);
  return i >= limit ? cut() : found(undefined);
}

/**
 * A picture as the conversation shows one: a link to it named by its words and its site, never
 * loaded, but a picture written into the reply itself (a data: address), which stays.
 */
function pictureLink(words: string, resource: string): string {
  // Before an address readers pass spaces, tabs and a line ending only: a no-break space is in it.
  const [location = ''] = resource.replace(/^[ \t\n]+/, '').replace(/^<([^>]*)>/, '$1').split(/[ \t\n]+/);
  // A `^` its words start with, escaped: `[^…]` would call a footnote, another reply's too.
  const name = words.trim().replace(/</g, '&lt;').replace(/^\^/, '\\^');
  if (/^data:image\//i.test(location)) return `![${name}](${resource})`;
  let site = '';
  try {
    if (/^(?:https?:)?\/\//i.test(location)) site = new URL(location, 'https://example.invalid').host;
  } catch {
    // Not an address: named by its words alone.
  }
  return `[${site ? `${name || 'Image'} · ${site}` : name || 'Image'}](${resource})`;
}
