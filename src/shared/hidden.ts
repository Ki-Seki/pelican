/**
 * Characters that change how text reads without being seen: zero-width ones, and direction
 * overrides and isolates. A command can read as an echo while the shell runs something else.
 */
const HIDDEN = /[؜​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/** The text with each such character shown as a token (⟨U+202E⟩), and whether there were any. */
export function revealHidden(text: string): { text: string; hidden: boolean } {
  let hidden = false;
  const shown = text.replace(HIDDEN, (ch) => {
    hidden = true;
    return `⟨U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟩`;
  });
  return { text: shown, hidden };
}
