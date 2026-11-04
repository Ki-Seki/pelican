// Bundles the server into one ESM file. Runtime dependencies stay external and
// are installed from package.json; the web app is built separately by Vite.
import { chmod } from 'node:fs/promises';

import { build } from 'esbuild';

const outfile = 'dist/server/index.js';
await build({
  entryPoints: ['src/server/cli.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
});
await chmod(outfile, 0o755);
