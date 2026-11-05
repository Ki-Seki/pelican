import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

Object.assign(globalThis, { location: new URL('http://localhost:7860/') });
const { splitStreaming, StreamingMarkdown } = await import('../src/web/components/StreamingMarkdown');

describe('a reply as it streams', () => {
  it('keeps finished blocks as they are and parses only the one being written', () => {
    expect(splitStreaming('First para.\n\nSecond is bei')).toEqual({ done: ['First para.\n\n'], tail: 'Second is bei' });
    // An indented line after a blank one may still belong to the list item above.
    expect(splitStreaming('- item\n\n  more of it\n\nNext')).toEqual({ done: ['- item\n\n  more of it\n\n'], tail: 'Next' });
    // A blank line inside a fence ends nothing.
    expect(splitStreaming('```js\na()\n\nb()\n```\n\nAfter')).toEqual({ done: ['```js\na()\n\nb()\n```\n\n'], tail: 'After' });
  });

  it('shows code whose fence is still open as plain text, highlighted once it closes', () => {
    expect(splitStreaming('Here:\n\n```ts\nconst a = 1;\nconst b')).toEqual({ done: ['Here:\n\n'], tail: '', code: 'const a = 1;\nconst b' });
    const open = renderToStaticMarkup(<StreamingMarkdown text={'Here:\n\n```ts\nconst a = 1;\n'} />);
    expect(open).toContain('<code>const a = 1;\n</code>');
    expect(open).not.toContain('hljs');
    const closed = renderToStaticMarkup(<StreamingMarkdown text={'Here:\n\n```ts\nconst a = 1;\n```\n'} />);
    expect(closed).toContain('hljs');
  });
});
