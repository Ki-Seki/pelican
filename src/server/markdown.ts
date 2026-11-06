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
 * starts with http://, https:// or www., or an email. It does that to the text an escape leaves,
 * so only code keeps one text. An email is looked for only where a run of the characters it is
 * made of starts, so a long run of them is read once.
 */
const BARE_LINK = /(?<![\p{L}\p{N}])(?:(?:https?:\/\/|www\.)[^\s<`]*[^\s<`.,:;!?"')\]}*_~]|(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+)/giu;
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

// A reply, read line by line as the CommonMark spec's own reader reads it (commonmark.js), then
// the words of each block. Where readers part ways on a reply (that one, micromark under the
// conversation's react-markdown, and markdown-it in VS Code's preview), it is written so that they
// read it alike: indented code fenced, a footnote's or a link's definition as text, a blank line
// before a list item they would read apart. test/export-markdown.test.ts tries thousands.

/** A list item's marker: its kind, where it stands and how far in the item's lines go on. */
interface ListData {
  ordered: boolean;
  char: string;
  offset: number;
  padding: number;
}

/** A line of a paragraph, of code or of HTML: where it goes in the reply written out, what stands before its words, and its words. */
interface Line {
  at: number;
  prefix: string;
  text: string;
  /** A lazy line, going on a paragraph whose containers it left. */
  lazy?: boolean;
}

type Block =
  | { kind: 'quote' }
  | { kind: 'list'; data: ListData }
  | { kind: 'item'; data: ListData; empty: boolean }
  | { kind: 'paragraph'; lines: Line[] }
  | { kind: 'fence'; char: string; length: number; offset: number }
  | { kind: 'code'; lines: Line[] }
  | { kind: 'html'; type: number; lines: Line[] };

const space = (c: string | undefined) => c === ' ' || c === '\t';

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
const MAYBE_SPECIAL = /^[#`~*+_=<>0-9-]/;
// Each tried where the line's next character is (lastIndex), never on a copy of the rest of it.
const ATX = /#{1,6}(?:[ \t]+|$)/y;
const FENCE_OPEN = /`{3,}(?!.*`)|~{3,}/y;
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

/** A GitHub footnote's definition starting here (`[^label]:`): how long its marker is. */
function footnoteMarker(text: string): number | undefined {
  if (!text.startsWith('[^')) return undefined;
  let i = 2;
  let data = false;
  for (; i < text.length && i < 1004; i += 1) {
    const c = text[i]!;
    if (c === ']') break;
    if (c === '[' || /\s/.test(c)) return undefined;
    if (c === '\\' && /[[\\\]]/.test(text[i + 1] ?? '')) i += 1;
    data = true;
  }
  if (!data || text[i] !== ']' || text[i + 1] !== ':') return undefined;
  return i + 2;
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

/** What starts a line that goes on in these containers: a quote's `>`, an item's indentation. */
const inside = (chain: readonly Block[]) => chain.map((block) => (block.kind === 'quote' ? '> '
  : block.kind === 'item' ? ' '.repeat(block.data.offset + block.data.padding) : '')).join('');
/** A blank line that stays in these containers. */
const blankIn = (chain: readonly Block[]) => inside(chain).trimEnd();

/**
 * A reply as the conversation shows it, kept to itself. Its headings sit two levels down, under
 * the speakers' (`===` and `---` ones as `###` and `####`), so none passes for one; its HTML is
 * text, as the conversation shows it, so none is a heading or hides what follows; a picture is a
 * link to it, as the conversation shows one, never loaded; and a code block it leaves open is
 * closed at its end. The rest is as written: what the reader takes as code stays code.
 */
export function reply(text: string): string {
  const out: Array<string | undefined> = [];
  const open: Block[] = [];
  /** A blank line owed before the next line with something on it: after HTML written as text, which that line would otherwise join. */
  let owed: string | undefined;
  /** Whether the line being read has nothing on it. */
  let empty = false;
  const emit = (line: string | undefined) => {
    if (owed !== undefined && !empty) out.push(owed);
    owed = undefined;
    out.push(line);
    return out.length - 1;
  };

  const finalize = (block: Block, chain: readonly Block[]) => {
    if (block.kind === 'paragraph') {
      const words = inlineParagraph(block.lines);
      block.lines.forEach((line, i) => {
        out[line.at] = line.prefix + words[i]!;
      });
    } else if (block.kind === 'code') {
      // Indented code, fenced: readers differ on what indentation makes code, never on a fence. The
      // first line keeps the markers it started its containers with, and the fence takes them; the
      // lines after it go on in those containers.
      const last = block.lines.findLastIndex((line) => line.text.trim());
      const marks = fence(block.lines.slice(0, last + 1).map((line) => line.text).join('\n'), 3);
      const within = inside(chain);
      block.lines.forEach((line, i) => {
        const shown = !line.text.trim() ? line.prefix.trimEnd() : `${i === 0 ? within : line.prefix}${line.text}`;
        out[line.at] = `${i === 0 ? `${line.prefix}${marks}\n` : ''}${shown}${i === last ? `\n${within}${marks}` : ''}`;
      });
    } else if (block.kind === 'html') {
      block.lines.forEach((line, i) => {
        const next = block.lines[i + 1];
        const words = line.text.trim() ? textLine(line.text.trimEnd()) : '';
        out[line.at] = line.prefix + words + (words && next?.text.trim() ? '\\' : '');
      });
      owed = blankIn(chain);
    }
  };
  const closeFrom = (from: number) => {
    while (open.length > from) finalize(open.pop()!, open);
  };

  const lines = text.split(/\r\n?|\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!;
    empty = raw.trim() === '';
    const cur = new Cursor(raw);
    let matched = 0;
    let fenceClosed = false;
    for (; matched < open.length; matched += 1) {
      cur.findNextNonspace();
      if (cur.edge === undefined && !['quote', 'list', 'item'].includes(open[matched]!.kind)) cur.edge = cur.column;
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
      if (parent?.kind === 'item') parent.empty = false;
      open.push(block);
      container = open.length - 1;
    };
    /** A block of one line, a heading or a rule, done with at once: the line, as it is written out. */
    const single = (line: string) => {
      closeUnmatched();
      while (open.length > 0 && !holds(open.at(-1)!, { kind: 'paragraph', lines: [] })) finalize(open.pop()!, open);
      const parent = open.at(-1);
      if (parent?.kind === 'item') parent.empty = false;
      container = open.length - 1;
      emit(line);
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
    let started = false;
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
        if (!started && here === 'paragraph') cutShort = blankIn(open.slice(0, container));
        started = true;
        cur.advanceNextNonspace();
        cur.advance(1, false);
        if (space(raw[cur.offset])) cur.advance(1, true);
        cur.edge = cur.column;
        add({ kind: 'quote' });
        continue;
      }
      if (!cur.indented && c === '#' && (match = matchAt(ATX, raw, cur.next))) {
        const hashes = match[0].trimEnd().length;
        single(`${spaces(raw.slice(0, cur.next))}${'#'.repeat(Math.min(6, hashes + 2))}${inlineLine(raw.slice(cur.next + hashes))}`);
        handled = true;
        break;
      }
      if (!cur.indented && (c === '`' || c === '~') && (match = matchAt(FENCE_OPEN, raw, cur.next))) {
        add({ kind: 'fence', char: match[0][0]!, length: match[0].length, offset: cur.indent });
        // A `|` after the fence, escaped: markdown-it (VS Code's preview) takes a line with one
        // for a table's header when the next looks like its delimiter row, and no fence opens.
        const info = raw.slice(cur.next + match[0].length).replace(/\\*\|/g, (run) => (run.length % 2 === 1 ? `\\${run}` : run));
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
        closeUnmatched();
        const paragraph = open.pop() as Extract<Block, { kind: 'paragraph' }>;
        container = open.length - 1;
        const words = inlineParagraph(paragraph.lines).map((line) => line.trim()).join(' ');
        const [first, ...others] = paragraph.lines;
        out[first!.at] = `${first!.prefix}${match[0][0] === '=' ? '###' : '####'} ${words}`;
        for (const line of others) out[line.at] = undefined;
        handled = true;
        break;
      }
      if (!cur.indented && thematicBreak(cur, cur.next)) {
        single(spaces(raw.slice(0, cur.next)) + raw.slice(cur.next));
        handled = true;
        break;
      }
      if (!cur.indented || here === 'list') {
        const marker = cur.line.slice(cur.next, cur.next + 11);
        const data = listMarker(cur, here);
        if (data) {
          const empty = cur.offset > cur.last;
          if (!started && here === 'paragraph') cutShort = blankIn(open.slice(0, container));
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
          continue;
        }
      }
      if (cur.indented && tip !== 'paragraph' && !cur.blank) {
        cur.code = cur.column;
        cur.advance(4, true);
        add({ kind: 'code', lines: [] });
        break;
      }
      cur.advanceNextNonspace();
      break;
    }
    if (handled) continue;
    if (open.length > DEEPEST) {
      // Too deep to read on: what was read is written out, and from this line on, text.
      const top = open[0];
      closeFrom(0);
      if (top?.kind === 'fence') out.push(top.char.repeat(top.length));
      out.push('', asText(lines.slice(index).join('\n')));
      return out.filter((line): line is string => line !== undefined).join('\n');
    }

    const tip = open.at(-1);
    if (!closed && !cur.blank && tip?.kind === 'paragraph') {
      // A lazy line: it goes on the paragraph, whatever containers it left. Indented 4 columns or
      // more, markdown-it (VS Code's preview) takes it for code that ends them: a space written as
      // `&#32;` starts it instead, which every reader takes as more of the paragraph.
      const deep = cur.column - cur.edge >= 4;
      tip.lines.push({ at: emit(undefined), prefix: deep ? `${spaces(cut(raw, cur.edge)[0])}&#32;` : spaces(raw.slice(0, lineStart(cur))), text: raw.slice(lineStart(cur)), lazy: true });
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
      block.lines.push({ at: emit(undefined), prefix: spaces(raw.slice(0, lineStart(cur))), text: raw.slice(lineStart(cur)) });
    } else if (!cur.blank) {
      cur.advanceNextNonspace();
      const paragraph: Block = { kind: 'paragraph', lines: [] };
      add(paragraph);
      paragraph.lines.push({ at: emit(undefined), prefix: spaces(raw.slice(0, lineStart(cur))), text: raw.slice(lineStart(cur)) });
    } else {
      emit(spaces(raw));
    }
  }
  // A code block open at the end, not in a quote or a list (which what follows ends), is closed.
  const last = open[0];
  closeFrom(0);
  if (last?.kind === 'fence') out.push(last.char.repeat(last.length));
  return out.filter((line): line is string => line !== undefined).join('\n');
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
  return parent.kind === 'quote' || parent.kind === 'item';
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
    case 'paragraph':
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

// A reply's words: what the reader takes as code stays as written; elsewhere, HTML is text and a
// picture a link. Where the reader's code cannot be told for sure (a backquote in a link's
// address, a table's cell or a bare link, which the reader may take whole), none is taken as
// code from there on: the HTML in it is text then, which can only show as more.

const ASCII_PUNCTUATION = /[!-\/:-@[-`{-~]/;
const AUTOLINK = /<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>\x00-\x1f]*|[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/y;
const BARE_START = /https?:\/\/|www\./iy;
const SIMPLE_PICTURE = /!\[([^[\]\\`\n]{0,1000})\]\(/y;
/** A line that starts a link's reference definition, which the reader takes whole. */
const DEFINITION = /^\[(?:[^\]\\]|\\.){0,999}\]:/;
/** How many links' addresses a paragraph is read for before none of its code is taken for sure: each is read on, up to 2,000 characters. */
const LOOKS = 20;

/**
 * The words of a paragraph's lines, each line's as it is written out. A line that defines a
 * footnote, as GitHub's extensions have it, starts with its `[` escaped: readers without them take
 * it for a paragraph, and read what it holds otherwise, so it is written as one for all of them.
 */
function inlineParagraph(lines: readonly Line[]): string[] {
  const table = lines.some((line) => delimiterRow(line.text));
  // A `>` that starts a line here is text (the line goes on a paragraph); markdown-it (VS Code's
  // preview) still takes one with any indentation for a quote that goes on: escaped, it is text
  // there too. A paragraph that starts as a link's reference definition is text too: readers part
  // ways on where one ends and what the lines after it are.
  const text = lines.map((line, i) => (footnoteMarker(line.text) !== undefined || line.text.startsWith('>') || (i === 0 && DEFINITION.test(line.text))
    // A lazy line can make no table, but markdown-it takes one that looks like a table's delimiter row for one.
    || (line.lazy && delimiterRow(line.text)) ? `\\${line.text}` : line.text)).join('\n');
  // A lazy line that starts with a tag, which the spec's reader takes as more of the paragraph,
  // micromark (the conversation's reader) may take as HTML of its own: code reaching into it is not sure.
  const breaks: number[] = [];
  let at = 0;
  for (const line of lines) {
    if (line.lazy && line.text.startsWith('<')) breaks.push(at);
    at += line.text.length + 1;
  }
  return inline(text, { table, sure: true, breaks }).split('\n');
}

/** The words of a heading's line. */
const inlineLine = (text: string) => inline(text, { table: false, sure: true });

/** A table's delimiter row, which makes the paragraph's line above it a table's header: its cells split at `|`, code or not. */
function delimiterRow(text: string): boolean {
  if (!text.includes('|')) return false;
  const cells = text.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
  return cells.every((cell) => /^[ \t]*:?-+:?[ \t]*$/.test(cell));
}

/**
 * A paragraph's or a heading's words, HTML as text and pictures as links, outside what the reader
 * surely takes as code. `table`: the paragraph may be a table, whose cells split code at `|`;
 * `sure`: whether code can be told there at all.
 */
function inline(text: string, { table, sure, breaks = [] }: { table: boolean; sure: boolean; breaks?: readonly number[] }): string {
  const n = text.length;
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
  // Where the last run that starts code and finds nothing to end it stands, code read from the
  // start. Where a `[` comes before it, markdown-it (VS Code's preview), reading on for a `]`,
  // forgets the code it found on the way.
  let unpaired = -1;
  {
    const ahead = finder();
    for (let i = 0; i < n;) {
      if (text[i] === '\\' && ASCII_PUNCTUATION.test(text[i + 1] ?? '')) {
        i += 2;
      } else if (text[i] === '`') {
        let length = 1;
        while (text[i + length] === '`') length += 1;
        const end = ahead(i + length, length);
        if (end === undefined) unpaired = i;
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
  for (let i = n - 1; i >= 0; i -= 1) stop[i] = text.charCodeAt(i) <= 32 ? i : stop[i + 1]!;
  const ticks = new Int32Array(n + 1);
  for (let i = 0; i < n; i += 1) ticks[i + 1] = ticks[i]! + (text[i] === '`' ? 1 : 0);
  const quoteIn = (from: number, to: number) => ticks[Math.min(to, n)]! - ticks[from]! > 0;

  let looks = 0;
  /** Where the reader may take some words whole from `from` to `to`: none of the code after it is sure if it holds a backquote. */
  const takenWhole = (from: number, to: number | undefined) => {
    if (to !== undefined && (to < 0 || quoteIn(from, to))) sure = false;
  };
  /** Another look ahead, at most LOOKS in a paragraph: past them, none of its code is sure. */
  const look = () => {
    looks += 1;
    if (looks > LOOKS) sure = false;
    return sure;
  };

  const out: string[] = [];
  /** Where the words not yet written out start: they go out as they are. */
  let from = 0;
  /** The first of `breaks` past the place read. */
  let breakAt = 0;
  const put = (at: number, words: string, next: number) => {
    out.push(text.slice(from, at), words);
    from = next;
    return next;
  };
  let i = 0;
  while (i < n) {
    const c = text[i]!;
    if (c === '\\' && i + 1 < n && ASCII_PUNCTUATION.test(text[i + 1]!)) {
      // An escaped `<` as `&lt;`: a bare link just before it would take the backslash into its address.
      i = text[i + 1] === '<' ? put(i, '&lt;', i + 2) : i + 2;
    } else if (c === '`') {
      let length = 1;
      while (text[i + length] === '`') length += 1;
      const end = sure ? closer(i + length, length) : undefined;
      // Which is code is not sure from here on: where a table's `|`, which ends a cell, would end it;
      // where it reaches a line a reader may take apart; or past a run of backquotes that ends no
      // code, after which markdown-it (VS Code's preview), misled by what it noted on the way, loses code.
      if (end !== undefined && table && /(?:^|[^\\])\|/.test(text.slice(i, end + length))) sure = false;
      while (breaks[breakAt] !== undefined && breaks[breakAt]! <= i) breakAt += 1;
      if (end !== undefined && breaks[breakAt] !== undefined && breaks[breakAt]! < end) sure = false;
      if (end === undefined) sure = false;
      i = end !== undefined && sure ? end + length : i + length;
    } else if (c === '<') {
      AUTOLINK.lastIndex = i;
      const link = AUTOLINK.exec(text);
      if (link) i += link[0].length;
      else if (/[A-Za-z/!?]/.test(text[i + 1] ?? '')) i = put(i, '&lt;', i + 1);
      else i += 1;
    } else if (c === '!' && text[i + 1] === '[') {
      SIMPLE_PICTURE.lastIndex = i;
      const picture = sure && look() ? SIMPLE_PICTURE.exec(text) : null;
      const end = picture ? linkEnd(text, i + picture[0].length - 1) : undefined;
      // One this does not read whole is its words, not a picture.
      i = picture && end !== undefined && end > 0
        ? put(i, pictureLink(picture[1]!, text.slice(i + picture[0].length, end - 1), text.slice(i, end)), end)
        : put(i, '\\!', i + 1);
    } else {
      if (sure && c === '[' && unpaired > i) sure = false;
      else if (sure && c === ']' && text[i + 1] === '(' && look()) takenWhole(i, linkEnd(text, i + 1));
      else if (sure && c === ']' && text[i + 1] === '[' && look()) takenWhole(i, bracketEnd(text, i + 1));
      else if (sure && c === '[' && text[i + 1] === '^' && look()) takenWhole(i, bracketEnd(text, i));
      else if (sure && (c === 'h' || c === 'H' || c === 'w' || c === 'W')) {
        BARE_START.lastIndex = i;
        if (BARE_START.test(text)) takenWhole(i, stop[i]);
      }
      i += 1;
    }
  }
  out.push(text.slice(from));
  return out.join('');
}

/** Where a `[…]` that starts at `at` ends, past its `]`, for up to 1,000 characters: -1 past them, undefined if it is no label. */
function bracketEnd(text: string, at: number): number | undefined {
  const limit = Math.min(text.length, at + 1002);
  for (let i = at + 1; i < limit; i += 1) {
    const c = text[i];
    if (c === '\\') i += 1;
    else if (c === '[') return undefined;
    else if (c === ']') return i + 1;
  }
  return limit < text.length ? -1 : undefined;
}

/**
 * Where an inline link's address and title end, after the `(` at `at`, past their `)`, as
 * CommonMark reads them; -1 when that is more than 2,000 characters on, or not sure; undefined
 * when they are not an address and a title.
 */
function linkEnd(text: string, at: number): number | undefined {
  const limit = Math.min(text.length, at + 2000);
  const cut = limit < text.length ? -1 : undefined;
  let i = at + 1;
  const blanks = () => {
    const from = i;
    let lines = 0;
    while (i < limit && (space(text[i]) || (text[i] === '\n' && lines++ === 0))) i += 1;
    return i > from;
  };
  blanks();
  if (text[i] === '<') {
    for (i += 1; i < limit && text[i] !== '>'; i += 1) {
      if (text[i] === '\n' || text[i] === '<') return undefined;
      if (text[i] === '\\') i += 1;
    }
    if (i >= limit) return cut;
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
      } else if (c <= ' ' || c === '\x7f') break;
    }
    if (i >= limit) return cut;
    if (depth > 32) return -1;
    if (depth > 0) return undefined;
  }
  if (blanks() && /["'(]/.test(text[i] ?? '')) {
    const close = text[i] === '(' ? ')' : text[i];
    for (i += 1; i < limit && text[i] !== close; i += 1) {
      if (text[i] === '\\') i += 1;
      else if (close === ')' && text[i] === '(') return undefined;
      else if (text[i] === '\n' && /^\n[ \t]*\n/.test(text.slice(i, i + 200))) return undefined;
    }
    if (i >= limit) return cut;
    i += 1;
    blanks();
  }
  if (text[i] === ')') return i + 1;
  return i >= limit ? cut : undefined;
}

/**
 * A picture as the conversation shows one: a link to it named by its words and its site, never
 * loaded, but a picture written into the reply itself (a data: address), which stays.
 */
function pictureLink(words: string, destination: string, written: string): string {
  const [address = ''] = destination.trim().replace(/^<([^>]*)>/, '$1').split(/[ \t\n]+/);
  if (/^data:image\//i.test(address)) return written;
  let site = '';
  try {
    if (/^(?:https?:)?\/\//i.test(address)) site = new URL(address, 'https://example.invalid').host;
  } catch {
    // Not an address: named by its words alone.
  }
  const name = words.trim().replace(/</g, '&lt;') || 'Image';
  return `[${site ? `${name} · ${site}` : name}](${destination})`;
}
