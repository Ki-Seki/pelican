/**
 * Quoting what you select, in plain text that reads the same in every Claude Code app: lines of a
 * file as `path:7-8` with the lines under it, anything else (a reply, a tool's output) as `>`
 * lines. Quotes wait above the message box and go above your words, each a block of its own.
 */

/** What was selected: text from the conversation, or lines of a file, numbered as in the file. */
export type Selection = { text: string } | { text: string; path: string; start: number; end?: number };

/** A file quote longer than this many lines keeps its first ones, and its range says so. */
export const MAX_QUOTE_LINES = 200;
/** Past this a quote is cut short: drafts are kept in the page, and a message must fit a request. */
const MAX_QUOTE_CHARS = 20_000;

/** Where a quote is from: a path and a line or a range, as a line comment names it too (lib/review). */
const HEADER = /^(\S(?:.*\S)?):(\d+)(?:-(\d+))?( \(removed\))?$/;
const QUOTED = /^>( |$)/;
const FENCE = /^\s*(```|~~~)/;

const quoted = (lines: string[]) => lines.map((line) => (line ? `> ${line}` : '>')).join('\n');

/**
 * The selection's lines. A file's are kept as they are, blank ones included, so they match their
 * numbers; text from the conversation loses the blank lines around it, and a run of them counts
 * as one. Indentation stays either way: output and code read by it.
 */
function linesOf(text: string, file: boolean): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trimEnd());
  if (file) {
    if (lines.length > 1 && lines.at(-1) === '') lines.pop();
    return lines.some(Boolean) ? lines : [];
  }
  const kept: string[] = [];
  for (const line of lines) {
    if (!line && (kept.length === 0 || kept.at(-1) === '')) continue;
    kept.push(line);
  }
  while (kept.at(-1) === '') kept.pop();
  return kept;
}

/**
 * The quote for a selection. A file's lines carry where they are (`src/app.ts:7-8`, or
 * `src/app.ts:7` for one line); text from the conversation is quoted as it reads. Empty when
 * nothing but space was selected.
 */
export function quoteText(selection: Selection): string {
  const file = 'path' in selection;
  let lines = linesOf(selection.text, file);
  if (lines.length === 0) return '';
  let cut = false;
  if (file && lines.length > MAX_QUOTE_LINES) {
    lines = lines.slice(0, MAX_QUOTE_LINES);
    cut = true;
  }
  let body = quoted(lines);
  if (body.length > MAX_QUOTE_CHARS) {
    body = body.slice(0, MAX_QUOTE_CHARS).replace(/\n[^\n]*$/, '');
    cut = true;
  }
  if (!file) return cut ? `${body}\n> …` : body;
  // Cut short, the range names the lines the quote holds, not all those selected.
  const end = cut ? selection.start + body.split('\n').length - 1 : selection.end ?? selection.start + lines.length - 1;
  return `${selection.path}:${end > selection.start ? `${selection.start}-${end}` : selection.start}\n${body}`;
}

/** A message with its quotes above the words, as Claude reads it: each block apart from the next. */
export function messageWithQuotes(quotes: readonly string[], text: string): string {
  return [...quotes.map((q) => q.trim()), text.trim()].filter(Boolean).join('\n\n');
}

/**
 * The quotes a message starts with, as messageWithQuotes put them there, and the words after
 * them: what goes back above the message box when a send fails.
 */
export function splitQuotes(message: string): { quotes: string[]; text: string } {
  const lines = message.split('\n');
  const quotes: string[] = [];
  let at = 0;
  for (;;) {
    let end = at;
    if (HEADER.test(lines[end] ?? '') && QUOTED.test(lines[end + 1] ?? '')) end += 1;
    if (!QUOTED.test(lines[end] ?? '')) break;
    while (QUOTED.test(lines[end] ?? '')) end += 1;
    // Each ends at a blank line, or the message does: words right under one are not of this shape.
    if (end < lines.length && lines[end] !== '') break;
    quotes.push(lines.slice(at, end).join('\n'));
    at = end;
    while (at < lines.length && lines[at] === '') at += 1;
  }
  return { quotes, text: lines.slice(at).join('\n') };
}

/** A prompt as it is shown: its words, and the quotes in it (where one is from, and what it says). */
export type PromptPart = { kind: 'text'; text: string } | { kind: 'quote'; from?: string; text: string };

/**
 * A prompt cut into its words and its quotes: a quote is a run of lines that start with `>`, with
 * the `path:line` line just above it when there is one (a quote from a file, a comment on a line).
 * Lines in a fenced code block are never a quote.
 */
export function promptParts(text: string): PromptPart[] {
  const lines = text.split('\n');
  const parts: PromptPart[] = [];
  let words: string[] = [];
  let fenced = false;
  const flush = () => {
    const kept = words.join('\n').replace(/^\n+|\n+$/g, '');
    if (kept) parts.push({ kind: 'text', text: kept });
    words = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (FENCE.test(line)) fenced = !fenced;
    const from = !fenced && HEADER.test(line) && QUOTED.test(lines[i + 1] ?? '') ? line : undefined;
    const first = from ? i + 1 : i;
    if (fenced || !QUOTED.test(lines[first] ?? '')) {
      words.push(line);
      continue;
    }
    let end = first;
    while (end < lines.length && QUOTED.test(lines[end]!)) end += 1;
    flush();
    parts.push({ kind: 'quote', ...(from ? { from } : {}), text: lines.slice(first, end).map((l) => l.replace(QUOTED, '')).join('\n') });
    i = end - 1;
  }
  flush();
  return parts;
}

/** What a quote waiting above the message box is called: where it is from, or how it begins. */
export function quoteLabel(quote: string): string {
  const [first = '', second = ''] = quote.split('\n');
  const header = QUOTED.test(second) ? HEADER.exec(first) : null;
  if (header) return `${header[1]!.split('/').pop()}:${header[3] ? `${header[2]}-${header[3]}` : header[2]}`;
  return quote.split('\n').map((line) => line.replace(QUOTED, '').trim()).find(Boolean) ?? '';
}

/**
 * Quotes on their way to a message box, by the box's draft key (the chat's view id). The box open
 * for that key takes them at once; with none open, they wait here for it.
 */
const waiting = new Map<string, string[]>();
const takers = new Map<string, (quote: string) => void>();

/** Puts a quote above a chat's message box, for example `addQuote(viewId, quoteText(selection))`. */
export function addQuote(key: string, quote: string): void {
  if (!quote.trim()) return;
  const take = takers.get(key);
  if (take) take(quote);
  else waiting.set(key, [...(waiting.get(key) ?? []), quote]);
}

/** The message box for `key` takes the quotes added for it, first those that waited; returns how to stop. */
export function receiveQuotes(key: string, take: (quote: string) => void): () => void {
  takers.set(key, take);
  const queued = waiting.get(key) ?? [];
  waiting.delete(key);
  for (const quote of queued) take(quote);
  return () => {
    if (takers.get(key) === take) takers.delete(key);
  };
}
