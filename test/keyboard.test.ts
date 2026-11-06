import { describe, expect, it } from 'vitest';

import { composing, sendsMessage, togglesTerminal } from '../src/web/lib/keyboard';

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

describe('the terminal’s key', () => {
  it('is Ctrl+`, as in Claude Desktop, on a Mac too, by the key left of 1 whatever it prints', () => {
    expect(togglesTerminal({ key: '`', code: 'Backquote', ctrlKey: true })).toBe(true);
    // A layout where that key prints something else.
    expect(togglesTerminal({ key: '^', code: 'Backquote', ctrlKey: true })).toBe(true);
    expect(togglesTerminal({ key: '`', code: 'Backquote' })).toBe(false);
    expect(togglesTerminal({ key: '`', code: 'Backquote', metaKey: true })).toBe(false);
    expect(togglesTerminal({ key: '~', code: 'Backquote', ctrlKey: true, shiftKey: true })).toBe(false);
  });
});
