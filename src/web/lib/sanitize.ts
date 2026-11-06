/**
 * What Claude Desktop does to text taken from the page before it goes to Claude, done the same way
 * so that a message reads alike in both apps: a quote cut to Desktop's length, an @ that would
 * mention a file made harmless, lines split where Desktop splits them, and a code fence that holds
 * whatever it fences. Secrets are masked by lib/secrets.
 */

/** Where a quote's lines break: Desktop splits on all of these. */
export const LINE_BREAK = /\r\n?|[\n\u2028\u2029]/;

/* ---------- a quote's length ---------- */

/** Desktop's longest quote, in UTF-16 units. */
export const MAX_QUOTE = 1500;

/** Cut to `max` units with … after it, never between the two halves of a character outside the BMP. */
export function capQuote(text: string, max = MAX_QUOTE): string {
  if (text.length <= max) return text;
  const unit = text.charCodeAt(max - 1);
  const cut = unit >= 0xd800 && unit <= 0xdbff ? max - 1 : max;
  return `${text.slice(0, cut)}…`;
}

/* ---------- an @ that would mention a file ---------- */

/** What ends a word before an @: space, and the few marks Desktop counts with it. */
const WORD_GAP = /^[\s\u0085\u115F\u1160\u3164\uFFA0\u3002\u3001\uFF1F\uFF01]$/u;
/**
 * What is not seen, so it neither starts nor ends a word, as Desktop counts it: controls other than
 * tab and line breaks, format and private characters, a lone half of a surrogate pair, and the few
 * that draw nothing (a blank Braille cell, the object mark).
 */
const UNSEEN = /^(?![\n\r\t])[\p{Cc}\p{Cf}\p{Co}\p{Default_Ignorable_Code_Point}\uFFF9-\uFFFB\uD800-\uDFFF\u2800\uFFFC\u{1D159}\u0890\u0891\u180F\u{13430}-\u{1343F}]$/u;

/** The character (a whole code point) just before `at`. */
function before(text: string, at: number): string {
  const low = text.charCodeAt(at - 1);
  const high = text.charCodeAt(at - 2);
  const pair = low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff;
  return text.slice(at - (pair ? 2 : 1), at);
}

/** Whether `at` starts a word: the text's start, or after space, past anything unseen. */
function startsWord(text: string, at: number): boolean {
  for (let n = at; n > 0;) {
    const char = before(text, n);
    if (WORD_GAP.test(char)) return true;
    if (!UNSEEN.test(char)) return false;
    n -= char.length;
  }
  return true;
}

/**
 * An @ that starts a word and is not followed by a space becomes ＠ (U+FF20), so quoted text cannot
 * mention a file or an agent to Claude Code, as in Claude Desktop.
 */
export const defuseMentions = (text: string): string => text.replace(/@/g, (at, i: number) => (startsWord(text, i) && text[i + 1] !== ' ' ? '\uFF20' : at));

/* ---------- a quote's lines ---------- */

/** Text as `> ` lines, Desktop's way: every line of it, an empty one as `> ` too. */
export const quotedLines = (text: string): string => defuseMentions(text).split(LINE_BREAK).map((line) => `> ${line}`).join('\n');

/* ---------- code ---------- */

const backtick = (unit: number) => unit === 0x60 || unit === 0x1fef || unit === 0xff40;
const breaksRun = (unit: number) => (unit >= 32 && unit < 127) || unit === 9 || unit === 10 || unit === 0xa0 || unit === 0x2028 || unit === 0x2029;

/** A code fence one backtick longer than the longest run of backticks in `code`, three at least. */
export function fenceFor(code: string): string {
  let longest = 2;
  let run = 0;
  for (let i = 0; i < code.length; i += 1) {
    const unit = code.charCodeAt(i);
    if (backtick(unit)) {
      run += 1;
      longest = Math.max(longest, run);
    } else if (breaksRun(unit)) {
      run = 0;
    }
  }
  return '`'.repeat(longest + 1);
}

/** Characters private to an app, which mean nothing to Claude: dropped; a broken surrogate shows as �. */
export function dropPrivate(text: string): string {
  let out = '';
  for (let i = 0; i < text.length;) {
    const point = text.codePointAt(i)!;
    const char = String.fromCodePoint(point);
    i += char.length;
    if (point >= 0xd800 && point <= 0xdfff) out += '\uFFFD';
    else if (!((point >= 0xe000 && point <= 0xf8ff) || (point >= 0xf0000 && (point & 0xfffe) !== 0xfffe) || point === 0x2800 || point === 0xfffc || point === 0x1d159)) out += char;
  }
  return out;
}

/** Control characters dropped, odd spaces made plain, as Desktop cleans a path or a snippet. */
export function plainControls(text: string): string {
  let out = '';
  for (const char of text) {
    const unit = char.charCodeAt(0);
    if ((unit > 0 && unit < 32 && unit !== 9 && unit !== 10) || (unit >= 127 && unit <= 159) || (unit >= 0xe000 && unit <= 0xf8ff)) continue;
    if (unit === 0 || unit === 0xa0 || unit === 0x1680 || (unit >= 0x2000 && unit <= 0x200a) || unit === 0x2028 || unit === 0x2029 || unit === 0x202f || unit === 0x205f) out += ' ';
    else if (unit === 0x37e) out += ';';
    else if (unit === 0x1fef) out += '`';
    else if (unit === 0x212a) out += 'K';
    else out += char;
  }
  return out;
}
