import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { EMOJI, HIDDEN } from '../src/shared/hidden';

const root = path.join(import.meta.dirname, '..');

// Characters that do not show as what they are (HIDDEN): in a file as they are, the code reads
// otherwise than it runs, and GitHub warns of hidden Unicode; written as escapes (\u202e), they
// read as they compile. The approval card shows the same ones.

/**
 * Prose, the docs and the README, where an emoji is written as it shows, with the invisible
 * characters it is made of (its style, the joiners between its pictures, a flag's tags), as GitHub
 * shows it. Only there, and only inside an emoji: anywhere else they are hidden characters still.
 */
const PROSE = /\.(?:md|html)$/i;
const EMOJIS = new RegExp(EMOJI.source, 'gu');

/** The first character of a line that does not show as what it is. */
const hiddenIn = (line: string, prose: boolean) => HIDDEN.exec(prose ? line.replace(EMOJIS, '') : line)?.[0];

/** What is not text: pictures, fonts, sound and video, documents, archives and programs. */
const BINARY = /\.(?:png|jpe?g|gif|ico|icns|webp|avif|bmp|tiff?|heic|psd|woff2?|ttf|otf|eot|mp3|m4a|aac|wav|ogg|oga|opus|flac|mp4|m4v|mov|webm|mkv|avi|pdf|docx?|xlsx?|pptx?|odt|ods|odp|numbers|pages|zip|tgz|gz|bz2|xz|zst|7z|rar|tar|jar|br|wasm|exe|dll|so|dylib|node|o|a|class|pyc|sqlite3?|db|bin)$/i;

/** The repository's text files: those git keeps, or would keep once added, but what is not text. */
function textFiles(): string[] {
  const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
  return [...new Set(listed.split('\0'))]
    .filter((file) => file && !BINARY.test(file))
    .map((file) => path.join(root, file))
    .filter((file) => statSync(file, { throwIfNoEntry: false })?.isFile());
}

const code = (char: string) => `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;

describe('the code, its tests and its docs', () => {
  it('hold no hidden or direction-changing character as it is: code writes each as an escape, and the docs hold only an emoji’s own', () => {
    const files = textFiles();
    expect(files.length).toBeGreaterThan(100);
    const found = files.flatMap((file) => readFileSync(file, 'utf8').split('\n').flatMap((line, i) => {
      const hidden = hiddenIn(line, PROSE.test(file));
      return hidden ? [`${path.relative(root, file)}:${i + 1}: ${code(hidden)}`] : [];
    }));
    expect(found).toEqual([]);
  });

  it('would find one, of every kind, in code and in the docs', () => {
    for (const char of ['\u202e', '\u2066', '\u200b', '\u200d', '\ufe0f', '\u{e0041}', '\u00ad', '\u00a0', '\u3000', '\u2028', '\ue000', '\u115f', '\u2800', '\u001b']) {
      expect(hiddenIn(`a${char}b`, false), JSON.stringify(char)).toBe(char);
      expect(hiddenIn(`a${char}b`, true), JSON.stringify(char)).toBe(char);
    }
    expect(hiddenIn('plain text, tabs\tand \u00e9, \u6d4b, \u{1f31f} or \u27e8U+202E\u27e9', false)).toBeUndefined();
  });

  it('let the docs and the README hold an emoji as it shows, with what it is made of, and nothing more', () => {
    // An emoji's style, keycap, skin tone, the joiners between its pictures, a flag of tags.
    const emoji = ['\u26a0\ufe0f', '\u2764\ufe0e', '1\ufe0f\u20e3', '\u{1f469}\u200d\u{1f4bb}', '\u{1f3f3}\ufe0f\u200d\u{1f308}', '\u{1f44d}\u{1f3fd}', '\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}', '\u{1f1ef}\u{1f1f5}'];
    for (const one of emoji) expect(hiddenIn(`Careful ${one} here`, true), JSON.stringify(one)).toBeUndefined();
    // Code still writes them as escapes.
    expect(hiddenIn('\u26a0\ufe0f', false)).toBe('\ufe0f');
    expect(hiddenIn('\u{1f469}\u200d\u{1f4bb}', false)).toBe('\u200d');
    // Outside an emoji, or where an emoji has no place for them, they are hidden characters.
    const stray: Array<[string, string]> = [
      ['a\ufe0fb', '\ufe0f'], ['a\u200db', '\u200d'], ['\u{1f469}\u200d', '\u200d'], ['\u26a0\ufe0f\ufe0f', '\ufe0f'],
      ['\u{1f469}\u202e\u{1f4bb}', '\u202e'], ['\u26a0\u2066\ufe0f', '\u2066'], ['\u{e0041}\u{e0042}', '\u{e0041}'],
      // Tags that spell more than a region's code are hidden text, not a flag.
      ['\u{1f3f4}\u{e0069}\u{e0067}\u{e006e}\u{e006f}\u{e0072}\u{e0065}\u{e0061}\u{e006c}\u{e006c}\u{e007f}', '\u{e0069}'],
    ];
    for (const [line, char] of stray) expect(hiddenIn(line, true), JSON.stringify(line)).toBe(char);
  });

  it('let the docs hold the flags of England, Scotland and Wales, and no other tags after a black flag', () => {
    const flag = (letters: string) => `\u{1f3f4}${[...letters].map((letter) => String.fromCodePoint(0xe0000 + letter.codePointAt(0)!)).join('')}\u{e007f}`;
    for (const region of ['gbeng', 'gbsct', 'gbwls']) expect(hiddenIn(`Made in ${flag(region)} here`, true), region).toBeUndefined();
    // A region's code Unicode recommends no flag for, or tags that spell a word or a number, are
    // hidden text: a system shows them as nothing, or as the letters they are.
    for (const tags of ['ustx', 'gbnir', 'gbeng1', 'gbengx', 'gb', 'ab', 'x', 'pwned', 'gbsc', 'gbwlss']) {
      expect(hiddenIn(`Made in ${flag(tags)} here`, true), tags).toBe(String.fromCodePoint(0xe0000 + tags.codePointAt(0)!));
    }
    expect(hiddenIn(`${flag('gbeng')}${flag('ustx')}`, true)).toBe('\u{e0075}');
  });

  it('read every file as text but those that are not, whatever kind they are', () => {
    for (const file of ['a.png', 'b.JPG', 'c.pdf', 'd.mov', 'e.mp3', 'f.woff2', 'g.otf', 'h.zip', 'i.tar', 'j.7z', 'k.wasm', 'l.sqlite', 'm.docx', 'n.heic']) {
      expect(BINARY.test(file), file).toBe(true);
    }
    for (const file of ['a.ts', 'b.tsx', 'c.md', 'd.html', 'e.svg', 'f.json', 'g.webmanifest', 'h.yml', 'i.css', 'LICENSE', '.npmrc', 'j.mjs', 'k.sh']) {
      expect(BINARY.test(file), file).toBe(false);
    }
  });
});
