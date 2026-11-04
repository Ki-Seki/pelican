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

const list = (value: string | undefined) => (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export type AuthMode = 'auto' | 'none';

/**
 * Settings from the environment; the command line (`cli.ts`) overrides some of
 * them before the server starts.
 */
export const config = {
  host: process.env.PELICAN_HOST ?? '127.0.0.1',
  port: Number(process.env.PELICAN_PORT ?? 7860),
  /** Name shown in the app, for telling machines apart. */
  machine: process.env.PELICAN_MACHINE ?? (os.hostname().split('.')[0] || 'local'),
  home,
  claudeHome: process.env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'),
  /** The password hash lives here. */
  configDir: process.env.PELICAN_CONFIG_DIR ?? path.join(home, '.config', 'pelican'),
  /** Uploads, push keys and subscriptions. */
  stateDir: process.env.PELICAN_STATE_DIR ?? path.join(home, '.local', 'state', 'pelican'),
  webDir: findWebDir(),
  /**
   * auto: sign in with the password when one is set (`pelican password`), else
   * with the access token in the link Pelican prints. none: no sign-in, for
   * when something in front already authenticates (a proxy, a gateway).
   */
  auth: (process.env.PELICAN_AUTH === 'none' ? 'none' : 'auto') as AuthMode,
  /** Origins, besides the page's own, allowed to send requests (for example a proxy's public URL). */
  allowedOrigins: list(process.env.PELICAN_ALLOWED_ORIGINS),
  /** Host names the server answers to, besides this machine's own names and addresses (and *.ts.net). */
  allowedHosts: list(process.env.PELICAN_ALLOWED_HOSTS),
  /**
   * A proxy on this machine (Tailscale, Caddy, nginx) sets X-Forwarded-For truthfully: limit sign-in
   * attempts by the client it names. Off by default, since anyone can write that header.
   */
  trustedProxy: process.env.PELICAN_TRUSTED_PROXY === '1',
  /** Pages, besides Pelican's own origin, that may show Pelican in a frame (space or comma separated). */
  frameAncestors: (process.env.PELICAN_FRAME_ANCESTORS ?? '').split(/[\s,]+/).filter(Boolean),
  /** Where a tapped notification opens a session; `{id}` is replaced. Default: the page that subscribed. */
  sessionUrl: process.env.PELICAN_SESSION_URL || undefined,
  /** A Claude process with nothing to do is closed after this long; the next message resumes the session. */
  idleCloseMs: Number(process.env.PELICAN_IDLE_CLOSE_MS ?? 30 * 60 * 1000),
  /** A transcript written by someone else this recently counts as live. */
  liveWindowMs: 45_000,
  claudeExecutable: process.env.PELICAN_CLAUDE_PATH || undefined,
  /** Demo mode: made-up sessions, nothing runs. */
  demo: false,
};

export type Config = typeof config;
