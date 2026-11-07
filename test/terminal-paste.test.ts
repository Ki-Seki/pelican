// @vitest-environment jsdom
// What a paste into the terminal sends (src/web/lib/terminal-input.ts): text, without the control
// characters a page can put on the clipboard as you copy from it.
import { describe, expect, it, vi } from 'vitest';

import { cleanPaste, cleanPastes } from '../src/web/lib/terminal-input';

describe('a paste into the terminal', () => {
  it('keeps text, tabs and line ends, and leaves out the control characters', () => {
    // The end of a bracketed paste, then a command and Enter: run at once, were it kept.
    expect(cleanPaste('echo hello\u001b[201~; touch pwned\r')).toBe('echo hello[201~; touch pwned\r');
    expect(cleanPaste('a\tb\nc\r\nd')).toBe('a\tb\nc\r\nd');
    expect(cleanPaste('x\u0003\u0004\u0015\u007f\u009b201~\u0085y')).toBe('x201~y');
    expect(cleanPaste('中文 café 🚀')).toBe('中文 café 🚀');
  });

  it('is taken before xterm sees it, and handed on cleaned', () => {
    const screen = document.createElement('div');
    const textarea = document.createElement('textarea');
    screen.append(textarea);
    document.body.append(screen);
    const xterm = vi.fn();
    textarea.addEventListener('paste', xterm);
    const paste = vi.fn();
    const stop = cleanPastes(screen, paste);
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { getData: (type: string) => (type === 'text/plain' ? 'ls\u001b[201~\r' : '') } });
    textarea.dispatchEvent(event);
    expect(paste).toHaveBeenCalledWith('ls[201~\r');
    expect(xterm).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    stop();
    textarea.dispatchEvent(new Event('paste', { bubbles: true }));
    expect(xterm).toHaveBeenCalledTimes(1);
    expect(paste).toHaveBeenCalledTimes(1);
    screen.remove();
  });
});
