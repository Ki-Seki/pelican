import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';

import { config } from './config.js';
import { qrTerminal } from './qr.js';
import { isLoopback, listensLocally } from './security.js';

/**
 * Getting onto the phone: the address a phone uses to reach this Pelican, and a QR code for it that
 * carries a one-time sign-in code (never the access token), good once and for two minutes.
 */

export type PhoneAddress = {
  url: string;
  /** Where the address came from, said when it is shown. */
  from: string;
  /** Tailscale Funnel: the address is open to the whole internet, not just your tailnet. */
  funnel?: boolean;
};

/** What a phone could use, or what is known that helps set one up. */
export type PhoneSearch = { address?: PhoneAddress; tailscale?: { cli: string; name?: string } };

/** A read-only command's output; undefined when it is missing, fails or takes too long. */
function read(file: string, args: string[], timeout = 3000): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => resolve(error ? undefined : String(stdout)));
  });
}

const json = (text: string | undefined): Record<string, unknown> | undefined => {
  try {
    const value = text ? JSON.parse(text) as unknown : undefined;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
};

/** Tailscale's command line: on PATH, or inside the macOS app, which does not put it there. */
async function tailscaleCli(): Promise<string | undefined> {
  if (await read('tailscale', ['version'])) return 'tailscale';
  const app = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
  if (process.platform === 'darwin' && existsSync(app) && (await read(app, ['version']))) return app;
  return undefined;
}

/** Whether a serve handler's target is this Pelican: a loopback address on its port. */
function forwardsTo(proxy: unknown, port: number): boolean {
  if (typeof proxy !== 'string' || !proxy) return false;
  const target = /^\d+$/.test(proxy) ? `http://127.0.0.1:${proxy}` : /^[a-z][a-z0-9+.-]*:\/\//i.test(proxy) ? proxy : `http://${proxy}`;
  try {
    const url = new URL(target);
    const targetPort = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    return targetPort === port && (isLoopback(url.hostname) || url.hostname === '[::1]');
  } catch {
    return false;
  }
}

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});

/**
 * The address `tailscale serve` gives this Pelican, from its config (`tailscale serve status
 * --json`): a name of this tailnet whose handler forwards to Pelican's port.
 */
export function servedAddress(serve: unknown, port: number): PhoneAddress | undefined {
  const configs = [record(serve), ...Object.values(record(record(serve).Foreground)).map(record)];
  for (const served of configs) {
    for (const [hostPort, web] of Object.entries(record(served.Web))) {
      for (const [mount, handler] of Object.entries(record(record(web).Handlers))) {
        if (!forwardsTo(record(handler).Proxy, port)) continue;
        const cut = hostPort.lastIndexOf(':');
        const host = cut > 0 ? hostPort.slice(0, cut) : hostPort;
        const webPort = cut > 0 ? hostPort.slice(cut + 1) : '443';
        const tcp = record(record(served.TCP)[webPort]);
        const scheme = tcp.HTTPS === undefined && tcp.HTTP === true ? 'http' : 'https';
        const shown = (scheme === 'https' && webPort === '443') || (scheme === 'http' && webPort === '80') ? '' : `:${webPort}`;
        const path = mount.startsWith('/') ? mount : `/${mount}`;
        return {
          url: `${scheme}://${host}${shown}${path.endsWith('/') ? path : `${path}/`}`,
          from: 'tailscale serve',
          ...(record(served.AllowFunnel)[hostPort] === true ? { funnel: true } : {}),
        };
      }
    }
  }
  return undefined;
}

/** An address as typed: a scheme added when missing (https), a slash at the end. */
export function normalAddress(text: string): string {
  const value = /^[a-z][a-z0-9+.-]*:\/\//i.test(text.trim()) ? text.trim() : `https://${text.trim()}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Not an address: ${text}`);
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error(`Not an address: ${text}`);
  url.search = '';
  url.hash = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}

/** This computer's address on the local network, for a Pelican that listens beyond it. */
function networkAddress(host: string, port: number): string | undefined {
  if (host === '0.0.0.0' || host === '::') {
    const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal);
    return lan ? `http://${lan.address}:${port}/` : undefined;
  }
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}/`;
}

/**
 * The address a phone uses, in this order: the one given, PELICAN_PUBLIC_URL, a `tailscale serve`
 * that forwards to this Pelican, the one origin PELICAN_ALLOWED_ORIGINS names, and the local
 * network's when Pelican listens beyond this computer. Tailscale is only read, never changed.
 */
export async function findPhoneAddress(port: number, host: string, given?: string): Promise<PhoneSearch> {
  if (given) return { address: { url: normalAddress(given), from: 'the address given' } };
  if (config.publicUrl) return { address: { url: config.publicUrl, from: 'PELICAN_PUBLIC_URL' } };
  const cli = await tailscaleCli();
  if (cli) {
    const address = servedAddress(json(await read(cli, ['serve', 'status', '--json'])), port);
    if (address) return { address };
  }
  if (config.allowedOrigins.length === 1) return { address: { url: `${config.allowedOrigins[0]}/`, from: 'PELICAN_ALLOWED_ORIGINS' } };
  if (!listensLocally(host)) {
    const url = networkAddress(host, port);
    if (url) return { address: { url, from: 'your network' } };
  }
  if (!cli) return {};
  const status = json(await read(cli, ['status', '--json']));
  const self = record(status?.Self);
  const name = status?.BackendState === 'Running' && typeof self.DNSName === 'string' && self.DNSName ? self.DNSName.replace(/\.$/, '') : undefined;
  return { tailscale: { cli, ...(name ? { name } : {}) } };
}

/** Where Pelican runs, for how Tailscale is set up there: a Mac, Linux, or Linux in WSL on Windows. */
export type Place = 'mac' | 'linux' | 'wsl';

export function placeHere(platform: NodeJS.Platform = process.platform, release = os.release(), env: NodeJS.ProcessEnv = process.env): Place {
  if (platform === 'darwin') return 'mac';
  return env.WSL_DISTRO_NAME || /microsoft/i.test(release) ? 'wsl' : 'linux';
}

/**
 * What to do when no address is known: the one command that makes one where Tailscale is on; how
 * to sign it in where it is installed but not connected; and where it is not installed, how to
 * install it here, as Tailscale's own pages say for this system.
 */
export function setupHint(search: PhoneSearch, port: number, command: string, place: Place = placeHere()): string[] {
  const lines = ['Pelican listens only on this computer, and your phone needs an address that reaches it.'];
  // On Linux, `tailscale serve` is root's unless this account is Tailscale's operator.
  const operator = place === 'mac' ? [] : ['If it says access is denied: `sudo tailscale set --operator=$USER`, then run it again.'];
  if (search.tailscale?.name) {
    lines.push(`Tailscale is on here. This serves Pelican at https://${search.tailscale.name}/ to your tailnet:`);
    lines.push('', `  ${search.tailscale.cli} serve --bg ${port}`, '', ...operator, `Then run \`${command} phone\` again.`);
    return lines;
  }
  if (search.tailscale) {
    lines.push(place === 'mac'
      ? 'Tailscale is installed here but not connected: open the Tailscale app and sign in, with the account your phone uses.'
      : 'Tailscale is installed here but not connected: run `sudo tailscale up` and sign in, with the account your phone uses.');
    lines.push(`Then \`${search.tailscale.cli} serve --bg ${port}\`, and \`${command} phone\` again.`, ...operator);
    return lines;
  }
  lines.push('Tailscale gives it one: install it here and on the phone, signed in to the same account. Here:');
  if (place === 'mac') lines.push('', '  The Tailscale app, from the App Store or https://tailscale.com/download/mac', '');
  else lines.push('', '  curl -fsSL https://tailscale.com/install.sh | sh', '  sudo tailscale up', '');
  // The Mac app puts no `tailscale` on the PATH: once it is in, this command says the one with its path.
  lines.push(place === 'mac'
    ? `On the phone, the Tailscale app from the App Store or Google Play. Then run \`${command} phone\` again: it says the command that serves Pelican.`
    : `On the phone, the Tailscale app from the App Store or Google Play. Then \`tailscale serve --bg ${port}\` here, and \`${command} phone\` again.`, ...operator);
  if (place === 'wsl') {
    lines.push(`Tailscale already on Windows? Use that one alone, as Tailscale advises: \`tailscale serve --bg ${port}\` in PowerShell, then \`${command} phone https://<this PC>.<your tailnet>.ts.net\` here.`);
  }
  lines.push(`Any other address that reaches this computer: \`${command} phone https://…\`.`);
  return lines;
}

/** Who else is on the tailnet: how many devices besides this one, and how many of them are phones. */
export type Tailnet = { others: number; phones: number };

/** Read from `tailscale status --json`, while Tailscale runs here. */
export function tailnetOf(status: Record<string, unknown> | undefined): Tailnet | undefined {
  if (!status || status.BackendState !== 'Running') return undefined;
  const peers = Object.values(record(status.Peer));
  const phones = peers.filter((peer) => /^(android|ios)$/i.test(String(record(peer).OS ?? ''))).length;
  return { others: peers.length, phones };
}

/** Who else is on the tailnet this computer is on, as Tailscale says; nothing where it is not on. */
export async function tailnetHere(): Promise<Tailnet | undefined> {
  const cli = await tailscaleCli();
  return cli ? tailnetOf(json(await read(cli, ['status', '--json']))) : undefined;
}

/**
 * Under a QR code for a Tailscale address: why the phone may not open it yet. An address on a
 * tailnet opens only on the tailnet's devices, so a phone not on it gets nowhere; and a proxy or
 * another VPN on the phone (Clash and the like) takes its requests, which then end in "closed the
 * connection" (ERR_CONNECTION_CLOSED), and Android runs one VPN at a time. In WSL, Windows is a
 * device of its own to Tailscale: its browser opens Pelican through localhost.
 */
export function tailnetHint(tailnet: Tailnet | undefined, port: number, place: Place = placeHere()): string[] {
  const lines: string[] = [];
  if (tailnet?.others === 0) {
    lines.push('Only this computer is on your tailnet, so your phone cannot open this address yet.');
  } else if (tailnet && tailnet.phones === 0) {
    lines.push('No phone is on your tailnet yet.');
  }
  if (lines.length > 0) {
    lines.push('On the phone, install the Tailscale app, sign in with the same account, and turn off any other');
    lines.push('VPN or proxy (Clash and the like): a phone runs one VPN at a time. `tailscale status` here then lists it.');
  }
  if (place === 'wsl') {
    lines.push(`On this PC, Windows' own browser opens Pelican at http://localhost:${port}: to Tailscale, Windows is a device of its own.`);
  }
  return lines.map((line) => `  ${line}`);
}

/**
 * Whether an address reaches this very Pelican. Only its public sign-in state is asked for, so
 * no secret goes to an address that turns out to be someone else's; the answer names the server.
 */
export async function checkAddress(url: string, instance: string): Promise<string | undefined> {
  let response: Response;
  try {
    response = await fetch(new URL('api/auth', url), { headers: { 'X-Pelican': '1' }, redirect: 'manual', signal: AbortSignal.timeout(6000) });
  } catch (error) {
    const reason = (error as { cause?: { code?: string } }).cause?.code ?? (error as Error).message;
    return `Could not reach ${url} from this computer (${reason}).`;
  }
  const text = await response.text().catch(() => '');
  if (response.status === 403 && text.includes('host name is not allowed')) {
    return `${new URL(url).host} reaches Pelican, but Pelican does not answer to that name. Start it with PELICAN_PUBLIC_URL=${url}`;
  }
  const answer = json(text);
  if (!answer || typeof answer.mode !== 'string') return `${url} is not Pelican (it answered ${response.status}).`;
  if (answer.instance !== instance) return `${url} reaches another Pelican, not the one running here.`;
  return undefined;
}

/** The block a terminal shows: the address, its QR code with a one-time code, and how long it works. */
export function phoneBlock(address: PhoneAddress, code: string | null): string {
  const link = code ? `${address.url}?code=${encodeURIComponent(code)}` : address.url;
  const lines = [
    `  On your phone: ${address.url}${address.from === 'the address given' ? '' : ` (${address.from})`}`,
    ...(address.funnel ? ['  Tailscale Funnel: this address is open to the whole internet.'] : []),
    '',
    qrTerminal(link).replace(/^/gm, '  '),
    '',
    code ? '  Scan it with the camera to sign in. It works once, for two minutes.' : '  Scan it with the camera.',
  ];
  return `${lines.join('\n')}\n`;
}
