import { describe, expect, it } from 'vitest';

import { promptGist, readPrompt } from '../src/shared/quoted';
import {
  attachBlock, attachHeader, fileItem, fileMention, itemName, itemTitle, MAX_QUOTE_LINES, messageWith, olderQuote, preparePassage, quoteItem,
  quoteLines, readMessage, replyBlocks, sendNowMessage, type WaitingItem,
} from '../src/web/lib/quote';
import { capQuote, defuseMentions, fenceFor, maskSecrets, quotedLines } from '../src/web/lib/sanitize';

/*
 * Claude Desktop's own patterns for reading a message back (its bundle, chunk c4d199b75, functions
 * R, Re, U and H, with their regular expressions as they are there), to check that what Pelican
 * writes is what Desktop reads.
 */
const desktop = (() => {
  const P = '<!-- reply -->';
  const F = /^<!-- reply -->\n((?:>(?: |$).*\n?)+)\n*/;
  const Oe = /^<!-- reply ([1-9][0-9]?) -->\n(?=> |>$)/;
  const I = /(?:>(?: |$).*\n?)+/y;
  const L = `\n\n${P}\n>`;
  const H = (e: string) => e.split('\n').map((l) => l.replace(/^> ?/, '')).join('\n').trim();
  const Le = /^<!-- attach(?:: (.*?))?(?: \| tab:(\S+))? -->\n((?:>(?: |$).*\n?)+)\n*/gm;
  const ae = /(?:^|\n)In `([^`\n]+)` at lines? (\d+)(?:-(\d+))?( \(before changes\))?(?: \u2014 review comment from [@\uFF20]\S+)?:$/;
  type Block = { quote: string; bodyStart: number; bodyEnd: number };
  function R(e: string): { blocks: Block[]; restStart: number } | null {
    if (!e.startsWith('<!-- reply')) return null;
    const t = Oe.exec(e);
    if (t === null) return null;
    const n = Number(t[1]);
    const r: Block[] = [];
    let a = t[0].length;
    let o = -2;
    for (;;) {
      I.lastIndex = a;
      const q = I.exec(e);
      if (q === null) return null;
      const s = a + q[0].length;
      const c = e.charCodeAt(s - 1) === 10 ? s - 1 : s;
      let l = s;
      while (e.charCodeAt(l) === 10) l++;
      if (l - c >= 3) {
        r.push({ quote: H(q[0]), bodyStart: c, bodyEnd: c });
        return { blocks: r, restStart: c + 3 };
      }
      if (o !== -1 && o < l) o = e.indexOf('\n\n\n', l);
      const u = o === -1 ? e.length : o;
      let d = -1;
      if (r.length + 1 < n) {
        for (let t4 = e.indexOf(L, l); t4 !== -1 && t4 < u; t4 = e.indexOf(L, t4 + 1)) {
          I.lastIndex = t4 + L.length - 1;
          if (I.test(e)) {
            d = t4;
            break;
          }
        }
      }
      r.push({ quote: H(q[0]), bodyStart: l, bodyEnd: d === -1 ? u : d });
      if (d === -1) return { blocks: r, restStart: o === -1 ? e.length : o + 3 };
      a = d + 2 + 14 + 1;
    }
  }
  /** Desktop's reading of a message: its reply quotes with their notes, its attached snippets, the rest. */
  function read(e: string) {
    const parsed = R(e);
    const replies = parsed ? parsed.blocks.map((b) => ({ quote: b.quote, note: e.slice(b.bodyStart, b.bodyEnd).trim() })) : [];
    let rest = parsed ? e.slice(parsed.restStart) : e;
    const now = !parsed && e.startsWith(P) ? F.exec(e) : null;
    if (now) {
      replies.push({ quote: H(now[1]!), note: '' });
      rest = e.slice(now[0].length);
    }
    const snippets: Array<{ text: string; label?: string; tab?: string }> = [];
    rest = rest.replace(Le, (_m, label: string | undefined, tab: string | undefined, lines: string) => {
      const text = lines.split('\n').map((l) => l.replace(/^> ?/, '')).join('\n').trim();
      if (text) snippets.push({ text, ...(label?.trim() ? { label: label.trim() } : {}), ...(tab ? { tab } : {}) });
      return '';
    }).trim();
    return { replies, snippets, rest };
  }
  return { read, isReply: (e: string) => (e.startsWith(`${P}\n>`) ? true : R(e) !== null), commentHeader: ae };
})();

const from = { what: 'reply' as const, key: 'a1', at: Date.UTC(2026, 10, 6, 10, 42) };
const quote = (text: string, note?: string, extra: Partial<WaitingItem> = {}): WaitingItem => ({ ...quoteItem(text, from, note ? { note } : {})!, ...extra });
const comment = (path: string, line: number, code: string, note: string, side: WaitingItem['side'] = 'same'): WaitingItem => ({
  id: `${path}:${line}`, kind: 'comment', text: code, note, path, lines: [line, line], side, from: { what: 'diff' },
});

/** A synthetic key of a kind Desktop masks, put together here so no file holds one. */
const fake = (...parts: string[]) => parts.join('');

describe('a quote, prepared as Claude Desktop prepares one', () => {
  it('masks secrets: a token past its first 8 characters, a short one whole, a private key between its BEGIN and END lines', () => {
    const anthropic = fake('sk-', 'ant-', 'api03-', 'A'.repeat(30));
    expect(maskSecrets(`key=${anthropic} rest`)).toBe(`key=${anthropic.slice(0, 8)}${'\u2022'.repeat(anthropic.length - 8)} rest`);
    const aws = fake('AK', 'IA', 'ABCDEFGHIJKLMNOP');
    expect(maskSecrets(`id ${aws}.`)).toBe(`id ${aws.slice(0, 8)}${'\u2022'.repeat(12)}.`);
    const github = fake('gh', 'p_', 'x'.repeat(36));
    expect(maskSecrets(github)).toBe(github.slice(0, 8) + '\u2022'.repeat(github.length - 8));
    // Not inside a longer word: "task-ant-…" is no key.
    expect(maskSecrets(fake('mask-ant-', 'B'.repeat(24)))).toBe(fake('mask-ant-', 'B'.repeat(24)));
    const key = ['-----BEGIN OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB', '-----END OPENSSH PRIVATE KEY-----'].join('\n');
    expect(maskSecrets(`before\n${key}\nafter`)).toBe(`before\n-----BEGIN OPENSSH PRIVATE KEY-----\n${'\u2022'.repeat(52)}\n-----END OPENSSH PRIVATE KEY-----\nafter`);
    expect(maskSecrets('nothing secret here')).toBe('nothing secret here');
  });

  it('is cut to 1,500 characters with …, never between the halves of a character outside the BMP', () => {
    expect(capQuote('a'.repeat(1500))).toBe('a'.repeat(1500));
    expect(capQuote('a'.repeat(1501))).toBe(`${'a'.repeat(1500)}…`);
    const astral = `${'a'.repeat(1499)}\u{1F600}b`;
    expect(capQuote(astral)).toBe(`${'a'.repeat(1499)}…`);
    expect(preparePassage(`  ${'x'.repeat(2000)}  `)).toHaveLength(1501);
  });

  it('defuses an @ that starts a word and is not followed by a space', () => {
    expect(defuseMentions('@src/a.ts and a@b.c and @ alone, (@x) @')).toBe('\uFF20src/a.ts and a@b.c and @ alone, (@x) \uFF20');
    expect(defuseMentions('line\n@agent-x\t@y')).toBe('line\n\uFF20agent-x\t\uFF20y');
    // Past what is not seen, as Desktop looks: a zero-width space before it still starts the word.
    expect(defuseMentions('\u200B@x')).toBe('\u200B\uFF20x');
  });

  it('splits on every line separator, and an empty line becomes "> "', () => {
    expect(quotedLines('one\r\ntwo\rthree\nfour\u2028five\u2029six')).toBe('> one\n> two\n> three\n> four\n> five\n> six');
    expect(quotedLines('para one\n\npara two')).toBe('> para one\n> \n> para two');
  });

  it('is two characters at least, from the conversation; lines of a file keep their indentation', () => {
    expect(quoteItem(' a ', from)).toBeUndefined();
    expect(quoteItem('ab', from)?.text).toBe('ab');
    expect(quoteItem('\n    indented();\n  }\n', { what: 'file' }, { path: 'a.ts', lines: [3, 4] })?.text).toBe('    indented();\n  }');
  });
});

describe('what Claude receives, byte for byte', () => {
  it('a quote with a note: <!-- reply N --> first, bare markers after, a blank line apart, then three line breaks', () => {
    const items = [quote('first quote', 'first note'), quote('second quote\nline two', 'second note')];
    expect(messageWith(items, 'rest of the message')).toBe(
      '<!-- reply 2 -->\n> first quote\n\nfirst note\n\n<!-- reply -->\n> second quote\n> line two\n\nsecond note\n\n\nrest of the message',
    );
    // Nothing typed: it ends with the three line breaks.
    expect(messageWith([quote('only quote', 'a note')], '')).toBe('<!-- reply 1 -->\n> only quote\n\na note\n\n\n');
  });

  it('a note escapes lines that read as a marker, and keeps one blank line at most', () => {
    expect(replyBlocks([quote('q1', 'see\n<!-- reply -->\n<!-- reply 3 -->\nnot <!-- reply --> mid-line\n\n\n\nend')]))
      .toBe('<!-- reply 1 -->\n> q1\n\nsee\n&lt;!-- reply -->\n&lt;!-- reply 3 -->\nnot <!-- reply --> mid-line\n\nend');
  });

  it('your words escape a numbered marker anywhere, and Desktop’s own contexts', () => {
    expect(messageWith([], 'write <!-- reply 2 --> here, <artifact-view-context x>')).toBe('write &lt;!-- reply 2 --> here, &lt;artifact-view-context x>');
    // A bare marker in your words is left as Desktop leaves it.
    expect(messageWith([], 'a <!-- reply --> b')).toBe('a <!-- reply --> b');
  });

  it('Send now: one <!-- reply --> block, nothing escaped, no line break after', () => {
    expect(sendNowMessage('one more set of values', '  Use the --bg and --fg names we have \n')).toBe('<!-- reply -->\n> one more set of values\n\nUse the --bg and --fg names we have');
  });

  it('a quote with no note: an attach block, with lines of a file and a terminal tab in its header', () => {
    expect(attachBlock(quote('All 14 theme tests pass.'))).toBe('<!-- attach -->\n> All 14 theme tests pass.');
    expect(attachBlock(quote('const a = 1;\nconst b = 2;', undefined, { path: 'src/app.ts', lines: [7, 8] }))).toBe('<!-- attach: src/app.ts:7-8 -->\n> const a = 1;\n> const b = 2;');
    expect(attachHeader('src/app.ts:12')).toBe('<!-- attach: src/app.ts:12 -->');
    expect(attachHeader('Terminal', '2')).toBe('<!-- attach: Terminal | tab:2 -->');
    // A label never breaks its header: no line breaks, no --> or |, an @ defused.
    expect(attachHeader('a-->b|c\n@d')).toBe('<!-- attach: abc \uFF20d -->');
  });

  it('a file: @"path" on the first line, a folder with its slash, quotes taken out', () => {
    expect(fileMention('src/settings/prefs.ts')).toBe('@"src/settings/prefs.ts"');
    expect(fileMention('src/settings/', true)).toBe('@"src/settings/"');
    expect(fileMention('odd"name.ts')).toBe('@"oddname.ts"');
    expect(messageWith([fileItem('src/prefs.ts'), fileItem('docs', true)], 'Read these')).toBe('@"src/prefs.ts" @"docs/"\nRead these');
  });

  it('a line comment: In `path` at line N:, the code fenced, the note; lines of a file with a note go the same way', () => {
    expect(messageWith([comment('src/styles/theme.css', 12, '  --surface: #fff;', 'Keep --surface, the editor uses it')], 'Looks good')).toBe(
      'In `src/styles/theme.css` at line 12:\n```css\n  --surface: #fff;\n```\nKeep --surface, the editor uses it\n\n\nLooks good',
    );
    const lines = quote('const a = 1;\nconst b = 2;', 'Name these better', { path: 'src/app.ts', lines: [7, 8] });
    expect(messageWith([lines], '')).toBe('In `src/app.ts` at lines 7-8:\n```ts\nconst a = 1;\nconst b = 2;\n```\nName these better');
  });

  it('the whole message in Desktop’s order: files, replies, comments, attached quotes, your words', () => {
    const items = [
      quote('All 14 theme tests pass.'),
      comment('src/styles/theme.css', 12, '--surface: #fff;', 'Keep --surface'),
      fileItem('src/settings/prefs.ts'),
      quote('It follows the system until you pick one.', 'Also follow it while the page is open'),
    ];
    expect(messageWith(items, 'Then run the tests.')).toBe([
      '@"src/settings/prefs.ts"',
      '<!-- reply 1 -->',
      '> It follows the system until you pick one.',
      '',
      'Also follow it while the page is open',
      '',
      '',
      'In `src/styles/theme.css` at line 12:',
      '```css',
      '--surface: #fff;',
      '```',
      'Keep --surface',
      '',
      '',
      '<!-- attach -->',
      '> All 14 theme tests pass.',
      '',
      'Then run the tests.',
    ].join('\n'));
  });

  it('only words, as they were typed, trimmed', () => {
    expect(messageWith([], '  Fix the login test \n')).toBe('Fix the login test');
  });

  it('past 99 replies, the rest go among your words, as they read', () => {
    const many = Array.from({ length: 100 }, (_, i) => quote(`quote ${i + 1}`, `note ${i + 1}`));
    const text = messageWith(many, 'go');
    expect(text.startsWith('<!-- reply 99 -->\n> quote 1\n\nnote 1\n\n<!-- reply -->\n> quote 2')).toBe(true);
    expect(text.endsWith('> quote 99\n\nnote 99\n\n\n> quote 100\n\nnote 100\n\ngo')).toBe(true);
  });
});

describe('both ways: Desktop reads what Pelican writes, and Pelican reads what Desktop writes', () => {
  const items = [
    quote('first quote\n\nsecond paragraph', 'first note'),
    quote('second quote', 'second\nnote'),
    quote('an excerpt'),
    quote('const a = 1;', undefined, { path: 'src/app.ts', lines: [3, 3] }),
  ];
  const message = messageWith(items, 'And the rest.');

  it('Desktop’s own patterns find the replies, their notes, the snippets and the words', () => {
    expect(desktop.isReply(message)).toBe(true);
    expect(desktop.read(message)).toEqual({
      replies: [{ quote: 'first quote\n\nsecond paragraph', note: 'first note' }, { quote: 'second quote', note: 'second\nnote' }],
      snippets: [{ text: 'an excerpt' }, { text: 'const a = 1;', label: 'src/app.ts:3' }],
      rest: 'And the rest.',
    });
    expect(desktop.isReply(sendNowMessage('a passage', 'a note'))).toBe(true);
    expect(desktop.read(sendNowMessage('a passage', 'a note'))).toEqual({ replies: [{ quote: 'a passage', note: '' }], snippets: [], rest: 'a note' });
    const commented = messageWith([comment('src/a.ts', 4, 'x', 'y', 'del')], '');
    expect(desktop.commentHeader.test(commented.split('\n')[0]!)).toBe(true);
    expect(desktop.commentHeader.exec(commented.split('\n')[0]!)?.slice(1)).toEqual(['src/a.ts', '4', undefined, ' (before changes)']);
  });

  it('Pelican reads them back as quiet quotes, notes and comments', () => {
    expect(readPrompt(message)).toEqual([
      { kind: 'quote', text: 'first quote\n\nsecond paragraph', note: 'first note' },
      { kind: 'quote', text: 'second quote', note: 'second\nnote' },
      { kind: 'quote', text: 'an excerpt' },
      { kind: 'quote', text: 'const a = 1;', label: 'src/app.ts:3' },
      { kind: 'text', text: 'And the rest.' },
    ]);
    expect(readPrompt(sendNowMessage('a passage', 'a note'))).toEqual([{ kind: 'quote', text: 'a passage', note: 'a note' }]);
  });

  it('reads a message Desktop wrote, by hand here as Desktop writes one', () => {
    const fromDesktop = '@"src/settings/prefs.ts"\n<!-- reply 1 -->\n> Done. The toggle sits under Display.\n\nAlso follow the system\n\n\nIn `src/styles/theme.css` at lines 3-4 (before changes):\n````css\n--bg: #fff;\n```not a fence```\n````\nKeep these\n\nIn `src/b.ts` at line 9:\n```ts\nx()\n```\nAnd here\n\n\n<!-- attach: Terminal | tab:2 -->\n> npm test\n> \n> 14 passed\n\nWhat now?';
    expect(readPrompt(fromDesktop)).toEqual([
      { kind: 'file', path: 'src/settings/prefs.ts', folder: false },
      { kind: 'quote', text: 'Done. The toggle sits under Display.', note: 'Also follow the system' },
      { kind: 'comment', path: 'src/styles/theme.css', lines: [3, 4], removed: true, code: '--bg: #fff;\n```not a fence```', lang: 'css', note: 'Keep these' },
      { kind: 'comment', path: 'src/b.ts', lines: [9, 9], removed: false, code: 'x()', lang: 'ts', note: 'And here' },
      { kind: 'quote', text: 'npm test\n\n14 passed', label: 'Terminal', tab: '2' },
      { kind: 'text', text: 'What now?' },
    ]);
  });

  it('still reads Pelican’s older quotes: > lines, and path:line above lines of a file or a comment', () => {
    expect(readPrompt('src/a.ts:7-8\n> one\n>\n> two\n\n> Why?\n\nExplain both.')).toEqual([
      { kind: 'quote', label: 'src/a.ts:7-8', text: 'one\n\ntwo' },
      { kind: 'quote', text: 'Why?' },
      { kind: 'text', text: 'Explain both.' },
    ]);
    expect(readPrompt('src/a.ts:4\n> + const x = 1;\nName it count')).toEqual([
      { kind: 'quote', label: 'src/a.ts:4', text: '+ const x = 1;' },
      { kind: 'text', text: 'Name it count' },
    ]);
  });

  it('never takes lines in a code block, or a marker in the middle of words, for a quote', () => {
    const text = 'Run this:\n```\n> npm test\n<!-- attach -->\n> x\n```\nthen a > b';
    expect(readPrompt(text)).toEqual([{ kind: 'text', text }]);
    expect(readPrompt('plain words')).toEqual([{ kind: 'text', text: 'plain words' }]);
  });

  it('shows escaped markers in your words as you wrote them', () => {
    expect(readPrompt(messageWith([quote('qq', 'n')], 'about <!-- reply 2 -->'))).toEqual([
      { kind: 'quote', text: 'qq', note: 'n' },
      { kind: 'text', text: 'about <!-- reply 2 -->' },
    ]);
  });

  it('come back as the same items and words, as a queued message taken back to edit', () => {
    const back = readMessage(messageWith([...items, fileItem('src/prefs.ts'), comment('src/a.ts', 4, 'x()', 'Why?')], 'And the rest.'));
    expect(back.text).toBe('And the rest.');
    expect(back.items.map(({ kind, text, note, path, lines }) => ({ kind, text, note, path, lines }))).toEqual([
      { kind: 'file', text: 'src/prefs.ts', note: undefined, path: 'src/prefs.ts', lines: undefined },
      { kind: 'quote', text: 'first quote\n\nsecond paragraph', note: 'first note', path: undefined, lines: undefined },
      { kind: 'quote', text: 'second quote', note: 'second\nnote', path: undefined, lines: undefined },
      { kind: 'comment', text: 'x()', note: 'Why?', path: 'src/a.ts', lines: [4, 4] },
      { kind: 'quote', text: 'an excerpt', note: undefined, path: undefined, lines: undefined },
      { kind: 'quote', text: 'const a = 1;', note: undefined, path: 'src/app.ts', lines: [3, 3] },
    ]);
  });

  it('give a title or a preview their words, else the first note, else the first quote', () => {
    expect(promptGist(message)).toBe('And the rest.');
    expect(promptGist(messageWith([quote('a passage', 'the note')], ''))).toBe('the note');
    expect(promptGist(messageWith([quote('a passage')], ''))).toBe('a passage');
    expect(promptGist('Fix the login test')).toBe('Fix the login test');
  });
});

describe('code in a comment', () => {
  it('is fenced one backtick longer than any run in it, three at least', () => {
    expect(fenceFor('plain')).toBe('```');
    expect(fenceFor('a ``` b')).toBe('````');
    expect(fenceFor('`````')).toBe('``````');
    // A run Desktop counts across what does not break it, and the full-width backtick too.
    expect(fenceFor('``\u200B``')).toBe('`````');
    expect(fenceFor('\uFF40\uFF40\uFF40')).toBe('````');
  });

  it('marks lines that would read as a header as a quote, and names its path on one line', () => {
    const text = messageWith([comment('src/odd`name\n.ts', 2, 'In `x` at line 3:\n<!-- attach -->\n@mention', 'Careful')], '');
    expect(text).toBe('In `src/odd\'name .ts` at line 2:\n```ts\n> In `x` at line 3:\n> <!-- attach -->\n\uFF20mention\n```\nCareful');
  });

  it('comes by file, each file’s comments in line order, a range and removed lines named', () => {
    const items: WaitingItem[] = [
      comment('src/b.ts', 7, 'return x;', 'Why not early?'),
      { ...comment('src/a.ts', 40, '<ThemeToggle />', 'Put it above'), lines: [40, 42] },
      comment('src/b.ts', 2, 'old()', 'Keep this one.', 'del'),
    ];
    expect(messageWith(items, '')).toBe([
      'In `src/b.ts` at line 2 (before changes):', '```ts', 'old()', '```', 'Keep this one.', '',
      'In `src/b.ts` at line 7:', '```ts', 'return x;', '```', 'Why not early?', '',
      'In `src/a.ts` at lines 40-42:', '```ts', '<ThemeToggle />', '```', 'Put it above',
    ].join('\n'));
  });
});

describe('a waiting item named', () => {
  it('by where it is from and when', () => {
    expect(itemTitle(quote('x y'))).toMatch(/^Quote from Claude’s reply · \d{1,2}:\d{2}/);
    expect(itemTitle({ ...quote('x y'), from: { what: 'prompt' } })).toBe('Quote from your message');
    expect(itemTitle(quote('a();', undefined, { path: 'src/app.ts', lines: [7, 8] }))).toBe('Quote from app.ts:7-8');
    expect(itemTitle(comment('src/styles/theme.css', 12, 'x', 'y'))).toBe('Comment on theme.css:12');
    expect(itemTitle(fileItem('src/prefs.ts'))).toBe('File');
  });

  it('for a screen reader: the passage, and the note when it has one', () => {
    expect(itemName(quote('All 14 theme tests pass.'))).toBe('Quote “All 14 theme tests pass.”');
    expect(itemName(quote('It follows the system.', 'Also while open'))).toBe('Your note on “It follows the system.”: Also while open');
    expect(itemName(comment('src/a.ts', 3, 'x', 'Name it'))).toBe('Comment on a.ts:3: Name it');
  });
});

describe('the file viewer’s Quote, handed over Pelican’s older way', () => {
  it('names the lines it holds, and becomes a quote of those lines', () => {
    expect(quoteLines('src/app.ts', 7, 8, ['const a = 1;', 'const b = 2;'])).toBe('src/app.ts:7-8\n> const a = 1;\n> const b = 2;');
    expect(quoteLines('src/app.ts', 3, 3, ['  return x;'])).toBe('src/app.ts:3\n>   return x;');
    const item = olderQuote(quoteLines('src/a.ts', 7, 8, ['  const a = 1;', '']))!;
    expect(item).toMatchObject({ kind: 'quote', text: '  const a = 1;', path: 'src/a.ts', lines: [7, 8], from: { what: 'file' } });
    expect(olderQuote('> Why?')).toMatchObject({ kind: 'quote', text: 'Why?' });
  });

  it('keeps the first lines of a long range, and names only those', () => {
    const lines = Array.from({ length: MAX_QUOTE_LINES + 20 }, (_, i) => `line ${i + 1}`);
    const quoted = quoteLines('big.txt', 11, 10 + lines.length, lines);
    expect(quoted.split('\n')[0]).toBe(`big.txt:11-${10 + MAX_QUOTE_LINES}`);
    expect(quoted.split('\n')).toHaveLength(MAX_QUOTE_LINES + 1);
  });
});
