import { diffLines } from 'diff';
import { describe, expect, it } from 'vitest';

import { applyHunks, diffCounts, lineDiff, splitLines, toHunks, unifiedDiff } from '../src/shared/line-diff';
import { parseDiff } from '../src/web/lib/review';

/** What the `diff` package counts for the same texts: the server's diff must agree with it. */
function reference(a: string, b: string) {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(a, b)) {
    const count = part.count ?? 0;
    if (part.added) added += count;
    else if (part.removed) removed += count;
  }
  return { added, removed };
}

/** A small deterministic random text, lines drawn from a few words. */
function text(seed: number, lines: number): string {
  let s = seed;
  const next = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s;
  };
  return Array.from({ length: lines }, () => ['a', 'b', 'c', 'const x = 1;', '}', ''][next() % 6]).join('\n') + '\n';
}

describe('the server’s line diff', () => {
  it('finds as few changed lines as a diff library does, and the edit script turns one text into the other', () => {
    for (let seed = 1; seed < 60; seed += 1) {
      const a = text(seed, 5 + (seed % 40));
      const b = text(seed * 7 + 3, 3 + (seed % 37));
      const ops = lineDiff(splitLines(a), splitLines(b))!;
      expect(diffCounts(ops)).toEqual(reference(a, b));
      expect(ops.filter((op) => op.kind !== 'add').map((op) => op.text)).toEqual(splitLines(a));
      expect(ops.filter((op) => op.kind !== 'del').map((op) => op.text)).toEqual(splitLines(b));
    }
  });

  it('gives up past its limit instead of taking long', () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}`);
    expect(lineDiff(a, b, 100)).toBeUndefined();
    expect(lineDiff(a, a)?.every((op) => op.kind === 'same')).toBe(true);
  });

  it('writes hunks with their context, numbered as git numbers them, and they apply back', () => {
    const before = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n';
    const after = 'one\ntwo\n3\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\n';
    const hunks = toHunks(lineDiff(splitLines(before), splitLines(after))!);
    expect(hunks.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines])).toEqual([[1, 6, 1, 6], [8, 3, 8, 4]]);
    expect(applyHunks(before, hunks)).toBe(after);
    const lines = parseDiff(unifiedDiff('a.txt', hunks));
    expect(lines.find((l) => l.kind === 'add')).toMatchObject({ text: '3', newLine: 3 });
    expect(lines.findLast((l) => l.kind === 'add')).toMatchObject({ text: 'eleven', newLine: 11 });
    // A hunk that does not fit the text is not forced in.
    expect(applyHunks('something else\n', hunks)).toBeUndefined();
  });

  it('numbers a new file and an emptied one as git does', () => {
    expect(toHunks(lineDiff([], ['a', 'b'])!)).toEqual([{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+a', '+b'] }]);
    expect(toHunks(lineDiff(['a'], [])!)).toEqual([{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, lines: ['-a'] }]);
    expect(applyHunks('', toHunks(lineDiff([], ['a', 'b'])!))).toBe('a\nb\n');
  });
});
