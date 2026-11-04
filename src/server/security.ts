import os from 'node:os';

import { config } from './config.js';

const hostname = (host: string) => {
  const h = host.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']'));
  const colon = h.lastIndexOf(':');
  return colon > -1 && h.indexOf(':') === colon ? h.slice(0, colon) : h;
};

export function isLoopback(host: string): boolean {
  const h = hostname(host);
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

/** True for addresses that only this machine can reach. */
export function listensLocally(host: string): boolean {
  return isLoopback(host);
}

function knownHosts(): Set<string> {
  const names = new Set<string>();
  const machine = os.hostname().toLowerCase();
  names.add(machine);
  names.add(machine.split('.')[0]!);
  // This computer's own addresses: a phone on the network may open it by IP.
  for (const address of Object.values(os.networkInterfaces()).flat()) if (address) names.add(address.address.toLowerCase());
  if (config.host !== '0.0.0.0' && config.host !== '::') names.add(hostname(config.host));
  for (const host of config.allowedHosts) names.add(hostname(host));
  for (const origin of config.allowedOrigins) {
    try {
      names.add(new URL(origin).hostname.toLowerCase());
    } catch {
      // Not a URL; ignored.
    }
  }
  return names;
}

/**
 * The server answers only to names that point at it: this computer's names and
 * addresses, loopback, Tailscale names (*.ts.net, which only Tailscale can point
 * anywhere) and configured ones. Otherwise a web page could rebind its own
 * domain to 127.0.0.1 (DNS rebinding) and use Pelican through your browser.
 */
export function hostAllowed(host: string | undefined): boolean {
  if (!host) return false;
  if (isLoopback(host)) return true;
  const name = hostname(host);
  if (name.endsWith('.ts.net')) return true;
  return knownHosts().has(name);
}

/**
 * Requests that change something must come from this app's own page, or from
 * an origin allowed in the config, so a page on another site cannot drive Claude.
 */
export function originAllowed(origin: string | undefined, ...hosts: Array<string | undefined>): boolean {
  if (!origin) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (config.allowedOrigins.includes(url.origin)) return true;
  return hosts.flatMap((h) => (h ? h.split(',').map((s) => s.trim()) : [])).includes(url.host);
}
