/**
 * Text from a file that Claude would otherwise take for Claude Code's own words: its tags
 * (`<system-reminder>`, `<command-name>`…) and the phrases that point it at a transcript or an
 * output file. The code and path of a line comment pass through these, as in Claude Desktop (its
 * bundle: chunk c4d65e22c for the phrases, cfdc58f68 and ce311b43f for the tags): such a tag gets
 * `\~` after its `<`, and such a phrase a backslash before its colon. Desktop looks hard, through
 * look-alike characters, characters that are not seen, and escapes a backslash could undo; this is
 * its code, step for step, so the same text comes out. Only the names are Pelican's.
 */

import { isUnseen } from './sanitize';

const raw = String.raw;

/* ---------- the phrases ---------- */

const PHRASES = ['Full transcript available at:', 'Read the output file to retrieve the result:'];

const escapeRegExp = (text: string) => text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');

/** Each phrase, with anything but plain text allowed between its letters: whether there is one to look for. */
const LOOSE_PHRASES = PHRASES.map((phrase) => new RegExp([...phrase].map((c) => (c === ' ' ? '[ \\xA0]' : escapeRegExp(c))).join('[^\\x20-\\x7E\\n\\t\\xA0]*')));

/** The text without what is not seen (a CR counts), a no-break space as a space, and where each of its characters was. */
function seenText(text: string): { kept: string; at: number[] } {
  let kept = '';
  const at: number[] = [];
  for (let i = 0; i < text.length;) {
    const char = String.fromCodePoint(text.codePointAt(i) ?? 0);
    if (char !== '\r' && !isUnseen(char)) {
      kept += char === '\u{A0}' ? ' ' : char;
      for (let unit = 0; unit < char.length; unit += 1) at.push(i + unit);
    }
    i += char.length;
  }
  return { kept, at };
}

/**
 * "Full transcript available at:" and "Read the output file to retrieve the result:", seen through
 * what is not seen, with a backslash before the colon: `at\:`.
 */
export function escapePhrases(text: string): string {
  if (!LOOSE_PHRASES.some((phrase) => phrase.test(text))) return text;
  const { kept, at } = seenText(text);
  const colons: number[] = [];
  for (const phrase of PHRASES) {
    for (let found = kept.indexOf(phrase); found !== -1; found = kept.indexOf(phrase, found + phrase.length)) colons.push(at[found + phrase.length - 1]!);
  }
  if (colons.length === 0) return text;
  let out = '';
  let from = 0;
  for (const colon of colons.sort((a, b) => a - b)) {
    out += `${text.slice(from, colon)}\\`;
    from = colon;
  }
  return out + text.slice(from);
}

/* ---------- the characters, as Desktop groups them ---------- */

/** What may stand between `<` and a tag's name: space, a slash or one like it, and what is not seen. */
const SEP = raw`[\s/\p{Cf}\p{Default_Ignorable_Code_Point}\p{M}\u{0}-\u{8}\u{B}\u{C}\u{E}-\u{1F}\u{7F}-\u{9F}\u{1735}\u{2041}\u{2044}\u{2215}\u{2571}\u{27CB}\u{29F8}\u{2CC6}\u{2F03}\u{3033}\u{30CE}\u{31D3}\u{32E8}\u{4E3F}\u{FF0F}\u{FF89}\u{1D23A}\u{2800}\u{FFFC}\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}\u{1D159}]`;
/** What may stand between the letters of a tag's name without being seen. */
const FILL = raw`[\p{Cf}\p{Default_Ignorable_Code_Point}\p{M}\u{2800}\u{FFFC}\u{0}-\u{1F}\u{7F}-\u{9F}\u{A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}\u{1D159}]`;
/** `<` and what looks like it. */
const LT = raw`[<\u{2C2}\u{1438}\u{16B2}\u{2039}\u{226E}\u{227A}\u{22D6}\u{2329}\u{276C}\u{276E}\u{2770}\u{27E8}\u{29FC}\u{3008}\u{FE64}\u{FF1C}\u{1D236}\u{E003C}]`;
/** `>` and what looks like it. */
const GT = raw`[>\u{2C3}\u{1433}\u{203A}\u{226F}\u{227B}\u{22D7}\u{232A}\u{276D}\u{276F}\u{2771}\u{27E9}\u{29FD}\u{3009}\u{FE65}\u{FF1E}\u{E003E}]`;
/** A backslash and what looks like one. */
const BACKSLASH = raw`[\\\u{2216}\u{2572}\u{27CD}\u{29F5}\u{29F9}\u{2F02}\u{31D4}\u{4E36}\u{FE68}\u{FF3C}\u{1D20F}\u{1D23B}]`;
const DASH = raw`[-\u{2D7}\u{6D4}\u{2010}\u{2011}\u{2012}\u{2013}\u{2043}\u{207B}\u{208B}\u{2212}\u{2796}\u{2CBA}\u{FE32}\u{FE58}\u{FE63}\u{FF0D}]`;
const UNDERSCORE = raw`[_\u{2CD}\u{7FA}\u{FE33}\u{FE34}\u{FE4D}\u{FE4E}\u{FE4F}\u{FF3F}]`;
const LETTER_I = raw`[i\u{FF49}\u{131}\u{130}]`;
/** What a tag's name is made of, its look-alikes included. */
const ATOM = `[${DASH.slice(1, -1)}${UNDERSCORE.slice(1, -1)}0-9a-z${raw`\u{FF10}-\u{FF19}\u{FF41}-\u{FF5A}\u{130}\u{131}\u{DF}\u{1E9E}`}]`;
/** A tag's name ends where no letter, digit or _ follows. */
const NAME_END = '(?![0-9A-Za-z_])';
/** Where the filling between a name's letters is made one character not seen, before the name is matched. */
const SENTINEL = '\u{200B}';
const SENTINEL_RUN = raw`[\u{200B}\u{E003C}]*`;
const SKIP = raw`(?:\u{E0020}|(?![\u{E0021}-\u{E007E}])${SEP})`;
const MARK = /[\p{M}\u{FF9E}\u{FF9F}]/u;
const LONGEST_NAME = 64;
const LOOK = 512;
const MARK_RUN = 33;

/* ---------- each character's kinds, by plane ---------- */

const IS_MARK = 1;
const IS_FORMAT = 2;
const FILLS = 4;
const SEPARATES = 8;
const IN_NAME = 16;
const OPENS = 32;
const planes: Uint8Array[] = [];

/** What each character of a plane is, found by Desktop's own patterns over all of them. */
function plane(index: number): Uint8Array {
  const known = planes[index];
  if (known) return known;
  const kinds = new Uint8Array(65536);
  const tests: Array<[RegExp, number]> = [[new RegExp(MARK.source, 'gu'), IS_MARK], [/\p{Cf}/gu, IS_FORMAT], [new RegExp(FILL, 'giu'), FILLS], [new RegExp(SEP, 'giu'), SEPARATES], [new RegExp(ATOM, 'giu'), IN_NAME], [new RegExp(LT, 'giu'), OPENS]];
  for (let start = index << 16; start < (index + 1) << 16; start += 8192) {
    const points: number[] = [];
    for (let point = start; point < start + 8192; point += 1) points.push(point >= 0xd800 && point <= 0xdfff ? 32 : point);
    const chars = String.fromCodePoint(...points);
    for (const [test, kind] of tests) {
      for (const found of chars.matchAll(test)) {
        const point = found[0].codePointAt(0)! & 65535;
        kinds[point] = kinds[point]! | kind;
      }
    }
  }
  planes[index] = kinds;
  return kinds;
}

const pairKinds = (high: number, low: number) => {
  const point = 65536 + ((high - 0xd800) << 10) + (low - 0xdc00);
  return plane(point >>> 16)[point & 65535]!;
};

/**
 * From `start`, the leading separators and a name's characters, with each character that fills
 * between them made the sentinel; null when nothing needed it. `spaces`: a space fills too.
 */
function withSentinels(text: string, start: number, spaces: boolean): string | null {
  const bmp = plane(0);
  const end = text.length;
  let at = start;
  if (at > 0 && at < end && (text.charCodeAt(at) & 0xfc00) === 0xdc00 && (text.charCodeAt(at - 1) & 0xfc00) === 0xd800) at -= 1;
  let parts: string[] | null = null;
  let from = at;
  let letters = -1;
  let stop = end;
  while (at < end) {
    const unit = text.charCodeAt(at);
    let kinds = 0;
    let width = 1;
    let point = unit;
    if ((unit & 0xf800) !== 0xd800) {
      kinds = bmp[unit]!;
    } else if (unit <= 0xdbff && at + 1 < end) {
      const low = text.charCodeAt(at + 1);
      if ((low & 0xfc00) === 0xdc00) {
        kinds = pairKinds(unit, low);
        width = 2;
        point = 65536 + ((unit - 0xd800) << 10) + (low - 0xdc00);
      }
    }
    const fills = (kinds & FILLS) !== 0 || (spaces && point === 32);
    let goes: boolean;
    if ((letters < 0 && (kinds & SEPARATES) !== 0 && (spaces || (kinds & OPENS) === 0)) || (letters >= 0 && fills)) {
      goes = true;
    } else if ((kinds & IN_NAME) !== 0 && letters < LONGEST_NAME) {
      letters = letters < 0 ? 1 : letters + 1;
      goes = true;
    } else {
      goes = false;
    }
    if (goes && fills && point !== 0x200b && (spaces || point !== 0xe003c)) {
      (parts ??= []).push(text.slice(from, at), SENTINEL);
      from = at + width;
    }
    at += width;
    if (!goes) {
      stop = at;
      break;
    }
  }
  if (parts === null) return null;
  parts.push(text.slice(from, stop));
  return parts.join('');
}

/** Where runs of 33 or more marks are, as [start, end] pairs; `first`: the first only. */
function markRuns(text: string, first: boolean): number[] {
  const bmp = plane(0);
  const runs: number[] = [];
  let start = -1;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    let kinds = 0;
    const at = i;
    if ((unit & 0xf800) !== 0xd800) {
      kinds = bmp[unit]!;
    } else if (unit <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if ((low & 0xfc00) === 0xdc00) {
        kinds = pairKinds(unit, low);
        i += 1;
      }
    }
    if (kinds & IS_MARK) {
      if (start < 0) start = at;
    } else if (start >= 0) {
      if (at - start >= MARK_RUN) {
        runs.push(start, at);
        if (first) return runs;
      }
      start = -1;
    }
  }
  if (start >= 0 && text.length - start >= MARK_RUN) runs.push(start, text.length);
  return runs;
}

const hasMarkRun = (text: string) => markRuns(text, true).length > 0;

/** Whether marks pile up 33 or more on one character (format characters among them do not count), after a quick sample. */
function piledMarks(text: string): boolean {
  const bmp = plane(0);
  let sampled = 0;
  for (let i = 0; i < text.length && sampled < 2; i += 16) {
    let unit = text.charCodeAt(i);
    let at = i;
    if ((unit & 0xfc00) === 0xdc00 && i > 0) {
      at = i - 1;
      unit = text.charCodeAt(at);
    }
    let kinds = 0;
    if ((unit & 0xf800) !== 0xd800) {
      kinds = bmp[unit]!;
    } else if (unit <= 0xdbff && at + 1 < text.length) {
      const low = text.charCodeAt(at + 1);
      if ((low & 0xfc00) === 0xdc00) kinds = pairKinds(unit, low);
    }
    if (kinds !== 0) sampled += 1;
  }
  if (sampled < 2) return false;
  let run = 0;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    let kinds = 0;
    let width = 1;
    if ((unit & 0xf800) !== 0xd800) {
      kinds = bmp[unit]!;
    } else if (unit <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if ((low & 0xfc00) === 0xdc00) {
        kinds = pairKinds(unit, low);
        width = 2;
        i += 1;
      }
    }
    if (kinds & IS_MARK) {
      run += width;
      if (run >= MARK_RUN) return true;
    } else if (!(kinds & IS_FORMAT)) {
      run = 0;
    }
  }
  return false;
}

/** Each run of 33 marks or more as one combining acute. */
function collapseMarks(text: string): string {
  const runs = markRuns(text, false);
  if (runs.length === 0) return text;
  let out = '';
  let from = 0;
  for (let i = 0; i < runs.length; i += 2) {
    out += `${text.slice(from, runs[i])}\u{301}`;
    from = runs[i + 1]!;
  }
  return out + text.slice(from);
}

/** Unicode's tag characters as the ASCII they stand for. */
const fromTagChars = (text: string) => text.replace(/[\u{E0021}-\u{E007E}]/gu, (c) => String.fromCharCode(c.codePointAt(0)! - 0xe0000));

/** Parenthesized letters as the sentinel and the letter. */
const unparenthesized = (text: string) => text.replace(/[\u{249C}-\u{24B5}\u{1F110}-\u{1F12A}]/gu, (c) => {
  const point = c.codePointAt(0)!;
  return point === 0x1f12a ? `${SENTINEL}S` : SENTINEL + String.fromCharCode(point <= 0x24b5 ? point - 0x249c + 97 : point - 0x1f110 + 65);
});

const SHAPE = new RegExp(`^(?:(?!${LT})${SEP})*(?:${ATOM}${SEP}*)*$`, 'iu');
const SEP_RUNS = new RegExp(`${SEP}+`, 'giu');
const SEP_OR_ATOM = new RegExp(`^(?:${SEP}|${ATOM})`, 'iu');

const startsAName = new Map<number, boolean>();
/** Whether a name could start with this character, once decomposed. */
function couldStartName(point: number): boolean {
  let known = startsAName.get(point);
  if (known === undefined) {
    const decomposed = String.fromCodePoint(point).normalize('NFKD');
    known = SEP_OR_ATOM.test(String.fromCodePoint(decomposed.codePointAt(0) ?? point));
    startsAName.set(point, known);
  }
  return known;
}

/** 512 characters of separators and name characters, with no more than 64 of the latter: too much to read, so taken for a tag. */
function saturated(text: string, at: number): boolean {
  if (text.length - at < LOOK) return false;
  let window = text.slice(at, at + LOOK);
  const last = window.charCodeAt(LOOK - 1);
  if (last >= 0xd800 && last <= 0xdbff) window = window.slice(0, -1);
  return SHAPE.test(window) && window.replace(SEP_RUNS, '').length <= LONGEST_NAME;
}

/* ---------- the tags ---------- */

/**
 * The tags Claude Code and Claude Desktop write into a conversation, as Desktop lists them to
 * escape: what Claude Code's harness adds, its commands' and shells' records, and Desktop's own.
 */
const TAGS = [
  'system-reminder', 'task-notification', 'slack_context', 'uploaded_files', 'available-deferred-tools', 'new-diagnostics', 'critical_user_preferences_reminder',
  'persisted-output', 'local-command-caveat', 'tick', 'goal', 'mcp-resource', 'mcp-resource-update', 'mcp-polling-update', 'teammate-message', 'cross-session-message',
  'launch-selected-element', 'connected_office_files', 'thinking', 'ide_opened_file', 'ide_selection', 'ide_diagnostics', 'browser_instruction', 'cell', 'cell_type',
  'language', 'command-message', 'command-args', 'no-action-needed', 'comprehensive-mode-instructions', 'cu_window_hints', 'widget_context_hint', 'preview-annotation-context',
  'sync_sources', 'tool_use_error', 'pr-created', 'command-name', 'bash-input', 'bash-stdout', 'bash-stderr', 'bash-exit-code', 'local-command-stdout',
  'local-command-stderr', 'user-prompt-submit-hook', 'agent-message', 'agent-notification', 'bash-notification', 'ci-monitor-event', 'side-sessions-event',
  'mobile-simulator-selected-element', 'terminal-selection', 'github_issue', 'browser-output', 'untrusted-content', 'scheduled-task', 'watching-report', 'run-history',
  'channel-message',
];

let groups = 0;
/** A group that never gives back what it took. */
const atomic = (pattern: string, name: string) => `(?=(?<${name}>${pattern}))\\k<${name}>`;

/** A name's characters, each with its look-alikes, the sentinel allowed between them. */
function nameAtoms(name: string): string[] {
  const atoms: string[] = [];
  for (let i = 0; i < name.length; i += 1) {
    if (name[i] === 's' && name[i + 1] === 's') {
      atoms.push('ss');
      i += 1;
    } else {
      atoms.push(name[i]!);
    }
  }
  return atoms.map((atom) => {
    if (atom === 'ss') return `(?:[s\\u{FF53}]${atomic(SENTINEL_RUN, `fa${(groups += 1)}`)}[s\\u{FF53}]|[\\u{DF}\\u{1E9E}])`;
    if (atom === '-') return DASH;
    if (atom === '_') return UNDERSCORE;
    if (atom === 'i') return LETTER_I;
    if (atom >= 'a' && atom <= 'z') return `[${atom}\\u{${(0xff41 + atom.charCodeAt(0) - 97).toString(16)}}]`;
    return `[${atom}\\u{${(0xff10 + atom.charCodeAt(0) - 48).toString(16)}}]`;
  });
}

const NAMES = `(?:${TAGS.map((name) => nameAtoms(name).map((atom, i) => (i === 0 ? atom : atomic(SENTINEL_RUN, `fs${(groups += 1)}`) + atom)).join('')).join('|')})`;
const NAME_HERE = new RegExp(`^(?=(${SEP}*))\\1${NAMES}${NAME_END}`, 'iuy');
const NAME_AFTER = new RegExp(`(?=((?:(?!${LT})${SEP})*))\\1${NAMES}${NAME_END}`, 'iuy');
const SKIP_RUN = new RegExp(`${SKIP}*`, 'uy');

/** Whether a tag's name starts at `at` (just after a `<`), looked for as Desktop looks. */
function tagAt(text: string, at: number): boolean {
  if (saturated(text, at)) return true;
  const sentinels = withSentinels(text, at, false);
  if (sentinels === null) {
    NAME_AFTER.lastIndex = at;
    if (NAME_AFTER.test(text)) return true;
  } else {
    NAME_AFTER.lastIndex = 0;
    if (NAME_AFTER.test(sentinels)) return true;
  }
  SKIP_RUN.lastIndex = at;
  SKIP_RUN.exec(text);
  const from = SKIP_RUN.lastIndex;
  const ahead = text.slice(from, from + LOOK);
  const plain = fromTagChars(ahead);
  const opened = unparenthesized(plain);
  if (opened === ahead && !/\P{ASCII}/u.test(ahead)) return false;
  const visible = ahead.replace(/\p{Cf}/gu, '');
  const tries = [opened, unparenthesized(visible), plain, visible];
  const piled = piledMarks(ahead);
  for (let i = 0; i < tries.length; i += 1) {
    const tried = tries[i]!;
    if (tries.indexOf(tried) !== i) continue;
    const first = tried.codePointAt(0);
    if (first === undefined || !couldStartName(first)) continue;
    const decomposed = (piled ? collapseMarks(tried) : tried).normalize('NFKD');
    NAME_HERE.lastIndex = 0;
    if (NAME_HERE.test(withSentinels(decomposed, 0, true) ?? decomposed)) return true;
  }
  return false;
}

/* ---------- a tag a backslash could make ---------- */

/** How many tag checks a text may take before every `<` in it counts as a tag's. */
export type Budget = { callsLeft: number };

const MOST_CALLS = 32768;
const MOST_PLAIN = 256;
const ROUNDS = 20;
const NOT_TEXT = /[\u{2800}\u{FFFC}\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}\u{1D159}]/gu;
const LT_ALL = new RegExp(LT, 'gu');
const GT_ALL = new RegExp(GT, 'gu');
const GT_ONE = new RegExp(GT, 'u');
const BACKSLASH_ALL = new RegExp(BACKSLASH, 'gu');
const ANY_BACKSLASH = new RegExp(`${BACKSLASH.slice(0, -1)}\\u{E005C}]`, 'u');

/** Enclosed and parenthesized digits and letters, as the ASCII they show. */
const isEnclosed = (point: number) => (point >= 0x2474 && point <= 0x24b5) || (point >= 0x1f100 && point <= 0x1f10a) || (point >= 0x1f110 && point <= 0x1f12a);
function enclosedAscii(char: string): string {
  const point = char.codePointAt(0) ?? 0;
  if (point === 0x1f12a) return 'S';
  if (point <= 0x247c) return String.fromCharCode(point - 0x2474 + 49);
  if (point <= 0x2487) return String(point - 0x247d + 10);
  if (point <= 0x2490) return String.fromCharCode(point - 0x2488 + 49);
  if (point <= 0x249b) return String(point - 0x2491 + 10);
  if (point <= 0x24b5) return String.fromCharCode(point - 0x249c + 97);
  if (point <= 0x1f10a) return point <= 0x1f101 ? '0' : String.fromCharCode(point - 0x1f101 + 48);
  return String.fromCharCode(point - 0x1f110 + 65);
}

const HEX_OR_U = /^[0-9a-fA-FuU]+$/;
/**
 * The characters after each backslash that an escape could be made of, as plain ASCII: so
 * `\ｕ００３ｃ` reads `<`. `chained`: a \u escape that makes a hex digit or a u goes on.
 */
function plainEscapes(text: string, chained: boolean): string {
  let out = '';
  let at = 0;
  while (at < text.length) {
    if (text[at] !== '\\') {
      const next = text.indexOf('\\', at);
      if (next === -1) {
        out += text.slice(at);
        break;
      }
      out += text.slice(at, next);
      at = next;
      continue;
    }
    out += '\\';
    at += 1;
    let unicode = false;
    let hex = '';
    let done = false;
    let first = true;
    while (at < text.length && !done) {
      const point = text.codePointAt(at) ?? 0;
      const char = String.fromCodePoint(point);
      let plainChar: string;
      if (isEnclosed(point)) {
        plainChar = enclosedAscii(char);
      } else {
        const normal = point < 128 ? char : char.normalize('NFKC');
        if (!HEX_OR_U.test(normal)) break;
        plainChar = normal;
      }
      out += plainChar;
      at += char.length;
      if (first) {
        first = false;
        if (plainChar.length === 1 && /[bfnrt]/.test(plainChar)) {
          done = true;
          break;
        }
      }
      for (const c of plainChar) {
        if (!unicode) {
          if (c === 'u' || c === 'U') unicode = true;
        } else if (/[0-9a-fA-F]/.test(c)) {
          hex += c;
          if (hex.length >= 4) {
            const made = String.fromCharCode(parseInt(hex, 16));
            if (hex.toLowerCase() === '005c') {
              unicode = false;
              hex = '';
              first = true;
            } else if (chained && /[0-9a-fA-FuU]/.test(made)) {
              unicode = false;
              hex = '';
            } else {
              done = true;
              break;
            }
          }
        }
      }
    }
  }
  return out;
}

const SIMPLE: Record<string, string> = { '\\': '\\', '/': '/', '"': '"', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
/** JSON's escapes undone, in one pass, and in two (\u first). */
const DECODERS = [
  (text: string) => text.replace(/\\u([0-9a-fA-F]{4})|\\([\\/"bfnrt])/g, (_m, hex: string | undefined, simple: string | undefined) => (hex === undefined ? SIMPLE[simple ?? ''] ?? simple ?? '' : String.fromCharCode(parseInt(hex, 16)))),
  (text: string) => text.replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))).replace(/\\([\\/"bfnrt])/g, (_m, simple: string) => SIMPLE[simple] ?? simple),
];

/** What is left of the budget of the check under way. */
let calls: Budget = { callsLeft: MOST_CALLS };

type Opener = { idx: number; len: number };

/** The `<`s that open a tag; undefined (taken for the worst) past the budget, at a saturated one, or past 256 that do not. */
function tagOpeners(text: string): Opener[] | undefined {
  const found: Opener[] = [];
  let plain = 0;
  for (const lt of text.matchAll(LT_ALL)) {
    const at = lt.index;
    calls.callsLeft -= 1;
    if (calls.callsLeft < 0 || saturated(text, at + lt[0].length)) return undefined;
    if (tagAt(text, at + lt[0].length)) found.push({ idx: at, len: lt[0].length });
    else if (++plain >= MOST_PLAIN) return undefined;
  }
  return found;
}

/** The text with each opener made `~`, and the `cuts` (markup) left out. */
function withoutOpeners(text: string, openers: readonly Opener[], cuts: ReadonlyArray<{ start: number; end: number }>): string {
  let out = '';
  let from = 0;
  let k = 0;
  for (const cut of [...cuts, { start: text.length, end: text.length }]) {
    for (; k < openers.length && openers[k]!.idx < cut.start; k += 1) {
      const opener = openers[k]!;
      if (opener.idx >= from) {
        out += `${text.slice(from, opener.idx)}~`;
        from = opener.idx + opener.len;
      }
    }
    out += text.slice(from, cut.start);
    from = cut.end;
    while (k < openers.length && openers[k]!.idx < cut.end) k += 1;
  }
  return out;
}

/** Whether a `<` in the text opens a tag (or the budget, or 256 that do not, says to take it so). */
function anyTag(text: string): boolean {
  let plain = 0;
  for (const lt of text.matchAll(LT_ALL)) {
    calls.callsLeft -= 1;
    if (calls.callsLeft < 0 || tagAt(text, lt.index + lt[0].length) || ++plain >= MOST_PLAIN) return true;
  }
  return false;
}

/** Whether undoing escapes, up to 20 times over, makes a tag. */
function decodingMakesTag(text: string): boolean {
  if (anyTag(text.replace(/\\/g, ''))) return true;
  for (const decode of DECODERS) {
    let current = text;
    let settled = false;
    for (let round = 0; round < ROUNDS; round += 1) {
      const next = decode(current);
      if (next === current) {
        settled = true;
        break;
      }
      current = next;
      if (anyTag(current) || anyTag(current.replace(/\\/g, ''))) return true;
    }
    if (!settled) return true;
  }
  return false;
}

/** Where the markup that opens at `at` ends; in `html`, past a comment and quoted values. */
function markupEnd(text: string, at: number, html: boolean): number {
  if (!html) return text.indexOf('>', at);
  if (text.startsWith('<!--', at)) {
    if (text.startsWith('>', at + 4) || text.startsWith('->', at + 4)) return text.indexOf('>', at + 4);
    const close = text.indexOf('-->', at + 4);
    const bang = text.indexOf('--!>', at + 4);
    const end = close < 0 ? bang : bang < 0 ? close : Math.min(close, bang);
    return end < 0 ? -1 : text.indexOf('>', end);
  }
  let quote = '';
  let afterEquals = false;
  for (let i = at + 1; i < text.length; i += 1) {
    const char = text[i]!;
    if (quote) {
      if (char === quote) quote = '';
    } else if ((char === '"' || char === "'") && afterEquals) {
      quote = char;
    } else if (char === '>') {
      return i;
    }
    if (!quote && !/\s/.test(char)) afterEquals = char === '=';
  }
  return -1;
}

/** The text with its markup left out, and the tags' `<` made `~`; undefined where that cannot be told. `every`: every `<` starts markup, not only a tag's. */
function stripMarkup(text: string, openers: readonly Opener[], every: boolean, html: boolean): string | undefined {
  const cuts: Array<{ start: number; end: number }> = [];
  let from = 0;
  let k = 0;
  for (;;) {
    const lt = text.indexOf('<', from);
    if (lt < 0) break;
    while (k < openers.length && openers[k]!.idx < lt) k += 1;
    if (!every && openers[k]?.idx !== lt) {
      from = lt + 1;
      continue;
    }
    const end = markupEnd(text, lt, html);
    if (end < 0) {
      if (html) {
        cuts.push({ start: lt, end: text.length });
        return withoutOpeners(text, openers, cuts);
      }
      return openers.slice(k).some((opener) => text[opener.idx] === '<') ? undefined : withoutOpeners(text, openers, cuts);
    }
    let inside = -1;
    for (let i = k; i < openers.length && openers[i]!.idx <= end; i += 1) inside = openers[i]!.idx;
    if (inside >= 0 && !every && GT_ONE.test(text.slice(lt, end))) return undefined;
    cuts.push({ start: lt, end: end + 1 });
    from = end + 1;
  }
  return withoutOpeners(text, openers, cuts);
}

/** The text with each `<…>` pair taken out, nested ones too. */
function withoutPairs(text: string): string {
  const kept: string[] = [];
  const opens: number[] = [];
  for (const char of text) {
    if (char === '<') {
      opens.push(kept.length);
      kept.push(char);
    } else if (char === '>' && opens.length > 0) {
      kept.length = opens.pop()!;
    } else {
      kept.push(char);
    }
  }
  return kept.join('');
}

/** Ways of reading the text with its markup left out. */
function unmarked(text: string): Array<string | undefined> {
  const openers = tagOpeners(text);
  if (openers === undefined) return [undefined];
  const ways: Array<string | undefined> = [];
  for (const html of [false, true]) for (const every of [false, true]) ways.push(stripMarkup(text, openers, every, html));
  const paired = withoutPairs(text);
  const pairedOpeners = tagOpeners(paired);
  ways.push(pairedOpeners === undefined ? undefined : withoutOpeners(paired, pairedOpeners, []));
  return ways;
}

/** Whether a reading of the text with its look-alikes made plain and its escapes undone makes a tag. */
function readsAsTag(text: string): boolean {
  if (hasMarkRun(text)) return true;
  const slashes = text.replace(BACKSLASH_ALL, '\\');
  const tagged = fromTagChars(slashes);
  const plainSlashes = plainEscapes(slashes, false);
  const plainTagged = plainEscapes(tagged, false);
  const chainedSlashes = plainEscapes(slashes, true);
  const chainedTagged = plainEscapes(tagged, true);
  const readings = [text, slashes, slashes.normalize('NFKC'), tagged, tagged.normalize('NFKC'), plainSlashes, plainSlashes.normalize('NFKC'), plainTagged,
    plainTagged.normalize('NFKC'), chainedSlashes, chainedSlashes.normalize('NFKC'), chainedTagged, chainedTagged.normalize('NFKC')];
  return [...new Set(readings)].some(decodingMakesTag);
}

function backslashMakesTagIn(text: string, budget: Budget | undefined): boolean {
  if (!ANY_BACKSLASH.test(text)) return false;
  if (hasMarkRun(text)) return true;
  calls = { callsLeft: Math.min(MOST_CALLS, budget?.callsLeft ?? MOST_CALLS) };
  const start = calls.callsLeft;
  const settle = (made: boolean) => {
    if (budget) budget.callsLeft -= start - Math.max(0, calls.callsLeft);
    return made;
  };
  const openers = tagOpeners(text);
  if (openers === undefined || readsAsTag(withoutOpeners(text, openers, []))) return settle(true);
  const compatible = text.normalize('NFKC');
  const plain = compatible.replace(LT_ALL, '<').replace(GT_ALL, '>');
  if (!plain.includes('<')) return settle(false);
  const tried = new Set<string>();
  for (const variant of new Set([text, compatible, plain])) {
    for (const way of unmarked(variant)) {
      if (way === undefined) return settle(true);
      if (!tried.has(way)) {
        tried.add(way);
        if (readsAsTag(way)) return settle(true);
      }
    }
  }
  return settle(false);
}

/** Whether a backslash in the text could, once escapes are undone, make a tag of Claude Code's. */
function backslashMakesTag(text: string, budget?: Budget): boolean {
  const withoutReserved = text.replace(NOT_TEXT, '');
  const variants = [...new Set([text, withoutReserved, text.replaceAll('\r', ''), withoutReserved.replaceAll('\r', '')])];
  if (variants.length === 1) return backslashMakesTagIn(text, budget);
  const shared = { callsLeft: Math.min(MOST_CALLS, budget?.callsLeft ?? MOST_CALLS) };
  const start = shared.callsLeft;
  const found = variants.some((variant) => backslashMakesTagIn(variant, shared));
  if (budget) budget.callsLeft -= start - Math.max(0, shared.callsLeft);
  return found;
}

/* ---------- escaping ---------- */

const OPENERS_ALL = new RegExp(LT, 'gu');
const BACKSLASHES_ALL = new RegExp(BACKSLASH, 'gu');
/** The phrases with \r and characters not part of the text allowed between their letters. */
const TIGHT_PHRASES = PHRASES.map((phrase) => new RegExp([...phrase].map(escapeRegExp).join(raw`[\r\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}\u{2800}\u{FFFC}\u{1D159}]*`), 'gu'));

/**
 * A tag of Claude Code's (its look-alikes too) with `\~` after its `<`, and the phrases with a
 * backslash before their colon. Unless `headsOnly`, a backslash that could make a tag gets a `~`
 * after it. With a `budget`, each `<` checked takes one call from it; once it is spent, every `<`
 * is escaped.
 */
export function escapeTags(text: string, budget?: Budget, options: { headsOnly?: boolean } = {}): string {
  const spent = budget !== undefined && budget.callsLeft <= 0;
  const safe = !options.headsOnly && (spent || backslashMakesTag(text, budget)) ? text.replace(BACKSLASHES_ALL, '$&~') : text;
  let out = safe.replace(OPENERS_ALL, (lt: string, at: number) => {
    if (budget) {
      if (budget.callsLeft <= 0) return `${lt}\\~`;
      budget.callsLeft -= 1;
    }
    return tagAt(safe, at + lt.length) ? `${lt}\\~` : lt;
  });
  for (const phrase of TIGHT_PHRASES) out = out.replace(phrase, (found) => `${found.slice(0, -1)}\\${found.slice(-1)}`);
  return out;
}
