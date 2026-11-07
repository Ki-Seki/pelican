// THIRD_PARTY_NOTICES: the packages built into Pelican's server (dist/server/index.js, by esbuild's
// metafile) and its web app (dist/web, by the modules Vite puts in it), each with its name, version,
// license and the full text of its license, and where its source is. Written by `npm run build`,
// which fails if a package built in is missing from it (scripts/build-server.mjs); npm ships it.
// The Agent SDK and the terminal's PTY (@lydell/node-pty) are not built in: npm installs each as a
// package, with its own license.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Where the notices are written, beside LICENSE. */
export const NOTICES = 'THIRD_PARTY_NOTICES';

/** Where the web app's build leaves the packages built into it, for the server's build to write the notices with. */
export const WEB_PACKAGES = 'dist/.third-party-web.json';

/**
 * A package's files that hold its license or notices, as npm packages name them: those of what it
 * takes from others too (rolldown's THIRD-PARTY-LICENSE, for the runtime it puts in a bundle).
 */
const LICENSE_FILE = /^(?:(?:third[-_]party[-_])?(?:licen[cs]es?|notices?)|copying|copyright|unlicense)(?:[-_.][\w.-]*)?$/i;

/** Licenses whose source must be offered with what is built from it, as the MPL asks for its files. */
const SOURCE_OFFERED = /\b(?:MPL|EPL|LGPL|CDDL)\b/i;

/**
 * The folder of the package a bundled file is from: that of the last `node_modules/<name>` (or
 * `node_modules/@scope/<name>`) in its path; undefined for one of Pelican's own.
 */
export function packageFolder(file) {
  const parts = file.split(/[\\/]/);
  const at = parts.lastIndexOf('node_modules');
  if (at < 0) return undefined;
  const length = parts[at + 1]?.startsWith('@') ? 2 : 1;
  return parts.length > at + length ? parts.slice(0, at + 1 + length).join('/') : undefined;
}

/** The folders of the packages bundled files are from, each once, in order. */
export const packagesOf = (files) => [...new Set(files.map(packageFolder).filter(Boolean))].sort();

/** A package's license as its package.json gives it. */
function licenseOf(manifest) {
  if (typeof manifest.license === 'string') return manifest.license;
  if (manifest.license?.type) return manifest.license.type;
  if (Array.isArray(manifest.licenses)) return manifest.licenses.map((license) => license.type ?? license).join(' OR ');
  return undefined;
}

const personOf = (person) => (typeof person === 'string' ? person : person?.name ? `${person.name}${person.email ? ` <${person.email}>` : ''}` : undefined);

/**
 * The texts of a package's license files. vite's LICENSE.md goes on with the licenses of what it
 * bundles into itself, none of which is in Pelican: what is, its preload helper, is vite's own.
 */
function licenseFiles(folder) {
  return readdirSync(folder)
    .filter((name) => LICENSE_FILE.test(name) && statSync(path.join(folder, name)).isFile())
    .sort()
    .map((name) => {
      const text = readFileSync(path.join(folder, name), 'utf8').replace(/\r\n?/g, '\n');
      const bundled = text.indexOf('\n# Licenses of bundled dependencies');
      return { name, text: (bundled >= 0 ? text.slice(0, bundled) : text).trim() };
    });
}

/**
 * For a package with no license file: the copyright and license lines at the top of its main file
 * (a source file's header), if any.
 */
function headerOf(folder, manifest) {
  const main = path.join(folder, typeof manifest.main === 'string' ? manifest.main : 'index.js');
  let head = '';
  try {
    head = readFileSync(/\.[cm]?js$/.test(main) ? main : `${main}.js`, 'utf8').slice(0, 4000);
  } catch {
    return [];
  }
  const comment = /^(?:\s*(?:\/\/.*|\/\*[\s\S]*?\*\/)\s*)+/.exec(head.replace(/^(?:'use strict';|"use strict";)\s*/, ''))?.[0] ?? '';
  const lines = comment.split('\n').map((line) => line.replace(/^\s*(?:\/\/|\/\*+|\*\/|\*)?\s*/, '').trimEnd());
  // A copyright line, a license line, and the address a license line ending in `:` gives.
  return lines.filter((line, i) => /copyright|licen[cs]ed? under/i.test(line) || (/^https?:\/\//.test(line) && /licen[cs]e.*:$/i.test(lines[i - 1] ?? '')));
}

/** Words as lines of at most `width` characters. */
const wrap = (words, width = 96) => words.split(' ').reduce((lines, word) => {
  const last = lines.at(-1);
  if (last !== undefined && `${last} ${word}`.length <= width) lines[lines.length - 1] = `${last} ${word}`;
  else lines.push(word);
  return lines;
}, []).join('\n');

/**
 * The notices of others that files of a package built in carry at their top, which a minifier
 * leaves out: a comment with a copyright line that the package's own license does not have, as
 * vfile's minpath.browser.js has path-browserify's and Node's. Each with the file's path in it.
 */
function noticesIn(pkg, files) {
  const own = [...pkg.files.map((file) => file.text), ...pkg.header].join('\n');
  const found = [];
  for (const file of [...new Set(files)].sort()) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const comment = /^(?:\s*(?:\/\/.*|\/\*[\s\S]*?\*\/)\s*)+/.exec(text.slice(0, 20_000).replace(/^(?:'use strict';|"use strict";)\s*/, ''))?.[0] ?? '';
    const lines = comment.split('\n').map((line) => line.replace(/^\s*(?:\/\/|\/\*+|\*\/|\*)? ?/, '').trimEnd());
    if (lines.some((line) => /^copyright\b/i.test(line.trim()) && !own.includes(line.trim()))) {
      found.push({ name: path.relative(pkg.folder, file), text: lines.join('\n').trim() });
    }
  }
  return found;
}

/**
 * Where the license of a package that comes with no license file is, when another package of its
 * project has it: @xterm/headless is built from xterm.js's repository, under the LICENSE that
 * @xterm/xterm ships, and names no author.
 */
const LICENSE_FROM = { '@xterm/headless': '@xterm/xterm' };

/** The license files of `other`, a package beside the one in `folder`, named as its project's. */
function projectLicense(folder, other) {
  const modules = folder.slice(0, folder.lastIndexOf('node_modules') + 'node_modules'.length);
  const at = path.join(modules, other);
  const { version } = JSON.parse(readFileSync(path.join(at, 'package.json'), 'utf8'));
  return licenseFiles(at).map((file) => ({ name: `${file.name} (its project's, as ${other} ${version} ships it)`, text: file.text }));
}

/**
 * Packages whose code a file of Pelican's own adapts, so that it is built in with that file though
 * no bundler counts it as theirs: xterm's serializer, in the terminal's copy of the screen.
 */
export const ADAPTED = [{ name: '@xterm/addon-serialize', file: 'src/server/terminal-snapshot.ts' }];

/** What a package is, read from its folder. */
export function readPackage(folder) {
  const manifest = JSON.parse(readFileSync(path.join(folder, 'package.json'), 'utf8'));
  const files = licenseFiles(folder);
  const from = files.length === 0 ? LICENSE_FROM[manifest.name] : undefined;
  return {
    folder,
    name: manifest.name,
    version: manifest.version,
    license: licenseOf(manifest),
    author: personOf(manifest.author),
    files: from ? projectLicense(folder, from) : files,
    header: headerOf(folder, manifest),
  };
}

/** The heading of a package's section, which `missing` looks for. */
const headingOf = (pkg) => `${pkg.name} ${pkg.version}\nLicense: ${pkg.license ?? 'not given'}\n`;

/** The MIT License's text (Pelican's own is it), with another copyright line. */
function mitWith(copyright) {
  const mit = readFileSync(path.join(here, '..', 'LICENSE'), 'utf8').replace(/\r\n?/g, '\n').trim();
  return mit.replace(/^Copyright .*$/m, copyright);
}

/** A package's section: what it is, where it is built in, where its source is, its license in full, and the notices of others its files built in carry. */
function section(pkg, where, files) {
  const npm = `https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}`;
  const tarball = `https://registry.npmjs.org/${pkg.name}/-/${pkg.name.split('/').pop()}-${pkg.version}.tgz`;
  const lines = [headingOf(pkg).trimEnd(), `Built into: ${where.join(' and ')}`, `Source: its npm package, ${npm} (${tarball})`];
  if (SOURCE_OFFERED.test(pkg.license ?? '')) {
    const license = pkg.license === 'MPL-2.0' ? 'Mozilla Public License 2.0' : pkg.license;
    lines.push('', wrap(`${pkg.name} is under the ${license}: its source code, of which Pelican builds the files it uses into ${where.join(' and ')} unchanged, is its npm package, ${pkg.name} ${pkg.version}, at the addresses above, under that license, which follows in full.`));
  }
  const texts = pkg.files.map((file) => `${file.name}:\n\n${file.text}`);
  if (/^MPL-2\.0$/.test(pkg.license ?? '')) {
    texts.push(`The Mozilla Public License 2.0:\n\n${readFileSync(path.join(here, 'licenses', 'MPL-2.0.txt'), 'utf8').replace(/\r\n?/g, '\n').trim()}`);
  }
  if (pkg.files.length === 0) {
    if (pkg.license !== 'MIT') throw new Error(`${pkg.name} ${pkg.version} (${pkg.license}) comes with no license file: say in scripts/notices.mjs where its license is`);
    const copyright = pkg.header.find((line) => /^copyright/i.test(line)) ?? (pkg.author ? `Copyright (c) ${pkg.author}` : undefined);
    if (!copyright) throw new Error(`${pkg.name} ${pkg.version} comes with no license file and names no author`);
    texts.push([
      'The package comes with no license file. Its package.json says MIT;',
      ...(pkg.header.length > 0 ? ['its main file says:', '', ...pkg.header.map((line) => `  ${line}`), ''] : [`its author, as package.json names them: ${pkg.author}.`, '']),
      `The MIT License, with ${pkg.header.length > 0 ? 'that' : 'its author\'s'} copyright line:`,
      '',
      mitWith(copyright),
    ].join('\n'));
  }
  const carried = noticesIn(pkg, files);
  if (carried.length > 0) {
    texts.push(`Notices of others in its files built in, which minifying leaves out of them:\n\n${carried.map((notice) => `${notice.name}:\n\n${notice.text}`).join('\n\n')}`);
  }
  return `${lines.join('\n')}\n\n${texts.join('\n\n')}\n`;
}

/**
 * The text of THIRD_PARTY_NOTICES: the packages built into the server and the web app (their
 * folders), each once, with where it is built in; `helpers`, a bundler whose own code it writes
 * into the server (esbuild's runtime); `adapted`, packages whose code a file of Pelican's adapts
 * (ADAPTED); and `files`, the files built in, for the notices they carry.
 * @param {{ version: string, server: string[], web: string[], helpers?: string[], adapted?: { folder: string, file: string }[], files?: string[] }} built
 */
export function notices({ version, server, web, helpers = [], adapted = [], files = [] }) {
  const where = new Map();
  for (const folder of server) where.set(folder, [...(where.get(folder) ?? []), 'the server (dist/server/index.js)']);
  for (const folder of helpers) where.set(folder, [...(where.get(folder) ?? []), 'the server (dist/server/index.js), as the helper code it writes into what it bundles (__toESM, __commonJS and the like)']);
  for (const { folder, file } of adapted) where.set(folder, [...(where.get(folder) ?? []), `the server (dist/server/index.js), as the code ${file} adapts from it`]);
  for (const folder of web) where.set(folder, [...(where.get(folder) ?? []), 'the web app (dist/web)']);
  const packages = [...where.keys()].map(readPackage).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const rule = '='.repeat(80);
  const offered = packages.filter((pkg) => SOURCE_OFFERED.test(pkg.license ?? ''));
  const head = [
    `Third-party notices for pelican-cc ${version}`,
    '',
    wrap('Pelican is under the MIT License (LICENSE). Its server, dist/server/index.js, and its web app, dist/web, are built with the packages below in them, each under its own license, whose text follows its name. The Agent SDK and the terminal\'s PTY, @lydell/node-pty, are not among them: npm installs each as a package of its own, with its license.'),
    ...(offered.length > 0 ? [
      '',
      wrap(`Of them, ${offered.map((pkg) => `${pkg.name} ${pkg.version} (${pkg.license})`).join(', ')} ${offered.length === 1 ? 'is' : 'are'} under a license that asks for its source code to be offered: it is the npm package of that name and version, as its section says.`),
    ] : []),
  ];
  return `${head.join('\n')}\n\n${packages.map((pkg) => `${rule}\n${section(pkg, where.get(pkg.folder), files.filter((file) => packageFolder(file) === pkg.folder))}`).join('\n')}`;
}

/** The packages (folders) the notices do not name with their version and license: none, when they are complete. */
export function missing(text, folders) {
  return folders.map(readPackage).filter((pkg) => !text.includes(`\n${headingOf(pkg)}`)).map((pkg) => `${pkg.name} ${pkg.version}`);
}

/**
 * Whether a bundle esbuild wrote has its runtime in it, the helpers it writes for what it bundles
 * (`var __toESM = …`), which neither its metafile nor its source map names.
 */
export const hasEsbuildRuntime = (code) => /^var __(?:toESM|commonJS|esm|export|require|copyProps|reExport) = /m.test(code);

/** The files of packages, with code in what a Vite or Rolldown build wrote. */
export function webFiles(bundle) {
  const files = [];
  for (const output of Object.values(bundle)) {
    if (output.type !== 'chunk') continue;
    for (const [id, module] of Object.entries(output.modules)) if (module.renderedLength > 0 && !id.startsWith('\0') && packageFolder(id)) files.push(id.replace(/[?#].*$/, ''));
  }
  return [...new Set(files)].sort();
}

/**
 * The packages a Vite or Rolldown build put in what it wrote: by the modules with code in its
 * chunks, the virtual ones vite and Rolldown add (vite's preload helper, Rolldown's runtime) by
 * the package they come from, and a stylesheet by the banner a package leaves at its top
 * (`/*! tailwindcss v4.3.4 | MIT License | … *\/`).
 */
export function webPackages(bundle, folderOf) {
  const files = [];
  for (const output of Object.values(bundle)) {
    if (output.type === 'chunk') {
      for (const [id, module] of Object.entries(output.modules)) {
        if (module.renderedLength === 0) continue;
        if (!id.startsWith('\0')) {
          files.push(id.replace(/[?#].*$/, ''));
          continue;
        }
        const named = /^\0(vite|rolldown)\//.exec(id)?.[1];
        if (!named) throw new Error(`A module of the web app's from no package Pelican knows: ${JSON.stringify(id)}`);
        files.push(path.join(folderOf(named), 'package.json'));
      }
    } else if (/\.css$/.test(output.fileName)) {
      const source = typeof output.source === 'string' ? output.source : Buffer.from(output.source).toString('utf8');
      for (const banner of source.matchAll(/\/\*!\s*([@\w./-]+) v(\d[\w.-]*)/g)) {
        const folder = folderOf(banner[1]);
        if (JSON.parse(readFileSync(path.join(folder, 'package.json'), 'utf8')).version !== banner[2]) throw new Error(`${banner[1]} ${banner[2]} is in the web app, but node_modules has another version`);
        files.push(path.join(folder, 'package.json'));
      }
    }
  }
  return packagesOf(files);
}
