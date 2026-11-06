/**
 * Quoting what you select, in plain text that reads the same in every Claude Code app: lines of a
 * file as `path:7-8` with the lines under it, anything else (a reply, a tool's output) as `>`
 * lines. Quotes wait above the message box and go above your words, each a block of its own.
 */

import { HEADER, QUOTED } from '../../shared/prompt-parts';

// How a prompt with quotes is shown: shared, as the export reads prompts the same way.
export { type PromptPart, promptParts } from '../../shared/prompt-parts';

/** What was selected: text from the conversation, or lines of a file from line `start` on, numbered as in the file. */
export type Selection = { text: string } | { text: string; path: string; start: number };

/** A file quote longer than this many lines keeps its first ones, and its range says so. */
export const MAX_QUOTE_LINES = 200;
/** Past this a quote is cut short: drafts are kept in the page, and a message must fit a request. */
const MAX_QUOTE_CHARS = 20_000;

const quoted = (lines: readonly string[]) => lines.map((line) => (line ? `> ${line}` : '>')).join('\n');

/**
 * The selection's lines. A file's are kept as they are, blank ones included, so they match their
 * numbers, all but the line break a selection of whole lines ends with; text from the conversation
 * loses the blank lines around it, and a run of them counts as one. Indentation stays either way:
 * output and code read by it.
 */
function linesOf(text: string, file: boolean): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trimEnd());
  if (file) {
    if (lines.length > 1 && lines.at(-1) === '') lines.pop();
    return lines;
  }
  const kept: string[] = [];
  for (const line of lines) {
    if (!line && (kept.length === 0 || kept.at(-1) === '')) continue;
    kept.push(line);
  }
  while (kept.at(-1) === '') kept.pop();
  return kept;
}

/** A quote's lines, past what a message can carry cut short at the end of a line. */
const capped = (body: string) => (body.length > MAX_QUOTE_CHARS ? body.slice(0, MAX_QUOTE_CHARS).replace(/\n[^\n]*$/, '') : body);

/**
 * Lines of a file quoted under where they are (`src/app.ts:7-8`, or `src/app.ts:7` for one line),
 * from line `start` on: the first ones when there are too many, and the range names exactly the
 * lines the quote holds. Empty when they are all blank.
 */
function fileQuote(path: string, start: number, lines: readonly string[]): string {
  if (!lines.some(Boolean)) return '';
  const body = capped(quoted(lines.slice(0, MAX_QUOTE_LINES)));
  const end = start + body.split('\n').length - 1;
  return `${path}:${end > start ? `${start}-${end}` : start}\n${body}`;
}

/**
 * The quote for a selection. A file's lines carry where they are; text from the conversation is
 * quoted as it reads. Empty when nothing but space was selected.
 */
export function quoteText(selection: Selection): string {
  if ('path' in selection) return fileQuote(selection.path, selection.start, linesOf(selection.text, true));
  const lines = linesOf(selection.text, false);
  if (lines.length === 0) return '';
  const body = quoted(lines);
  return body.length > MAX_QUOTE_CHARS ? `${capped(body)}\n> …` : body;
}

// A message with its quotes above the words: lib/drafts has it, as it loads with the first screen.
export { messageWithQuotes } from './drafts';

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

/**
 * Lines `from` to `to` of a file (numbered from 1), quoted with where they are: the file viewer's
 * Quote. They are the file's own lines, a blank last one too: there is no selection's line break
 * to leave out, so the quote holds every line its range names.
 */
export function quoteLines(path: string, from: number, to: number, lines: readonly string[]): string {
  return fileQuote(path, from, lines.slice(0, Math.max(0, to - from + 1)).map((line) => line.trimEnd()));
}

/**
 * Text put after what is already written, on lines of its own: an empty line before it when there
 * is text, and one after it for what is said about it (a request to Claude from Changes).
 */
export function withQuote(written: string, block: string): string {
  const before = written.replace(/\s+$/, '');
  return `${before ? `${before}\n\n` : ''}${block}\n\n`;
}
