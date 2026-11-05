import { describe, expect, it } from 'vitest';

import { rehypeCodeLines, splitIntoLines } from '../src/web/lib/code-lines';

const comment = (value: string) => ({ type: 'element', tagName: 'span', properties: { className: ['hljs-comment'] }, children: [{ type: 'text', value }] });

describe('a highlighted file, line by line', () => {
  it('keeps each line’s highlighting, also for a span over several lines', () => {
    const lines = splitIntoLines([comment('/* one\ntwo */'), { type: 'text', value: '\nlet x;\n' }]);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toEqual([comment('/* one')]);
    expect(lines[1]).toEqual([comment('two */')]);
    expect(lines[2]).toEqual([{ type: 'text', value: 'let x;' }]);
  });

  it('keeps blank lines, so each line is numbered as in the file', () => {
    expect(splitIntoLines([{ type: 'text', value: 'a\n\nb' }])).toEqual([[{ type: 'text', value: 'a' }], [], [{ type: 'text', value: 'b' }]]);
  });

  it('numbers the lines of a code block from 1', () => {
    const code = { type: 'element', tagName: 'code', children: [{ type: 'text', value: 'one\ntwo\n' }] };
    const tree = { type: 'root', children: [{ type: 'element', tagName: 'pre', children: [code] }] };
    rehypeCodeLines()(tree);
    expect(code.children).toEqual([
      { type: 'element', tagName: 'pelican-line', properties: { dataN: '1' }, children: [{ type: 'text', value: 'one' }] },
      { type: 'element', tagName: 'pelican-line', properties: { dataN: '2' }, children: [{ type: 'text', value: 'two' }] },
    ]);
  });
});
