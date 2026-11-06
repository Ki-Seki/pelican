// Checks that the terminal's PTY is Microsoft's node-pty: every file @lydell/node-pty's platform
// packages ship (the native module, spawn-helper and the JavaScript that loads them), for every
// platform as npm-shrinkwrap.json pins them and as npm installed them here, is byte for byte the
// file at the same place in Microsoft's node-pty package of the same version, whose tarball is
// checked against the integrity the npm registry publishes for it. What is @lydell's own (each
// package's manifest, readme and license, and the few lines of @lydell/node-pty that pick the
// platform's package) is pinned by npm-shrinkwrap.json, which npm checks as it installs.
//   node scripts/pty-binaries.mjs
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readTar } from './upstream-report.mjs';

export const PACKAGE = '@lydell/node-pty';
const UPSTREAM = 'node-pty';
const REGISTRY = 'https://registry.npmjs.org';

/** A platform package's files that are its own, not Microsoft's. */
const OWN = new Set(['package.json', 'README.md', 'LICENSE']);

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/**
 * Whether `data` is what an npm integrity string says it is (`sha512-<base64>`, perhaps several).
 * @param {Buffer} data
 * @param {string} integrity
 */
export function intact(data, integrity) {
  const sums = String(integrity ?? '').split(/\s+/).filter(Boolean).map((sum) => sum.split('-'));
  const strong = sums.filter(([algorithm]) => algorithm === 'sha512');
  return strong.length > 0 && strong.every(([, digest]) => createHash('sha512').update(data).digest('base64') === digest);
}

/**
 * What a platform package's files (by their paths in it) have that Microsoft's package (its
 * tarball's files, `package/<path>`) has not, byte for byte. A package with no native module in it
 * is a problem too: there would be nothing to compare.
 * @param {Map<string, Buffer>} files
 * @param {Map<string, Buffer>} microsoft
 * @param {string} label
 * @returns {{ problems: string[], checked: string[] }}
 */
export function compare(files, microsoft, label) {
  const problems = [];
  const checked = [];
  for (const [name, data] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    if (OWN.has(name)) continue;
    const theirs = microsoft.get(`package/${name}`);
    if (!theirs) problems.push(`${label}: ${name} is not in Microsoft's package`);
    else if (sha256(theirs) !== sha256(data)) problems.push(`${label}: ${name} is not Microsoft's (sha256 ${sha256(data)}, Microsoft's ${sha256(theirs)})`);
    else checked.push(name);
  }
  if (!checked.some((name) => name.endsWith('.node'))) problems.push(`${label}: no native module that is Microsoft's`);
  return { problems, checked };
}

/**
 * The PTY's version, exactly pinned in package.json, and the platform packages npm-shrinkwrap.json
 * pins for it, with where npm fetches them and their integrity.
 * @param {Record<string, any>} manifest
 * @param {Record<string, any>} shrinkwrap
 */
export function pinned(manifest, shrinkwrap) {
  const version = manifest.optionalDependencies?.[PACKAGE];
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version ?? '')) throw new Error(`${PACKAGE} is not pinned to one version in package.json: ${version}`);
  const main = shrinkwrap.packages?.[`node_modules/${PACKAGE}`];
  if (main?.version !== version) throw new Error(`npm-shrinkwrap.json pins ${PACKAGE} ${main?.version}, package.json ${version}`);
  const platforms = Object.keys(main.optionalDependencies ?? {}).map((name) => {
    const entry = shrinkwrap.packages[`node_modules/${name}`];
    if (!entry?.resolved || !entry.integrity || entry.version !== version) throw new Error(`npm-shrinkwrap.json does not pin ${name} ${version}`);
    return { name, platform: name.slice(PACKAGE.length + 1), resolved: entry.resolved, integrity: entry.integrity };
  });
  if (platforms.length === 0) throw new Error(`npm-shrinkwrap.json names no platform package of ${PACKAGE}`);
  return { version, platforms };
}

/** A tarball's files under `package/`, by their paths in the package. */
const packageFiles = (files) => new Map([...files].filter(([name]) => name.startsWith('package/')).map(([name, data]) => [name.slice('package/'.length), data]));

/** The files of a folder and those under it, by their paths in it. */
async function folderFiles(dir) {
  const files = new Map();
  const walk = async (at) => {
    for (const entry of await readdir(path.join(dir, at), { withFileTypes: true })) {
      const name = at ? `${at}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) files.set(name, await readFile(path.join(dir, name)));
    }
  };
  await walk('');
  return files;
}

async function download(url, integrity) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (!intact(data, integrity)) throw new Error(`${url} is not what its integrity says`);
  return data;
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const json = async (file) => JSON.parse(await readFile(path.join(root, file), 'utf8'));
  const { version, platforms } = pinned(await json('package.json'), await json('npm-shrinkwrap.json'));

  const packument = await (await fetch(`${REGISTRY}/${UPSTREAM}/${version}`, { signal: AbortSignal.timeout(60_000) })).json();
  if (packument.version !== version || !packument.dist?.tarball || !packument.dist.integrity) throw new Error(`The registry has no ${UPSTREAM} ${version}`);
  const microsoft = readTar(await download(packument.dist.tarball, packument.dist.integrity));
  console.log(`${UPSTREAM} ${version}, Microsoft's: ${packument.dist.integrity.slice(0, 31)}…`);

  const problems = [];
  const report = (label, result) => {
    problems.push(...result.problems);
    if (result.problems.length === 0) console.log(`  ${label}: ${result.checked.length} files are Microsoft's (${result.checked.filter((name) => !name.endsWith('.js')).join(', ')})`);
  };
  for (const { name, platform, resolved, integrity } of platforms) {
    report(`${name} as pinned`, compare(packageFiles(readTar(await download(resolved, integrity))), microsoft, `${name} as pinned`));
  }
  // What npm installed here, the copy the terminal loads.
  const here = path.join(root, 'node_modules', `${PACKAGE}-${process.platform}-${process.arch}`);
  const installed = await folderFiles(here).catch(() => undefined);
  if (installed) report(`${PACKAGE}-${process.platform}-${process.arch} as installed`, compare(installed, microsoft, 'as installed'));
  else console.log(`  Nothing installed for ${process.platform}-${process.arch}.`);

  if (problems.length > 0) throw new Error(`\n${problems.join('\n')}`);
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
  main().catch((error) => {
    console.error(`pty-binaries: ${error.message}`);
    process.exitCode = 1;
  });
}
