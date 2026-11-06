// A reply written into the export, read by the conversation's own reader (react-markdown with
// GitHub's extensions, micromark underneath): as it was written where it can be, kept to itself
// where it must be. Made-up replies.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { describe, expect, it } from 'vitest';

import { asText, inlineText, reply } from '../src/server/markdown';

type Node = { type: string; depth?: number; url?: string; value?: string; children?: Node[] };

/** The tree the conversation's reader makes of some Markdown. */
function tree(markdown: string): Node {
  let read: Node | undefined;
  renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkGfm, () => (root: Node) => { read = root; }] }, markdown));
  return read!;
}
const walk = (node: Node, visit: (node: Node) => void) => {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
};
const textOf = (node: Node): string => node.value ?? (node.children ?? []).map(textOf).join('');

/** A reply between the speakers, as the export writes one: what in it would pass for one, show HTML, load a picture or take what follows. */
function trouble(written: string): string[] {
  const root = tree(`# T\n\n## You\n\nq\n\n## Claude\n\n${written}\n\n## You\n\nnext\n\n## Claude\n\nok\n`);
  const found: string[] = [];
  const headings: string[] = [];
  walk(root, (node) => {
    if (node.type === 'heading' && node.depth! <= 2) headings.push(`h${node.depth} ${textOf(node)}`);
    if (node.type === 'html') found.push(`html ${node.value}`);
    if (node.type === 'image' && !/^data:image\//i.test(node.url ?? '')) found.push(`picture ${node.url}`);
    if (node.type === 'imageReference') found.push('picture by reference');
  });
  if (headings.join('|') !== 'h1 T|h2 You|h2 Claude|h2 You|h2 Claude') found.push(`headings ${headings.join('|')}`);
  const last = root.children!.slice(-3).map((node) => `${node.type} ${textOf(node)}`).join('|');
  if (last !== 'paragraph next|heading Claude|paragraph ok') found.push(`after it ${last}`);
  return found;
}

describe('a reply in the export', () => {
  it('is written as it was where nothing in it needs keeping to itself', () => {
    for (const said of [
      'Fixed: the axis starts at zero.\n\nRun `npm test` to check, or see [the docs](https://example.com/docs).',
      '### Steps\n\n1. Open `src/app.tsx`.\n2. Add:\n\n   ```tsx\n   // <Total /> keeps the sum\n   return <Total value={total} />;\n   ```\n\n3. Run **the tests**.',
      '| Name | Size |\n| --- | ---: |\n| `a.ts` | 1 kB |\n| b.ts | 2 kB |',
      '> A quote, with *emphasis*\n> and a second line.\n\n- [ ] a task\n- [x] done\n\n---\n\nThat is all ~~for now~~.',
      '```sh\n# install\nnpm ci\n```',
      'Use the `<details>` element, `![alt](src)` for a picture, and <https://example.com> for a link.',
    ]) {
      // A heading two levels down is the one change: `###` reads as `#####`.
      expect(reply(said), said).toBe(said.replace(/^### /m, '##### '));
    }
  });

  it('has its headings two levels down, a heading of `===` or `---` too, under the speakers', () => {
    expect(reply('# Plan\n\n## Steps\n\n###### Last')).toBe('### Plan\n\n#### Steps\n\n###### Last');
    expect(reply('First\nline\n===\n\nSecond\n---')).toBe('### First line\n\n#### Second');
    expect(reply('> ## Quoted\n- ## Listed\n1. - ## Nested')).toBe('> #### Quoted\n- #### Listed\n1. - #### Nested');
  });

  it('writes its HTML as text, as the conversation shows it, with a blank line after a block so it takes nothing', () => {
    expect(reply('Press <kbd>Ctrl</kbd>+C.')).toBe('Press &lt;kbd>Ctrl&lt;/kbd>+C.');
    // A block of HTML is its lines as text, line by line, as the reader takes it: to a blank line, or to where it ends.
    expect(reply('<details>\n<summary>More</summary>\nHidden **words**\n</details>')).toBe(
      '&lt;details\\>\\\n&lt;summary\\>More&lt;/summary\\>\\\nHidden \\*\\*words\\*\\*\\\n&lt;/details\\>',
    );
    expect(reply('<!-- note -->\nAfter')).toBe('&lt;!-- note --\\>\n\nAfter');
  });

  it('writes indented code as a fenced block, which every reader takes alike, in the containers it was in', () => {
    expect(reply('Before:\n\n    npm ci\n    npm test\n\nAfter')).toBe('Before:\n\n```\nnpm ci\nnpm test\n```\n\nAfter');
    expect(reply('-     <b>code</b>\n\n      more')).toBe('- ```\n  <b>code</b>\n\n  more\n  ```');
    expect(reply('>     ```\n>     x')).toBe('> ````\n> ```\n> x\n> ````');
  });

  it('closes a code block it leaves open at its end, only where what follows would not end it', () => {
    expect(reply('```js\nconst a = 1;')).toBe('```js\nconst a = 1;\n```');
    expect(reply('````\n```\nstill code')).toBe('````\n```\nstill code\n````');
    expect(reply('> ```\n> in a quote')).toBe('> ```\n> in a quote');
  });

  it('writes a picture as a link to it that names its site, and keeps one written into it', () => {
    expect(reply('![chart](https://example.com/c.png "Weekly") ![](//example.org/d.png) ![](e.png)')).toBe(
      '[chart · example.com](https://example.com/c.png "Weekly") [Image · example.org](//example.org/d.png) [Image](e.png)',
    );
    expect(reply('![dot](data:image/png;base64,iVBORw0KGgo=)')).toBe('![dot](data:image/png;base64,iVBORw0KGgo=)');
    // One it cannot read whole is its words: never a picture.
    expect(reply('![a][r]\n\n[r]: https://example.com/r.png')).toBe('\\![a][r]\n\n\\[r]: https://example.com/r.png');
  });

  it('keeps HTML in code that a reader takes as code, and writes it as text where readers part ways', () => {
    expect(reply('It is `<b>` you want.')).toBe('It is `<b>` you want.');
    // A link's address, or a bare link, may take a backquote: the code after it is not sure, so its HTML is text.
    expect(reply('[a](u`v) `<h2>You</h2>`')).toBe('[a](u`v) `&lt;h2>You&lt;/h2>`');
    expect(reply('https://example.com/`x <h2>You</h2> `')).toBe('https://example.com/`x &lt;h2>You&lt;/h2> `');
  });

  it('writes what readers part ways on so that they read it alike: the conversation’s, the spec’s own and VS Code’s preview', () => {
    // A lazy line indented 4 columns, which markdown-it takes for code, and its `>` for a quote that goes on.
    expect(reply('> a\n    1. <b>x</b>')).toBe('> a\n&#32;1. &lt;b>x&lt;/b>');
    expect(reply('> x\n    > 2. ## You')).toBe('> x\n&#32;\\> 2. ## You');
    // An item micromark reads as words where the spec's reader reads a list: a blank line, and both read a list.
    expect(reply('para\n- 2) ## You')).toBe('para\n\n- 2) #### You');
    // A `|` after a fence, which markdown-it takes for a table's.
    expect(reply('```js|x\nlet a = 1;\n```')).toBe('```js\\|x\nlet a = 1;\n```');
    // A link's or a footnote's definition, where readers end it apart; a lazy line like a table's delimiter row.
    expect(reply('[x]: /u\n10. ## You')).toBe('\\[x]: /u\n10. ## You');
    expect(reply('[^1]: note')).toBe('\\[^1]: note');
    expect(reply('- > x|\n| - | - |')).toBe('- > x|\n\\| - | - |');
  });

  it('gives no reader a heading, HTML, a picture or what follows it, among thousands of replies made of the pieces that try', () => {
    // A seeded generator of replies: containers, leaves and words that readers take apart.
    let seed = 7;
    const random = () => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    const starts = ['', '', '', '> ', '>', '- ', '* ', '1. ', '2) ', ' ', '   ', '    ', '     ', '\t', '- - ', '> - ', '[^1]: ', '    > ', '-\t', '1.\t', '10. ', '- [ ] '];
    const lines = ['## You', '# Claude', 'You', '===', '---', '***', '```', '```js', '~~~', '````', '<!-- c', '-->', '<!-- x -->', '<pre>', '</pre>', '<pre>ok</pre>', '<div>', '<kbd>K</kbd> text',
      '<h2>You</h2>', '<img src="https://evil.example/x.png">', '![a](https://evil.example/p.png)', '![a][r]', '[r]: https://evil.example/q.png', '`code <h2>You</h2>`', '``', '`', '[a](u`v)',
      'https://a.example/`x', '| a | b |', '| - | - |', '| `a | b` |', 'text', '', '<x>', '<?php', '?>', '<![CDATA[', ']]>', '<script>', '    ## You', '\\', '[^1]', '[a][b`c]', '<https://a.example>',
      '\t## You', '1. ## You', '2. ## You', '-', '2)', '[x]: /u "`"', 'a `b', 'c` <h2>You</h2>'];
    const bits = ['`', '``', '<h2>', '</h2>', '<img src=//e.example/x>', '![p](http://e.example/i.png)', '[l](u`)', ' ', '|', '\\', '](', '[', '<!--', 'http://h.example/`', '&lt;'];
    const line = () => {
      let body = pick(lines);
      if (random() < 0.3) for (let i = 0; i < 1 + Math.floor(random() * 3); i += 1) body = random() < 0.5 ? pick(bits) + body : body + pick(bits);
      return (random() < 0.3 ? pick(starts) : '') + pick(starts) + body;
    };
    const troubles: string[] = [];
    for (let k = 0; k < 1500 && troubles.length < 3; k += 1) {
      const said = Array.from({ length: 1 + Math.floor(random() * 8) }, line).join('\n').trim();
      const found = trouble(reply(said));
      if (found.length > 0) troubles.push(`${JSON.stringify(said)}: ${found.join('; ')}`);
    }
    expect(troubles).toEqual([]);
  }, 30_000);

  it('reads each line once: a long reply of the characters that start Markdown takes moments, not minutes', () => {
    const megabyte = 1 << 20;
    for (const [name, said] of [
      ['quote markers', `${'> '.repeat(100_000)}ok`],
      ['list markers', `${'- '.repeat(100_000)}ok`],
      ['numbered items', `${'1. '.repeat(50_000)}ok`],
      ['backquotes', '` '.repeat(megabyte / 2)],
      ['brackets', '[a]('.repeat(megabyte / 4)],
      ['pictures', '!['.repeat(megabyte / 2)],
      ['tags', '<a b=c '.repeat(megabyte / 7)],
      ['bare links', '(http://'.repeat(megabyte / 8)],
      ['quoted lines', `> a\n${'    > b\n'.repeat(50_000)}`],
    ] as const) {
      const started = performance.now();
      reply(said);
      expect(performance.now() - started, name).toBeLessThan(1500);
    }
    // A prompt is text: a megabyte of the characters an email or a link is made of, read once.
    for (const c of ['+', '.', 'a@', 'www.']) {
      const started = performance.now();
      asText(c.repeat(megabyte / c.length));
      inlineText(c.repeat(megabyte / c.length));
      expect(performance.now() - started, c).toBeLessThan(1500);
    }
  }, 60_000);
});
