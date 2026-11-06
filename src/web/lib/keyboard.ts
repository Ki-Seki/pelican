/**
 * Keys, in one place: what sends a message, and the few shortcuts Pelican shares with Claude
 * Desktop and the CLI (Esc stops Claude, ⌘K searches the sessions, ⌘\ closes a pane, Ctrl+` the
 * terminal, ⌘/ lists the keys).
 */

type KeyLike = { key: string; code?: string; isComposing?: boolean; keyCode?: number; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean };

/** Apple keyboards print ⌘ where others print Ctrl, and their Ctrl+K is the text fields' own. */
export const isApple = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

/** The shortcut modifier as it is printed on this keyboard. */
export const MOD = isApple ? '⌘' : 'Ctrl';

/** The same, in the form aria-keyshortcuts takes. */
export const MOD_ARIA = isApple ? 'Meta' : 'Control';

/**
 * Whether a key belongs to an input method choosing a candidate (Chinese, Japanese, Korean).
 * Safari ends the composition before the keydown of the Enter that confirms it, so isComposing
 * is false by then; that keydown still says 229, the code browsers give keys an input method takes.
 */
export const composing = (e: KeyLike): boolean => Boolean(e.isComposing) || e.keyCode === 229;

/** Cmd/Ctrl+\: closes the pane beside the conversation it is pressed in, as Close pane does in Claude Desktop. */
export const closesPane = (e: KeyLike): boolean => e.key === '\\' && Boolean(e.metaKey || e.ctrlKey);

/**
 * Ctrl+`: shows the terminal, and hides it from inside it, as in Claude Desktop (Ctrl on a Mac
 * too). The key left of 1, whatever a keyboard prints on it.
 */
export const togglesTerminal = (e: KeyLike): boolean =>
  Boolean(e.ctrlKey) && !e.metaKey && !e.altKey && !e.shiftKey && (e.code === 'Backquote' || e.key === '`');

/** ⌘ on Apple keyboards, Ctrl elsewhere, with no other modifier. */
export const withMod = (e: KeyLike): boolean =>
  (isApple ? Boolean(e.metaKey) && !e.ctrlKey : Boolean(e.ctrlKey) && !e.metaKey) && !e.altKey && !e.shiftKey;

/**
 * Whether a key in the message box sends it. ⌘/Ctrl+Enter always does, as in the prompt editor;
 * the Enter key setting decides only what a plain Enter does.
 */
export function sendsMessage(e: KeyLike, enterSends: boolean): boolean {
  if (e.key !== 'Enter' || composing(e)) return false;
  if (e.metaKey || e.ctrlKey) return true;
  return enterSends && !e.shiftKey && !e.altKey;
}

/** A computer: a mouse or trackpad that can hover, so a keyboard is very likely there too. */
export const hasKeyboard = (): boolean => typeof window !== 'undefined' && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
