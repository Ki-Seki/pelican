import { describe, expect, it } from 'vitest';

import { commentsMessage } from '../src/web/lib/review';
import { addQuote, labelIsCode, MAX_QUOTE_LINES, messageWithQuotes, promptParts, quoteLabel, quoteLines, quoteText, receiveQuotes, splitQuotes, terminalQuote } from '../src/web/lib/quote';

describe('quoteText', () => {
  it('quotes text from the conversation as > lines, without the blank lines around it', () => {
    expect(quoteText({ text: '\n\nThe settings page already reads them.\n' })).toBe('> The settings page already reads them.');
    expect(quoteText({ text: 'First paragraph.\n\n\n\nSecond one,\r\nstill second.  ' })).toBe('> First paragraph.\n>\n> Second one,\n> still second.');
  });

  it('keeps the indentation of output and code', () => {
    expect(quoteText({ text: 'Traceback:\n  File "export.py", line 41\n    owner = db.fetch_owner(row.owner_id)' }))
      .toBe('> Traceback:\n>   File "export.py", line 41\n>     owner = db.fetch_owner(row.owner_id)');
  });

  it('quotes a file’s lines under path:start-end, as they are in the file', () => {
    // Whole lines selected end with a line break, which is no line of its own: the range is 7-8.
    const text = '      <FontSizePicker />\n      <ThemeToggle value={theme} />\n';
    expect(quoteText({ path: 'src/settings/Settings.tsx', start: 7, text }))
      .toBe('src/settings/Settings.tsx:7-8\n>       <FontSizePicker />\n>       <ThemeToggle value={theme} />');
    // The range follows from the lines, blank ones included.
    expect(quoteText({ path: 'a.ts', start: 3, text: 'one\n\nthree' })).toBe('a.ts:3-5\n> one\n>\n> three');
    expect(quoteText({ path: 'a.ts', start: 12, text: 'return x;' })).toBe('a.ts:12\n> return x;');
  });

  it('keeps the first lines of a long file quote, and its range says which', () => {
    const text = Array.from({ length: MAX_QUOTE_LINES + 50 }, (_, i) => `line ${i + 1}`).join('\n');
    const quote = quoteText({ path: 'big.txt', start: 1, text });
    expect(quote.split('\n')[0]).toBe(`big.txt:1-${MAX_QUOTE_LINES}`);
    expect(quote.split('\n')).toHaveLength(MAX_QUOTE_LINES + 1);
  });

  it('cuts a very long quote short, and says so', () => {
    const quote = quoteText({ text: 'word '.repeat(10_000) });
    expect(quote.length).toBeLessThan(21_000);
    expect(quote.endsWith('\n> …')).toBe(true);
  });

  it('makes nothing of a selection that is only space', () => {
    expect(quoteText({ text: ' \n\t\n' })).toBe('');
    expect(quoteText({ path: 'a.ts', start: 4, text: '\n' })).toBe('');
  });
});

describe('a message with quotes', () => {
  const prose = quoteText({ text: 'Why CSS variables?' });
  const lines = quoteText({ path: 'src/styles/theme.css', start: 2, text: '  --bg: #ffffff;\n  --fg: #111111;' });

  it('puts each quote above the words, a block apart', () => {
    expect(messageWithQuotes([prose, lines], 'And not a context?')).toBe(
      '> Why CSS variables?\n\nsrc/styles/theme.css:2-3\n>   --bg: #ffffff;\n>   --fg: #111111;\n\nAnd not a context?',
    );
    expect(messageWithQuotes([prose], '')).toBe('> Why CSS variables?');
    expect(messageWithQuotes([], ' Just words ')).toBe('Just words');
  });

  it('comes apart into the same quotes and words again', () => {
    for (const [quotes, text] of [[[prose, lines], 'And not a context?'], [[lines], ''], [[], 'No quotes\n> but this line']] as const) {
      expect(splitQuotes(messageWithQuotes(quotes, text))).toEqual({ quotes, text });
    }
  });

  it('leaves words that come right under a quote with it', () => {
    expect(splitQuotes('> a quote\nmy words')).toEqual({ quotes: [], text: '> a quote\nmy words' });
  });
});

describe('promptParts', () => {
  it('sets quotes apart from the words, with where a file quote is from', () => {
    expect(promptParts('src/a.ts:7-8\n> one\n>\n> two\n\n> Why?\n\nExplain both.')).toEqual([
      { kind: 'quote', from: 'src/a.ts:7-8', text: 'one\n\ntwo' },
      { kind: 'quote', text: 'Why?' },
      { kind: 'text', text: 'Explain both.' },
    ]);
  });

  it('reads line comments as quotes with the note after them', () => {
    const message = commentsMessage([
      { id: '1', path: 'src/a.ts', kind: 'add', line: 4, code: 'const x = 1;', note: 'Name it count' },
      { id: '2', path: 'src/b.ts', kind: 'del', line: 9, code: 'old()', note: 'Keep this' },
    ]);
    expect(promptParts(message)).toEqual([
      { kind: 'quote', from: 'src/a.ts:4', text: '+ const x = 1;' },
      { kind: 'text', text: 'Name it count' },
      { kind: 'quote', from: 'src/b.ts:9 (removed)', text: '- old()' },
      { kind: 'text', text: 'Keep this' },
    ]);
  });

  it('never takes lines in a code block, or a > in the middle of a line, for a quote', () => {
    const text = 'Run this:\n```\n> npm test\n```\nthen a > b';
    expect(promptParts(text)).toEqual([{ kind: 'text', text }]);
    expect(promptParts('plain words')).toEqual([{ kind: 'text', text: 'plain words' }]);
  });
});

describe('quoteLabel', () => {
  it('names a file quote by the file and its lines, and any other by how it begins', () => {
    expect(quoteLabel('src/settings/Settings.tsx:7-8\n> <FontSizePicker />')).toBe('Settings.tsx:7-8');
    expect(quoteLabel('a.ts:12\n> return x;')).toBe('a.ts:12');
    expect(quoteLabel('>\n>   The settings page already reads them.')).toBe('The settings page already reads them.');
  });
});

describe('quotes on their way to a message box', () => {
  it('wait for the box when none is open, then go to it as they come', () => {
    addQuote('chat-1', '> first');
    addQuote('chat-1', '   ');
    addQuote('chat-2', '> elsewhere');
    const taken: string[] = [];
    const stop = receiveQuotes('chat-1', (quote) => taken.push(quote));
    expect(taken).toEqual(['> first']);
    addQuote('chat-1', '> second');
    expect(taken).toEqual(['> first', '> second']);
    stop();
    addQuote('chat-1', '> later');
    expect(taken).toHaveLength(2);
    const again: string[] = [];
    receiveQuotes('chat-1', (quote) => again.push(quote))();
    expect(again).toEqual(['> later']);
  });
});

describe('the file viewer’s Quote', () => {
  it('names the lines it holds, as a selection of a file does', () => {
    expect(quoteLines('src/app.ts', 7, 8, ['const a = 1;', 'const b = 2;'])).toBe('src/app.ts:7-8\n> const a = 1;\n> const b = 2;');
    expect(quoteLines('src/app.ts', 3, 3, ['  return x;'])).toBe('src/app.ts:3\n>   return x;');
  });

  it('holds every line its range names, a blank last one too, and comes back whole when a send fails', () => {
    const quote = quoteLines('src/a.ts', 7, 8, ['  const a = 1;', '']);
    expect(quote).toBe('src/a.ts:7-8\n>   const a = 1;\n>');
    expect(quoteLabel(quote)).toBe('a.ts:7-8');
    expect(splitQuotes(messageWithQuotes([quote], 'Why?'))).toEqual({ quotes: [quote], text: 'Why?' });
  });

  it('keeps the first lines of a long range, and names only those', () => {
    const lines = Array.from({ length: MAX_QUOTE_LINES + 20 }, (_, i) => `line ${i + 1}`);
    const quote = quoteLines('big.txt', 11, 10 + lines.length, lines);
    expect(quote.split('\n')[0]).toBe(`big.txt:11-${10 + MAX_QUOTE_LINES}`);
    expect(quote.split('\n')).toHaveLength(MAX_QUOTE_LINES + 1);
  });
});

describe('the terminal’s Quote', () => {
  it('quotes output as a code block that says it is the terminal’s, without the blank lines around it', () => {
    expect(terminalQuote('\n\n% npm test   \r\n FAIL  src/theme.test.ts\n\n  expected dark\n\n')).toBe('```terminal\n% npm test\n FAIL  src/theme.test.ts\n\n  expected dark\n```');
    expect(terminalQuote(' \n\t\n')).toBe('');
  });

  it('fences it past any backticks the output holds, so none of it can close the block', () => {
    expect(terminalQuote('echo ```\n```')).toBe('````terminal\necho ```\n```\n````');
  });

  it('keeps the last lines of a long output, where a command ends and says what went wrong', () => {
    const lines = Array.from({ length: MAX_QUOTE_LINES + 50 }, (_, i) => `line ${i + 1}`);
    const quote = terminalQuote(lines.join('\n')).split('\n');
    expect(quote).toHaveLength(MAX_QUOTE_LINES + 2);
    expect(quote[1]).toBe('line 51');
    expect(quote.at(-2)).toBe(`line ${MAX_QUOTE_LINES + 50}`);
    // Past what a message can carry, from the start of a line.
    const long = terminalQuote(Array.from({ length: 150 }, (_, i) => `${i} ${'x'.repeat(200)}`).join('\n')).split('\n');
    expect(long.length).toBeLessThan(150);
    expect(long[1]).toMatch(/^\d+ x+$/);
  });

  it('goes above the words, shows as a quote from the terminal, is named by its one line or its lines, and comes back whole when a send fails', () => {
    const quote = terminalQuote('% npm test\nFAIL src/theme.test.ts');
    expect(splitQuotes(messageWithQuotes([quote, '> Why?'], 'Fix it'))).toEqual({ quotes: [quote, '> Why?'], text: 'Fix it' });
    expect(promptParts(messageWithQuotes([quote], 'Fix it'))).toEqual([
      { kind: 'quote', from: 'Terminal', text: '% npm test\nFAIL src/theme.test.ts' },
      { kind: 'text', text: 'Fix it' },
    ]);
    expect(quoteLabel(quote)).toBe('Terminal · 2 lines');
    expect(quoteLabel(terminalQuote('  zsh: command not found: nmp'))).toBe('zsh: command not found: nmp');
    // Named in the code font only by code: a line, a file's place; a count or a reply's words in plain type.
    expect(labelIsCode(quote)).toBe(false);
    expect(labelIsCode(terminalQuote('zsh: command not found: nmp'))).toBe(true);
    expect(labelIsCode('src/a.ts:7\n> one')).toBe(true);
    expect(labelIsCode('> Why?')).toBe(false);
    // A code block of one's own, of any other kind, stays the message's.
    const own = '```bash\nnpm test\n```\n\nWhy?';
    expect(splitQuotes(own)).toEqual({ quotes: [], text: own });
    expect(promptParts(own)).toEqual([{ kind: 'text', text: own }]);
  });
});
