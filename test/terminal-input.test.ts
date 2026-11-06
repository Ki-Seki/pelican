// What the terminal's keys send, and how its screen reads as text: the phone's key row and line
// field, and the screen as text behind a long press (src/web/lib/terminal-input.ts).
import { describe, expect, it } from 'vitest';

import { asksForSecret, bufferText, type BufferLike, controlCharacter, keySequence, lineBeforeCursor, viewportText } from '../src/web/lib/terminal-input';

describe('the key row', () => {
  it('sends Esc, Tab and the arrows as a terminal does, as the program asked for them', () => {
    expect(keySequence('esc')).toBe('\u001b');
    expect(keySequence('tab')).toBe('\t');
    expect(keySequence('up')).toBe('\u001b[A');
    expect(keySequence('left')).toBe('\u001b[D');
    // vim and less ask for application cursor keys.
    expect(keySequence('down', { applicationCursor: true })).toBe('\u001bOB');
    expect(keySequence('right', { ctrl: true })).toBe('\u001b[1;5C');
  });

  it('sends Ctrl and a character as its control character', () => {
    expect(controlCharacter('c')).toBe('\u0003');
    expect(controlCharacter('C')).toBe('\u0003');
    expect(controlCharacter('d')).toBe('\u0004');
    expect(controlCharacter('[')).toBe('\u001b');
    expect(controlCharacter('\\')).toBe('\u001c');
    expect(controlCharacter(' ')).toBe('\u0000');
    expect(controlCharacter('/')).toBe('\u001f');
    expect(controlCharacter('?')).toBe('\u007f');
    expect(controlCharacter('1')).toBeUndefined();
    expect(controlCharacter('ab')).toBeUndefined();
  });
});

describe('a password prompt', () => {
  it('is told by the line the cursor is on, as sudo, ssh, git and gpg ask, in a few languages', () => {
    for (const line of [
      'Password:',
      'Password: ',
      '[sudo] password for sam:',
      "sam@build-box's password:",
      "Enter passphrase for key '/Users/sam/.ssh/id_ed25519':",
      "Password for 'https://sam@example.com':",
      "Enter PIN for 'PIV Card Holder pin':",
      'Retype new password:',
      'Enter password (will not be echoed):',
      '[sudo] sam \u7684\u5bc6\u7801\uff1a',
      '\u30d1\u30b9\u30ef\u30fc\u30c9:',
      'Passwort:',
    ]) expect(asksForSecret(line), line).toBe(true);
  });

  it('is not a prompt that asks for something else, nor a shell prompt, nor output that mentions one', () => {
    for (const line of [
      "Username for 'https://example.com':",
      'Verification code:',
      'sam@box app % ',
      'sam@box app % echo password',
      'Spinning:',
      'The password was changed.',
      '',
    ]) expect(asksForSecret(line), line).toBe(false);
  });
});

/** A buffer as xterm keeps one: its rows, the ones the terminal wrapped marked so. */
function buffer(rows: Array<string | { wrapped: string }>, cursor: { x: number; y: number } = { x: 0, y: 0 }, viewportY = 0): BufferLike {
  const lines = rows.map((row) => (typeof row === 'string' ? { text: row, isWrapped: false } : { text: row.wrapped, isWrapped: true }));
  return {
    length: lines.length,
    baseY: 0,
    viewportY,
    cursorX: cursor.x,
    cursorY: cursor.y,
    getLine: (y) => {
      const line = lines[y];
      return line && {
        isWrapped: line.isWrapped,
        translateToString: (trimRight = false, start = 0, end = line.text.length) => {
          const text = line.text.slice(start, end);
          return trimRight ? text.trimEnd() : text;
        },
      };
    },
  };
}

describe('the screen as text', () => {
  it('joins what the terminal wrapped, keeping the spaces inside a line, and leaves the empty rows around it out', () => {
    const screen = buffer(['', 'sam@box app % git status   ', 'On branch main, with a line ', { wrapped: 'that the terminal wrapped' }, '', '   ', '']);
    expect(bufferText(screen)).toBe('sam@box app % git status\nOn branch main, with a line that the terminal wrapped');
  });

  it('reads the rows on screen, from where it is scrolled to', () => {
    const screen = buffer(['one', 'two', 'three', 'four', 'five'], { x: 0, y: 0 }, 2);
    expect(viewportText(screen, 2)).toBe('three\nfour');
  });

  it('reads the cursor’s row up to the cursor, for a prompt', () => {
    expect(lineBeforeCursor(buffer(['out', 'Password: typed'], { x: 10, y: 1 }))).toBe('Password:');
  });
});
