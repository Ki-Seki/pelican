import { describe, expect, it } from 'vitest';

import { splitIntoLines } from '../src/web/lib/code-lines';
import { MAX_QUOTED, quoteLines, quoteText, withQuote } from '../src/web/lib/quote';

describe('quotes for the message', () => {
  it('name lines as path:7-8 and quote them line by line, as comments do', () => {
    expect(quoteLines('src/a.ts', 7, 8, ['  const a = 1;', ''])).toBe('src/a.ts:7-8\n>   const a = 1;\n>');
    expect(quoteLines('src/a.ts', 3, 3, ['x'])).toBe('src/a.ts:3\n> x');
    expect(quoteText('One\r\nTwo\n\n')).toBe('> One\n> Two');
    const long = quoteLines('a', 1, 300, Array.from({ length: 300 }, (_, i) => `l${i}`)).split('\n');
    expect(long).toHaveLength(MAX_QUOTED + 2);
    expect(long.at(-1)).toBe('> … (100 more lines)');
  });

  it('go on lines of their own after what is written, with room for a word about them', () => {
    expect(withQuote('', '> a')).toBe('> a\n\n');
    expect(withQuote('Look at this:  ', 'a:1\n> x')).toBe('Look at this:\n\na:1\n> x\n\n');
  });
});

describe('a highlighted file, line by line', () => {
  it('keeps each line’s highlighting, also for a span over several lines', () => {
    const lines = splitIntoLines([
      { type: 'element', tagName: 'span', properties: { className: ['hljs-comment'] }, children: [{ type: 'text', value: '/* one\ntwo */' }] },
      { type: 'text', value: '\nlet x;\n' },
    ]);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toEqual([{ type: 'element', tagName: 'span', properties: { className: ['hljs-comment'] }, children: [{ type: 'text', value: '/* one' }] }]);
    expect(lines[1]).toEqual([{ type: 'element', tagName: 'span', properties: { className: ['hljs-comment'] }, children: [{ type: 'text', value: 'two */' }] }]);
    expect(lines[2]).toEqual([{ type: 'text', value: 'let x;' }]);
  });
});
