// Bundles the server into one ESM file, with the packages it uses built in, as CI tested them; the
// web app is built separately by Vite. Only the Agent SDK stays a package npm installs: it finds
// the Claude Code it runs in its platform's package, of which npm installs this computer's alone.
// (From a package that pins its tree with npm-shrinkwrap.json, npm installs every platform's: 2.6 GB.)
import { realpathSync } from 'node:fs';
import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

import { hasEsbuildRuntime, missing, NOTICES, notices, packageFolder, packagesOf, WEB_PACKAGES } from './notices.mjs';

/**
 * How the server is built; test/package.test.ts builds it so too.
 * @type {import('esbuild').BuildOptions}
 */
export const serverBuild = {
  entryPoints: ['src/server/cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['@anthropic-ai/claude-agent-sdk'],
  // Packages written for require() (web-push, ws) require Node's own modules: an ES module has
  // no require of its own, so it is given one.
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as createRequireForPackages } from 'node:module';\nconst require = createRequireForPackages(import.meta.url);" },
};

/** Run as a command, not imported by the tests (a path through a symlink, such as macOS's /tmp, counts). */
const isMain = () => {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

/**
 * The packages built into the server, by esbuild's metafile: those of the files with code in
 * the bundle. Paths are the working folder's (node_modules may be a link elsewhere).
 */
export const serverPackages = (metafile, outfile, cwd = process.cwd()) => {
  const output = metafile.outputs[path.relative(cwd, path.resolve(cwd, outfile))] ?? Object.values(metafile.outputs).find((each) => each.entryPoint);
  return packagesOf(Object.entries(output.inputs).filter(([, input]) => input.bytesInOutput > 0).map(([file]) => path.resolve(cwd, file)));
};

/** The files of packages with code in the server, by esbuild's metafile, for the notices of others they carry. */
export const serverFiles = (metafile, outfile, cwd = process.cwd()) => {
  const output = metafile.outputs[path.relative(cwd, path.resolve(cwd, outfile))] ?? Object.values(metafile.outputs).find((each) => each.entryPoint);
  return Object.entries(output.inputs).filter(([, input]) => input.bytesInOutput > 0).map(([file]) => path.resolve(cwd, file)).filter((file) => packageFolder(file));
};

/**
 * esbuild, where it wrote its runtime into the server (hasEsbuildRuntime): its code too, under its
 * license, which neither its metafile nor its source map names. Its folder as the others are, in
 * the working folder's node_modules.
 */
export const serverHelpers = async (outfile, cwd = process.cwd()) => (hasEsbuildRuntime(await readFile(path.resolve(cwd, outfile), 'utf8')) ? [path.join(cwd, 'node_modules', 'esbuild')] : []);

/**
 * The packages a source map names files of: another account of what the bundle holds, which the
 * notices are checked against.
 */
export const mappedPackages = async (map) => {
  const { sources } = JSON.parse(await readFile(map, 'utf8'));
  return packagesOf(sources.map((source) => path.resolve(path.dirname(map), source)));
};

if (isMain()) {
  const outfile = 'dist/server/index.js';
  const { metafile } = await build({ ...serverBuild, outfile, sourcemap: true, metafile: true, logLevel: 'info' });
  await chmod(outfile, 0o755);
  // THIRD_PARTY_NOTICES, of the packages built into the server and the web app, which Vite built first.
  const { folders: web, files: webIn } = JSON.parse(await readFile(WEB_PACKAGES, 'utf8').catch(() => {
    throw new Error(`${WEB_PACKAGES} is missing: build the web app first (npm run build does)`);
  }));
  const server = serverPackages(metafile, outfile);
  const helpers = await serverHelpers(outfile);
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  const text = notices({ version, server, web, helpers, files: [...serverFiles(metafile, outfile), ...webIn] });
  // Each package built in is in it: by the metafile, by the bundle's source map, by the web app's modules, and esbuild's runtime.
  const left = missing(text, [...new Set([...server, ...(await mappedPackages(`${outfile}.map`)), ...web, ...helpers])]);
  if (left.length > 0) throw new Error(`${NOTICES} leaves out ${left.join(', ')}`);
  await writeFile(NOTICES, text);
  await rm(WEB_PACKAGES);
  console.log(`${NOTICES}: ${server.length + helpers.length} packages in the server, ${web.length} in the web app`);
}
