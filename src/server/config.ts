import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const home = os.homedir();

/** Directory of the built web app: next to the bundled server, or `dist/web` when run from source. */
function findWebDir(): string | undefined {
  for (const candidate of [path.join(here, '../web'), path.join(here, '../../dist/web')]) {
    if (existsSync(path.join(candidate, 'index.html'))) return candidate;
  }
  return undefined;
}

export const config = {
  host: process.env.PELICAN_HOST ?? '127.0.0.1',
  port: Number(process.env.PELICAN_PORT ?? 7860),
  /** Name shown in the app, for telling machines apart. */
  machine: process.env.PELICAN_MACHINE ?? os.hostname().split('.')[0] ?? 'local',
  home,
  claudeHome: process.env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'),
  stateDir: process.env.PELICAN_STATE_DIR ?? path.join(home, '.local/state/pelican'),
  webDir: findWebDir(),
  /** Extra origins allowed to open the WebSocket and send requests, besides the page's own. */
  allowedOrigins: (process.env.PELICAN_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  /** A Claude process with nothing to do is closed after this long; resuming starts a new one. */
  idleCloseMs: Number(process.env.PELICAN_IDLE_CLOSE_MS ?? 30 * 60 * 1000),
  /** A transcript written by someone else this recently counts as live. */
  liveWindowMs: 45_000,
  claudeExecutable: process.env.PELICAN_CLAUDE_PATH || undefined,
};

export type Config = typeof config;
