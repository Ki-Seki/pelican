#!/usr/bin/env node
// What changed upstream, in Markdown, for keeping up with Claude Code:
//
//   node scripts/upstream-report.mjs <from> <to>   What changed between two Agent SDK versions: the
//                                                  Agent SDK's and Claude Code's changelog entries in
//                                                  between, and the changes to the SDK's types
//   node scripts/upstream-report.mjs [<version>]   What is newer than this Agent SDK version (by
//                                                  default the one package.json pins); nothing when
//                                                  nothing is
//
// The report fits a GitHub comment; --full gives all of it, with the whole diff. sdk-report.yml
// comments the first on a pull request that moves the pin, and claude-code-updates.yml keeps the
// second in an issue. It only reads: npm's registry, the two packages (`npm pack` into a temporary
// folder, so nothing in them is installed or run) and the two changelogs on GitHub.
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const SDK = '@anthropic-ai/claude-agent-sdk';
const REGISTRY = `https://registry.npmjs.org/${SDK.replace('/', '%2F')}`;
const NPM_PAGE = `https://www.npmjs.com/package/${SDK}/v/`;
export const CHANGELOGS = {
  sdk: { raw: 'https://raw.githubusercontent.com/anthropics/claude-agent-sdk-typescript/main/CHANGELOG.md', page: 'https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md' },
  claudeCode: { raw: 'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md', page: 'https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md' },
};
/** What a host programs against: the SDK's types (agentSdkTypes.d.ts re-exports them) and its tools'. */
export const TYPES = ['sdk.d.ts', 'agentSdkTypes.d.ts', 'sdk-tools.d.ts'];
/** GitHub holds 65,536 characters in a comment or an issue; the workflows add a line or two. */
export const LIMIT = 60_000;

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
/** An exact version: anything else from a pull request never reaches a command line. */
export const isVersion = (text) => typeof text === 'string' && VERSION.test(text);

/** Semantic version order: negative when a comes first, a prerelease before its release. */
export function compareVersions(a, b) {
  const [x, y] = [VERSION.exec(a), VERSION.exec(b)];
  if (!x || !y) throw new Error(`Not a version: ${x ? b : a}`);
  for (let i = 1; i <= 3; i += 1) {
    const difference = Number(x[i]) - Number(y[i]);
    if (difference) return Math.sign(difference);
  }
  if (x[4] === y[4]) return 0;
  if (!x[4] || !y[4]) return x[4] ? -1 : 1;
  return x[4].localeCompare(y[4], 'en', { numeric: true });
}

// Changelogs

/** A changelog's sections, each `## <version>` heading with what is under it, in the file's order. */
export function changelogSections(markdown) {
  const sections = [];
  let current;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+\[?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(line);
    if (heading) sections.push((current = { version: heading[1], lines: [] }));
    else if (/^#{1,2}\s/.test(line)) current = undefined;
    else current?.lines.push(line);
  }
  return sections.map(({ version, lines }) => ({ version, body: lines.join('\n').trim() }));
}

/** The sections after `from`, up to and including `to` (or all newer ones), newest first. */
export function changelogBetween(markdown, from, to) {
  return changelogSections(markdown)
    .filter(({ version }) => compareVersions(version, from) > 0 && (to === undefined || compareVersions(version, to) <= 0))
    .sort((a, b) => compareVersions(b.version, a.version));
}

/** The address of a heading on GitHub's page of a Markdown file: `## 2.1.318` is `#21318`. */
export const anchor = (heading) => `#${heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-')}`;

/**
 * Text from another project, made safe to post: GitHub turns `@name` into a notification for that
 * account, and `#123` or an issue's address into a link that also shows on that issue's own page,
 * here or upstream. Outside code they go into code spans, which GitHub leaves alone.
 */
export function quiet(markdown) {
  let fenced = false;
  return markdown.split('\n').map((line) => {
    if (/^\s{0,3}(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced || /^\s{0,3}(```|~~~)/.test(line)) return line;
    return line.split(/(`[^`]*`)/).map((part, i) => (i % 2 ? part : part
      .replace(/https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull|discussions)\/\d+(?:#[\w-]+)?/g, (url) => `\`${url}\``)
      .replace(/(^|[^\w`&/])((?:[\w.-]+\/[\w.-]+)?#\d+|GH-\d+)\b/g, '$1`$2`')
      .replace(/(^|[^\w`])(@[A-Za-z0-9][\w-]*(?:\/[\w.-]+)?)/g, '$1`$2`'))).join('');
  }).join('\n');
}

// The packages

/** The regular files in a .tgz, by name. They are read, never written out. */
export function readTar(tgz) {
  const tar = gunzipSync(tgz);
  const files = new Map();
  for (let at = 0; at + 512 <= tar.length;) {
    const header = tar.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) => header.toString('utf8', start, start + length).replace(/\0[\s\S]*$/, '');
    const name = [field(257, 6).startsWith('ustar') ? field(345, 155) : '', field(0, 100)].filter(Boolean).join('/');
    const size = Number.parseInt(field(124, 12).trim() || '0', 8);
    at += 512;
    if (['0', ''].includes(field(156, 1))) files.set(name, tar.subarray(at, at + size));
    at += Math.ceil(size / 512) * 512;
  }
  return files;
}

function exec(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 64 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve(stdout);
    });
  });
}

/** One Agent SDK version's package.json and type files, from its package. */
async function sdkPackage(version, dir) {
  if (!isVersion(version)) throw new Error(`Not a version: ${version}`);
  const output = await exec('npm', ['pack', `${SDK}@${version}`, '--ignore-scripts', '--json', '--pack-destination', dir], {
    cwd: dir,
    shell: process.platform === 'win32',
  });
  const [{ filename }] = JSON.parse(output);
  const files = readTar(await readFile(path.join(dir, path.basename(filename))));
  const text = (name) => files.get(`package/${name}`)?.toString('utf8');
  const manifest = JSON.parse(text('package.json') ?? '{}');
  return { version, claudeCode: manifest.claudeCodeVersion, types: new Map(TYPES.map((name) => [name, text(name)])) };
}

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.text();
}

/** The Agent SDK versions on npm, newest first, each with the Claude Code it brings and its day. */
export function sdkVersions(packument) {
  return Object.values(packument.versions ?? {})
    .filter((manifest) => isVersion(manifest.version) && !manifest.deprecated)
    .map((manifest) => ({ version: manifest.version, claudeCode: manifest.claudeCodeVersion, date: packument.time?.[manifest.version]?.slice(0, 10) }))
    .sort((a, b) => compareVersions(b.version, a.version));
}

// Types

/** The code of a declaration file without its comments, one statement part a line, no blank lines. */
export function stripComments(source) {
  const kept = [];
  let from = 0;
  for (let i = 0; i < source.length;) {
    const pair = source.slice(i, i + 2);
    if (pair === '/*' || pair === '//') {
      kept.push(source.slice(from, i));
      const end = pair === '/*' ? source.indexOf('*/', i + 2) : source.indexOf('\n', i);
      i = end < 0 ? source.length : pair === '/*' ? end + 2 : end;
      from = i;
    } else if (source[i] === "'" || source[i] === '"' || source[i] === '`') {
      // A string may hold `//` or `/*` (an address in a literal type).
      let j = i + 1;
      while (j < source.length && source[j] !== source[i] && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
      i = j + 1;
    } else {
      i += 1;
    }
  }
  kept.push(source.slice(from));
  return kept.join('').split('\n').map((line) => line.trimEnd()).filter(Boolean).join('\n');
}

const DECLARATION = /^(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(type|interface|function|const|let|var|class|enum|namespace)\s+([\w$]+)/;

/** The top-level declarations of comment-free code, by name; overloads share one entry. */
export function declarations(code) {
  const found = new Map();
  let current;
  for (const line of code.split('\n')) {
    if (/^import\s/.test(line)) {
      current = undefined;
      continue;
    }
    if (/^[^\s})\]]/.test(line)) {
      const [, kind = 'statement', name = line] = DECLARATION.exec(line) ?? [];
      current = found.get(name) ?? { kind, lines: [] };
      found.set(name, current);
    }
    current?.lines.push(line);
  }
  return new Map([...found].map(([name, { kind, lines }]) => [name, { kind, text: lines.join('\n') }]));
}

/** The members of an object type, interface or class, by name, each with its text; else undefined. */
export function members(text) {
  const lines = text.split('\n');
  const indent = /^\s+/.exec(lines[1] ?? '')?.[0];
  if (!lines[0]?.endsWith('{') || !indent) return undefined;
  const found = new Map();
  let current;
  for (const line of lines.slice(1)) {
    if (!line.startsWith(indent)) {
      current = undefined;
      continue;
    }
    const rest = line.slice(indent.length);
    if (/^[^\s})\]|&>,]/.test(rest)) {
      const name = /^(?:(?:readonly|static|private|protected|public|abstract|get|set|async)\s+)*(\[[^\]]*\]|'[^']*'|"[^"]*"|[\w$]+|\(|<)/.exec(rest)?.[1] ?? rest;
      const key = name === '(' || name === '<' ? '()' : name;
      current = found.get(key) ?? [];
      found.set(key, current);
    }
    current?.push(line);
  }
  return new Map([...found].map(([name, memberLines]) => [name, memberLines.join('\n')]));
}

/** The names or literals of a union, or of a tuple of literals (a list of tools); else undefined. */
export function constituents({ kind, text }) {
  const flat = text.replace(/\s+/g, ' ');
  const at = kind === 'const' ? flat.indexOf(':') : kind === 'type' ? flat.indexOf('=') : -1;
  if (at < 0) return undefined;
  const type = flat.slice(at + 1).trim().replace(/;$/, '').replace(/^readonly\s+/, '');
  const tuple = /^\[(.*)\]$/.exec(type);
  const parts = (tuple ? tuple[1].split(',') : type.replace(/^\|/, '').split('|')).map((part) => part.trim()).filter(Boolean);
  const simple = /^(?:[\w$.]+|'[^']*'|"[^"]*"|-?\d+)$/;
  return parts.length > 1 && parts.every((part) => simple.test(part)) ? parts : undefined;
}

const code = (name) => `\`${name}\``;

/** "added `a`; removed `b`; changed `c`" between two keyed sets, or '' when only the order moved. */
function delta(before, after) {
  const added = [...after.keys()].filter((key) => !before.has(key));
  const removed = [...before.keys()].filter((key) => !after.has(key));
  const changed = [...after.keys()].filter((key) => before.has(key) && before.get(key) !== after.get(key));
  return [['added', added], ['removed', removed], ['changed', changed]]
    .filter(([, keys]) => keys.length)
    .map(([word, keys]) => `${word} ${keys.map(code).join(', ')}`)
    .join('; ');
}

/** What changed in the code of a declaration file, a line per declaration; comments do not count. */
export function typeChanges(before, after) {
  const [old, now] = [declarations(stripComments(before)), declarations(stripComments(after))];
  const lines = [];
  for (const [name, declaration] of now) {
    const was = old.get(name);
    if (!was || was.text === declaration.text) continue;
    const [a, b] = [constituents(was), constituents(declaration)];
    const [x, y] = [members(was.text), members(declaration.text)];
    const what = a && b ? delta(new Map(a.map((part) => [part, part])), new Map(b.map((part) => [part, part]))) : x && y ? delta(x, y) : '';
    lines.push(what ? `${code(name)}: ${what}` : `${code(name)} changed`);
  }
  const named = (map, names) => names.map((name) => (map.get(name).kind === 'statement' ? code(name) : `${map.get(name).kind} ${code(name)}`)).join(', ');
  const added = [...now.keys()].filter((name) => !old.has(name));
  const removed = [...old.keys()].filter((name) => !now.has(name));
  if (added.length) lines.push(`New: ${named(now, added)}`);
  if (removed.length) lines.push(`Gone: ${named(old, removed)}`);
  return lines;
}

/** A unified diff of two texts by git, which any checkout of this repository has; '' when equal. */
export async function diffTexts(before, after, [left, right]) {
  if (before === after) return '';
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pelican-diff-'));
  try {
    for (const [name, text] of [[left, before], [right, after]]) {
      await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await writeFile(path.join(dir, name), text);
    }
    // Exit code 1 means the files differ. The user's git settings (an external diff, other
    // prefixes, colours) would change the output.
    const output = await exec('git', ['diff', '--no-index', '--no-color', '--no-ext-diff', '--no-textconv', '--no-prefix', '--histogram', '--unified=3', '--', left, right], {
      cwd: dir,
      env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' },
    }).catch((error) => (error.code === 1 ? error.stdout : Promise.reject(error)));
    return output.split('\n').filter((line) => !/^(diff --git|index) /.test(line)).join('\n').trimEnd();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** "+12 −5 lines" for a unified diff. */
export function diffSize(diff) {
  const lines = diff.split('\n');
  const count = (sign) => lines.filter((line) => line.startsWith(sign) && !line.startsWith(sign.repeat(3))).length;
  return `+${count('+')} −${count('-')} lines`;
}

// Fitting a comment

/** As many lines as fit in `max` characters with the note after them, or the note alone. */
export function cutLines(lines, max, note) {
  const kept = [];
  let size = note.length;
  for (const line of lines) {
    if (size + line.length + 1 > max) break;
    kept.push(line);
    size += line.length + 1;
  }
  return kept.length === lines.length ? lines.join('\n') : [...kept, note].join('\n');
}

/**
 * Joins the parts, and when the whole is longer than `limit`, shortens them in the given order,
 * each only as much as it takes.
 */
export function fit(parts, limit, order) {
  const texts = parts.map((part) => part.text);
  const size = () => texts.filter(Boolean).join('\n\n').length;
  for (const i of order) {
    const over = size() - limit;
    if (over <= 0) break;
    texts[i] = parts[i].shorten(Math.max(0, texts[i].length - over));
  }
  return texts.filter(Boolean).join('\n\n');
}

/** A heading and its lines, which shorten to those that fit and a note on where the rest is. */
function section(heading, lines, rest) {
  return {
    text: [heading, '', ...lines].join('\n').trimEnd(),
    shorten: (max) => [heading, '', cutLines(lines, max - heading.length - 2, rest)].join('\n'),
  };
}

/**
 * A changelog's entries under a heading. Shortened, it keeps whole versions while they fit and
 * then what fits of the next, and links each version it leaves out, or leaves only in part.
 */
function changelogPart(heading, entries, page, empty, first) {
  const link = (version) => `[${version}](${page}${anchor(version)})`;
  const blocks = entries.map((entry) => [`**${link(entry.version)}**`, '', ...quiet(entry.body).split('\n'), '']);
  if (first) blocks.unshift([first, '']);
  return {
    text: [heading, '', ...(blocks.length ? blocks.flat() : [empty])].join('\n').trimEnd(),
    shorten: (max) => {
      const skip = first ? 1 : 0;
      const note = (from, partly) => `More in the changelog: ${entries.slice(Math.max(0, from - skip)).map((entry, i) => `${link(entry.version)}${i === 0 && partly ? ' (the rest)' : ''}`).join(', ')}.`;
      let room = max - heading.length - 2 - note(0, true).length - 1;
      const kept = [];
      for (const [i, block] of blocks.entries()) {
        const size = block.join('\n').length + 1;
        if (size <= room) {
          kept.push(...block);
          room -= size;
          continue;
        }
        const lines = block.slice(0, 2);
        room -= lines.join('\n').length + 1;
        for (const line of block.slice(2)) {
          if (line.length + 1 > room) break;
          lines.push(line);
          room -= line.length + 1;
        }
        // A heading with nothing under it is left out with the rest.
        const partly = lines.length > 2;
        if (partly) kept.push(...lines, '');
        return [heading, '', ...kept, note(i, partly)].join('\n');
      }
      return [heading, '', ...kept].join('\n').trimEnd();
    },
  };
}

/** A diff folded away under a summary, in a fence no line of it can close. */
function diffBlock(summary, diff, rest) {
  const fence = '`'.repeat(Math.max(3, ...(diff.match(/`+/g) ?? []).map((run) => run.length + 1)));
  const open = `<details><summary>${summary}</summary>\n\n${fence}diff`;
  const close = `${fence}\n\n</details>`;
  return {
    text: [open, diff, close].join('\n'),
    shorten: (max) => {
      const room = max - open.length - close.length - rest.length - 4;
      // A few lines of a long diff say less than the list above them.
      return room < 400 ? rest : [open, cutLines(diff.split('\n'), room, ''), fence, '', rest, '', '</details>'].join('\n');
    },
  };
}

// The reports

/** What changed between two Agent SDK versions, from what was fetched: pure, for the tests too. */
export function changeMarkdown({ from, to, sdkLog, claudeCodeLog, types, diff, full = false, limit = full ? Infinity : LIMIT }) {
  const command = `\`node scripts/upstream-report.mjs ${from.version} ${to.version} --full\``;
  const forward = compareVersions(to.version, from.version) > 0;
  const [a, b] = [from.claudeCode, to.claudeCode];
  const newer = Boolean(a && b && compareVersions(b, a) > 0);
  const claudeCode = !a || !b ? 'The packages do not say which Claude Code they bring.'
    : a === b ? `Claude Code stays at ${b}.`
      : `Claude Code ${a} → ${b}.`;
  const header = {
    text: `## Agent SDK ${from.version} → ${to.version}\n\n${claudeCode} [On npm](${NPM_PAGE}${to.version}).`,
    shorten: () => header.text,
  };

  const missing = (entries, version, page) => (entries[0]?.version === version ? undefined : `The [changelog](${page}) has no entry for ${version} yet.`);
  const sdkEntries = forward ? changelogBetween(sdkLog, from.version, to.version) : [];
  const sdkPart = changelogPart('### Agent SDK changelog', sdkEntries, CHANGELOGS.sdk.page, 'An older version: no new entries.',
    forward ? missing(sdkEntries, to.version, CHANGELOGS.sdk.page) : undefined);

  const typeLines = TYPES.flatMap((name) => {
    const changes = types.get(name);
    return changes === undefined ? [] : [code(name), '', ...(changes.length ? changes.map((line) => `- ${line}`) : ['Comments only.']), ''];
  });
  const same = TYPES.filter((name) => !types.has(name));
  if (same.length) typeLines.push(`Unchanged: ${same.map(code).join(', ')}.`);
  const typesPart = section('### Types', typeLines, `…and more: ${command} lists all of it.`);

  const diffPart = diff
    ? diffBlock(full ? `The diff: ${diffSize(diff)}` : `The diff, comments left out: ${diffSize(diff)}`, diff, `The whole diff, comments included: ${command}.`)
    : { text: '', shorten: () => '' };

  const claudeCodeEntries = newer ? changelogBetween(claudeCodeLog, a, b) : [];
  const claudeCodePart = changelogPart('### Claude Code changelog', claudeCodeEntries, CHANGELOGS.claudeCode.page, 'No new entries.',
    newer ? missing(claudeCodeEntries, b, CHANGELOGS.claudeCode.page) : undefined);

  // Shortened first: the diff (the list above it names what it holds), then Claude Code's long changelog.
  return fit([header, sdkPart, typesPart, diffPart, claudeCodePart], limit, [3, 4, 2, 1]);
}

/** What changed between two Agent SDK versions. */
export async function changeReport(fromVersion, toVersion, { full = false } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pelican-sdk-'));
  try {
    const [from, to, sdkLog, claudeCodeLog] = await Promise.all([
      sdkPackage(fromVersion, dir),
      sdkPackage(toVersion, dir),
      download(CHANGELOGS.sdk.raw),
      download(CHANGELOGS.claudeCode.raw),
    ]);
    const types = new Map();
    const diffs = [];
    for (const name of TYPES) {
      const [before = '', after = ''] = [from.types.get(name), to.types.get(name)];
      if (before === after) continue;
      types.set(name, typeChanges(before, after));
      const [left, right] = full ? [before, after] : [stripComments(before), stripComments(after)];
      diffs.push(await diffTexts(left, right, [`${from.version}/${name}`, `${to.version}/${name}`]));
    }
    return changeMarkdown({ from, to, sdkLog, claudeCodeLog, types, diff: diffs.filter(Boolean).join('\n'), full });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** What is newer than an Agent SDK version, from what was fetched; '' when nothing is. */
export function newerMarkdown({ version, versions, sdkLog, claudeCodeLog, full = false, limit = full ? Infinity : LIMIT }) {
  const pinned = versions.find((entry) => entry.version === version);
  if (!pinned?.claudeCode) throw new Error(`npm has no Agent SDK ${version} that names its Claude Code`);
  const newer = versions.filter((entry) => compareVersions(entry.version, version) > 0);
  const entries = changelogBetween(claudeCodeLog, pinned.claudeCode);
  if (!newer.length && !entries.length) return '';
  const sdkSections = new Set(changelogSections(sdkLog).map((entry) => entry.version));
  const header = { text: `Pelican pins Agent SDK ${version}, which brings Claude Code ${pinned.claudeCode}.`, shorten: () => header.text };
  const sdkPart = section('### Agent SDK', newer.length ? newer.map((entry) => {
    const link = sdkSections.has(entry.version) ? `${CHANGELOGS.sdk.page}${anchor(entry.version)}` : `${NPM_PAGE}${entry.version}`;
    return `- [${entry.version}](${link})${entry.claudeCode ? ` · Claude Code ${entry.claudeCode}` : ''}${entry.date ? ` · ${entry.date}` : ''}`;
  }) : ['No newer version yet.'], `…and more [on npm](https://www.npmjs.com/package/${SDK}?activeTab=versions).`);
  const claudeCodePart = changelogPart('### Claude Code', entries, CHANGELOGS.claudeCode.page, 'No newer changelog entries.');
  return fit([header, sdkPart, claudeCodePart], limit, [2, 1]);
}

/** What is newer than an Agent SDK version. */
export async function newerReport(version, { full = false } = {}) {
  const [packument, sdkLog, claudeCodeLog] = await Promise.all([
    download(REGISTRY).then((text) => JSON.parse(text)),
    download(CHANGELOGS.sdk.raw),
    download(CHANGELOGS.claudeCode.raw),
  ]);
  return newerMarkdown({ version, versions: sdkVersions(packument), sdkLog, claudeCodeLog, full });
}

const USAGE = `Usage: node scripts/upstream-report.mjs <from> <to> [--full]   what changed between two Agent SDK versions
       node scripts/upstream-report.mjs [<version>] [--full]     what is newer (default: the pinned version)`;

async function main(args) {
  if (args.includes('--help') || args.includes('-h')) return void console.log(USAGE);
  const full = args.includes('--full');
  const versions = args.filter((arg) => arg !== '--full');
  const wrong = versions.find((arg) => !isVersion(arg));
  if (wrong !== undefined || versions.length > 2) {
    console.error(wrong === undefined ? USAGE : `Not an exact version: ${wrong}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (versions.length === 2) {
    if (versions[0] === versions[1]) throw new Error(`Both versions are ${versions[0]}`);
    console.log(await changeReport(versions[0], versions[1], { full }));
    return;
  }
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const pinned = versions[0] ?? manifest.dependencies?.[SDK];
  if (!isVersion(pinned)) throw new Error(`package.json pins no exact version of ${SDK}`);
  const report = await newerReport(pinned, { full });
  if (report) console.log(report);
  else console.error(`Nothing is newer than Agent SDK ${pinned}.`);
}

/** Run as a command, not imported by the tests (a path through a symlink, such as macOS's /tmp, counts). */
const isMain = () => {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isMain()) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`upstream-report: ${error.message}`);
    process.exitCode = 1;
  });
}
