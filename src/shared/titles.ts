/**
 * A session with no title of its own is called by the text of a prompt, which can be a pasted
 * page. As a title it is one line of about 60 columns, a CJK character taking two, cut where the
 * words allow and marked with an ellipsis; a title someone gave the session is never cut.
 */

/** Characters drawn two columns wide: CJK, kana, Hangul, full-width forms and emoji. */
const WIDE = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]|\p{Emoji_Presentation}/u;

const width = (char: string) => (WIDE.test(char) ? 2 : 1);

/** How many columns text takes on one line. */
export function columns(text: string): number {
  let total = 0;
  for (const char of text) total += width(char);
  return total;
}

/** Punctuation that ends a phrase in CJK text, where no space follows it. */
const CJK_STOP = /[，。；：、！？]/u;
const ASCII_STOP = /[,.;:!?]/;

/**
 * Whether a title may end just before `chars[i]`: at a space or CJK punctuation, or at ASCII
 * punctuation that ends a phrase (`Chat.tsx`, `v2.4` and `10:30` hold none).
 */
function breaksAt(chars: string[], i: number): boolean {
  const char = chars[i];
  if (char === undefined) return true;
  if (char === ' ' || CJK_STOP.test(char)) return true;
  if (!ASCII_STOP.test(char)) return false;
  const next = chars[i + 1];
  return next === undefined || next === ' ' || WIDE.test(next) || WIDE.test(chars[i - 1] ?? '');
}

const TRAILING = /[\s,.;:!?，。；：、！？\-–—]+$/u;

/** `text` on one line, at most `max` columns: cut at the last natural break, else where the limit falls. */
export function shortTitle(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (columns(flat) <= max) return flat;
  const chars = [...flat];
  // The longest start that leaves a column for the ellipsis…
  let fit = 0;
  let used = 0;
  while (fit < chars.length && used + width(chars[fit]!) <= max - 1) {
    used += width(chars[fit]!);
    fit += 1;
  }
  // …ended at its last break, unless that would leave less than half of it.
  let cut = fit;
  let upTo = used;
  for (let i = fit; i > 0; i -= 1) {
    if (breaksAt(chars, i)) {
      cut = upTo >= max / 2 ? i : fit;
      break;
    }
    upTo -= width(chars[i - 1]!);
  }
  const kept = chars.slice(0, cut).join('').replace(TRAILING, '') || chars.slice(0, fit).join('');
  return `${kept}…`;
}
