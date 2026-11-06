// Bundles the server into one ESM file, with the packages it uses built in, as CI tested them; the
// web app is built separately by Vite. Only the Agent SDK stays a package npm installs: it finds
// the Claude Code it runs in its platform's package, of which npm installs this computer's alone.
// (From a package that pins its tree with npm-shrinkwrap.json, npm installs every platform's: 2.6 GB.)
import { realpathSync } from 'node:fs';
import { chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

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

if (isMain()) {
  const outfile = 'dist/server/index.js';
  await build({ ...serverBuild, outfile, sourcemap: true, logLevel: 'info' });
  await chmod(outfile, 0o755);
}
