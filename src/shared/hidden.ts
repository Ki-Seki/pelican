/**
 * Characters that do not show as what they are: controls, invisible ones (zero-width ones, joiners,
 * variation selectors, tags, fillers), direction-changing ones, private ones, separators and spaces
 * other than a plain one, and ones drawn blank. A command can read as an echo while the shell runs
 * something else, or name another file than the one it shows. The repository holds none of them as
 * they are, but in an emoji in its docs (test/hidden-characters.test.ts).
 */
export const HIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Default_Ignorable_Code_Point}\u2800\ufffc\u{1d159}]|(?! )\p{Zs}/u;

/**
 * An emoji as the conversation shows it, with the invisible characters that are part of it: a
 * keycap, a flag of two letters, a black flag with the tags of England, Scotland or Wales (the
 * only flags of tags Unicode recommends; other tags show as nothing, or as letters, and may spell
 * anything), or a picture with its text or emoji style, its skin tone, and the joiners that make
 * several pictures one.
 */
export const EMOJI = /[#*0-9]\ufe0f?\u20e3|\p{RI}\p{RI}|\u{1f3f4}\u{e0067}\u{e0062}(?:\u{e0065}\u{e006e}\u{e0067}|\u{e0073}\u{e0063}\u{e0074}|\u{e0077}\u{e006c}\u{e0073})\u{e007f}|\p{ExtPict}(?:\p{EMod}|[\ufe0e\ufe0f])?(?:\u200d\p{ExtPict}(?:\p{EMod}|\ufe0f)?)*/u;

const HIDDEN_ALL = new RegExp(HIDDEN.source, 'gu');
const EMOJIS = new RegExp(EMOJI.source, 'gu');

/**
 * The text with each such character shown as a token (⟨U+202E⟩), and whether there were any. A
 * command, a path or a tool's input shows every one; words (`prose`), such as what Claude says a
 * command does, keep their emoji whole, as the conversation shows them.
 */
export function revealHidden(text: string, { prose = false }: { prose?: boolean } = {}): { text: string; hidden: boolean } {
  let hidden = false;
  const reveal = (part: string) => part.replace(HIDDEN_ALL, (ch) => {
    hidden = true;
    return `⟨U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟩`;
  });
  if (!prose) return { text: reveal(text), hidden };
  let shown = '';
  let at = 0;
  for (const emoji of text.matchAll(EMOJIS)) {
    shown += reveal(text.slice(at, emoji.index)) + emoji[0];
    at = emoji.index + emoji[0].length;
  }
  shown += reveal(text.slice(at));
  return { text: shown, hidden };
}
