// Bundles the server into one ESM file. Runtime dependencies stay external and are installed from
// package.json, and so does the terminal's PTY (@lydell/node-pty, an optional dependency loaded on
// first use); the web app is built separately by Vite. The terminal's copy of the screen
// (@xterm/headless and its serialize addon) is bundled in: development dependencies, so an install
// does not grow by them.
import { chmod } from 'node:fs/promises';

import { build } from 'esbuild';

const BUNDLED = /^@xterm\//;

const outfile = 'dist/server/index.js';
await build({
  entryPoints: ['src/server/cli.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  plugins: [{
    name: 'packages-external',
    setup(pluginBuild) {
      // Every package import, Node's own modules included, but those bundled in.
      pluginBuild.onResolve({ filter: /^[^./]/ }, (args) => (BUNDLED.test(args.path) ? undefined : { path: args.path, external: true }));
    },
  }],
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
});
await chmod(outfile, 0o755);
