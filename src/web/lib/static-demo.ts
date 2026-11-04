/**
 * The live demo on the project site: the web app with no server behind it.
 * `scripts/site.mjs` saves what the demo server answers to each request as a
 * file, named by a hash of the request; here those files are read back, with
 * times moved up to now, and anything that would change something is refused.
 */
export const STATIC_DEMO = import.meta.env.MODE === 'static-demo';

/** FNV-1a: the same short name the site build gives each saved answer. */
export function requestKey(path: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < path.length; i += 1) {
    hash ^= path.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

const TIME_KEYS = new Set(['timestamp', 'lastActivity', 'createdAt', 'resetsAt', 'at']);

function shift(value: unknown, by: number): unknown {
  if (Array.isArray(value)) return value.map((v) => shift(v, by));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) out[key] = TIME_KEYS.has(key) && typeof v === 'number' ? v + by : shift(v, by);
    return out;
  }
  return value;
}

let generatedAt: Promise<number> | undefined;

export class DemoRefusal extends Error {}

export async function staticRequest(base: URL, path: string, init?: RequestInit): Promise<unknown> {
  if (init?.method && init.method !== 'GET') {
    throw new DemoRefusal('This demo runs in your browser with made-up sessions, so nothing is sent or changed. Install Pelican to work with Claude.');
  }
  generatedAt ??= fetch(new URL('data/meta.json', base)).then((r) => r.json()).then((m: { generatedAt: number }) => m.generatedAt);
  const [query, params] = path.split('?');
  // A file search the build did not save: filter the full list here.
  let wanted = path;
  let search: string | undefined;
  if (query === 'files') {
    const q = new URLSearchParams(params).get('q') ?? '';
    search = q.toLowerCase();
    wanted = `files?cwd=${encodeURIComponent(new URLSearchParams(params).get('cwd') ?? '')}&q=`;
  }
  const response = await fetch(new URL(`data/${requestKey(wanted)}.json`, base));
  if (!response.ok) throw new DemoRefusal('Not part of the demo');
  let data = await response.json() as Record<string, unknown>;
  if (search && Array.isArray(data.files)) data = { files: (data.files as string[]).filter((f) => f.toLowerCase().includes(search!)) };
  return shift(data, Date.now() - (await generatedAt));
}
