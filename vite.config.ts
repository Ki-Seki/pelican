import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

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
  plugins: [react(), tailwindcss(), highlightLanguages(), precompress()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    target: 'es2022',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: backend, ws: true },
    },
  },
});
