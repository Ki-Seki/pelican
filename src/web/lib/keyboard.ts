/**
 * Keys, in one place: Claude Desktop's web key table (the keys its Code tab takes in a browser,
 * which Pelican takes too, under the same names), what sends a message, and the keys a browser
 * keeps for itself. The list of keys (Shortcuts, ⌘/) is made from this table, and a menu shows
 * an action's key from it, so neither can name a key that does not work.
 */

export type KeyLike = {
  key: string;
  code?: string;
  isComposing?: boolean;
  keyCode?: number;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  /** AltGr, which types a character on many layouts off a Mac. */
  getModifierState?(key: 'AltGraph'): boolean;
};

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

/**
 * A key and the modifiers held with it, written as Desktop's table writes them: `mod+shift+k`.
 * `mod` is ⌘ on an Apple keyboard and Ctrl on others; `ctrl` is Control itself, on a Mac too
 * (Desktop's ⌃O and ⌃`); `alt` is ⌥ or Alt. The key is what KeyboardEvent.key gives with no
 * modifier held, in lower case: `k`, `,`, `` ` ``, `enter`, `escape`.
 */
export type Chord = string;

/** Where a key works: anywhere on the page, or only where its thing has the keys. */
export type KeyScope =
  | 'page'
  /** The message box. */
  | 'box'
  /** While the Quote pill shows over a selection. */
  | 'pill'
  /** The note box a quote opens. */
  | 'note'
  /** Changes and files, with comments waiting. */
  | 'comments'
  /** A question Claude asks, while it waits. */
  | 'question'
  /** An open menu or sheet. */
  | 'dialog';

/** The parts of the list of keys, in Desktop's order. */
export const KEY_GROUPS = ['General', 'This session', 'Panes', 'Message box', 'Quotes and comments', 'Questions'] as const;
export type KeyGroup = (typeof KEY_GROUPS)[number];

/** What the message box's keys depend on: the Enter key setting. */
export type KeyContext = { enterSends: boolean };

export type KeyDef = {
  label: string;
  /** Its part of the list of keys; none for the browser's own. */
  group?: KeyGroup;
  scope: KeyScope;
  /** Shown, first the key itself, then any that do the same (Send: ↵ or ⌘↵). */
  keys: readonly Chord[] | ((context: KeyContext) => readonly Chord[]);
  /** Taken too, never shown: a key a browser may keep (⌘, for Settings), or the one Pelican had before. */
  also?: readonly Chord[];
  /**
   * Desktop's key for a part of 0.5.0 that is not here yet: nothing takes it, and the list of keys
   * and the menus leave it out until something does.
   */
  soon?: true;
  /** The browser's own key (Copy, Paste), shown in a menu beside what it does; Pelican never takes it. */
  browser?: true;
};

/**
 * Claude Desktop's web keys, by what they do, in the order the list of keys shows them. Where the
 * desktop app's key is the browser's (⌘N, ⌘⇧D, ⌘,), its web build has another, and so does Pelican.
 */
export const KEYS = {
  commandMenu: { label: 'Command menu', group: 'General', scope: 'page', keys: ['mod+k'], soon: true },
  // ⌘K finds a session until the command menu takes it, as it did before.
  searchSessions: { label: 'Search sessions', group: 'General', scope: 'page', keys: ['mod+shift+k'], also: ['mod+k'] },
  newSession: { label: 'New session', group: 'General', scope: 'page', keys: ['mod+shift+o'] },
  settings: { label: 'Settings', group: 'General', scope: 'page', keys: ['mod+shift+,'], also: ['mod+,'] },
  shortcuts: { label: 'Keyboard shortcuts', group: 'General', scope: 'page', keys: ['mod+/'] },
  close: { label: 'Close a menu or sheet', group: 'General', scope: 'dialog', keys: ['escape'] },

  rename: { label: 'Rename', group: 'This session', scope: 'page', keys: ['mod+alt+r'], soon: true },
  fork: { label: 'Fork', group: 'This session', scope: 'page', keys: ['mod+alt+o'], soon: true },
  archive: { label: 'Archive', group: 'This session', scope: 'page', keys: ['mod+alt+a'], soon: true },
  sideChat: { label: 'Side chat', group: 'This session', scope: 'page', keys: ['mod+;'] },
  transcriptView: { label: 'Transcript view', group: 'This session', scope: 'page', keys: ['ctrl+o'] },
  backgroundTasks: { label: 'Background tasks', group: 'This session', scope: 'page', keys: ['ctrl+b'], soon: true },

  // Control on a Mac too, as in Desktop's web build: ⌘⇧D is the browser's (bookmark all tabs).
  changes: { label: 'Changes and files', group: 'Panes', scope: 'page', keys: ['ctrl+shift+d'], also: ['mod+shift+d'] },
  files: { label: 'Files', group: 'Panes', scope: 'page', keys: ['mod+shift+f'], soon: true },
  terminal: { label: 'Terminal', group: 'Panes', scope: 'page', keys: ['ctrl+`'], soon: true },
  newTerminal: { label: 'New terminal', group: 'Panes', scope: 'page', keys: ['ctrl+shift+`'], soon: true },
  closePane: { label: 'Close pane', group: 'Panes', scope: 'page', keys: ['mod+\\'] },

  send: { label: 'Send', group: 'Message box', scope: 'box', keys: ({ enterSends }) => (enterSends ? ['enter', 'mod+enter'] : ['mod+enter']) },
  newLine: { label: 'New line', group: 'Message box', scope: 'box', keys: ({ enterSends }) => (enterSends ? ['shift+enter'] : ['enter']) },
  queue: { label: 'Queue for later, while Claude works', group: 'Message box', scope: 'box', keys: ['mod+enter'], soon: true },
  addFiles: { label: 'Add files or photos', group: 'Message box', scope: 'page', keys: ['mod+u'], soon: true },
  model: { label: 'Model', group: 'Message box', scope: 'page', keys: ['mod+shift+i'], soon: true },
  effort: { label: 'Effort', group: 'Message box', scope: 'page', keys: ['mod+shift+e'], soon: true },
  fastMode: { label: 'Fast mode', group: 'Message box', scope: 'page', keys: ['mod+alt+f'], soon: true },
  mode: { label: 'Mode', group: 'Message box', scope: 'page', keys: ['mod+alt+m'], soon: true },
  stop: { label: 'Stop', group: 'Message box', scope: 'page', keys: ['escape'] },
  // Typed at the start of a word in the box, not pressed with a modifier.
  commands: { label: 'Commands', group: 'Message box', scope: 'box', keys: ['/'] },
  mention: { label: 'Files and agents', group: 'Message box', scope: 'box', keys: ['@'] },
  shell: { label: 'Shell command', group: 'Message box', scope: 'box', keys: ['!'] },

  quote: { label: 'Quote, with the pill showing', group: 'Quotes and comments', scope: 'pill', keys: ['enter'] },
  quoteSelection: { label: 'Quote without a note', group: 'Quotes and comments', scope: 'page', keys: ['mod+shift+l'] },
  // As in the message box: where the Enter key makes a new line, it does so in a note too.
  noteAdd: { label: 'Note box: add', group: 'Quotes and comments', scope: 'note', keys: ({ enterSends }) => (enterSends ? ['enter'] : []) },
  noteSend: { label: 'Note box: send now', group: 'Quotes and comments', scope: 'note', keys: ['mod+enter'] },
  commentsSend: { label: 'Changes and files: send all comments', group: 'Quotes and comments', scope: 'comments', keys: ['mod+enter'] },

  pickAnswer: { label: 'Pick an answer', group: 'Questions', scope: 'question', keys: ['1', '2', '3', '4', '5', '6', '7', '8', '9'], soon: true },

  copy: { label: 'Copy', scope: 'page', keys: ['mod+c'], browser: true },
  paste: { label: 'Paste', scope: 'page', keys: ['mod+v'], browser: true },
  selectAll: { label: 'Select all', scope: 'page', keys: ['mod+a'], browser: true },
} as const satisfies Record<string, KeyDef>;

export type KeyId = keyof typeof KEYS;

const def = (id: KeyId): KeyDef => KEYS[id];

/** Every key in the table, in its order. */
export const KEY_IDS = Object.keys(KEYS) as KeyId[];

/** Whether something takes this key now: one of Pelican's, or the browser's own. */
export const keyWorks = (id: KeyId): boolean => !def(id).soon;

/** The keys shown for it, first the key itself. */
export function chordsOf(id: KeyId, context: KeyContext = { enterSends: true }): readonly Chord[] {
  const { keys } = def(id);
  return typeof keys === 'function' ? keys(context) : keys;
}

type Parsed = { key: string; mod: boolean; ctrl: boolean; shift: boolean; alt: boolean };

function parse(chord: Chord): Parsed {
  const parts = chord.split('+');
  const mods = new Set(parts.slice(0, -1));
  return { key: parts.at(-1)!, mod: mods.has('mod'), ctrl: mods.has('ctrl'), shift: mods.has('shift'), alt: mods.has('alt') };
}

/**
 * A chord as the keys actually held on one kind of keyboard, so two written differently compare
 * equal where they are the same keys: off a Mac, `mod` and `ctrl` are both Control.
 */
export function normalize(chord: Chord, apple: boolean): string {
  const c = parse(chord);
  const control = apple ? c.ctrl : c.ctrl || c.mod;
  return [control && 'ctrl', c.alt && 'alt', c.shift && 'shift', apple && c.mod && 'meta', c.key].filter(Boolean).join('+');
}

/** The key a physical key gives with no modifier on a US layout, for the codes a chord can name. */
const CODE_KEYS: Record<string, string> = {
  Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Semicolon: ';', Quote: "'", Backquote: '`',
  BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Space: ' ',
};

function codeKey(code: string | undefined): string | undefined {
  if (!code) return undefined;
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1]!.toLowerCase();
  const digit = /^Digit(\d)$/.exec(code);
  if (digit) return digit[1];
  return CODE_KEYS[code];
}

/**
 * The key a keydown names, as a chord writes it. A letter or a digit is what the layout prints on
 * it (an AZERTY A is `a`); anything else held with Shift or ⌥, or that is not a plain character
 * (⌥R gives ®, ⇧, gives <, a Russian layout gives л), is read by where it sits on the keyboard.
 */
function keyOf(e: KeyLike): string {
  const key = e.key.toLowerCase();
  if (/^[a-z0-9]$/.test(key)) return key;
  if (!e.shiftKey && !e.altKey && /^[\x21-\x7e]$/.test(e.key)) return key;
  return codeKey(e.code) ?? key;
}

/** Whether a keydown is one chord, with exactly its modifiers held. */
export function pressed(e: KeyLike, chord: Chord, apple = isApple): boolean {
  if (composing(e)) return false;
  const c = parse(chord);
  // AltGr types a character (Ctrl+Alt to the browser, on Windows): never a chord of Ctrl+Alt.
  if (!apple && e.getModifierState?.('AltGraph')) return false;
  const meta = apple ? c.mod : false;
  const control = apple ? c.ctrl : c.ctrl || c.mod;
  if (Boolean(e.metaKey) !== meta || Boolean(e.ctrlKey) !== control) return false;
  if (Boolean(e.altKey) !== c.alt || Boolean(e.shiftKey) !== c.shift) return false;
  return keyOf(e) === c.key;
}

/** Whether a keydown is the key for this, or one it takes too. */
export function isKey(e: KeyLike, id: KeyId, apple = isApple, context?: KeyContext): boolean {
  return [...chordsOf(id, context), ...(def(id).also ?? [])].some((chord) => pressed(e, chord, apple));
}

const APPLE_MODS: Array<[keyof Parsed, string]> = [['ctrl', '⌃'], ['alt', '⌥'], ['shift', '⇧'], ['mod', '⌘']];
const OTHER_MODS: Array<[keyof Parsed, string]> = [['mod', 'Ctrl'], ['ctrl', 'Ctrl'], ['alt', 'Alt'], ['shift', 'Shift']];
const NAMES: Record<string, [apple: string, other: string]> = {
  enter: ['↵', 'Enter'],
  escape: ['esc', 'Esc'],
  tab: ['⇥', 'Tab'],
  arrowup: ['↑', '↑'],
  arrowdown: ['↓', '↓'],
  arrowleft: ['←', '←'],
  arrowright: ['→', '→'],
  pageup: ['PgUp', 'PgUp'],
  pagedown: ['PgDn', 'PgDn'],
  ' ': ['Space', 'Space'],
};

/** A chord as a keyboard prints its keys: ⇧ ⌘ K on a Mac (in Apple's order), Ctrl Shift K elsewhere. */
export function chordParts(chord: Chord, apple = isApple): string[] {
  const c = parse(chord);
  const mods = (apple ? APPLE_MODS : OTHER_MODS).filter(([name]) => c[name]).map(([, sign]) => sign);
  const name = NAMES[c.key]?.[apple ? 0 : 1] ?? (/^f\d+$/.test(c.key) ? c.key.toUpperCase() : c.key.length === 1 ? c.key.toUpperCase() : c.key);
  return [...new Set(mods), name];
}

/** A chord in a line of text: ⇧⌘K on a Mac, Ctrl+Shift+K elsewhere. */
export const chordText = (chord: Chord, apple = isApple): string => chordParts(chord, apple).join(apple ? '' : '+');

/**
 * The key for this as a menu or a button's title shows it, faintly beside its name; none while
 * nothing takes it yet, or where the Enter key setting (`context`) gives it none.
 */
export function keyText(id: KeyId, apple = isApple, context?: KeyContext): string | undefined {
  if (!keyWorks(id)) return undefined;
  const first = chordsOf(id, context)[0];
  return first ? chordText(first, apple) : undefined;
}

/** A name with its key, for a button's title: "Close (⌘\)". */
export const withKey = (label: string, id: KeyId, apple = isApple): string => {
  const text = keyText(id, apple);
  return text ? `${label} (${text})` : label;
};

const ARIA_NAMES: Record<string, string> = { enter: 'Enter', escape: 'Escape', ' ': 'Space' };

/** Every key that does this, in the form aria-keyshortcuts takes, for an element that has it; none if none does. */
export function ariaKeys(id: KeyId, apple = isApple, context?: KeyContext): string | undefined {
  if (!keyWorks(id)) return undefined;
  const chords = [...chordsOf(id, context), ...(def(id).also ?? [])];
  if (chords.length === 0) return undefined;
  const names = chords.map((chord) => {
    const c = parse(chord);
    const mods = [
      (apple ? c.ctrl : c.ctrl || c.mod) && 'Control',
      c.alt && 'Alt',
      c.shift && 'Shift',
      apple && c.mod && 'Meta',
    ].filter(Boolean);
    return [...mods, ARIA_NAMES[c.key] ?? (c.key.length === 1 ? c.key.toUpperCase() : c.key)].join('+');
  });
  return [...new Set(names)].join(' ');
}

/**
 * Keys a browser keeps for itself, on each kind of keyboard: it opens, closes or switches windows
 * and tabs with them, or reaches its address bar, bookmarks, settings, find, print or zoom, and the
 * system has a few. A page never gets some of them, and taking the others takes away the browser's
 * own, so none is a key of Pelican's. Two are taken as well, where a browser passes them on (⌘, for
 * Settings, and the ⌘⇧D Changes and files had before); neither is shown.
 *
 * Keys a page may take, where Desktop's web build takes them too, are left out: ⇧⌘K and ⇧⌘I open
 * developer tools in some browsers off a Mac, ⇧⌘O their bookmarks, ⇧⌘L Safari's sidebar, ⌘U a
 * page's source. Each of those does something that also has a place in a menu.
 */
export const BROWSER_KEEPS: { apple: readonly Chord[]; other: readonly Chord[] } = {
  apple: [
    'mod+n', 'mod+shift+n', 'mod+t', 'mod+shift+t', 'mod+w', 'mod+shift+w', 'mod+q',
    'mod+shift+[', 'mod+shift+]', 'mod+alt+arrowleft', 'mod+alt+arrowright', 'ctrl+tab', 'ctrl+shift+tab',
    'mod+1', 'mod+2', 'mod+3', 'mod+4', 'mod+5', 'mod+6', 'mod+7', 'mod+8', 'mod+9',
    'mod+h', 'mod+m', 'mod+`', 'ctrl+mod+f',
    'mod+l', 'mod+r', 'mod+shift+r', 'mod+d', 'mod+shift+d', 'mod+,', 'mod+y',
    'mod+f', 'mod+g', 'mod+shift+g', 'mod+p', 'mod+=', 'mod+-', 'mod+0', 'mod+[', 'mod+]',
    'mod+a', 'mod+c', 'mod+v', 'mod+x', 'mod+z', 'mod+shift+z',
  ],
  other: [
    'mod+n', 'mod+shift+n', 'mod+t', 'mod+shift+t', 'mod+w', 'mod+shift+w', 'mod+f4', 'alt+f4',
    'mod+tab', 'mod+shift+tab', 'mod+pageup', 'mod+pagedown',
    'mod+1', 'mod+2', 'mod+3', 'mod+4', 'mod+5', 'mod+6', 'mod+7', 'mod+8', 'mod+9',
    'mod+l', 'alt+d', 'f5', 'mod+r', 'mod+shift+r', 'mod+d', 'mod+h', 'mod+j', 'f11',
    'mod+f', 'mod+g', 'mod+p', 'mod+=', 'mod+-', 'mod+0', 'alt+arrowleft', 'alt+arrowright',
    'mod+a', 'mod+c', 'mod+v', 'mod+x', 'mod+z', 'mod+y',
  ],
};

/** Whether a browser keeps this chord for itself on this kind of keyboard. */
export function browserKeeps(chord: Chord, apple: boolean): boolean {
  const held = normalize(chord, apple);
  return BROWSER_KEEPS[apple ? 'apple' : 'other'].some((kept) => normalize(kept, apple) === held);
}

/** A row of the list of keys: what it does, and the keys that do it, each as printed. */
export type ShortcutRow = { id: KeyId; label: string; keys: string[][]; range?: boolean };

/**
 * The list of keys, by part, in Desktop's order: every key that works here, and nothing else.
 * The message box's follow the Enter key setting.
 */
export function shortcutList(context: KeyContext, apple = isApple): Array<{ group: KeyGroup; rows: ShortcutRow[] }> {
  return KEY_GROUPS.map((group) => ({
    group,
    rows: KEY_IDS.filter((id) => def(id).group === group && keyWorks(id) && chordsOf(id, context).length > 0).map((id) => {
      const chords = chordsOf(id, context);
      // A run of digits (1 to 9) reads as a range.
      const range = chords.length > 2 && chords.every((chord) => /^\d$/.test(chord));
      const keys = range ? [chordParts(chords[0]!, apple), chordParts(chords.at(-1)!, apple)] : chords.map((chord) => chordParts(chord, apple));
      return { id, label: def(id).label, keys, ...(range ? { range } : {}) };
    }),
  })).filter((part) => part.rows.length > 0);
}
