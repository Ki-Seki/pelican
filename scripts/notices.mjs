// THIRD_PARTY_NOTICES: the packages built into Pelican's server (dist/server/index.js, by esbuild's
// metafile) and its web app (dist/web, by the modules Vite puts in it), each with its name, version,
// license and the full text of its license, and where its source is. Written by `npm run build`,
// which fails if a package built in is missing from it (scripts/build-server.mjs); npm ships it.
// The Agent SDK is not built in: npm installs it as a package, with its own license.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Where the notices are written, beside LICENSE. */
export const NOTICES = 'THIRD_PARTY_NOTICES';

/** Where the web app's build leaves the packages built into it, for the server's build to write the notices with. */
export const WEB_PACKAGES = 'dist/.third-party-web.json';

/** A package's files that hold its license or notices, as npm packages name them. */
const LICENSE_FILE = /^(?:licen[cs]e|copying|copyright|notice|unlicense)(?:[-_.][\w.-]*)?$/i;

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

/** What a package is, read from its folder. */
export function readPackage(folder) {
  const manifest = JSON.parse(readFileSync(path.join(folder, 'package.json'), 'utf8'));
  return {
    folder,
    name: manifest.name,
    version: manifest.version,
    license: licenseOf(manifest),
    author: personOf(manifest.author),
    files: licenseFiles(folder),
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

/** A package's section: what it is, where it is built in, where its source is, and its license in full. */
function section(pkg, where) {
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
  return `${lines.join('\n')}\n\n${texts.join('\n\n')}\n`;
}

/**
 * The text of THIRD_PARTY_NOTICES: the packages built into the server and the web app (their
 * folders), each once, with where it is built in.
 */
export function notices({ version, server, web }) {
  const where = new Map();
  for (const folder of server) where.set(folder, [...(where.get(folder) ?? []), 'the server (dist/server/index.js)']);
  for (const folder of web) where.set(folder, [...(where.get(folder) ?? []), 'the web app (dist/web)']);
  const packages = [...where.keys()].map(readPackage).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const rule = '='.repeat(80);
  const offered = packages.filter((pkg) => SOURCE_OFFERED.test(pkg.license ?? ''));
  const head = [
    `Third-party notices for pelican-cc ${version}`,
    '',
    wrap('Pelican is under the MIT License (LICENSE). Its server, dist/server/index.js, and its web app, dist/web, are built with the packages below in them, each under its own license, whose text follows its name. The Agent SDK is not among them: npm installs it as a package of its own, with its license.'),
    ...(offered.length > 0 ? [
      '',
      wrap(`Of them, ${offered.map((pkg) => `${pkg.name} ${pkg.version} (${pkg.license})`).join(', ')} ${offered.length === 1 ? 'is' : 'are'} under a license that asks for its source code to be offered: it is the npm package of that name and version, as its section says.`),
    ] : []),
  ];
  return `${head.join('\n')}\n\n${packages.map((pkg) => `${rule}\n${section(pkg, where.get(pkg.folder))}`).join('\n')}`;
}

/** The packages (folders) the notices do not name with their version and license: none, when they are complete. */
export function missing(text, folders) {
  return folders.map(readPackage).filter((pkg) => !text.includes(`\n${headingOf(pkg)}`)).map((pkg) => `${pkg.name} ${pkg.version}`);
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
