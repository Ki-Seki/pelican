/**
 * A prompt as Claude Desktop writes one, read back: the files it attached (`@"path"` on its first
 * line), the quotes it replies to with a note (`<!-- reply N -->` blocks), quotes and file lines
 * attached as context (`<!-- attach -->` blocks), comments on lines (In `path` at line N:, with
 * the code fenced under it), then the words typed. Pelican writes its messages the same way
 * (web/lib/quote), so each app shows the other's, and still reads its own older `>` quotes and
 * `path:line` headers. Only the text decides; nothing else is sent along.
 */

export type PromptPart =
  | { kind: 'text'; text: string }
  /** A quote: with a note (a reply), or with a label (lines of a file, a terminal tab) or none. */
  | { kind: 'quote'; text: string; note?: string; label?: string; tab?: string }
  | { kind: 'comment'; path: string; lines: [number, number]; removed: boolean; code?: string; lang?: string; note: string }
  | { kind: 'file'; path: string; folder: boolean };

/** Desktop's markers. */
export const REPLY = '<!-- reply -->';
const REPLY_COUNT = /^<!-- reply ([1-9][0-9]?) -->\n(?=> |>$)/;
/** Lines that are a quote, from where it is set (sticky). */
const QUOTE_RUN = /(?:>(?: |$).*\n?)+/y;
const NEXT_REPLY = `\n\n${REPLY}\n>`;
const SEND_NOW = /^<!-- reply -->\n((?:>(?: |$).*\n?)+)\n*/;
const ATTACH = /^<!-- attach(?:: (.*?))?(?: \| tab:(\S+))? -->$/;
const COMMENT = /^In `([^`\n]+)` at lines? (\d+)(?:-(\d+))?( \(before changes\))?(?: \u2014 review comment from [@\uFF20]\S+)?:$/;
const FILES = /^@"[^"\n]+"(?: @"[^"\n]+")*\n/;
const FENCE = /^\s*(`{3,}|~{3,})/;
/** Pelican's own older quotes: a line that starts with >, and the `path:line` above a quote of a file. */
const OLDER_HEADER = /^(\S(?:.*\S)?):(\d+)(?:-(\d+))?( \(removed\))?$/;
const QUOTED = /^>( |$)/;

/** A quote's text from its `> ` lines. */
export const unquote = (lines: string): string => lines.split('\n').map((line) => line.replace(/^> ?/, '')).join('\n').trim();

/** What Desktop escaped in your words and notes, as you wrote it. */
const unescape = (text: string) => text.replace(/&lt;(!-- reply|artifact-view-context|artifact-start-context)/g, '<$1');

type ReplyBlock = { quote: string; note: string };

/**
 * The reply blocks a message starts with, as Desktop reads them: the first marker counts the
 * blocks (1 to 99), each block is its `> ` lines, a blank line and the note, the next starts with
 * a bare marker, and three line breaks end them. Null when the message does not start so.
 */
function replyBlocks(text: string): { blocks: ReplyBlock[]; rest: number } | null {
  const head = REPLY_COUNT.exec(text);
  if (!head) return null;
  const count = Number(head[1]);
  const blocks: ReplyBlock[] = [];
  let markerEnd = head[0].length;
  let end = -2;
  for (;;) {
    QUOTE_RUN.lastIndex = markerEnd;
    const quote = QUOTE_RUN.exec(text);
    if (!quote) return null;
    const after = markerEnd + quote[0].length;
    const close = text.charCodeAt(after - 1) === 10 ? after - 1 : after;
    let body = after;
    while (text.charCodeAt(body) === 10) body += 1;
    if (body - close >= 3) {
      blocks.push({ quote: unquote(quote[0]), note: '' });
      return { blocks, rest: close + 3 };
    }
    if (end !== -1 && end < body) end = text.indexOf('\n\n\n', body);
    const limit = end === -1 ? text.length : end;
    let next = -1;
    if (blocks.length + 1 < count) {
      for (let at = text.indexOf(NEXT_REPLY, body); at !== -1 && at < limit; at = text.indexOf(NEXT_REPLY, at + 1)) {
        QUOTE_RUN.lastIndex = at + NEXT_REPLY.length - 1;
        if (QUOTE_RUN.test(text)) {
          next = at;
          break;
        }
      }
    }
    blocks.push({ quote: unquote(quote[0]), note: unescape(text.slice(body, next === -1 ? limit : next).trim()) });
    if (next === -1) return { blocks, rest: end === -1 ? text.length : end + 3 };
    markerEnd = next + 2 + REPLY.length + 1;
  }
}

/** Where a fenced block that opens at `lines[at]` closes: the index of its closing fence, or -1. */
function fenceEnd(lines: readonly string[], at: number): number {
  const open = FENCE.exec(lines[at] ?? '')?.[1];
  if (!open) return -1;
  for (let i = at + 1; i < lines.length; i += 1) {
    const close = /^\s*(`{3,}|~{3,})\s*$/.exec(lines[i]!)?.[1];
    if (close && close[0] === open[0] && close.length >= open.length) return i;
  }
  return -1;
}

/**
 * The rest of a message, after its files and reply blocks: attach blocks and line comments where
 * they stand, Pelican's older quotes, and the words between them. A fenced block that is not a
 * comment's code stays part of the words, and nothing in it is read as a quote.
 */
function readBody(text: string): PromptPart[] {
  const lines = text.split('\n');
  const parts: PromptPart[] = [];
  let words: string[] = [];
  const flush = () => {
    const kept = words.join('\n').replace(/^\n+|\n+$/g, '');
    if (kept.trim()) parts.push({ kind: 'text', text: unescape(kept) });
    words = [];
  };
  const quoteRun = (from: number) => {
    let end = from;
    while (end < lines.length && QUOTED.test(lines[end]!)) end += 1;
    return end;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const attach = ATTACH.exec(line);
    if (attach && QUOTED.test(lines[i + 1] ?? '')) {
      const end = quoteRun(i + 1);
      flush();
      const label = attach[1]?.trim();
      parts.push({ kind: 'quote', text: unquote(lines.slice(i + 1, end).join('\n')), ...(label ? { label } : {}), ...(attach[2] ? { tab: attach[2] } : {}) });
      i = end - 1;
      continue;
    }
    const comment = COMMENT.exec(line);
    const codeEnd = comment ? fenceEnd(lines, i + 1) : -1;
    if (comment && codeEnd > i + 1) {
      flush();
      const lang = lines[i + 1]!.replace(/^\s*(?:`{3,}|~{3,})/, '').trim();
      // Its note runs until a blank line before the next comment, or the blank lines before your words.
      let end = codeEnd + 1;
      while (end < lines.length) {
        if (lines[end] === '' && (lines[end + 1] === '' || (COMMENT.test(lines[end + 1] ?? '') && fenceEnd(lines, end + 2) > end + 2))) break;
        end += 1;
      }
      const start = Number(comment[2]);
      parts.push({
        kind: 'comment',
        path: comment[1]!,
        lines: [start, comment[3] ? Number(comment[3]) : start],
        removed: Boolean(comment[4]),
        code: lines.slice(i + 2, codeEnd).join('\n'),
        ...(lang ? { lang } : {}),
        note: unescape(lines.slice(codeEnd + 1, end).join('\n').trim()),
      });
      i = end - 1;
      continue;
    }
    if (FENCE.test(line)) {
      const end = fenceEnd(lines, i);
      const last = end === -1 ? lines.length - 1 : end;
      words.push(...lines.slice(i, last + 1));
      i = last;
      continue;
    }
    const older = OLDER_HEADER.exec(line);
    const first = older && QUOTED.test(lines[i + 1] ?? '') ? i + 1 : i;
    if (QUOTED.test(lines[first] ?? '')) {
      const end = quoteRun(first);
      flush();
      parts.push({ kind: 'quote', text: lines.slice(first, end).map((l) => l.replace(QUOTED, '')).join('\n'), ...(first > i ? { label: line } : {}) });
      i = end - 1;
      continue;
    }
    words.push(line);
  }
  flush();
  return parts;
}

/** A prompt in its parts, in the order they read: files, the quotes it replies to, then the rest. */
export function readPrompt(text: string): PromptPart[] {
  const parts: PromptPart[] = [];
  let rest = text.replace(/\r\n/g, '\n');
  const files = FILES.exec(rest);
  if (files) {
    for (const [, path] of files[0].matchAll(/@"([^"\n]+)"/g)) parts.push({ kind: 'file', path: path!.replace(/\/$/, ''), folder: path!.endsWith('/') });
    rest = rest.slice(files[0].length);
  }
  const replies = rest.startsWith('<!-- reply') ? replyBlocks(rest) : null;
  if (replies) {
    for (const block of replies.blocks) parts.push({ kind: 'quote', text: block.quote, ...(block.note ? { note: block.note } : {}) });
    rest = rest.slice(replies.rest);
  } else {
    // Send now: one reply, its note the rest of the message.
    const now = SEND_NOW.exec(rest);
    if (now) {
      const after = readBody(rest.slice(now[0].length));
      const note = after.length > 0 && after.every((part) => part.kind === 'text') ? after.map((part) => (part.kind === 'text' ? part.text : '')).join('\n\n') : '';
      parts.push({ kind: 'quote', text: unquote(now[1]!), ...(note ? { note } : {}) });
      if (!note) parts.push(...after);
      return parts;
    }
  }
  parts.push(...readBody(rest));
  return parts;
}

/** Whether a prompt holds anything but words: a quote, a comment or a file. */
export const hasQuotes = (parts: readonly PromptPart[]): boolean => parts.some((part) => part.kind !== 'text');

/**
 * A prompt in a few words, for a title or a one-line preview: what was typed, or else the first
 * note, the first quote, or the files.
 */
export function promptGist(text: string): string {
  const parts = readPrompt(text);
  if (!hasQuotes(parts)) return text;
  const typed = parts.filter((part) => part.kind === 'text').map((part) => (part.kind === 'text' ? part.text : '')).join('\n\n');
  if (typed.trim()) return typed;
  for (const part of parts) {
    if ((part.kind === 'quote' || part.kind === 'comment') && part.note) return part.note;
  }
  const quote = parts.find((part) => part.kind === 'quote');
  if (quote?.kind === 'quote') return quote.text;
  return parts.flatMap((part) => (part.kind === 'file' ? [part.path] : [])).join(' ');
}
