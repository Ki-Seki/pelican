// The project site (site/) with its live demo: the web app built to run without a server,
// reading what `pelican --demo` answers, saved as files. Needs the app built first.
//   npm run build && node scripts/site.mjs <out dir>      then serve <out dir>, e.g. npx serve <out dir>
import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const out = path.resolve(process.argv[2] ?? '_site');
const PORT = 47861;
const BASE = `http://127.0.0.1:${PORT}/api/`;

/** The same key the web app uses for a saved answer (src/web/lib/static-demo.ts). */
function requestKey(value) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp('site', out, { recursive: true });
await mkdir(path.join(out, 'assets', 'shots'), { recursive: true });
await cp('docs/shots', path.join(out, 'assets', 'shots'), { recursive: true });
await cp('docs/logo.svg', path.join(out, 'assets', 'logo.svg'));
await cp('docs/how-it-works.svg', path.join(out, 'assets', 'how-it-works.svg'));

// The app, built to read saved answers instead of a server.
const demo = path.join(out, 'demo');
const vite = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--mode', 'static-demo', '--outDir', demo, '--emptyOutDir'], { stdio: 'inherit' });
if (vite.status !== 0) process.exit(vite.status ?? 1);

// The demo server, in a state folder of its own, answers what the app will ask.
const state = await mkdtemp(path.join(os.homedir(), '.pelican-site-'));
const server = spawn(process.execPath, ['dist/server/index.js', '--demo', '--name', 'laptop', '--port', String(PORT)], {
  stdio: 'ignore',
  env: { ...process.env, PELICAN_STATE_DIR: state },
});
const stop = () => server.kill();
process.on('exit', stop);
for (let i = 0; ; i += 1) {
  try {
    if ((await fetch(`${BASE}info`)).ok) break;
  } catch {
    if (i > 50) throw new Error('The demo server did not start (is the app built?)');
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
}

const data = path.join(demo, 'data');
await mkdir(data, { recursive: true });
const saved = new Set();
async function save(request) {
  if (saved.has(request)) return undefined;
  saved.add(request);
  const response = await fetch(BASE + request);
  if (!response.ok) return undefined;
  const body = await response.json();
  await writeFile(path.join(data, `${requestKey(request)}.json`), JSON.stringify(body));
  return body;
}
const q = encodeURIComponent;

for (const request of ['auth', 'info', 'models', 'usage', 'projects', 'dirs']) await save(request);
const { sessions } = await save('sessions');
const folders = new Set();
for (const session of sessions) {
  await save(`sessions/${q(session.id)}`);
  await save(`sessions/${q(session.id)}/messages?limit=120`);
  await save(`sessions/${q(session.id)}/mcp`);
  if (session.cwd) folders.add(session.cwd);
}
for (const cwd of folders) {
  await save(`commands?cwd=${q(cwd)}`);
  await save(`files?cwd=${q(cwd)}&q=`);
  const git = await save(`git?cwd=${q(cwd)}`);
  for (const file of git?.files ?? []) await save(`git/diff?cwd=${q(cwd)}&path=${q(file.path)}`);
  // Every folder and small file, so the Files panel works all the way down.
  const walk = async (dir) => {
    const listing = await save(`tree?cwd=${q(cwd)}&path=${q(dir)}`);
    for (const entry of listing?.entries ?? []) {
      if (entry.dir) await walk(entry.path);
      else if ((entry.size ?? 0) < 200_000) await save(`file?cwd=${q(cwd)}&path=${q(entry.path)}`);
    }
  };
  await walk('');
}
await writeFile(path.join(data, 'meta.json'), JSON.stringify({ generatedAt: Date.now() }));
stop();
await rm(state, { recursive: true, force: true });
console.log(`site written to ${out} (${saved.size} demo answers)`);
