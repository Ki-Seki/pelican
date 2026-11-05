/**
 * The Pelican a command talks to (`pelican phone`, `pelican service`, a second start): where this
 * computer reaches it.
 */

/**
 * Where this computer reaches a Pelican that listens on `host`: a wildcard address on loopback,
 * `::1` as itself, a name as it resolves (Node tries each address `localhost` has, as listening did).
 */
export function callable(host: string, port: number): string {
  if (host === '0.0.0.0' || host === '127.0.0.1') return `http://127.0.0.1:${port}/`;
  if (host === '::' || host === '::1') return `http://[::1]:${port}/`;
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}/`;
}

/** The address a server reports it listens at, as this computer reaches it (a wildcard on loopback). */
export const reachable = (url: string) => url.replace('://0.0.0.0:', '://127.0.0.1:').replace('://[::]:', '://[::1]:');
