/**
 * Characters that change how text reads without being seen: zero-width ones, and direction
 * overrides and isolates. A command can read as an echo while the shell runs something else.
 */
const HIDDEN = /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/** The text with each such character shown as a token (⟨U+202E⟩), and whether there were any. */
export function revealHidden(text: string): { text: string; hidden: boolean } {
  let hidden = false;
  const shown = text.replace(HIDDEN, (ch) => {
    hidden = true;
    return `⟨U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟩`;
  });
  return { text: shown, hidden };
}

/**
 * An emoji as the conversation shows it, with the invisible characters that are part of it: a
 * keycap, a flag of two letters, a black flag with the tags of England, Scotland or Wales (the
 * only flags of tags Unicode recommends; other tags show as nothing, or as letters, and may spell
 * anything), or a picture with its text or emoji style, its skin tone, and the joiners that make
 * several pictures one.
 */
export const EMOJI = /[#*0-9]\ufe0f?\u20e3|\p{RI}\p{RI}|\u{1f3f4}\u{e0067}\u{e0062}(?:\u{e0065}\u{e006e}\u{e0067}|\u{e0073}\u{e0063}\u{e0074}|\u{e0077}\u{e006c}\u{e0073})\u{e007f}|\p{ExtPict}(?:\p{EMod}|[\ufe0e\ufe0f])?(?:\u200d\p{ExtPict}(?:\p{EMod}|\ufe0f)?)*/u;
