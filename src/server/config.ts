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

/** Settings Pelican could not use, said once at start (cli.ts). */
export const configWarnings: string[] = [];

/**
 * Web origins (`https://host[:port]`), and nothing looser: no `*`, no `null`, no bare scheme,
 * no path. With `wildcardHost`, `https://*.example.com` is allowed too (for frame-ancestors).
 */
function origins(name: string, value: string | undefined, wildcardHost = false): string[] {
  const kept: string[] = [];
  for (const entry of (value ?? '').split(/[\s,]+/).filter(Boolean)) {
    const wildcard = wildcardHost && /^https?:\/\/\*\.[^*]+$/i.test(entry);
    let url: URL | undefined;
    try {
      url = /^https?:\/\//i.test(entry) ? new URL(wildcard ? entry.replace('*.', 'wildcard.') : entry) : undefined;
    } catch {
      url = undefined;
    }
    const origin = url && (wildcard ? url.origin.replace('://wildcard.', '://*.') : url.origin);
    // Host names of letters, digits, dots and dashes (or an IPv6 address): a URL may hold
    // characters such as `;` that would end a header's directive.
    if (url && origin && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password
      && (wildcard ? /^https?:\/\/\*\.[a-z0-9.-]+(:\d+)?$/ : /^https?:\/\/([a-z0-9.-]+|\[[0-9a-f:.]+\])(:\d+)?$/).test(origin)) {
      kept.push(origin);
    } else {
      configWarnings.push(`${name}: ignored "${entry}"; use an origin like https://pelican.example.com`);
    }
  }
  return kept;
}

/**
 * The address phones use to reach Pelican (a tunnel's, a proxy's): an http(s) URL, perhaps under a
 * path, with nothing else in it. It is Pelican's own address, so its origin is allowed too.
 */
function publicUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  let url: URL | undefined;
  try {
    url = new URL(value.trim());
  } catch {
    url = undefined;
  }
  if (url && /^https?:$/.test(url.protocol) && !url.username && !url.password && !url.search && !url.hash
    && /^([a-z0-9.-]+|\[[0-9a-f:.]+\])$/.test(url.hostname)) {
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url.href;
  }
  configWarnings.push(`PELICAN_PUBLIC_URL: ignored "${value}"; use an address like https://laptop.example.ts.net/`);
  return undefined;
}

const publicAddress = publicUrl(process.env.PELICAN_PUBLIC_URL);
const allowedOrigins = origins('PELICAN_ALLOWED_ORIGINS', process.env.PELICAN_ALLOWED_ORIGINS);
if (publicAddress && !allowedOrigins.includes(new URL(publicAddress).origin)) allowedOrigins.push(new URL(publicAddress).origin);

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
  allowedOrigins,
  /** The address phones use, when it is not this computer's own (PELICAN_PUBLIC_URL). */
  publicUrl: publicAddress,
  /** Host names the server answers to, besides this machine's own names and addresses (and *.ts.net). */
  allowedHosts: list(process.env.PELICAN_ALLOWED_HOSTS),
  /**
   * A proxy on this machine (Tailscale, Caddy, nginx) sets X-Forwarded-For truthfully: limit sign-in
   * attempts by the client it names. Off by default, since anyone can write that header.
   */
  trustedProxy: process.env.PELICAN_TRUSTED_PROXY === '1',
  /** Pages, besides Pelican's own origin, that may show Pelican in a frame (space or comma separated). */
  frameAncestors: origins('PELICAN_FRAME_ANCESTORS', process.env.PELICAN_FRAME_ANCESTORS, true),
  /** Where a tapped notification opens a session; `{id}` is replaced. Default: the page that subscribed. */
  sessionUrl: process.env.PELICAN_SESSION_URL || undefined,
  /** A Claude process with nothing to do is closed after this long; the next message resumes the session. */
  idleCloseMs: Number(process.env.PELICAN_IDLE_CLOSE_MS ?? 30 * 60 * 1000),
  /** A transcript written by someone else this recently counts as live. */
  liveWindowMs: 45_000,
  claudeExecutable: process.env.PELICAN_CLAUDE_PATH || undefined,
  /** Keep the computer from sleeping while Claude works; PELICAN_KEEP_AWAKE=0 turns it off. */
  keepAwake: process.env.PELICAN_KEEP_AWAKE !== '0',
  /** Demo mode: made-up sessions, nothing runs. */
  demo: false,
};

export type Config = typeof config;
