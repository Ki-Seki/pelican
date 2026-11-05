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

const TIME_KEYS = new Set(['timestamp', 'lastActivity', 'createdAt', 'resetsAt', 'at', 'startedAt', 'queuedAt', 'lastProgressAt']);

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

/**
 * What both demos (this one and `pelican --demo`) say, in these words only, to anything they do
 * not act out: calmly, as a note, not as an error.
 */
export const DEMO_NOTE = STATIC_DEMO
  ? 'This is a demo, so nothing runs. Install Pelican to work with Claude.'
  : 'This is the demo, so nothing runs. Start Pelican without --demo to work with Claude.';

/** Where the site's demo sends people who want the real thing. */
export const INSTALL_URL = '../docs.html#install';

/** The demo saying what it does not do; shown as a note. */
export class DemoRefusal extends Error {}

export async function staticRequest(base: URL, path: string, init?: RequestInit): Promise<unknown> {
  if (init?.method && init.method !== 'GET') throw new DemoRefusal(DEMO_NOTE);
  generatedAt ??= fetch(new URL('data/meta.json', base)).then((r) => r.json()).then((m: { generatedAt: number }) => m.generatedAt);
  const [query, params] = path.split('?');
  // Searching the files' text needs the computer: the demo says so, asking for nothing.
  if (query === 'search') throw new DemoRefusal(DEMO_NOTE);
  // Which files are there, for links in the conversation: from the folder's whole list, saved.
  if (query === 'exists') {
    const asked = new URLSearchParams(params);
    const listing = await fetch(new URL(`data/${requestKey(`files?cwd=${encodeURIComponent(asked.get('cwd') ?? '')}&q=`)}.json`, base));
    const files = listing.ok ? ((await listing.json()) as { files?: string[] }).files ?? [] : [];
    return { paths: asked.getAll('p').filter((p) => files.includes(p)) };
  }
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
