import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const root = path.join(import.meta.dirname, '..');

/**
 * Characters that do not show as what they are: controls, invisible ones (joiners, variation
 * selectors, tags), direction-changing ones, private ones, spaces other than a plain one, and ones
 * drawn blank. In a file as they are, the code reads otherwise than it runs, and GitHub warns of
 * hidden Unicode; written as escapes (\u202e), they read as they compile.
 */
const HIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Default_Ignorable_Code_Point}\u2800\ufffc\u{1d159}]|(?! )\p{Zs}/u;

/** The repository's text files: those git keeps, or would keep once added, but pictures, fonts and archives. */
function textFiles(): string[] {
  const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
  return [...new Set(listed.split('\0'))]
    .filter((file) => file && !/\.(png|jpe?g|gif|ico|webp|woff2?|ttf|mp4|webm|tgz|gz)$/i.test(file))
    .map((file) => path.join(root, file))
    .filter((file) => statSync(file, { throwIfNoEntry: false })?.isFile());
}

describe('the code, its tests and its docs', () => {
  it('hold no hidden or direction-changing character as it is: each is written as an escape', () => {
    const files = textFiles();
    expect(files.length).toBeGreaterThan(100);
    const found = files.flatMap((file) => readFileSync(file, 'utf8').split('\n').flatMap((line, i) => {
      const match = HIDDEN.exec(line);
      return match ? [`${path.relative(root, file)}:${i + 1}: U+${match[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`] : [];
    }));
    expect(found).toEqual([]);
  });

  it('would find one, of every kind', () => {
    for (const char of ['\u202e', '\u2066', '\u200b', '\u200d', '\ufe0f', '\u{e0041}', '\u00ad', '\u00a0', '\u3000', '\u2028', '\ue000', '\u115f', '\u2800', '\u001b']) {
      expect(HIDDEN.test(`a${char}b`), JSON.stringify(char)).toBe(true);
    }
    expect(HIDDEN.test('plain text, tabs\tand é, 测, 🌟 or ⟨U+202E⟩')).toBe(false);
  });
});
