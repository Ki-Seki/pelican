import { realpathSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

import { WEB_PACKAGES, webPackages } from './scripts/notices.mjs';

const backend = `http://127.0.0.1:${process.env.PELICAN_PORT ?? '7860'}`;

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

/**
 * Writes `.br` and `.gz` copies next to the built files that compress, for the server to send to
 * browsers that take them: Tailscale Serve and SSH tunnels, the usual ways in from a phone, pass
 * files on as they are. Done once here, at the highest settings, rather than on every request.
 * Not for the project site's demo, whose host compresses on its own.
 */
function precompress(): Plugin {
  let outDir = '';
  let skip = false;
  return {
    name: 'pelican-precompress',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
      skip = config.mode === 'static-demo';
    },
    async closeBundle() {
      if (skip) return;
      const files = (await readdir(outDir, { recursive: true }))
        .filter((name) => /\.(js|css|html|svg|json|webmanifest|txt)$/.test(name))
        .map((name) => path.join(outDir, name));
      await Promise.all(files.map(async (file) => {
        const data = await readFile(file);
        if (data.length < 1024) return;
        const [br, gz] = await Promise.all([
          brotli(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length } }),
          gzip(data, { level: 9 }),
        ]);
        // A copy that saves little is not worth a second file.
        if (br.length < data.length * 0.9) await writeFile(`${file}.br`, br);
        if (gz.length < data.length * 0.9) await writeFile(`${file}.gz`, gz);
      }));
    },
  };
}

/**
 * Notes the packages built into the web app, for scripts/build-server.mjs to write
 * THIRD_PARTY_NOTICES with: next to the app, not in it, as WEB_PACKAGES. Not for the project
 * site's demo, which ships no package.
 */
function thirdParty(): Plugin {
  let root = '';
  let outDir = '';
  let skip = false;
  return {
    name: 'pelican-third-party',
    apply: 'build',
    configResolved(config) {
      root = fileURLToPath(new URL('.', import.meta.url));
      outDir = path.resolve(config.root, config.build.outDir);
      skip = config.mode === 'static-demo';
    },
    async generateBundle(_options, bundle) {
      if (skip) return;
      const folders = webPackages(bundle, (name: string) => realpathSync(path.join(root, 'node_modules', name)));
      // Beside the app's folder: in dist/ for `npm run build`, where the server's build reads it.
      const listed = path.resolve(outDir, '..', path.basename(WEB_PACKAGES));
      await writeFile(listed, `${JSON.stringify(folders, null, 2)}\n`);
    },
  };
}

/**
 * Code in replies is highlighted in the languages of src/web/lib/languages.ts, in place of
 * lowlight's own `common` set, which rehype-highlight bundles even when given others.
 */
function highlightLanguages(): Plugin {
  const languages = fileURLToPath(new URL('./src/web/lib/languages.ts', import.meta.url));
  return {
    name: 'pelican-highlight-languages',
    enforce: 'pre',
    resolveId(source, importer) {
      return source === './lib/common.js' && importer && /[\\/]lowlight[\\/]index\.js$/.test(importer) ? languages : null;
    },
  };
}

export default defineConfig({
  root: 'src/web',
  // Every URL is relative: the app works at `/` and under any path prefix a
  // reverse proxy mounts it at, without being told which.
  base: './',
  publicDir: '../../public',
  plugins: [react(), tailwindcss(), highlightLanguages(), precompress(), thirdParty()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    target: 'es2022',
    rolldownOptions: {
      output: {
        // What the session list needs comes in one file. Left to itself, Rolldown moves what the
        // list shares with a part loaded inside a lazily loaded one (the usage page in Settings, the
        // tabs of Changes and files in the conversation) into a second file the list waits for too.
        codeSplitting: { groups: [{ name: 'index', tags: ['$initial'] }] },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: backend, ws: true },
    },
  },
});
