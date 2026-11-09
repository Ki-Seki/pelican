// Bundles the server into one ESM file, with the packages it uses built in, as CI tested them, the
// terminal's copy of the screen (@xterm/headless, with Unicode 11's widths) among them; the web app
// is built separately by Vite. Two stay out. The terminal's PTY (@lydell/node-pty, an optional
// dependency loaded on first use) is a package npm installs, which finds its native module in its
// platform's package, of which npm installs this computer's alone. (From a package that pins its
// tree with npm-shrinkwrap.json, npm installs every platform's: 2.6 GB.) And Anthropic's Agent SDK,
// whose license lets no one else ship its code: the server loads Anthropic's own package, which it
// fetches from npm the first time it runs (src/server/agent-sdk.ts). Only its version, and the
// Claude Code version it was released with, are written in.
import { readFileSync, realpathSync } from 'node:fs';
import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

import { ADAPTED, hasEsbuildRuntime, missing, NOTICES, notices, packageFolder, packagesOf, WEB_PACKAGES } from './notices.mjs';

/**
 * xterm's packages carry source maps of their own, which name their sources as xterm's build saw
 * them (webpack://…), not where they are: read without them, the server's source map names the
 * files built in, as it does every other package's, and so accounts for them as its metafile does.
 * @type {import('esbuild').Plugin}
 */
const filesAsBuiltIn = {
  name: 'files-as-built-in',
  setup(pluginBuild) {
    pluginBuild.onLoad({ filter: /[\\/]node_modules[\\/]@xterm[\\/].*\.[cm]?js$/ }, async (args) => ({
      contents: (await readFile(args.path, 'utf8')).replace(/\n\/\/# sourceMappingURL=\S+\s*$/, '\n'),
      loader: 'js',
    }));
  },
};

/**
 * The Agent SDK npm installed here, which must be the version package.json pins: what the server
 * says it was tested with (the Claude Code that SDK was released with) before it loads its own copy.
 */
export function agentSdk() {
  const require = createRequire(import.meta.url);
  const manifest = JSON.parse(readFileSync(path.join(path.dirname(require.resolve('@anthropic-ai/claude-agent-sdk')), 'package.json'), 'utf8'));
  const pinned = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).devDependencies?.['@anthropic-ai/claude-agent-sdk'];
  if (manifest.version !== pinned) throw new Error(`npm installed Agent SDK ${manifest.version} here, package.json pins ${pinned}: run npm ci`);
  return { version: manifest.version, claudeCodeVersion: manifest.claudeCodeVersion };
}

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
  external: ['@anthropic-ai/claude-agent-sdk', '@lydell/node-pty'],
  // As strings, which esbuild writes in where they are used.
  define: Object.fromEntries(Object.entries(agentSdk()).map(([key, value]) => [`PELICAN_SDK_${key === 'version' ? 'VERSION' : 'CLAUDE_CODE'}`, JSON.stringify(value)])),
  plugins: [filesAsBuiltIn],
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
 * The packages whose code a file of Pelican's own adapts (ADAPTED), in the working folder's
 * node_modules, with that file, which must still say so: their code is in the server too.
 */
export const serverAdapted = async (cwd = process.cwd()) => Promise.all(ADAPTED.map(async ({ name, file }) => {
  if (!(await readFile(path.resolve(cwd, file), 'utf8')).includes(name)) throw new Error(`${file} no longer names ${name}, which scripts/notices.mjs says it adapts`);
  return { folder: path.join(cwd, 'node_modules', name), file };
}));

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
  const adapted = await serverAdapted();
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  const text = notices({ version, server, web, helpers, adapted, files: [...serverFiles(metafile, outfile), ...webIn] });
  // Each package built in is in it: by the metafile, by the bundle's source map, by the web app's
  // modules, esbuild's runtime, and the code adapted from others.
  const left = missing(text, [...new Set([...server, ...(await mappedPackages(`${outfile}.map`)), ...web, ...helpers, ...adapted.map((each) => each.folder)])]);
  if (left.length > 0) throw new Error(`${NOTICES} leaves out ${left.join(', ')}`);
  await writeFile(NOTICES, text);
  await rm(WEB_PACKAGES);
  console.log(`${NOTICES}: ${server.length + helpers.length + adapted.length} packages in the server, ${web.length} in the web app`);
}
