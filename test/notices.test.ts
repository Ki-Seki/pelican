// THIRD_PARTY_NOTICES, as `npm run build` writes it: every package built into the server and the
// web app is in it, with its version, its license and the license's text, and the source of what
// is under the MPL is said. Each bundle is built here as the build builds it.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { mappedPackages, serverAdapted, serverBuild, serverFiles, serverHelpers, serverPackages } from '../scripts/build-server.mjs';
import { missing, notices, packageFolder, packagesOf, readPackage } from '../scripts/notices.mjs';

const root = path.resolve(import.meta.dirname, '..');
let dir: string;
let server: string[];
let mapped: string[];
let web: string[];
let helpers: string[];
let adapted: Array<{ folder: string; file: string }>;
let files: string[];

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'pelican-notices-'));
  const outfile = path.join(dir, 'server', 'index.js');
  const { metafile } = await esbuild({ ...serverBuild, absWorkingDir: root, outfile, sourcemap: true, metafile: true, logLevel: 'silent' });
  server = serverPackages(metafile, outfile, root);
  mapped = await mappedPackages(`${outfile}.map`);
  helpers = await serverHelpers(outfile, root);
  adapted = await serverAdapted(root);
  await viteBuild({ configFile: path.join(root, 'vite.config.ts'), logLevel: 'silent', build: { outDir: path.join(dir, 'web'), emptyOutDir: true } });
  const built = JSON.parse(await readFile(path.join(dir, '.third-party-web.json'), 'utf8')) as { folders: string[]; files: string[] };
  web = built.folders;
  files = [...serverFiles(metafile, outfile, root), ...built.files];
}, 180_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const names = (folders: string[]) => folders.map((folder) => readPackage(folder).name);

describe('the packages built in', () => {
  it('are found by the folder of each file built in', () => {
    expect(packageFolder('/x/node_modules/a/node_modules/@b/c/lib/d.js')).toBe('/x/node_modules/a/node_modules/@b/c');
    expect(packageFolder('/x/node_modules/hono/dist/index.js')).toBe('/x/node_modules/hono');
    expect(packageFolder('/x/src/server/app.ts')).toBeUndefined();
    expect(packagesOf(['/n/node_modules/b/x.js', '/n/node_modules/a/y.js', '/n/node_modules/b/z.js', '/p/src/c.ts'])).toEqual(['/n/node_modules/a', '/n/node_modules/b']);
  });

  it('in the server, by its metafile, are those its source map names', () => {
    expect(server).toEqual(mapped);
    expect(names(server)).toEqual(expect.arrayContaining(['hono', '@hono/node-server', 'ws', 'web-push', 'qrcode-generator', 'jws', 'ecdsa-sig-formatter', 'buffer-equal-constant-time', '@xterm/headless', '@xterm/addon-unicode11']));
    // npm installs these as packages of their own, the terminal's PTY loaded only when a terminal starts.
    expect(names(server)).not.toContain('@anthropic-ai/claude-agent-sdk');
    expect(names(server).filter((name) => name.startsWith('@lydell/'))).toEqual([]);
  });

  it('in the web app take in what Vite and Rolldown add, and the stylesheet Tailwind makes', () => {
    expect(names(web)).toEqual(expect.arrayContaining(['react', 'react-dom', 'scheduler', 'react-markdown', 'highlight.js', 'lucide-react', 'qrcode-generator', 'tailwindcss', 'vite', 'rolldown']));
    // The terminal's screen, in a chunk of its own that only its tab loads.
    expect(names(web)).toEqual(expect.arrayContaining(['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-unicode11', '@xterm/addon-web-links']));
  });
});

describe('THIRD_PARTY_NOTICES', () => {
  let text: string;
  beforeAll(() => {
    text = notices({ version: '0.0.0', server, web, helpers, adapted, files });
  });
  const sectionOf = (name: string) => {
    const at = text.indexOf(`\n${name} `);
    return text.slice(at, text.indexOf('='.repeat(80), at));
  };

  it('credits esbuild for the helper code it writes into the server, which no source map names', () => {
    expect(names(helpers)).toEqual(['esbuild']);
    const esbuild = sectionOf('esbuild');
    expect(esbuild).toMatch(/Built into: the server \(dist\/server\/index\.js\), as the helper code it writes into what it bundles/);
    expect(esbuild).toContain('Copyright (c) 2020 Evan Wallace');
  });

  it('gives what rolldown takes from others, as its runtime is in the web app: its THIRD-PARTY-LICENSE', () => {
    const rolldown = sectionOf('rolldown');
    expect(rolldown).toContain('THIRD-PARTY-LICENSE:');
    expect(rolldown).toContain('[these people](https://github.com/rollup/rollup/graphs/contributors)');
  });

  it('keeps the notices of others that a file built in carries at its top, which minifying leaves out: vfile’s path-browserify', () => {
    const vfile = sectionOf('vfile');
    expect(vfile).toContain('lib/minpath.browser.js:');
    expect(vfile).toContain('Copyright (c) 2013 James Halliday');
    expect(vfile).toContain('Copyright Joyent, Inc. and other Node contributors.');
    // A file's notice that only points to the package's own license is not repeated.
    expect(sectionOf('react')).not.toContain('Notices of others');
  });

  it('credits the xterm.js authors for each of their packages: xterm’s headless one by its project’s license, and the serializer the terminal’s copy of the screen adapts', () => {
    const headless = sectionOf('@xterm/headless');
    expect(headless).toMatch(/Built into: the server \(dist\/server\/index\.js\)/);
    expect(headless).toMatch(/LICENSE \(its project's, as @xterm\/xterm [\d.]+ ships it\):/);
    expect(headless).toContain('The xterm.js authors');
    expect(adapted.map(({ folder, file }) => [readPackage(folder).name, file])).toEqual([['@xterm/addon-serialize', 'src/server/terminal-snapshot.ts']]);
    const serializer = sectionOf('@xterm/addon-serialize');
    expect(serializer).toContain('Built into: the server (dist/server/index.js), as the code src/server/terminal-snapshot.ts adapts from it');
    expect(serializer).toContain('The xterm.js authors');
    for (const name of ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-unicode11', '@xterm/addon-web-links']) expect(sectionOf(name), name).toMatch(/Permission is hereby granted/);
  });

  it('names each package built in, with its version, license and the license in full', () => {
    expect(missing(text, [...new Set([...server, ...mapped, ...web, ...adapted.map((each) => each.folder)])])).toEqual([]);
    for (const folder of [...server, ...web, ...adapted.map((each) => each.folder)]) {
      const { name, version, license } = readPackage(folder);
      const at = text.indexOf(`\n${name} ${version}\nLicense: ${license}\n`);
      expect(at, name).toBeGreaterThan(0);
      const next = text.indexOf('='.repeat(80), at);
      const section = text.slice(at, next < 0 ? undefined : next);
      expect(section, name).toMatch(/permission|licen[cs]e|copyright/i);
      expect(section.length, name).toBeGreaterThan(200);
    }
  });

  it('says that the MPL’s source is the npm package, and gives the MPL in full', () => {
    const at = text.indexOf('\nweb-push ');
    const section = text.slice(at, text.indexOf('='.repeat(80), at));
    expect(section).toContain('License: MPL-2.0');
    expect(section.replace(/\s+/g, ' ')).toMatch(/its source code, of which Pelican builds the files it uses into the server \(dist\/server\/index\.js\) unchanged, is its npm package, web-push \d/);
    expect(section).toMatch(/https:\/\/registry\.npmjs\.org\/web-push\/-\/web-push-\d[\w.-]*\.tgz/);
    expect(section).toContain('Mozilla Public License Version 2.0');
    expect(section).toContain('Exhibit B - "Incompatible With Secondary Licenses" Notice');
  });

  it('gives the MIT License with the copyright line of a package that comes with no license file', () => {
    const qr = text.slice(text.indexOf('\nqrcode-generator '));
    expect(qr).toMatch(/^\nqrcode-generator [\d.]+\nLicense: MIT\nBuilt into: the server \(dist\/server\/index\.js\) and the web app \(dist\/web\)/);
    expect(qr).toContain('Copyright (c) 2009 Kazuhiko Arase\n\nPermission is hereby granted');
  });

  it('is found to leave out a package that is built in but not named', () => {
    const left = server.find((folder) => readPackage(folder).name === 'web-push')!;
    const without = notices({ version: '0.0.0', server: server.filter((folder) => folder !== left), web });
    expect(missing(without, server)).toEqual([`web-push ${readPackage(left).version}`]);
  });

  it('is in the package npm publishes', async () => {
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { files: string[] };
    expect(manifest.files).toContain('THIRD_PARTY_NOTICES');
  });
});
