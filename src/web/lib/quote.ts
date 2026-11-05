/**
 * Text quoted into the message being written: plain text, so it reads the same in every app the
 * session is open in (the terminal, Claude Desktop), and the way Claude Code itself names lines.
 * - Lines of a file: `path:7-8` (or `path:7`), then each line as a `> ` line, as line comments do.
 * - Prose (a reply, a note): each line as a `> ` line.
 * At most MAX_QUOTED lines go in; a note says how many more there were.
 */
export const MAX_QUOTED = 200;

function quoted(lines: readonly string[]): string {
  const shown = lines.slice(0, MAX_QUOTED).map((line) => (line ? `> ${line}` : '>'));
  if (lines.length > MAX_QUOTED) shown.push(`> … (${lines.length - MAX_QUOTED} more lines)`);
  return shown.join('\n');
}

/** Lines `from` to `to` of a file (numbered from 1), with where they are first. */
export function quoteLines(path: string, from: number, to: number, lines: readonly string[]): string {
  const where = to > from ? `${path}:${from}-${to}` : `${path}:${from}`;
  return `${where}\n${quoted(lines)}`;
}

/** Prose, quoted line by line. */
export function quoteText(text: string): string {
  return quoted(text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n'));
}

/**
 * A quote put after what is already written: on a line of its own, with an empty line before it
 * when there is text, and one after it for what is said about it.
 */
export function withQuote(written: string, quote: string): string {
  const before = written.replace(/\s+$/, '');
  return `${before ? `${before}\n\n` : ''}${quote}\n\n`;
}
