/**
 * What Claude Desktop does to text taken from the page before it goes to Claude, done the same way
 * so that a message reads alike in both apps: secrets masked, an @ that would mention a file made
 * harmless, lines split where Desktop splits them, and a code fence that holds whatever it fences.
 */

/** Where a quote's lines break: Desktop splits on all of these. */
export const LINE_BREAK = /\r\n?|[\n\u2028\u2029]/;

/* ---------- secrets ---------- */

/** A secret starts on its own, not inside a longer word or token. */
const ALONE = '(?<![A-Za-z0-9_-])';

/** Desktop's patterns for keys and tokens, by kind: Anthropic, OpenAI, GitHub, AWS, Slack, Google, Stripe, age, GitLab, a JWT. */
const TOKENS = [
  'sk-ant-[A-Za-z0-9_-]{20,}',
  'sk-(?:proj|svcacct|admin|None)-[A-Za-z0-9_-]{20,}',
  'sk-[A-Za-z0-9]{20,}',
  '(?:gh[opsu]_|github_pat_)[A-Za-z0-9_]{20,}',
  'ghr_[A-Za-z0-9]{20,}',
  'AKIA[A-Z0-9]{16}',
  'xox[abceprs]-[A-Za-z0-9-]{10,}',
  'xapp-[0-9]-[A-Z0-9]{1,20}-[0-9]{1,20}-[A-Za-z0-9]{10,}',
  'AIza[A-Za-z0-9_-]{35}',
  '(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}',
  'whsec_[A-Za-z0-9]{20,}',
  'AGE-SECRET-KEY-1[02-9AC-HJ-NP-Z]{58}',
  'gl(?:pat|dt)-[A-Za-z0-9_-]{20,}',
  'eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}(?:\\.[A-Za-z0-9_-]*)*',
];
const TOKEN = new RegExp(`${ALONE}(?:${TOKENS.join('|')})`, 'g');

/** A private key, from its BEGIN line to its END line, as Desktop finds one. */
const SPACES = '\\u00A0\\u1680\\u2000-\\u200A\\u202F\\u205F\\u3000';
const ANY_SPACE = `\\t\\v\\f\\r\\n\\u2028\\u2029 ${SPACES}`;
const DASHES = '-{4,5}';
const KEY_WORDS = `PRIVATE[${ANY_SPACE}]*KEY(?:[${ANY_SPACE}]*BLOCK)?[ \\t${SPACES}]*${DASHES}`;
const PRIVATE_KEY = new RegExp(
  `${DASHES}[ \\t${SPACES}]*BEGIN[A-Z0-9${ANY_SPACE}]*${KEY_WORDS}[A-Za-z0-9+/=$\\\\\\r\\n\\u2028\\u2029${SPACES}]{0,5000}?${DASHES}[ \\t${SPACES}]*END[A-Z0-9${ANY_SPACE}]*${KEY_WORDS}`,
  'g',
);

/** The rest of a token a pattern began: letters, digits, _ and inner hyphens. */
const TOKEN_TAIL = /(?:[A-Za-z0-9_]|(?<=[A-Za-z0-9_])-(?=[A-Za-z0-9_]))*/y;

const dots = (text: string) => text.split('\n').map((line) => '\u2022'.repeat(line.length)).join('\n');

/**
 * One secret masked, as Desktop masks it: a short one whole, a longer one after its first 8
 * characters; a private key keeps its BEGIN and END lines, which say what it is.
 */
function masked(secret: string, key: boolean): string {
  if (key && secret.startsWith('-----BEGIN')) {
    const end = secret.lastIndexOf('-----END');
    const header = /-{4,5}/g;
    header.lastIndex = 10;
    const body = header.exec(secret);
    const from = body ? body.index + body[0].length : 10;
    const to = end > from ? end : secret.length;
    return secret.slice(0, from) + dots(secret.slice(from, to)) + secret.slice(to);
  }
  if (secret.length <= 12) return dots(secret);
  return secret.slice(0, 8) + dots(secret.slice(8));
}

/** The text with every key, token and private key in it masked with •, the way Claude Desktop masks a quote. */
export function maskSecrets(text: string): string {
  const found: Array<{ start: number; end: number; key: boolean }> = [];
  for (const match of text.matchAll(PRIVATE_KEY)) found.push({ start: match.index, end: match.index + match[0].length, key: true });
  for (const match of text.matchAll(TOKEN)) {
    TOKEN_TAIL.lastIndex = match.index + match[0].length;
    TOKEN_TAIL.exec(text);
    found.push({ start: match.index, end: Math.max(TOKEN_TAIL.lastIndex, match.index + match[0].length), key: false });
  }
  if (found.length === 0) return text;
  found.sort((a, b) => a.start - b.start || a.end - b.end);
  const spans: typeof found = [];
  for (const span of found) {
    const last = spans.at(-1);
    if (last && span.start < last.end) {
      last.end = Math.max(last.end, span.end);
      last.key ||= span.key;
    } else {
      spans.push({ ...span });
    }
  }
  let out = '';
  let at = 0;
  for (const span of spans) {
    out += text.slice(at, span.start) + masked(text.slice(span.start, span.end), span.key);
    at = span.end;
  }
  return out + text.slice(at);
}

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
/** What is not seen, so it neither starts nor ends a word. */
const UNSEEN = /^[\p{Cf}\p{Co}\p{Default_Ignorable_Code_Point}\u0890\u0891\u180F\u{13430}-\u{1343F}]$/u;

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
