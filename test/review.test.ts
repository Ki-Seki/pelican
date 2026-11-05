import { describe, expect, it } from 'vitest';

import { commentsMessage, type LineComment, lineKey, parseDiff } from '../src/web/lib/review';

const diff = [
  'diff --git a/db/schema.sql b/db/schema.sql',
  'index 1111111..2222222 100644',
  '--- a/db/schema.sql',
  '+++ b/db/schema.sql',
  '@@ -3,4 +3,5 @@ create table users (',
  '   id integer primary key,',
  '--- the old note',
  '-  name text',
  '+  name text not null,',
  '+++ a new note',
  '   email text',
  '\\ No newline at end of file',
  '@@ -20,2 +21,2 @@',
  '-old',
  '+new',
  '',
].join('\n');

describe('a diff, line by line', () => {
  const lines = parseDiff(diff);

  it('numbers each line in the old file, the new one, or both, from its hunk', () => {
    expect(lines.filter((l) => l.kind !== 'hunk' && l.kind !== 'note')).toEqual([
      { kind: 'same', text: '  id integer primary key,', oldLine: 3, newLine: 3 },
      { kind: 'del', text: '-- the old note', oldLine: 4 },
      { kind: 'del', text: '  name text', oldLine: 5 },
      { kind: 'add', text: '  name text not null,', newLine: 4 },
      { kind: 'add', text: '++ a new note', newLine: 5 },
      { kind: 'same', text: '  email text', oldLine: 6, newLine: 6 },
      { kind: 'del', text: 'old', oldLine: 20 },
      { kind: 'add', text: 'new', newLine: 21 },
    ]);
  });

  it('leaves out the file headers but keeps a removed SQL comment that looks like one', () => {
    expect(lines.some((l) => l.text.startsWith('a/db') || l.text.startsWith('index '))).toBe(false);
    expect(lines.filter((l) => l.kind === 'hunk')).toHaveLength(2);
    expect(lines.find((l) => l.kind === 'note')?.text).toBe('\\ No newline at end of file');
  });

  it('counts a new file from its first line, and keeps the note of a diff cut short', () => {
    const added = parseDiff('diff --git a/x b/x\nnew file mode 100644\n--- /dev/null\n+++ b/./x\n@@ -0,0 +1,2 @@\n+a\n+b\n… (diff cut short)\n');
    expect(added).toEqual([
      { kind: 'hunk', text: '@@ -0,0 +1,2 @@' },
      { kind: 'add', text: 'a', newLine: 1 },
      { kind: 'add', text: 'b', newLine: 2 },
      { kind: 'note', text: '… (diff cut short)' },
    ]);
  });

  it('tells apart a removed line and an added one with the same number', () => {
    expect(lineKey({ kind: 'del', text: 'old', oldLine: 20 })).not.toBe(lineKey({ kind: 'add', text: 'new', newLine: 20 }));
    expect(lineKey({ kind: 'same', text: 'x', oldLine: 3, newLine: 4 })).toBe(lineKey({ kind: 'add', text: 'y', newLine: 4 }));
  });
});

describe('comments as a message', () => {
  const comment = (path: string, line: number, kind: LineComment['kind'], code: string, note: string): LineComment => ({ id: `${path}${line}`, path, line, kind, code, note });

  it('quotes each line under its place, in file order, then says what was said', () => {
    const text = commentsMessage([
      comment('src/b.ts', 7, 'same', '  return x;', 'Why not early?'),
      comment('src/a.ts', 40, 'add', '    <ThemeToggle value={theme} />', ' Put it above the font size.\n'),
      comment('src/a.ts', 12, 'del', 'const timeout = 30;', 'Keep this one.'),
    ]);
    expect(text).toBe([
      'src/a.ts:12 (removed)\n> - const timeout = 30;\nKeep this one.',
      'src/a.ts:40\n> + <ThemeToggle value={theme} />\nPut it above the font size.',
      'src/b.ts:7\n> return x;\nWhy not early?',
    ].join('\n\n'));
  });

  it('shortens a very long line', () => {
    const text = commentsMessage([comment('min.js', 1, 'add', 'x'.repeat(500), 'Minified?')]);
    expect(text.split('\n')[1]).toBe(`> + ${'x'.repeat(200)}…`);
  });
});
