/**
 * Which characters Pelican writes out, as ⟨U+202E⟩, with a warning, where what you read decides
 * what runs or is sent: an approval, what a folder brings before you trust it, a file Claude sends
 * you and the name you save it under. Claude Code and Claude Desktop show such text as it is; this
 * is Pelican's own addition, and it warns of every character that can make what you read differ
 * from what runs or is sent, and of nothing else: a warning that comes with ordinary text teaches
 * you to pass it by.
 *
 * Written out, wherever they are:
 * - what turns text around, the bidi controls (U+202A to U+202E, U+2066 to U+2069, U+200E, U+200F,
 *   U+061C): a command reads as an echo while the shell runs something else;
 * - what shows as nothing or as a blank, and so can make two names look alike or carry text no one
 *   sees: tags (but in a flag, below), zero-width spaces, the word joiner, U+FEFF, soft hyphens,
 *   the combining grapheme joiner, Hangul fillers, U+180E, U+2800, U+FFFC, U+1D159, U+FFF9 to
 *   U+FFFB, and every other default-ignorable or format character but the signs drawn before Arabic
 *   numbers (U+0600 to U+0605 and the like, which show);
 * - controls but tab and newline, a carriage return too (a browser draws it as nothing; a shell
 *   takes it as part of a word, so a `cd` whose folder ends in one fails, and the next line runs
 *   where it started), and the line and paragraph separators (drawn as nothing or as a space, and a
 *   line break to JavaScript);
 * - a variation selector after nothing that takes it: after ASCII, a space, or another selector.
 *
 * Left as they are, wherever they are:
 * - an emoji, whole, with the invisible characters it is made of (EMOJI): its style (VS15 or VS16),
 *   a keycap, a skin tone, the joiners between its pictures, the tags of the flags of England,
 *   Scotland and Wales;
 * - spaces other than a plain one: no-break (U+00A0), narrow (U+202F, which macOS puts before AM in
 *   a screenshot's name), full width (U+3000, as CJK input types it), thin and the rest. Each shows
 *   as a space, in a command's monospace about as wide as a plain one. A shell (bash, zsh) takes
 *   one as part of a word, so words that read apart run as one: that can name another file than the
 *   one you read, as a look-alike letter can, but never runs a command or passes an argument you do
 *   not see; PowerShell splits words at it, as it reads. Written out, they would warn of every
 *   macOS screenshot, French quotation and CJK sentence that holds one;
 * - a private-use character, such as Apple's logo (U+F8FF): it shows as a glyph or a box.
 *
 * A command, a path, a name, a rule or a tool's input (the default) writes out every other joiner
 * and variation selector: there one makes two names look alike, and a run of them carries what no
 * one sees. Words (`prose`), such as what Claude says a command does or the caption of a file it
 * sends, keep those their scripts are written with: a joiner or non-joiner after a letter or mark
 * beyond ASCII (Persian, Arabic, the Indic scripts), and one variation selector after a character
 * that takes it (VS1 to VS14 after a math symbol, an ideograph or a Myanmar, Phags-pa, Manichaean
 * or Egyptian letter, VS17 to VS256 after an ideograph, Mongolian's own after a Mongolian letter).
 *
 * The repository's check of its own files (test/hidden-characters.test.ts) is stricter, as code
 * hygiene should be: there every one of these, spaces and private-use characters too, is an escape.
 */

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
 * joiners, selectors, tags and bidi controls among them), or another format character but the
 * signs drawn before numbers. Whether it is written out depends on where it is (revealHidden).
 */
const UNSEEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u2800\ufffc\u{1d159}\p{Default_Ignorable_Code_Point}]|(?![\u0600-\u0605\u06dd\u070f\u0890\u0891\u08e2\u{110bd}\u{110cd}])\p{Cf}/u;

/** An emoji, kept whole (the group), or a character that may not show as what it is. */
const PARTS = new RegExp(`(${EMOJI.source})|${UNSEEN.source}`, 'gu');

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

/**
 * The text with each character that can make it read otherwise than it runs written out as a token
 * (⟨U+202E⟩), and whether there were any, as above: a command, a path, a name, a rule or a tool's
 * input by default, words with `prose`.
 */
export function revealHidden(text: string, { prose = false }: { prose?: boolean } = {}): { text: string; hidden: boolean } {
  let hidden = false;
  const shown = text.replace(PARTS, (char: string, emoji: string | undefined, at: number) => {
    if (emoji !== undefined) return emoji;
    if (prose && written(char, [...text.slice(Math.max(0, at - 2), at)].at(-1))) return char;
    hidden = true;
    return `⟨U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟩`;
  });
  return { text: shown, hidden };
}
