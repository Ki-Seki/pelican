// What the terminal's keys send, and how its screen reads as text: the phone's key row and line
// field, and the screen as text behind a long press (src/web/lib/terminal-input.ts).
import { describe, expect, it } from 'vitest';

import { terminalClientMessage, utf8Pieces } from '../src/shared/terminal';
import {
  asksForSecret, bufferText, type BufferLike, colorQuery, controlCharacter, keySequence, lineBeforeCursor, themeColors, viewportText,
} from '../src/web/lib/terminal-input';

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

describe('the colors a program asks for', () => {
  it('are the server’s to answer: the page swallows the asking, and draws a color set alongside', () => {
    expect(colorQuery(11, '?')).toEqual({ asks: true });
    expect(colorQuery(10, '?;?')).toEqual({ asks: true });
    expect(colorQuery(4, '1;?;196;?')).toEqual({ asks: true });
    // Setting alone is the page's own.
    expect(colorQuery(11, '#102030')).toEqual({ asks: false });
    expect(colorQuery(4, '1;rgb:ff/00/00')).toEqual({ asks: false });
    // Both: what is set, as a sequence of its own, for the page to draw.
    expect(colorQuery(10, '#ffffff;?;#00ff00')).toEqual({ asks: true, sets: '\u001b]10;#ffffff\u001b\\\u001b]12;#00ff00\u001b\\' });
    expect(colorQuery(4, '1;?;2;#00ff00')).toEqual({ asks: true, sets: '\u001b]4;2;#00ff00\u001b\\' });
    // Past the cursor's color, 10's slots end, as xterm reads them.
    expect(colorQuery(12, '?;#ffffff')).toEqual({ asks: true });
  });

  it('are answered from the colors the page says it draws in, each #rrggbb', () => {
    const theme = {
      foreground: '#171717', background: '#fafafa', cursor: '#171717',
      black: '#000000', red: '#cf222e', green: '#116329', yellow: '#4d2d00', blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
      brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#633c01', brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#8c959f',
    };
    const colors = themeColors(theme);
    expect(colors).toEqual({ foreground: '#171717', background: '#fafafa', cursor: '#171717', ansi: expect.arrayContaining(['#cf222e']) });
    expect(colors?.ansi).toHaveLength(16);
    expect(colors?.ansi[1]).toBe('#cf222e');
    expect(colors?.ansi[15]).toBe('#8c959f');
    expect(terminalClientMessage(JSON.stringify({ type: 'colors', colors }))).toEqual({ type: 'colors', colors });
    // Anything else says nothing.
    expect(themeColors({ ...theme, background: 'rgba(0, 0, 0, 0.5)' })).toBeUndefined();
    expect(themeColors({ ...theme, brightWhite: undefined } as unknown as typeof theme)).toBeUndefined();
    expect(terminalClientMessage(JSON.stringify({ type: 'colors', colors: { ...colors, ansi: colors?.ansi.slice(1) } }))).toBeUndefined();
  });
});

describe('output in pieces', () => {
  it('is cut only between characters, so xterm takes each whole, and is all there', () => {
    const encoder = new TextEncoder();
    const text = `a\u2014b\u{1f680}c\u00e9\u4e2d${'x'.repeat(10)}\u2026`;
    const bytes = encoder.encode(text);
    for (let size = 4; size <= bytes.length + 1; size += 1) {
      const pieces = utf8Pieces(bytes, size);
      expect(pieces.every((piece) => piece.length <= size && piece.length > 0)).toBe(true);
      // Each piece reads as text on its own: no character is cut.
      const decoder = new TextDecoder('utf-8', { fatal: true });
      expect(pieces.map((piece) => decoder.decode(piece)).join('')).toBe(text);
    }
    // A frame boundary right after E2 80, the start of an em dash: the dash goes to the next piece.
    const dash = encoder.encode('ab\u2014cd');
    expect(utf8Pieces(dash, 4).map((piece) => [...piece])).toEqual([[0x61, 0x62], [0xe2, 0x80, 0x94, 0x63], [0x64]]);
    expect(utf8Pieces(dash, 64)).toEqual([dash]);
  });
});
