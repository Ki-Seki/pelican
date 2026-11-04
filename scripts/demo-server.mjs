// `pelican --demo` for the scripts that record it (site, screenshots, video): built app, a port of
// its own, and fresh config and state folders, so nothing of this machine's Pelican is read or
// written. Waits until this very demo answers, and fails rather than waiting forever.
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Pelican's page marks its requests; the server refuses API requests without the mark. */
export const MARK = { 'X-Pelican': '1' };

export async function startDemo({ port, name = 'laptop' }) {
  const base = `http://127.0.0.1:${port}/`;
  const ask = (url) => fetch(url, { headers: MARK, signal: AbortSignal.timeout(1500) });
  // Something already on the port (an earlier demo left running) would be recorded instead.
  if (await ask(`${base}api/info`).then(() => true, () => false)) {
    throw new Error(`Port ${port} is taken; stop what runs there (an earlier demo?) and try again`);
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'pelican-demo-'));
  const server = spawn(process.execPath, ['dist/server/index.js', '--demo', '--name', name, '--port', String(port)], {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, PELICAN_CONFIG_DIR: path.join(root, 'config'), PELICAN_STATE_DIR: path.join(root, 'state'), PELICAN_HOST: '127.0.0.1' },
  });
  let exited = false;
  server.on('exit', () => { exited = true; });
  const stop = () => {
    server.kill();
    rmSync(root, { recursive: true, force: true });
  };
  process.on('exit', stop);
  try {
    for (let i = 0; ; i += 1) {
      if (exited) throw new Error('The demo server stopped (is the app built? run `npm run build`)');
      const info = await ask(`${base}api/info`).then((r) => (r.ok ? r.json() : undefined), () => undefined);
      // The port was free before it started, and it exits if it cannot listen: this is ours.
      if (info?.demo === true && info.machine === name) break;
      if (i > 75) throw new Error(`The demo server did not answer on ${base}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  } catch (error) {
    stop();
    throw error;
  }
  return { base, stop: async () => stop() };
}
