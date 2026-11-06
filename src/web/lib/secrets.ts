/**
 * Keys, tokens and private keys in text taken from the page, masked with • before it goes to
 * Claude, match for match as Claude Desktop masks a quote (its bundle, chunk shared-m-1, ME): the
 * same patterns, found where they start on their own, and also right after an escape (`\n`, `%20`,
 * `\x41`, `A`), after a lone hyphen, inside a word after `_`, a digit or `-`, after a dot (a
 * JWT), and with invisible characters inside them. Ported as it is there, step for step, so the
 * same text comes out; only the names are Pelican's.
 */

/** A secret starts on its own, not inside a longer word or token. */
const ALONE = '(?<![A-Za-z0-9_-])';
/** Escapes a token may follow in JSON, a string literal or a URL. */
const ESCAPES = [String.raw`\\[bfnrt]`, String.raw`\\x[0-9A-Fa-f]{2}`, String.raw`\\u[0-9A-Fa-f]{4}`, '%[0-9A-Fa-f]{2}', '%25[0-9A-Fa-f]{2}'];
const SPACES = '\\u00A0\\u1680\\u2000-\\u200A\\u202F\\u205F\\u3000';
const ANY_SPACE = `\\t\\v\\f\\r\\n\\u2028\\u2029 ${SPACES}`;
const SPACE_RUN = `[${ANY_SPACE}]*`;
const DASHES = '-{4,5}';
const LINE_SPACE = `[ \\t${SPACES}]*`;
const KEY_WORDS = RegExp(`PRIVATE${SPACE_RUN}KEY(?:${SPACE_RUN}BLOCK)?${LINE_SPACE}${DASHES}`);
const BEGIN_LINE = RegExp(`${DASHES}${LINE_SPACE}BEGIN[A-Z0-9${ANY_SPACE}]*${KEY_WORDS.source}`);
const END_LINE = RegExp(`${DASHES}${LINE_SPACE}END[A-Z0-9${ANY_SPACE}]*${KEY_WORDS.source}`);
const NOT_BEFORE_KEY = '(?![A-Za-z0-9_-]*----BEGIN)';
/** A JWT of three parts, or an encrypted one of five; never two (a header and a payload alone). */
const JWT = `eyJ[A-Za-z0-9_-]{10,}\\.(?:${NOT_BEFORE_KEY}[A-Za-z0-9_-]*\\.(?!-?eyJ)${NOT_BEFORE_KEY}[A-Za-z0-9_-]{10,}\\.(?!-?eyJ)${NOT_BEFORE_KEY}[A-Za-z0-9_-]{10,}\\.(?!-?eyJ)(?:[A-Za-z0-9_]|-(?!---)){10,64}(?:(?![A-Za-z0-9_-]*----)[A-Za-z0-9_-]*)?|eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,})`;

/** Desktop's patterns, in its order: what each finds, whether it is found inside a word, and what must be in the text for it to be looked for. */
type Pattern = { id: string; inWord?: boolean; regex: RegExp; trigger: string };
const PATTERNS: Pattern[] = [
  { id: 'anthropic', inWord: true, regex: RegExp(`${ALONE}sk-ant-[A-Za-z0-9_-]{20,}`), trigger: 'sk-ant-' },
  { id: 'openai_proj', inWord: true, regex: RegExp(`${ALONE}sk-(?:proj|svcacct|admin|None)-[A-Za-z0-9_-]{20,}`), trigger: 'sk-(?:proj|svcacct|admin|None)-' },
  { id: 'openai', regex: RegExp(`${ALONE}sk-[A-Za-z0-9]{20,}`), trigger: 'sk-[A-Za-z0-9]{20}' },
  { id: 'github', inWord: true, regex: RegExp(`${ALONE}(?:(?:gh[opsu]_|github_pat_)[A-Za-z0-9_]{20,}|ghr_[A-Za-z0-9]{20,})`), trigger: 'gh[oprsu]_|github_pat_' },
  { id: 'aws', inWord: true, regex: RegExp(`${ALONE}AKIA[A-Z0-9]{16}`), trigger: 'AKIA' },
  { id: 'slack', inWord: true, regex: RegExp(`${ALONE}(?:xox[abceprs]-[A-Za-z0-9-]{10,}|xapp-[0-9]-[A-Z0-9]{1,20}-[0-9]{1,20}-[A-Za-z0-9]{10,})`), trigger: 'xox[abceprs]-|xapp-[0-9]-' },
  { id: 'google', inWord: true, regex: RegExp(`${ALONE}AIza[A-Za-z0-9_-]{35}`), trigger: 'AIza' },
  { id: 'stripe', inWord: true, regex: RegExp(`${ALONE}(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}`), trigger: '[sr]k_(?:live|test)_[A-Za-z0-9]{20}' },
  { id: 'stripe_webhook', inWord: true, regex: RegExp(`${ALONE}whsec_[A-Za-z0-9]{20,}`), trigger: 'whsec_[A-Za-z0-9]{20}' },
  { id: 'age', inWord: true, regex: RegExp(`${ALONE}AGE-SECRET-KEY-1[02-9AC-HJ-NP-Z]{58}`), trigger: 'AGE-SECRET-KEY-1' },
  { id: 'gitlab', inWord: true, regex: RegExp(`${ALONE}gl(?:pat|dt)-[A-Za-z0-9_-]{20,}`), trigger: 'gl(?:pat|dt)-' },
  { id: 'jwt', regex: RegExp(`${ALONE}${JWT}`), trigger: '\\.eyJ|(?:^|[^A-Za-z0-9_-])-?eyJ[A-Za-z0-9_-]{10,}\\.' },
  { id: 'private_key', regex: RegExp(`${BEGIN_LINE.source}[A-Za-z0-9+/=$\\\\\\r\\n\\u2028\\u2029${SPACES}]{0,5000}?${END_LINE.source}`), trigger: KEY_WORDS.source },
];

const ANY_PATTERN = PATTERNS.map((p) => `(?:${p.regex.source})`).join('|');
/** The patterns that start on their own, without that start. */
const BARE = PATTERNS.filter(({ regex }) => regex.source.startsWith(ALONE)).map(({ regex }) => `(?:${regex.source.slice(ALONE.length)})`);
/** A token right after a lone hyphen: `-sk-ant-…`. */
const AFTER_HYPHEN = `(?<=${ALONE}-)(?:${BARE.join('|')})`;
/** A JWT right after a dot. */
const AFTER_DOT = `(?<=\\.)(?=(${JWT}))`;
const KEY_MARK = /(?<!-)-{4,}(?=BEGIN|END|$)|PRIVATE/;
/** A token after `_`, a digit, `-` or an escape (one that is found inside a word); a JWT after an escape. */
const IN_WORD = `(?<![^0-9_-]${ESCAPES.map((e) => `(?<!${e})`).join('')})(?:${PATTERNS.filter((p) => p.inWord === true && p.regex.source.startsWith(ALONE)).map((p) => p.regex.source.slice(ALONE.length)).join('|')})|(?:${ESCAPES.join('|')})(?<jwt>${JWT})`;
const TRIGGER = RegExp(PATTERNS.map((p) => `(?:${p.trigger})`).join('|'));
const ESCAPED_JWT = RegExp(`(?:${ESCAPES.join('|')})eyJ[A-Za-z0-9_-]{10,}\\.`);
/** Whether there can be a secret in the text at all. */
const mayHold = (text: string) => TRIGGER.test(text) || (text.includes('eyJ') && ESCAPED_JWT.test(text));

/* ---------- what is not seen ---------- */

/** Desktop's characters that draw nothing or are not text: controls, format characters, noncharacters. */
const NOT_SEEN = String.raw`[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800\uFFFC\u{1D159}\u{13441}\u{13442}\u{16910}\u{16FE4}\uFDD0-\uFDEF\uFFFE\uFFFF\u{1FFFE}\u{1FFFF}\u{2FFFE}\u{2FFFF}\u{3FFFE}\u{3FFFF}\u{4FFFE}\u{4FFFF}\u{5FFFE}\u{5FFFF}\u{6FFFE}\u{6FFFF}\u{7FFFE}\u{7FFFF}\u{8FFFE}\u{8FFFF}\u{9FFFE}\u{9FFFF}\u{AFFFE}\u{AFFFF}\u{BFFFE}\u{BFFFF}\u{CFFFE}\u{CFFFF}\u{DFFFE}\u{DFFFF}\u{EFFFE}\u{EFFFF}\u{FFFFE}\u{FFFFF}\u{10FFFE}\u{10FFFF}]`;
/** Something not seen in a token, other than a tab or a line break: those, marks, private and unassigned characters. */
const INVISIBLE = RegExp(String.raw`(?![\t\n\r])${NOT_SEEN}|[\p{M}\p{Co}\p{Cn}]`, 'u');
const hasInvisible = (text: string) => INVISIBLE.test(text);
const INVISIBLE_RUN = RegExp(`(?:${INVISIBLE.source}){1,65536}`, 'gu');
const NOT_PLAIN = /[^\t\n\r\x20-\x7E]/;

const STARTS_SECRET = RegExp(`^(?:${BARE.concat(BEGIN_LINE.source).join('|')})`);
const SHADOW_LOOK = 512;
const LONG_JWT = /^eyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]*){0,2}$/;
const TOKEN_CHAR = /[A-Za-z0-9_-]/;
/** The rest of a token a pattern began: letters, digits, _ and inner hyphens. */
const TOKEN_TAIL = /(?:[A-Za-z0-9_]|(?<=[A-Za-z0-9_])-(?=[A-Za-z0-9_]))*/y;
const A_SPACE = RegExp(`[${ANY_SPACE}]`);

/** Where a run of what a token may hold, spaces and invisible characters included, ends. */
function runEnd(text: string, from: number): number {
  let plain = true;
  let at = from;
  while (at < text.length) {
    const point = text.codePointAt(at) ?? 0;
    if ((point >= 65 && point <= 90) || (point >= 48 && point <= 57) || (plain && ((point >= 97 && point <= 122) || point === 95 || point === 45))) {
      at += 1;
      continue;
    }
    const char = String.fromCodePoint(point);
    const invisible = hasInvisible(char);
    if (!invisible && !A_SPACE.test(char)) break;
    plain &&= invisible;
    at += char.length;
  }
  return at;
}

/** Where `word` ends if it starts at `from`, invisible characters allowed between its letters; -1 if it is not there. */
function wordEnd(text: string, from: number, word: string): number {
  let at = from;
  for (let i = 0; i < word.length; i += 1) {
    while (i > 0 && at < text.length) {
      const char = String.fromCodePoint(text.codePointAt(at) ?? 0);
      if (!NOT_PLAIN.test(char) || !hasInvisible(char)) break;
      at += char.length;
    }
    if (text[at] !== word[i]) return -1;
    at += 1;
  }
  return at;
}

const KEY_AFTER_PRIVATE = RegExp(`^[${ANY_SPACE}]*KEY(?:[${ANY_SPACE}]*BLOCK)?${LINE_SPACE}-{4}`);
const KEY_AFTER_PRIVATE_CUT = RegExp(`^[${ANY_SPACE}]*(?:K|KE|KEY[${ANY_SPACE}]*(?:B|BL|BLO|BLOC|BLOCK)?${LINE_SPACE}-{0,3})?$`);
const KEY_LOOK = 64;
const ESCAPE_BACK = 6;

function tokenTailEnd(text: string, from: number): number {
  TOKEN_TAIL.lastIndex = from;
  TOKEN_TAIL.exec(text);
  return TOKEN_TAIL.lastIndex;
}

/** Whether "PRIVATE" ending at `at` is a private key's: "KEY -----" follows, or could, where the text is cut. */
function privateKeyAfter(text: string, at: number, last: boolean): boolean {
  const next = text.slice(at, at + KEY_LOOK).replace(INVISIBLE_RUN, '');
  return KEY_AFTER_PRIVATE.test(next) || ((!last || at + KEY_LOOK < text.length) && KEY_AFTER_PRIVATE_CUT.test(next));
}

const LONG_WORD = 15;
/** Whether the token starting at `at` comes after 15 characters of one word (or after the start of a chunk that is not the first). */
function deepInWord(text: string, at: number, first: boolean): boolean {
  let back = at;
  while (back > 0 && at - back < LONG_WORD) {
    if ((text.charCodeAt(back - 1) !== 45 || text[back - 2] === '-' || text[back] === '-') && !/[A-Za-z0-9_]/.test(text[back - 1]!) && !NOT_PLAIN.test(text[back - 1]!)) return false;
    back -= 1;
  }
  return at - back >= LONG_WORD || !first;
}

/** Where a token found from `from` to `to` ends: before a run of four dashes that starts a key's line, if one is in it. */
function tokenEnd(text: string, from: number, to: number, anyDashes = false): number {
  for (let i = from; i < to; i += 1) {
    if (text[i] !== '-') continue;
    let dashes = 0;
    let at = i;
    while (at < text.length) {
      const point = text.codePointAt(at) ?? 0;
      if (text[at] === '-') dashes += 1;
      else if (!hasInvisible(String.fromCodePoint(point))) break;
      at += point > 65535 ? 2 : 1;
    }
    if (dashes >= 4 && (anyDashes || !TOKEN_CHAR.test(text[at] ?? '') || wordEnd(text, at, 'BEGIN') >= 0 || wordEnd(text, at, 'END') >= 0)) return i;
    i = at - 1;
  }
  return to;
}

type Found = { index: number; value: string; added?: boolean };

/** Every secret a pattern finds in `text`, in the ways Desktop looks for one. `last`: the text's end is the end of all of it; `first`: its start is. */
function* findAll(text: string, last: boolean, first: boolean): Generator<Found> {
  for (const match of text.matchAll(RegExp(ANY_PATTERN, 'g'))) yield { index: match.index, value: match[0] };
  for (const match of text.matchAll(RegExp(AFTER_HYPHEN, 'g'))) {
    const cut = match[0].search(/(?<!-)-{4,}(?=BEGIN|END|$)/);
    yield { index: match.index, value: cut < 0 ? match[0] : match[0].slice(0, cut) };
  }
  let reach = -1;
  let keyAt = -1;
  let tail = -1;
  for (const match of text.matchAll(RegExp(IN_WORD, 'g'))) {
    const value = match.groups?.jwt ?? match[0];
    const start = match.index + match[0].length - value.length;
    const end = match.index + match[0].length;
    if (end > reach) {
      reach = runEnd(text, end);
      keyAt = -1;
      for (let i = start; i < reach; i += 1) {
        const after = text.charCodeAt(i) === 80 ? wordEnd(text, i, 'PRIVATE') : -1;
        if (after >= 0 && after <= reach && privateKeyAfter(text, after, last)) keyAt = i;
      }
    }
    let unfinished = false;
    if (!last && reach >= text.length) {
      if (end > tail) tail = tokenTailEnd(text, end);
      unfinished = match.index - ESCAPE_BACK >= text.length - 8192 || tail >= text.length;
    }
    if (keyAt >= start || unfinished) continue;
    yield { index: start, value: text.slice(start, tokenEnd(text, start, end, deepInWord(text, start, first))), added: true };
  }
  if (text.includes('.eyJ')) {
    for (const match of text.matchAll(RegExp(AFTER_DOT, 'g'))) {
      const point = text.codePointAt(match.index + match[1]!.length);
      const next = point === undefined ? '' : String.fromCodePoint(point);
      if ((next === '' ? last : !TOKEN_CHAR.test(next) && !(NOT_PLAIN.test(next) && hasInvisible(next))) && !KEY_MARK.test(match[1]!)) yield { index: match.index, value: match[1]! };
    }
  }
}

/**
 * The text without what is not seen, for finding a secret with invisible characters inside it. A
 * run left out right after a token's character, where `before` (the text as first read this way)
 * starts a secret, leaves a NUL in its place, so the two halves are not read as one.
 */
function shadowOf(text: string, before?: string): { shadow: string; edges: number; toRaw: (at: number) => number } {
  let removed = 0;
  const starts: number[] = [];
  const shifts: number[] = [];
  let shift = 0;
  let edges = 0;
  const shadow = text.replace(INVISIBLE_RUN, (run: string, at: number) => {
    const inShadow = at - removed;
    removed += run.length;
    const ahead = before !== undefined && at > 0 && TOKEN_CHAR.test(text[at - 1]!) ? before.slice(inShadow, inShadow + SHADOW_LOOK) : undefined;
    const edge = ahead !== undefined && (STARTS_SECRET.test(ahead) || (ahead.length === SHADOW_LOOK && LONG_JWT.test(ahead))) ? '\0' : '';
    edges += edge.length;
    starts.push(at - shift + edge.length);
    shift += run.length - edge.length;
    shifts.push(shift);
    return edge;
  });
  const toRaw = (at: number) => {
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (starts[mid]! <= at) low = mid + 1;
      else high = mid;
    }
    return low === 0 ? at : at + shifts[low - 1]!;
  };
  return { shadow, edges, toRaw };
}

type Span = { start: number; end: number; value: string; patternId: string; added: boolean; keep?: number };

const MAX_SCAN = 262144;

/** The secrets in `text` (of at most 262,144 characters), as spans that never overlap, in order. */
function secretsIn(text: string, last: boolean, first = true): Span[] {
  if (text.length > MAX_SCAN) return [];
  const found: Array<{ start: number; end: number; patternId: string; added: boolean; inner?: number }> = [];
  const add = (start: number, end: number, value: string, added = false) => {
    found.push({ start, end, patternId: PATTERNS.find((p) => p.regex.test(value))?.id ?? 'unknown', added });
  };
  if (mayHold(text)) for (const f of findAll(text, last, first)) add(f.index, f.index + f.value.length, f.value, f.added);
  if (hasInvisible(text)) {
    const read = (before?: string) => {
      const { shadow, edges, toRaw } = shadowOf(text, before);
      if ((before === undefined || edges !== 0) && mayHold(shadow)) {
        for (const f of findAll(shadow, last, first)) add(toRaw(f.index), toRaw(f.index + f.value.length - 1) + 1, f.value, f.added);
      }
      return shadow;
    };
    read(read());
  }
  found.sort((a, b) => a.start - b.start);
  const inside = (span: (typeof found)[number], at: number) => {
    if (span.added && at > span.start) span.inner = Math.min(span.inner ?? at, at);
  };
  const merged: typeof found = [];
  for (const span of found) {
    const prev = merged.at(-1);
    if (prev !== undefined && span.start < prev.end) {
      inside(prev, span.start);
      prev.end = Math.max(prev.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }
  const spans: typeof found = [];
  let tail = 0;
  for (const span of merged) {
    const prev = spans.at(-1);
    if (prev !== undefined && span.start < tail) {
      inside(prev, span.start);
      prev.end = span.end;
    } else {
      if (prev !== undefined) prev.end = Math.max(prev.end, tail);
      spans.push(span);
    }
    const top = spans.at(-1)!;
    if (top.patternId === 'private_key') tail = top.end;
    else if (top.end >= tail) tail = tokenTailEnd(text, top.end);
  }
  const lastSpan = spans.at(-1);
  if (lastSpan !== undefined) lastSpan.end = Math.max(lastSpan.end, tail);
  return spans.map(({ start, end, patternId, added, inner }) => ({ start, end, value: text.slice(start, end), patternId, added, ...(inner === undefined ? {} : { keep: inner - start }) }));
}

/* ---------- masking one ---------- */

const SHOWN = 8;
const KEY_BEGIN = '-----BEGIN';
const KEY_END = '-----END';
const AFTER_END = /^[^-]*(?:-[^A-Za-z0-9]*)?$/;

/** Where a private key's BEGIN line's five dashes end, invisible characters between them allowed; -1 if they do not. */
function beginLineEnd(key: string): number {
  let dashes = 0;
  for (let at = 10; at < key.length;) {
    const char = String.fromCodePoint(key.codePointAt(at) ?? 0);
    if (char === '-') {
      dashes += 1;
      if (dashes === 5) return at + 1;
    } else if (!hasInvisible(char)) {
      if (dashes === 4) return at;
      dashes = 0;
    }
    at += char.length;
  }
  return -1;
}

const dots = (text: string) => (text.includes('\n') ? text.split('\n').map((line) => '\u2022'.repeat(line.length)).join('\n') : '\u2022'.repeat(text.length));

/**
 * One secret masked: a private key between its BEGIN and END lines, which say what it is; a token
 * of 12 characters or fewer whole; a longer one after its first 8 (fewer when `keep` says so),
 * counting only characters that are seen.
 */
function masked(secret: string, keep = Infinity): string {
  const most = Math.max(0, keep);
  if (secret.startsWith(KEY_BEGIN)) {
    const endAt = secret.lastIndexOf(KEY_END);
    const to = endAt >= 0 && AFTER_END.test(secret.slice(endAt + 8)) ? endAt : secret.length;
    const header = beginLineEnd(secret);
    const from = header >= 0 && header <= to ? header : 10;
    return maskSecrets(secret.slice(0, from)) + dots(secret.slice(from, to)) + maskSecrets(secret.slice(to));
  }
  if (!hasInvisible(secret)) {
    if (secret.length <= 12) return dots(secret);
    const shown = Math.min(SHOWN, most);
    return secret.slice(0, shown) + dots(secret.slice(shown));
  }
  let seen = 0;
  let eighth = 0;
  let within = 0;
  for (let at = 0; at < secret.length;) {
    const char = String.fromCodePoint(secret.codePointAt(at) ?? 0);
    at += char.length;
    if (!hasInvisible(char)) {
      seen += 1;
      if (seen === SHOWN) eighth = at;
    }
    if (at <= most) within = at;
  }
  if (seen <= 12) return dots(secret);
  const shown = Math.min(eighth, within);
  return secret.slice(0, shown) + dots(secret.slice(shown));
}

const replaced = (text: string, spans: readonly Span[]) => {
  if (spans.length === 0) return text;
  let out = '';
  let at = 0;
  for (const span of spans) {
    out += text.slice(at, span.start) + masked(span.value, span.keep);
    at = span.end;
  }
  return out + text.slice(at);
};

const CHUNK_STEP = 253952;

/** The text with every key, token and private key in it masked with •, the way Claude Desktop masks a quote. */
export function maskSecrets(text: string): string {
  if (text.length <= MAX_SCAN) return replaced(text, secretsIn(text, true));
  // A long text in chunks that overlap, so a secret across a chunk's edge is found whole.
  const found: Span[] = [];
  for (let from = 0; from < text.length; from += CHUNK_STEP) {
    for (const span of secretsIn(text.slice(from, from + MAX_SCAN), from + MAX_SCAN >= text.length, from === 0)) {
      found.push({ patternId: span.patternId, value: span.value, start: from + span.start, end: from + span.end, added: span.added, ...(span.keep === undefined ? {} : { keep: span.keep }) });
    }
  }
  found.sort((a, b) => a.start - b.start || Number(a.added) - Number(b.added) || a.end - b.end);
  const spans: Span[] = [];
  for (const span of found) {
    const prev = spans.at(-1);
    const afterKey = span.added && span.start === prev?.end && prev.patternId === 'private_key';
    if (prev !== undefined && span.start <= prev.end && !afterKey) {
      if (span.end > prev.end) {
        prev.end = span.end;
        prev.value = text.slice(prev.start, prev.end);
      }
    } else {
      spans.push({ ...span });
    }
  }
  return replaced(text, spans);
}
