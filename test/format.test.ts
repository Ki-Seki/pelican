import { describe, expect, it } from 'vitest';

import { duration, resumeCommand, shellQuote, shortPath } from '../src/web/lib/format';

describe('resumeCommand', () => {
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
