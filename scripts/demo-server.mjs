// `pelican --demo` for the scripts that record it (site, screenshots, video): built app, a port of
// its own, and fresh config and state folders, so nothing of this machine's Pelican is read or
// written. Waits until the demo answers, and fails rather than waiting forever.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Pelican's page marks its requests; the server refuses API requests without the mark. */
export const MARK = { 'X-Pelican': '1' };

export async function startDemo({ port, name = 'laptop' }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pelican-demo-'));
  const server = spawn(process.execPath, ['dist/server/index.js', '--demo', '--name', name, '--port', String(port)], {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, PELICAN_CONFIG_DIR: path.join(root, 'config'), PELICAN_STATE_DIR: path.join(root, 'state'), PELICAN_HOST: '127.0.0.1' },
  });
  let exited = false;
  server.on('exit', () => { exited = true; });
  const stop = async () => {
    server.kill();
    await rm(root, { recursive: true, force: true });
  };
  process.on('exit', () => server.kill());
  const base = `http://127.0.0.1:${port}/`;
  for (let i = 0; ; i += 1) {
    if (exited) throw new Error('The demo server stopped (is the app built? run `npm run build`)');
    try {
      const response = await fetch(`${base}api/info`, { headers: MARK });
      if (response.ok && (await response.json()).demo === true) break;
    } catch {
      // Not listening yet.
    }
    if (i > 75) {
      await stop();
      throw new Error(`The demo server did not answer on ${base}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return { base, stop };
}
