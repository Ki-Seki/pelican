/**
 * Quotes, line comments and files waiting to go with the next message, and that message as Claude
 * Desktop writes it, byte for byte, so Desktop and the CLI see Pelican's quotes as replies, and
 * Pelican shows theirs (shared/quoted reads them back):
 *
 *   @"src/prefs.ts"                         files attached, on the first line
 *   <!-- reply 2 -->                        quotes with a note: the first marker counts them
 *   > first quote
 *
 *   first note
 *
 *   <!-- reply -->
 *   > second quote
 *
 *   second note
 *
 *
 *   In `src/theme.css` at line 12:          line comments, then three line breaks
 *   ```css
 *   --surface: #fff;
 *   ```
 *   Keep it
 *
 *
 *   <!-- attach -->                         quotes with no note, each a block
 *   > a passage
 *
 *   <!-- attach: src/app.ts:7-8 -->         lines of a file carry where they are
 *   > const a = 1;
 *
 *   your words
 */

import { promptGist, type PromptPart, readPrompt, REPLY } from '../../shared/quoted';
import { MAX_REPLIES } from './drafts';
import { baseName, clockTime } from './format';
import { newId } from './ids';
import { commentsMessage, type CommentBlock } from './review';
import { capQuote, defuseMentions, LINE_BREAK, quotedLines } from './sanitize';
import { maskSecrets } from './secrets';

export { promptGist, readPrompt };
export type { PromptPart };

export { MAX_REPLIES };

/** Desktop's words when a message holds as many quotes with a note as it can. */
export const TOO_MANY_REPLIES = 'Your message can hold up to 99 quotes with a note. Send it, then add more.';

/** Where a waiting item was taken from. */
export type QuoteFrom = {
  /**
   * Claude's reply, your prompt, a step's output, the side chat's answer, a file, a diff, the
   * terminal; `earlier` for one read back from a message, where nothing says.
   */
  what: 'reply' | 'prompt' | 'step' | 'side' | 'file' | 'diff' | 'terminal' | 'earlier';
  /** The conversation item it is in (its data-quote-from), to show it there again. */
  key?: string;
  /** When that was said. */
  at?: number;
  /** Where the passage is in that item: how many characters other than spaces come before its start, and before its end. */
  span?: [number, number];
};

/** What waits above the message box for the next message: a quote, a line comment or a file. */
export type WaitingItem = {
  id: string;
  kind: 'quote' | 'file' | 'comment';
  /** A quote's passage (secrets masked, 1,500 characters at most), a comment's code, a file's path. */
  text: string;
  /** What you said about it: a quote's note, which makes it a reply, or a comment. */
  note?: string;
  from: QuoteFrom;
  /** The file a quote of lines or a comment is in. */
  path?: string;
  /** Its first and last line. */
  lines?: [number, number];
  /** A comment's line as the diff marked it; a removed one is Desktop's "before changes". */
  side?: 'add' | 'del' | 'same';
  /** A folder attached, not a file. */
  folder?: boolean;
  /**
   * The terminal tab a quote of output is from, and what its header calls it (the tab's title, as
   * Desktop names it; "Terminal" when it has none): `<!-- attach: zsh | tab:2 -->`. A label also
   * keeps what a header read back from a message said, when it is not lines of a file.
   */
  tab?: string;
  label?: string;
};

/** A quote with a note: a reply, in Desktop's word. */
export const isReply = (item: WaitingItem): boolean => item.kind === 'quote' && Boolean(item.note?.trim());

/* ---------- making one ---------- */

/**
 * A passage as a quote holds it, as Claude Desktop prepares one: secrets masked, then cut to
 * 1,500 characters. Text from the conversation loses the space around it; lines of a file keep
 * their indentation and lose only the line breaks around them.
 */
export function preparePassage(text: string, lines = false): string {
  const kept = lines ? text.replace(/^(?:\r?\n)+|(?:\r?\n)+$/g, '') : text.trim();
  return capQuote(maskSecrets(kept));
}

/** A quote of `text`, or nothing for one shorter than two characters (Desktop's least). */
export function quoteItem(text: string, from: QuoteFrom, extra: Partial<Pick<WaitingItem, 'note' | 'path' | 'lines' | 'tab' | 'label'>> = {}): WaitingItem | undefined {
  const passage = preparePassage(text, Boolean(extra.lines));
  if (passage.trim().length < 2 && !extra.lines) return undefined;
  if (!passage.trim()) return undefined;
  return { id: newId(), kind: 'quote', text: passage, from, ...extra };
}

/** A file or folder attached as context, sent as an @"path" mention. */
export const fileItem = (path: string, folder = false): WaitingItem => ({ id: newId(), kind: 'file', text: path, path, from: { what: 'file' }, ...(folder ? { folder } : {}) });

/* ---------- what Claude receives ---------- */

/** `<!-- attach -->`, or with a label (where lines are from) and a terminal tab: `<!-- attach: src/a.ts:7-8 -->`. */
export function attachHeader(label?: string, tab?: string): string {
  if (!label && !tab) return '<!-- attach -->';
  let shown = label?.replace(new RegExp(LINE_BREAK, 'g'), ' ');
  while (shown !== undefined && /-->|\|/.test(shown)) shown = shown.replace(/-->|\|/g, '');
  shown = shown === undefined ? undefined : defuseMentions(shown).trim();
  return `<!-- attach: ${[shown, tab ? `tab:${tab}` : undefined].filter(Boolean).join(' | ')} -->`;
}

/** A label for lines of a file: `src/app.ts:7-8`, or `src/app.ts:12` for one. */
export const linesLabel = (path: string, lines?: [number, number]): string => (lines ? `${path}:${lines[0] === lines[1] ? lines[0] : `${lines[0]}-${lines[1]}`}` : path);

/** A quote with no note, as context: Desktop's attach block, its header naming lines of a file, or a terminal tab. */
export function attachBlock(item: WaitingItem): string {
  const label = item.path ? linesLabel(item.path, item.lines) : item.label ?? (item.tab ? 'Terminal' : undefined);
  return `${attachHeader(label, item.tab)}\n${quotedLines(item.text)}`;
}

/** Lines in a note that read as a reply marker are written `&lt;!-- reply…`; three line breaks or more become two. */
const escapeNote = (note: string) => note.replace(/^<!-- reply(?: [0-9]+)? -->$/gm, (marker) => `&lt;${marker.slice(1)}`).replace(/\n{3,}/g, '\n\n');

/** A numbered reply marker in your words is written `&lt;!-- reply N -->`, so it is never read as one. */
export const escapeWords = (text: string): string => text.replace(/<!-- reply [0-9]+ -->/g, (marker) => `&lt;${marker.slice(1)}`);

/** Desktop's contexts of its own, never taken from a message: written `&lt;…`. */
const escapeContexts = (text: string) => text.replace(/<(artifact-view-context|artifact-start-context)/g, '&lt;$1');

/**
 * Quotes with a note, as Desktop's reply blocks: the first marker counts them (99 at most), each
 * is its `> ` lines, a blank line and the note, one blank line apart.
 */
export function replyBlocks(replies: readonly WaitingItem[]): string {
  return replies
    .slice(0, MAX_REPLIES)
    .map((reply) => `${quotedLines(reply.text)}\n\n${escapeNote((reply.note ?? '').trim())}`)
    .map((block, i, all) => `${i === 0 ? `<!-- reply ${all.length} -->` : REPLY}\n${block}`)
    .join('\n\n');
}

/** Send now from the note box: one reply on its own, which steers Claude while it works. */
export const sendNowMessage = (text: string, note: string): string => `${REPLY}\n${quotedLines(text)}\n\n${note.trim()}`;

/** A file as Desktop mentions one: `@"src/prefs.ts"`, a folder with its slash. */
export const fileMention = (path: string, folder = false): string => `@"${path.replaceAll('"', '').replace(/[/\\]+$/, '')}${folder ? '/' : ''}"`;

/** A comment, or lines of a file with a note, as a comment on those lines; one with no code, as Desktop writes it, without any. */
const commentOf = (item: WaitingItem): CommentBlock => ({
  path: item.path ?? '',
  lines: item.lines ?? [1, 1],
  removed: item.side === 'del',
  ...(item.text !== '' ? { code: item.text } : {}),
  note: item.note ?? '',
});

/**
 * The message for `typed` with what waits, in Desktop's order: the files, the replies and three
 * line breaks, the comments and three more, the attached quotes, your words. Lines of a file
 * with a note go as a comment on them, as Desktop's Add comment on a file does.
 */
export function messageWith(items: readonly WaitingItem[], typed: string): string {
  const files = items.filter((item) => item.kind === 'file');
  const replies = items.filter((item) => isReply(item) && !item.path);
  const comments = items.filter((item) => item.kind === 'comment' || (isReply(item) && item.path));
  const attached = items.filter((item) => item.kind === 'quote' && !isReply(item));
  // Past Desktop's 99, a reply goes among your words, its quote and note as they read.
  const extra = replies.slice(MAX_REPLIES).map((reply) => escapeWords(`${quotedLines(reply.text)}\n\n${(reply.note ?? '').trim()}`));
  const words = [...extra, ...(typed !== '' ? [escapeWords(typed)] : [])];
  const body = escapeContexts((attached.length > 0 ? `${attached.map(attachBlock).join('\n\n')}\n\n` : '') + words.join('\n\n'));
  const commented = comments.length > 0 ? commentsMessage(comments.map(commentOf), body) : body.trim();
  const section = replies.length > 0 ? escapeContexts(replyBlocks(replies)) : '';
  const head = files.length > 0 ? `${files.map((file) => fileMention(file.path ?? file.text, file.folder)).join(' ')}\n` : '';
  return head + (section ? `${section}\n\n\n${commented}` : commented);
}

/* ---------- read back ---------- */

const NUMBERS = /^(.+):(\d+)(?:-(\d+))?$/;

/**
 * A message's waiting items and words, as messageWith put them together: what comes back to the
 * box when a queued message is taken back to edit. Where each was taken from is not in the text.
 */
export function readMessage(text: string): { items: WaitingItem[]; text: string } {
  const items: WaitingItem[] = [];
  const words: string[] = [];
  const from: QuoteFrom = { what: 'earlier' };
  for (const part of readPrompt(text)) {
    if (part.kind === 'text') words.push(part.text);
    else if (part.kind === 'file') items.push({ ...fileItem(part.path, part.folder), from });
    else if (part.kind === 'comment') {
      items.push({ id: newId(), kind: 'comment', text: part.code ?? '', note: part.note, path: part.path, lines: part.lines, side: part.removed ? 'del' : 'same', from: { what: 'diff' } });
    } else {
      // A terminal's header names its tab, never lines of a file; one that names only a tab had no title.
      const lone = part.tab ? undefined : /^tab:(\S+)$/.exec(part.label ?? '')?.[1];
      const numbered = part.label && !part.tab && !lone ? NUMBERS.exec(part.label) : null;
      const tab = part.tab ?? lone;
      items.push({
        id: newId(),
        kind: 'quote',
        text: part.text,
        from: tab ? { what: 'terminal' } : from,
        ...(part.note ? { note: part.note } : {}),
        ...(numbered ? { path: numbered[1]!, lines: [Number(numbered[2]), Number(numbered[3] ?? numbered[2])] as [number, number] } : {}),
        ...(part.label && !numbered && !lone ? { label: part.label } : {}),
        ...(tab ? { tab } : {}),
      });
    }
  }
  return { items, text: words.join('\n\n') };
}

/* ---------- how one is named ---------- */

/** A file and its lines, short: `theme.css:12`, `app.ts:7-8`. */
export const shortLines = (path: string, lines?: [number, number]): string => linesLabel(baseName(path), lines);

const SOURCES: Record<QuoteFrom['what'], string> = {
  reply: 'Claude’s reply',
  prompt: 'your message',
  step: 'a step',
  side: 'the side chat',
  file: 'a file',
  diff: 'the changes',
  terminal: 'the terminal',
  earlier: '',
};

/** What a waiting item's editor is titled: "Quote from Claude’s reply · 10:42 AM", "Comment on theme.css:12". */
export function itemTitle(item: WaitingItem): string {
  if (item.kind === 'file') return item.folder ? 'Folder' : 'File';
  if (item.kind === 'comment') return `Comment on ${shortLines(item.path ?? '', item.lines)}`;
  const source = item.path ? shortLines(item.path, item.lines) : SOURCES[item.from.what];
  const time = item.from.at && !item.path ? ` · ${clockTime(item.from.at)}` : '';
  return source ? `Quote from ${source}${time}` : 'Quote';
}

/** A quote's first words, on one line. */
export const passageStart = (item: WaitingItem): string => item.text.split(LINE_BREAK).map((line) => line.trim()).filter(Boolean).join(' ');

/** A passage as a preview of two lines shows it: its blank lines left out, so they take none of the two. */
export const previewText = (text: string): string => text.replace(/\n\s*\n/g, '\n');

/** What a waiting item is, in words, for a screen reader and a tooltip. */
export function itemName(item: WaitingItem): string {
  if (item.kind === 'file') return `${item.folder ? 'Folder' : 'File'} ${item.path ?? item.text}`;
  if (item.kind === 'comment') return `Comment on ${shortLines(item.path ?? '', item.lines)}: ${item.note ?? ''}`;
  const passage = item.path ? `${shortLines(item.path, item.lines)}` : `“${passageStart(item)}”`;
  return item.note?.trim() ? `Your note on ${passage}: ${item.note.trim()}` : `Quote ${passage}`;
}

/* ---------- Pelican's older quotes, for what still holds them ---------- */

/** A file quote before 0.5.0: `src/app.ts:7-8` above `> ` lines. The file viewer still hands its lines over this way. */
export const MAX_QUOTE_LINES = 200;

/**
 * Lines `from` to `to` of a file (numbered from 1), quoted under where they are, as the file
 * viewer's Quote hands them over (the message box takes them as a quote of those lines).
 */
export function quoteLines(path: string, from: number, to: number, lines: readonly string[]): string {
  const kept = lines.slice(0, Math.max(0, Math.min(to - from + 1, MAX_QUOTE_LINES))).map((line) => line.trimEnd());
  if (!kept.some(Boolean)) return '';
  const end = from + kept.length - 1;
  return `${path}:${end > from ? `${from}-${end}` : from}\n${kept.map((line) => (line ? `> ${line}` : '>')).join('\n')}`;
}

/** A quote handed over as text, Pelican's older way (`path:7-8` and `> ` lines, or `> ` lines), as a waiting item. */
export function olderQuote(quote: string, from: QuoteFrom = { what: 'earlier' }): WaitingItem | undefined {
  const [part] = readPrompt(quote);
  if (!part || part.kind !== 'quote') return quoteItem(quote, from);
  const numbered = part.label ? NUMBERS.exec(part.label.replace(/ \(removed\)$/, '')) : null;
  return quoteItem(part.text, numbered ? { ...from, what: from.what === 'earlier' ? 'file' : from.what } : from, numbered ? { path: numbered[1]!, lines: [Number(numbered[2]), Number(numbered[3] ?? numbered[2])] } : {});
}

/**
 * Text put after what is already written, on lines of its own: an empty line before it when there
 * is text, and one after it for what is said about it (a request to Claude from Changes).
 */
export function withQuote(written: string, block: string): string {
  const before = written.replace(/\s+$/, '');
  return `${before ? `${before}\n\n` : ''}${block}\n\n`;
}
