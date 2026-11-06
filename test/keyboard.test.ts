import { describe, expect, it } from 'vitest';

import {
  ariaKeys,
  BROWSER_KEEPS,
  browserKeeps,
  chordParts,
  chordsOf,
  chordText,
  composing,
  isKey,
  KEY_GROUPS,
  KEY_IDS,
  type KeyId,
  KEYS,
  type KeyScope,
  keyText,
  keyWorks,
  normalize,
  pressed,
  sendsMessage,
  shortcutList,
  withKey,
} from '../src/web/lib/keyboard';

const APPLE = true;
const OTHER = false;

describe('the Enter that confirms an input method candidate', () => {
  it('is composing in Safari too, where isComposing is already false but the key says 229', () => {
    expect(composing({ key: 'Enter', isComposing: false, keyCode: 229 })).toBe(true);
    expect(composing({ key: 'Enter', isComposing: true, keyCode: 13 })).toBe(true);
    expect(composing({ key: 'Enter', isComposing: false, keyCode: 13 })).toBe(false);
  });

  it('never sends, whatever the Enter key setting', () => {
    for (const enterSends of [true, false]) {
      expect(sendsMessage({ key: 'Enter', keyCode: 229 }, enterSends)).toBe(false);
      expect(sendsMessage({ key: 'Enter', isComposing: true }, enterSends)).toBe(false);
      expect(sendsMessage({ key: 'Enter', keyCode: 229, metaKey: true }, enterSends)).toBe(false);
    }
  });

  it('is no shortcut either', () => {
    expect(pressed({ key: 'k', metaKey: true, keyCode: 229 }, 'mod+k', APPLE)).toBe(false);
  });
});

describe('sending with the keyboard', () => {
  it('⌘/Ctrl+Enter always sends; the setting decides only what a plain Enter does', () => {
    expect(sendsMessage({ key: 'Enter', metaKey: true }, false)).toBe(true);
    expect(sendsMessage({ key: 'Enter', ctrlKey: true }, false)).toBe(true);
    expect(sendsMessage({ key: 'Enter' }, false)).toBe(false);
    expect(sendsMessage({ key: 'Enter' }, true)).toBe(true);
  });

  it('Shift+Enter is a new line', () => {
    expect(sendsMessage({ key: 'Enter', shiftKey: true }, true)).toBe(false);
    expect(sendsMessage({ key: 'a' }, true)).toBe(false);
  });
});

describe('Claude Desktop’s web keys', () => {
  it('are Desktop’s, as its web build binds them', () => {
    const shown = (id: KeyId) => chordsOf(id)[0];
    expect(shown('commandMenu')).toBe('mod+k');
    expect(shown('searchSessions')).toBe('mod+shift+k');
    expect(shown('newSession')).toBe('mod+shift+o');
    expect(shown('settings')).toBe('mod+shift+,');
    expect(shown('shortcuts')).toBe('mod+/');
    expect(shown('rename')).toBe('mod+alt+r');
    expect(shown('fork')).toBe('mod+alt+o');
    expect(shown('archive')).toBe('mod+alt+a');
    expect(shown('sideChat')).toBe('mod+;');
    expect(shown('transcriptView')).toBe('ctrl+o');
    expect(shown('backgroundTasks')).toBe('ctrl+b');
    expect(shown('changes')).toBe('ctrl+shift+d');
    expect(shown('files')).toBe('mod+shift+f');
    expect(shown('terminal')).toBe('ctrl+`');
    expect(shown('newTerminal')).toBe('ctrl+shift+`');
    expect(shown('closePane')).toBe('mod+\\');
    expect(shown('quoteSelection')).toBe('mod+shift+l');
    expect(shown('addFiles')).toBe('mod+u');
    expect(shown('model')).toBe('mod+shift+i');
    expect(shown('effort')).toBe('mod+shift+e');
    expect(shown('fastMode')).toBe('mod+alt+f');
    expect(shown('mode')).toBe('mod+alt+m');
    // Pin has none on the web, where ⌥⌘P is Desktop's preview pane.
    expect(KEY_IDS.some((id) => chordsOf(id).includes('mod+alt+p'))).toBe(false);
  });

  it('tells ⌘K from ⇧⌘K: the command menu’s and the session search’s', () => {
    const cmdK = { key: 'k', code: 'KeyK', metaKey: true };
    const shiftCmdK = { key: 'K', code: 'KeyK', metaKey: true, shiftKey: true };
    expect(isKey(cmdK, 'commandMenu', APPLE)).toBe(true);
    expect(isKey(shiftCmdK, 'commandMenu', APPLE)).toBe(false);
    expect(isKey(shiftCmdK, 'searchSessions', APPLE)).toBe(true);
    expect(isKey({ ...shiftCmdK, metaKey: false, ctrlKey: true }, 'searchSessions', OTHER)).toBe(true);
    expect(isKey({ ...cmdK, metaKey: false, ctrlKey: true }, 'commandMenu', OTHER)).toBe(true);
    // Until the command menu is here, ⌘K still finds a session, as it did.
    expect(keyWorks('commandMenu')).toBe(false);
    expect(isKey(cmdK, 'searchSessions', APPLE)).toBe(true);
    // On a Mac, Control+K is the text field's own (delete to the end of the line).
    expect(isKey({ key: 'k', ctrlKey: true }, 'searchSessions', APPLE)).toBe(false);
  });

  it('takes ⌘, for Settings too where the browser passes it on, and ⇧⌘, however a layout prints it', () => {
    expect(isKey({ key: ',', code: 'Comma', metaKey: true, shiftKey: true }, 'settings', APPLE)).toBe(true);
    expect(isKey({ key: '<', code: 'Comma', metaKey: true, shiftKey: true }, 'settings', APPLE)).toBe(true);
    expect(isKey({ key: ',', code: 'Comma', metaKey: true }, 'settings', APPLE)).toBe(true);
    expect(isKey({ key: '<', code: 'Comma', ctrlKey: true, shiftKey: true }, 'settings', OTHER)).toBe(true);
    // Shown is only Desktop's web key: ⌘, is the browser's own.
    expect(keyText('settings', APPLE)).toBe('⇧⌘,');
    expect(browserKeeps('mod+,', APPLE)).toBe(true);
  });

  it('knows Control from ⌘ on a Mac, and the two as one Ctrl elsewhere', () => {
    const ctrlShiftD = { key: 'D', code: 'KeyD', ctrlKey: true, shiftKey: true };
    expect(isKey(ctrlShiftD, 'changes', APPLE)).toBe(true);
    expect(isKey(ctrlShiftD, 'changes', OTHER)).toBe(true);
    // The ⌘⇧D Changes and files had before still works on a Mac, where a browser passes it on.
    expect(isKey({ key: 'D', code: 'KeyD', metaKey: true, shiftKey: true }, 'changes', APPLE)).toBe(true);
    expect(isKey({ key: 'o', code: 'KeyO', ctrlKey: true }, 'transcriptView', APPLE)).toBe(true);
    expect(isKey({ key: 'o', code: 'KeyO', metaKey: true }, 'transcriptView', APPLE)).toBe(false);
    expect(isKey({ key: ';', code: 'Semicolon', metaKey: true, ctrlKey: true }, 'sideChat', APPLE)).toBe(false);
    expect(isKey({ key: ';', code: 'Semicolon', metaKey: true, ctrlKey: true }, 'sideChat', OTHER)).toBe(false);
    expect(isKey({ key: ';', code: 'Semicolon', ctrlKey: true }, 'sideChat', OTHER)).toBe(true);
    expect(normalize('mod+shift+d', OTHER)).toBe(normalize('ctrl+shift+d', OTHER));
    expect(normalize('mod+shift+d', APPLE)).not.toBe(normalize('ctrl+shift+d', APPLE));
  });

  it('reads ⌥ chords on a Mac by where the key is, since ⌥R types ®', () => {
    expect(isKey({ key: '®', code: 'KeyR', metaKey: true, altKey: true }, 'rename', APPLE)).toBe(true);
    expect(isKey({ key: 'ø', code: 'KeyO', metaKey: true, altKey: true }, 'fork', APPLE)).toBe(true);
    expect(isKey({ key: 'å', code: 'KeyA', metaKey: true, altKey: true }, 'archive', APPLE)).toBe(true);
    expect(isKey({ key: '®', code: 'KeyR', metaKey: true }, 'rename', APPLE)).toBe(false);
  });

  it('never takes AltGr typing a character for a Ctrl+Alt chord', () => {
    // Polish ą is AltGr+A, which a browser off a Mac reports as Ctrl+Alt+A.
    const altGr = { key: 'ą', code: 'KeyA', ctrlKey: true, altKey: true, getModifierState: (key: string) => key === 'AltGraph' };
    expect(isKey(altGr, 'archive', OTHER)).toBe(false);
    expect(isKey({ ...altGr, getModifierState: () => false }, 'archive', OTHER)).toBe(true);
  });

  it('finds the key of another script’s layout where it sits, and a letter where the layout prints it', () => {
    // A Russian layout gives л for K.
    expect(isKey({ key: 'л', code: 'KeyK', ctrlKey: true, shiftKey: true }, 'searchSessions', OTHER)).toBe(true);
    // AZERTY prints A where QWERTY has Q: the letter counts, not the place.
    expect(pressed({ key: 'a', code: 'KeyQ', metaKey: true }, 'mod+a', APPLE)).toBe(true);
    expect(pressed({ key: 'a', code: 'KeyQ', metaKey: true }, 'mod+q', APPLE)).toBe(false);
    // ` and ~ are the same key.
    expect(isKey({ key: '`', code: 'Backquote', ctrlKey: true }, 'terminal', APPLE)).toBe(true);
    expect(isKey({ key: '~', code: 'Backquote', ctrlKey: true, shiftKey: true }, 'newTerminal', APPLE)).toBe(true);
    expect(isKey({ key: '~', code: 'Backquote', ctrlKey: true, shiftKey: true }, 'terminal', APPLE)).toBe(false);
  });

  it('prints keys as each keyboard does: symbols in Apple’s order on a Mac, words elsewhere', () => {
    expect(keyText('searchSessions', APPLE)).toBe('⇧⌘K');
    expect(keyText('searchSessions', OTHER)).toBe('Ctrl+Shift+K');
    expect(keyText('changes', APPLE)).toBe('⌃⇧D');
    expect(keyText('changes', OTHER)).toBe('Ctrl+Shift+D');
    expect(keyText('closePane', APPLE)).toBe('⌘\\');
    expect(keyText('copy', APPLE)).toBe('⌘C');
    expect(chordText('mod+alt+r', APPLE)).toBe('⌥⌘R');
    expect(chordText('mod+alt+r', OTHER)).toBe('Ctrl+Alt+R');
    expect(chordParts('ctrl+shift+`', APPLE)).toEqual(['⌃', '⇧', '`']);
    expect(chordParts('mod+enter', APPLE)).toEqual(['⌘', '↵']);
    expect(chordParts('escape', OTHER)).toEqual(['Esc']);
    expect(withKey('Close', 'sideChat', OTHER)).toBe('Close (Ctrl+;)');
    expect(ariaKeys('searchSessions', APPLE)).toBe('Shift+Meta+K Meta+K');
    // Off a Mac, ⌘⇧D and ⌃⇧D are the same keys.
    expect(ariaKeys('changes', OTHER)).toBe('Control+Shift+D');
  });

  it('names no key that is not here yet, in a menu or a title', () => {
    for (const id of KEY_IDS.filter((key) => !keyWorks(key))) {
      expect(keyText(id, APPLE)).toBeUndefined();
      expect(ariaKeys(id, APPLE)).toBeUndefined();
      expect(withKey('Rename', id)).toBe('Rename');
    }
  });
});

/** Every chord a key is pressed with, shown or taken too, as held on one kind of keyboard. */
const held = (id: KeyId, apple: boolean, enterSends: boolean) => {
  const def = KEYS[id] as { also?: readonly string[] };
  return [...new Set([...chordsOf(id, { enterSends }), ...(def.also ?? [])].map((chord) => normalize(chord, apple)))];
};
const scopeOf = (id: KeyId): KeyScope => KEYS[id].scope;

/**
 * Keys that pass from one thing to another as 0.5.0 is built: ⌘K finds a session until the command
 * menu takes it, and ⌘↵ sends until it queues for later while Claude works.
 */
const HANDOVERS: Array<[coming: KeyId, going: KeyId]> = [['commandMenu', 'searchSessions'], ['queue', 'send']];
const handedOver = (a: KeyId, b: KeyId) => HANDOVERS.some(([x, y]) => (x === a && y === b) || (x === b && y === a));

describe('the key table', () => {
  it('gives no two things one key in one place, on either kind of keyboard, whatever the Enter key does', () => {
    for (const apple of [APPLE, OTHER]) {
      for (const enterSends of [true, false]) {
        const seen = new Map<string, KeyId>();
        for (const id of KEY_IDS) {
          for (const chord of held(id, apple, enterSends)) {
            const where = `${scopeOf(id)} ${chord}`;
            const other = seen.get(where);
            if (other) expect(handedOver(id, other), `${id} and ${other} share ${where}`).toBe(true);
            else seen.set(where, id);
          }
        }
      }
    }
  });

  it('hands a key over only from one that works to one still to come', () => {
    for (const [coming, going] of HANDOVERS) {
      expect(keyWorks(coming)).toBe(false);
      expect(keyWorks(going)).toBe(true);
    }
  });

  it('takes no key a browser keeps for itself; only keys it shows nowhere may be ones a browser passes on', () => {
    for (const apple of [APPLE, OTHER]) {
      for (const id of KEY_IDS) {
        if ('browser' in KEYS[id]) continue;
        for (const context of [{ enterSends: true }, { enterSends: false }]) {
          for (const chord of chordsOf(id, context)) expect(browserKeeps(chord, apple), `${id}: ${chord}`).toBe(false);
        }
      }
    }
    // The browser's own keys are there to show beside what they do, and are the browser's.
    for (const id of ['copy', 'paste', 'selectAll'] as const) expect(browserKeeps(chordsOf(id)[0]!, APPLE)).toBe(true);
    expect(BROWSER_KEEPS.apple).toContain('mod+shift+d');
    expect(BROWSER_KEEPS.apple).toContain('mod+n');
  });

  it('lists every key that works, in Desktop’s parts and order, and none that does not', () => {
    const parts = shortcutList({ enterSends: true }, APPLE);
    expect(parts.map((part) => part.group)).toEqual(KEY_GROUPS.filter((group) => parts.some((part) => part.group === group)));
    const listed = parts.flatMap((part) => part.rows.map((row) => row.id));
    const works = KEY_IDS.filter((id) => keyWorks(id) && !('browser' in KEYS[id]));
    expect([...listed].sort()).toEqual([...works].sort());
    expect(parts.find((part) => part.group === 'General')!.rows.map((row) => `${row.label}: ${row.keys.map((k) => k.join(' ')).join(' or ')}`)).toEqual([
      'Search sessions: ⇧ ⌘ K',
      'New session: ⇧ ⌘ O',
      'Settings: ⇧ ⌘ ,',
      'Keyboard shortcuts: ⌘ /',
      'Close a menu or sheet: esc',
    ]);
  });

  it('says what sends a message by the Enter key setting', () => {
    const rows = (enterSends: boolean) => shortcutList({ enterSends }, OTHER).find((part) => part.group === 'Message box')!.rows;
    const keys = (enterSends: boolean, id: KeyId) => rows(enterSends).find((row) => row.id === id)!.keys.map((k) => k.join(' '));
    expect(keys(true, 'send')).toEqual(['Enter', 'Ctrl Enter']);
    expect(keys(true, 'newLine')).toEqual(['Shift Enter']);
    expect(keys(false, 'send')).toEqual(['Ctrl Enter']);
    expect(keys(false, 'newLine')).toEqual(['Enter']);
  });
});
