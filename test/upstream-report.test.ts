import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  anchor, changeMarkdown, changelogBetween, changelogSections, compareVersions, constituents, cutLines, declarations, diffSize, diffTexts,
  fit, isVersion, LIMIT, members, newerMarkdown, quiet, readTar, sdkVersions, stripComments, typeChanges,
} from '../scripts/upstream-report.mjs';

// Shaped like Claude Code's CHANGELOG.md, with what must not reach a comment as it is.
const CLAUDE_CODE_LOG = [
  '# Changelog',
  '',
  '## 2.1.320',
  '',
  '- Added `/foo` (#123), thanks to @someone and anthropics/claude-code#77',
  '- Fixed a crash, see https://github.com/anthropics/claude-code/issues/712, mail ada@example.com',
  '',
  '## 2.1.319',
  '',
  '- Fixed `@scope/pkg` showing as #1 in code',
  '',
  '```js',
  'const at = "@decorator #5";',
  '```',
  '',
  '## 2.1.318',
  '',
  '- Added the thing',
  '',
  '## 2.1.316',
  '',
  '- Older',
].join('\n');

const SDK_LOG = ['# Changelog', '', '## 0.3.320', '', '- Added `SDKNoteMessage`', '', '## 0.3.318', '', '- Earlier'].join('\n');

// Shaped like sdk.d.ts (4-space members, JSDoc) and sdk-tools.d.ts (2-space interfaces).
const BEFORE = `import type { UUID } from 'crypto';

/**
 * Options for a query.
 */
export declare type Options = {
    /**
     * Additional directories. A // in a comment, and a ' too.
     */
    additionalDirectories?: string[];
    /** The model. */
    model?: string;
    /** Removed later. */
    oldOption?: boolean;
    hooks?: {
        PreToolUse?: string[];
    };
};

export declare type PermissionMode = 'default' | 'acceptEdits' | 'plan';

export declare const BUILTIN_TOOL_NAMES: readonly ['Bash', 'Edit', 'Read'];

export declare type SDKMessage = SDKAssistantMessage | SDKUserMessage;

export declare function query(_params: {
    prompt: string;
    options?: Options;
}): Query;

/** Old words. */
export declare type Untouched = {
    url: 'https://example.com/a//b'; // a comment after code
};

export declare type Gone = string;

export interface BashInput {
  /**
   * The command
   */
  command: string;
  timeout?: number;
}

export { }
`;

const AFTER = `import type { UUID } from 'crypto';

/**
 * Options for a query, said anew.
 */
export declare type Options = {
    /**
     * Additional directories, absolute.
     */
    additionalDirectories?: string[];
    /** The model, or an alias. */
    model?: string | 'default';
    /** New. */
    newOption?: number;
    hooks?: {
        PreToolUse?: string[];
        PostToolUse?: string[];
    };
};

export declare type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto';

export declare const BUILTIN_TOOL_NAMES: readonly ['Bash', 'Edit', 'Monitor', 'Read'];

export declare type SDKMessage = SDKAssistantMessage | SDKUserMessage | SDKNoteMessage;

export declare function query(_params: {
    prompt: string;
    options?: Options;
}): Query;

/** New words. */
export declare type Untouched = {
    url: 'https://example.com/a//b'; // another comment after code
};

export declare type SDKNoteMessage = {
    type: 'note';
};

export interface BashInput {
  /**
   * The command
   */
  command: string;
  timeout?: number;
  run_in_background?: boolean;
}

export { }
`;

describe('versions', () => {
  it('are exact versions only: a range or anything else never reaches a command', () => {
    expect(isVersion('0.3.318')).toBe(true);
    expect(isVersion('1.0.0-rc.1')).toBe(true);
    for (const wrong of ['^0.3.318', '0.3', 'latest', '0.3.318; rm -rf /', '0.3.318\n0.3.319', '', undefined]) expect(isVersion(wrong)).toBe(false);
  });

  it('are ordered as semantic versions', () => {
    expect(compareVersions('2.1.318', '2.1.99')).toBe(1);
    expect(compareVersions('2.1.318', '2.1.318')).toBe(0);
    expect(compareVersions('1.0.0-rc.2', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0-rc.10', '1.0.0-rc.9')).toBe(1);
    expect(() => compareVersions('latest', '1.0.0')).toThrow('Not a version: latest');
  });
});

describe('a changelog', () => {
  it('splits into its versions, in the order of the file', () => {
    const sections = changelogSections(CLAUDE_CODE_LOG);
    expect(sections.map((section) => section.version)).toEqual(['2.1.320', '2.1.319', '2.1.318', '2.1.316']);
    expect(sections[2]).toEqual({ version: '2.1.318', body: '- Added the thing' });
    expect(changelogSections('## [1.2.0](https://example.com) - 2026-01-01\n\n- One\n\n## v1.1.0\n\n- Two').map((section) => section.version)).toEqual(['1.2.0', '1.1.0']);
  });

  it('gives the entries after one version up to another, newest first', () => {
    expect(changelogBetween(CLAUDE_CODE_LOG, '2.1.318', '2.1.320').map((section) => section.version)).toEqual(['2.1.320', '2.1.319']);
    expect(changelogBetween(CLAUDE_CODE_LOG, '2.1.316', '2.1.318').map((section) => section.version)).toEqual(['2.1.318']);
    // Versions without an entry are simply not there; with no end, all the newer ones.
    expect(changelogBetween(CLAUDE_CODE_LOG, '2.1.317').map((section) => section.version)).toEqual(['2.1.320', '2.1.319', '2.1.318']);
    expect(changelogBetween(CLAUDE_CODE_LOG, '2.1.320')).toEqual([]);
  });

  it('links each version to its heading on GitHub', () => {
    expect(anchor('2.1.318')).toBe('#21318');
    expect(anchor('1.0.0-rc.1')).toBe('#100-rc1');
  });

  it('notifies nobody and links no issue when posted', () => {
    const posted = quiet(CLAUDE_CODE_LOG);
    expect(posted).toContain('- Added `/foo` (`#123`), thanks to `@someone` and `anthropics/claude-code#77`');
    expect(posted).toContain('see `https://github.com/anthropics/claude-code/issues/712`, mail ada@example.com');
    // Code spans and fenced code stay as they are.
    expect(posted).toContain('- Fixed `@scope/pkg` showing as `#1` in code');
    expect(posted).toContain('const at = "@decorator #5";');
  });
});

describe('a package', () => {
  /** One tar entry, as npm writes them (ustar); the checksum is not read. */
  function entry(name: string, content: string, type = '0', prefix = ''): Buffer {
    const data = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0);
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write(type, 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    header.write(prefix, 345);
    return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
  }

  it('is read in memory: its regular files by name, nothing else', () => {
    const big = 'x'.repeat(1300);
    const tgz = gzipSync(Buffer.concat([
      entry('package/', '', '5'),
      entry('package/package.json', '{"claudeCodeVersion":"2.1.318"}'),
      entry('package/link', '', '2'),
      entry('sdk.d.ts', big, '0', 'package'),
      entry('package/after.txt', 'after'),
      Buffer.alloc(1024),
    ]));
    const files = readTar(tgz);
    expect([...files.keys()]).toEqual(['package/package.json', 'package/sdk.d.ts', 'package/after.txt']);
    expect(JSON.parse(files.get('package/package.json')!.toString())).toEqual({ claudeCodeVersion: '2.1.318' });
    expect(files.get('package/sdk.d.ts')!.toString()).toBe(big);
    expect(files.get('package/after.txt')!.toString()).toBe('after');
  });

  it('versions come from npm newest first, deprecated ones left out', () => {
    const packument = {
      versions: {
        '0.3.317': { version: '0.3.317', claudeCodeVersion: '2.1.317' },
        '0.3.320': { version: '0.3.320', claudeCodeVersion: '2.1.320' },
        '0.3.319': { version: '0.3.319', claudeCodeVersion: '2.1.319', deprecated: 'Broken' },
        '0.3.318': { version: '0.3.318', claudeCodeVersion: '2.1.318' },
      },
      time: { '0.3.320': '2026-11-05T21:00:00.000Z', '0.3.318': '2026-11-03T21:55:44.877Z' },
    };
    expect(sdkVersions(packument)).toEqual([
      { version: '0.3.320', claudeCode: '2.1.320', date: '2026-11-05' },
      { version: '0.3.318', claudeCode: '2.1.318', date: '2026-11-03' },
      { version: '0.3.317', claudeCode: '2.1.317', date: undefined },
    ]);
  });
});

describe('the types', () => {
  it('without comments are the code a host depends on, strings kept whole', () => {
    const code = stripComments(BEFORE);
    expect(code).not.toContain('Additional directories');
    expect(code).not.toContain('a comment after code');
    expect(code).toContain("    url: 'https://example.com/a//b';");
    expect(code.split('\n')).not.toContain('');
  });

  it('split into declarations, and those into members or the parts of a union', () => {
    const found = declarations(stripComments(AFTER));
    expect([...found.keys()]).toEqual(['Options', 'PermissionMode', 'BUILTIN_TOOL_NAMES', 'SDKMessage', 'query', 'Untouched', 'SDKNoteMessage', 'BashInput', 'export { }']);
    expect(found.get('query')!.kind).toBe('function');
    expect([...members(found.get('Options')!.text)!.keys()]).toEqual(['additionalDirectories', 'model', 'newOption', 'hooks']);
    expect([...members(found.get('BashInput')!.text)!.keys()]).toEqual(['command', 'timeout', 'run_in_background']);
    expect(constituents(found.get('PermissionMode')!)).toEqual(["'default'", "'acceptEdits'", "'plan'", "'auto'"]);
    expect(constituents(found.get('BUILTIN_TOOL_NAMES')!)).toEqual(["'Bash'", "'Edit'", "'Monitor'", "'Read'"]);
    expect(constituents(found.get('Options')!)).toBeUndefined();
  });

  it('changes are listed a line a declaration; comments alone change nothing', () => {
    expect(typeChanges(BEFORE, AFTER)).toEqual([
      '`Options`: added `newOption`; removed `oldOption`; changed `model`, `hooks`',
      "`PermissionMode`: added `'auto'`",
      "`BUILTIN_TOOL_NAMES`: added `'Monitor'`",
      '`SDKMessage`: added `SDKNoteMessage`',
      '`BashInput`: added `run_in_background`',
      'New: type `SDKNoteMessage`',
      'Gone: type `Gone`',
    ]);
    expect(typeChanges(BEFORE, BEFORE.replace('Old words.', 'Other words.'))).toEqual([]);
  });

  it('diff, by git, between two labelled versions', async () => {
    const diff = await diffTexts(stripComments(BEFORE), stripComments(AFTER), ['0.3.318/sdk.d.ts', '0.3.320/sdk.d.ts']);
    const lines = diff.split('\n');
    expect(lines.slice(0, 2)).toEqual(['--- 0.3.318/sdk.d.ts', '+++ 0.3.320/sdk.d.ts']);
    expect(lines).toContain('+    newOption?: number;');
    expect(lines).toContain('-    oldOption?: boolean;');
    expect(diffSize(diff)).toMatch(/^\+\d+ −\d+ lines$/);
    expect(await diffTexts('same', 'same', ['a', 'b'])).toBe('');
  });
});

describe('fitting a comment', () => {
  it('keeps the lines that fit, then the note', () => {
    expect(cutLines(['one', 'two', 'three'], 100, '…')).toBe('one\ntwo\nthree');
    expect(cutLines(['one', 'two', 'three'], 9, '…')).toBe('one\ntwo\n…');
    expect(cutLines(['one', 'two'], 1, '…')).toBe('…');
  });

  it('shortens the parts in the order given, each only as much as it must', () => {
    const part = (text: string) => ({ text, shorten: (max: number) => text.slice(0, max) });
    expect(fit([part('aaaa'), part('bbbb'), part('cccc')], 100, [2, 1])).toBe('aaaa\n\nbbbb\n\ncccc');
    expect(fit([part('aaaa'), part('bbbb'), part('cccc')], 13, [2, 1])).toBe('aaaa\n\nbbbb\n\nc');
    expect(fit([part('aaaa'), part('bbbb'), part('cccc')], 8, [2, 1])).toBe('aaaa\n\nbb');
  });
});

const from = { version: '0.3.318', claudeCode: '2.1.318' };
const to = { version: '0.3.320', claudeCode: '2.1.320' };
const types = new Map([['sdk.d.ts', typeChanges(BEFORE, AFTER)], ['sdk-tools.d.ts', []]]);

describe('the report on a pull request that moves the pin', () => {
  it('says what changed: both changelogs between the versions, the types and their diff', async () => {
    const diff = await diffTexts(stripComments(BEFORE), stripComments(AFTER), ['0.3.318/sdk.d.ts', '0.3.320/sdk.d.ts']);
    const report = changeMarkdown({ from, to, sdkLog: SDK_LOG, claudeCodeLog: CLAUDE_CODE_LOG, types, diff });
    expect(report.startsWith('## Agent SDK 0.3.318 → 0.3.320\n\nClaude Code 2.1.318 → 2.1.320.')).toBe(true);
    expect(report).toContain('**[0.3.320](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#03320)**');
    expect(report).not.toContain('0.3.318](');
    expect(report).toContain('**[2.1.320](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21320)**');
    expect(report).toContain('**[2.1.319](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21319)**');
    expect(report).not.toContain('Added the thing');
    expect(report).toContain('thanks to `@someone`');
    expect(report).toContain('`sdk.d.ts`\n\n- `Options`: added `newOption`');
    expect(report).toContain('`sdk-tools.d.ts`\n\nComments only.');
    expect(report).toContain('Unchanged: `agentSdkTypes.d.ts`.');
    expect(report).toContain('<details><summary>The diff, comments left out: ');
    expect(report).toContain('```diff\n--- 0.3.318/sdk.d.ts');
  });

  it('fits a comment: the diff goes first, then the older Claude Code entries, each version linked', () => {
    const long = (version: string) => `## ${version}\n\n${Array.from({ length: 40 }, (_, i) => `- Change ${i} in ${version}, said at some length so that it takes room`).join('\n')}`;
    const claudeCodeLog = ['# Changelog', long('2.1.320'), long('2.1.319'), long('2.1.318')].join('\n\n');
    const diff = Array.from({ length: 300 }, (_, i) => `+    option${i}?: string;`).join('\n');
    const older = { version: '0.3.317', claudeCode: '2.1.317' };
    const report = changeMarkdown({ from: older, to, sdkLog: SDK_LOG, claudeCodeLog, types, diff, limit: 4000 });
    expect(report.length).toBeLessThanOrEqual(4000);
    expect(report).not.toContain('```diff');
    expect(report).toContain('The whole diff, comments included: `node scripts/upstream-report.mjs 0.3.317 0.3.320 --full`.');
    expect(report).toContain('- Change 0 in 2.1.320');
    // The version cut short, if any lines of it fit, then those left out, to the oldest.
    expect(report).toMatch(/More in the changelog: (\[2\.1\.\d+\]\(\S+\)( \(the rest\))?, )*\[2\.1\.318\]\(\S+#21318\)\.$/);
    expect(report).not.toContain('Change 0 in 2.1.318');
    // The types, short, stay whole.
    expect(report).toContain('`Options`: added `newOption`');
    expect(changeMarkdown({ from, to, sdkLog: SDK_LOG, claudeCodeLog, types, diff }).length).toBeLessThanOrEqual(LIMIT);
  });

  it('cuts a diff that fits in part at a line, and closes its fence', () => {
    const diff = Array.from({ length: 300 }, (_, i) => `+    option${i}?: string;`).join('\n');
    const whole = changeMarkdown({ from, to, sdkLog: SDK_LOG, claudeCodeLog: CLAUDE_CODE_LOG, types, diff });
    const report = changeMarkdown({ from, to, sdkLog: SDK_LOG, claudeCodeLog: CLAUDE_CODE_LOG, types, diff, limit: whole.length - 3000 });
    expect(report.length).toBeLessThanOrEqual(whole.length - 3000);
    expect(report).toContain('+    option0?: string;');
    expect(report).not.toContain('+    option299?: string;');
    expect(report).toMatch(/\+ {4}option\d+\?: string;\n\n```\n\nThe whole diff, comments included: `node scripts\/upstream-report\.mjs 0\.3\.318 0\.3\.320 --full`\.\n\n<\/details>/);
    // Claude Code's entries are whole: the diff gave way first.
    expect(report).toContain('**[2.1.319](');
  });

  it('says so when Claude Code stays, and when an entry is not written yet', () => {
    const report = changeMarkdown({ from, to: { version: '0.3.321', claudeCode: '2.1.318' }, sdkLog: SDK_LOG, claudeCodeLog: CLAUDE_CODE_LOG, types: new Map(), diff: '' });
    expect(report).toContain('Claude Code stays at 2.1.318.');
    expect(report).toContain('### Claude Code changelog\n\nNo new entries.');
    expect(report).toContain('[changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md) has no entry for 0.3.321 yet.');
    expect(report).toContain('Unchanged: `sdk.d.ts`, `agentSdkTypes.d.ts`, `sdk-tools.d.ts`.');
    expect(report).not.toContain('<details>');
  });
});

describe('the weekly issue', () => {
  const versions = [
    { version: '0.3.320', claudeCode: '2.1.320', date: '2026-11-05' },
    { version: '0.3.319', claudeCode: '2.1.319', date: '2026-11-04' },
    { version: '0.3.318', claudeCode: '2.1.318', date: '2026-11-03' },
  ];

  it('lists the newer Agent SDKs and Claude Code entries, each with a link', () => {
    const body = newerMarkdown({ version: '0.3.318', versions, sdkLog: SDK_LOG, claudeCodeLog: CLAUDE_CODE_LOG });
    expect(body.split('\n').slice(0, 7)).toEqual([
      'Pelican pins Agent SDK 0.3.318, which brings Claude Code 2.1.318.',
      '',
      '### Agent SDK',
      '',
      '- [0.3.320](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#03320) · Claude Code 2.1.320 · 2026-11-05',
      // No changelog entry: npm's page instead.
      '- [0.3.319](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk/v/0.3.319) · Claude Code 2.1.319 · 2026-11-04',
      '',
    ]);
    expect(body).toContain('**[2.1.320](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21320)**');
    expect(body).toContain('**[2.1.319](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21319)**');
    expect(body).not.toContain('Added the thing');
  });

  it('is empty once nothing is newer, and refuses a version npm does not have', () => {
    expect(newerMarkdown({ version: '0.3.320', versions, sdkLog: SDK_LOG, claudeCodeLog: CLAUDE_CODE_LOG })).toBe('');
    expect(() => newerMarkdown({ version: '0.3.999', versions, sdkLog: SDK_LOG, claudeCodeLog: CLAUDE_CODE_LOG })).toThrow('npm has no Agent SDK 0.3.999');
  });
});
