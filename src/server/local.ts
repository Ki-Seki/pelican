import { type Running, runningServer } from './running.js';

/**
 * The Pelican a command talks to (`pelican phone`, `pelican service`, a second start): where this
 * computer reaches it, and whether what answers there is the very Pelican this account started.
 * Anything can listen on a port, another account's program too, so only the note a running
 * Pelican leaves in the state folder (readable only by you) says which server is ours.
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

/** Asks a local Pelican something, the way its page does. */
export async function askLocal(base: string, route: string, init: RequestInit = {}): Promise<Response> {
  return fetch(new URL(`api/${route}`, base), { ...init, headers: { 'X-Pelican': '1', ...(init.headers as Record<string, string> | undefined) }, signal: AbortSignal.timeout(5000) });
}

/** The answer of whatever listens at an address, if it is a Pelican: its sign-in state and its id. */
export async function pelicanAt(base: string): Promise<{ mode: string; instance?: string } | undefined> {
  try {
    const answer = await (await askLocal(base, 'auth')).json() as { mode?: unknown; instance?: unknown };
    return typeof answer.mode === 'string' ? { mode: answer.mode, ...(typeof answer.instance === 'string' ? { instance: answer.instance } : {}) } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The Pelican this account runs (on `port`, when one is given), when it is what answers: the note
 * names a live process, and the server at the note's address gives the note's id. Undefined
 * otherwise, also when something else holds the port.
 */
export async function thisPelican(port?: number): Promise<{ running: Running; mode: string } | undefined> {
  const running = await runningServer();
  if (!running || (port !== undefined && running.port !== port) || typeof running.instance !== 'string') return undefined;
  const answer = await pelicanAt(running.url);
  return answer && answer.instance === running.instance ? { running, mode: answer.mode } : undefined;
}
