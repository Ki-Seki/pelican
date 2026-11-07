import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, existsSync, realpathSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

import { type Context, Hono, type Next } from 'hono';

import pkg from '../../package.json' with { type: 'json' };
import type { BackgroundTask } from '../shared/protocol.js';
import {
  changesBetween, IDLE_FOR_MS, type InstallInfo, type Interruption, isNewerVersion, PACKAGE_NAME, type RestartWay, type UpdateInfo, type UpdateState, VERSION,
} from '../shared/update.js';
import { config } from './config.js';
import { openRuns } from './runner.js';
import { LABEL, launchdJob, plistFile, unitFile } from './service.js';
import { sessionInfo, sessionTitle } from './sessions.js';
import { runningShellList } from './shell-runs.js';
import { listTerminals, terminalRunning } from './terminals.js';

/**
 * Updating Pelican from its Settings. Pelican asks npm's registry (the one a global install uses,
 * as the user's and the global npm settings name it, never a project's) which version of pelican-cc
 * is newest (`dist-tags.latest`), at most once a day and when Settings opens, and reads what changed
 * from that version's CHANGELOG.md. Where Pelican can update itself (an `npm install -g` into npm's
 * global folder, which this account can write to), the owner can start the update there: npm
 * installs that exact version, first into a folder of its own, where Pelican checks it starts
 * (`pelican --version`), then over this install with the same prefix (npm checks each tarball's
 * integrity); then Pelican starts again, through launchd or systemd when it runs as a service, in
 * its own place in a terminal. Wherever it cannot, Settings shows the command to run instead, and
 * why. An update ends what Pelican runs (Claude's processes, background tasks, terminals, `!`
 * commands), so Settings lists those first and offers to wait until nothing has run for a minute.
 */

/** What a program printed, and how it ended (-1: it could not run, or was stopped). */
export type Ran = { code: number; stdout: string; stderr: string };

/** What updating needs of the computer, and of this Pelican; tests give stand-ins. */
export type UpdateContext = {
  platform: NodeJS.Platform;
  /** The Node running Pelican, its options, Pelican's script as started, and its arguments. */
  execPath: string;
  execArgv: string[];
  script: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  home: string;
  uid: number;
  pid: number;
  /** Whether a parent talks to Pelican over IPC (pm2, a test runner): a start in place would cut it off. */
  ipc: boolean;
  /** npm, as the Node running Pelican has it: the program, and the arguments before npm's own. */
  npm?: { file: string; args: string[] };
  /** Runs a program, never through a shell: in `cwd`, else in the folder Pelican was started in. */
  run: (file: string, args: string[], options?: { timeout?: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal; cwd?: string }) => Promise<Ran>;
  fetch: typeof fetch;
  /** process.execve, where this Node has it. */
  execve?: (file: string, args: string[], env: NodeJS.ProcessEnv) => never;
  now: () => number;
};

const runProgram: UpdateContext['run'] = (file, args, { timeout = 60_000, env, signal, cwd } = {}) => new Promise((resolve) => {
  execFile(file, args, { timeout, env: env ?? process.env, maxBuffer: 32 * 1024 * 1024, ...(signal ? { signal } : {}), ...(cwd ? { cwd } : {}), windowsHide: true }, (error, stdout, stderr) => {
    const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : -1) : 0;
    resolve({ code, stdout: String(stdout), stderr: String(stderr || (error && code === -1 ? error.message : '')) });
  });
});

/**
 * The npm of the Node running Pelican, run with that Node: npm-cli.js where Node's installers put
 * it (beside `bin`, as the official installer, Homebrew, nvm, fnm and Volta do), or what the `npm`
 * beside `node` links to. Not the first npm on PATH, which may be another Node's, with another
 * global folder.
 */
export function npmBeside(execPath: string, platform: NodeJS.Platform = process.platform): UpdateContext['npm'] {
  const bin = path.dirname(execPath);
  const clis = [path.join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  for (const cli of clis) if (existsSync(cli)) return { file: execPath, args: [path.normalize(cli)] };
  try {
    const linked = realpathSync(path.join(bin, platform === 'win32' ? 'npm.cmd' : 'npm'));
    if (linked.endsWith('npm-cli.js')) return { file: execPath, args: [linked] };
  } catch {
    // No npm beside it.
  }
  return undefined;
}

/** This computer, and this Pelican, as started. */
export function thisPelican(): UpdateContext {
  return {
    platform: process.platform,
    execPath: process.execPath,
    execArgv: process.execArgv,
    script: process.argv[1] ?? '',
    args: process.argv.slice(2),
    env: process.env,
    home: os.homedir(),
    uid: process.getuid?.() ?? 0,
    pid: process.pid,
    ipc: Boolean(process.channel),
    npm: npmBeside(process.execPath),
    run: runProgram,
    fetch: (input, init) => fetch(input, init),
    ...(typeof process.execve === 'function' && process.platform !== 'win32' ? { execve: (file: string, args: string[], env: NodeJS.ProcessEnv) => process.execve!(file, args, env) } : {}),
    now: Date.now,
  };
}

let context: UpdateContext | undefined;
const ctx = (): UpdateContext => (context ??= thisPelican());

/** For tests: update with this context instead (this computer's when undefined), and forget what was found. */
export function useUpdateContext(next?: UpdateContext): void {
  context = next;
  found = undefined;
  checked = undefined;
  tried = undefined;
  checking = undefined;
  changelogs.clear();
  cancelWaiting();
  claimed = false;
  state = undefined;
}

/** Times updating keeps to; tests shorten them. */
export const updateTiming = {
  /** The registry is asked by itself at most this often… */
  everyMs: 24 * 3600_000,
  /** …and when Settings opens, unless it was asked this recently. */
  settingsMs: 5 * 60_000,
  /** "Update when idle": how long nothing must have run, and how often that is looked at. */
  idleMs: IDLE_FOR_MS,
  idleLookMs: 5_000,
  /** How long the page has to see Pelican restarting before it does. */
  restartPauseMs: 1_000,
  /** How long launchd or systemd, asked to start Pelican again, has to stop this one. */
  serviceStopMs: 30_000,
  /** Before starting in place, how long the processes Pelican started have to end. */
  childrenMs: 10_000,
};

// What the computer says, for messages: paths under the home folder as ~/…
const tilde = (file: string) => (file === ctx().home ? '~' : file.startsWith(`${ctx().home}${path.sep}`) ? `~${file.slice(ctx().home.length)}` : file);

const quoted = (word: string) => `'${word.replace(/'/g, `'\\''`)}'`;

/**
 * A word of a shell command, quoted when it needs to be. A path under the home folder keeps its ~
 * outside the quotes (`~/'my projects/pelican'`), as the shell expands only a bare one.
 */
export function shellWord(word: string): string {
  if (/^[\w./:@%+=,-]+$/.test(word)) return word;
  if (word === '~' || /^~\/[\w./:@%+=,-]*$/.test(word)) return word;
  if (word.startsWith('~/')) return `~/${quoted(word.slice(2))}`;
  return quoted(word);
}
const command = (...words: string[]) => words.map(shellWord).join(' ');

/** How this Pelican was installed, as found once: what Settings offers. */
type Install = Omit<InstallInfo, 'command'> & { commandFor?: (version: string) => string; scriptIn?: string };

let found: Promise<Install> | undefined;

const exists = (file: string) => access(file).then(() => true, () => false);
const writable = (file: string) => access(file, constants.W_OK).then(() => true, () => false);
const sameFolder = async (a: string, b: string) => (await realpath(a).catch(() => path.resolve(a))) === (await realpath(b).catch(() => path.resolve(b)));

/** Pelican's own package folder: the nearest above its script with a package.json named pelican-cc. */
async function packageFolder(script: string): Promise<string | undefined> {
  for (let dir = path.dirname(script); ; dir = path.dirname(dir)) {
    try {
      const manifest = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as { name?: unknown };
      if (manifest.name === PACKAGE_NAME) return dir;
    } catch {
      // Not here.
    }
    if (path.dirname(dir) === dir) return undefined;
  }
}

/** The environment npm runs with: Pelican's, with nothing an earlier npm left of its own run (npx, npm start). */
function npmEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) if (!/^npm_(lifecycle_|package_|command$|execpath$|node_execpath$)/i.test(name)) kept[name] = value;
  return kept;
}

/**
 * Runs npm as `npm install -g` typed in a terminal at home would: from the home folder, never from
 * the folder Pelican was started in, where a cloned project's .npmrc would name the registry (and
 * the rest of npm's settings) for Pelican's own code.
 */
function runNpm(args: string[], options: { timeout: number; signal?: AbortSignal }): Promise<Ran> {
  const { npm, env, home, run } = ctx();
  if (!npm) return Promise.resolve({ code: -1, stdout: '', stderr: 'npm is not beside this Node' });
  return run(npm.file, [...npm.args, ...args], { ...options, env: npmEnvironment(env), cwd: home });
}

const npmSays = async (args: string[]): Promise<string | undefined> => {
  if (!ctx().npm) return undefined;
  const ran = await runNpm(args, { timeout: 30_000 });
  return ran.code === 0 ? ran.stdout.trim().split('\n').at(-1)?.trim() || undefined : undefined;
};

/**
 * Programs that run a package from a cache of their own, which they fill again: asked for a
 * version by number, each starts that one, which is how such a Pelican updates.
 */
const RUNNERS: Array<{ test: (folder: string) => boolean; name: string; run: string[] }> = [
  { test: (folder) => folder.split(path.sep).includes('_npx'), name: 'npx', run: ['npx'] },
  // pnpm dlx (and pnpx): in its cache's dlx folder (a dlx-<pid> one before pnpm 9), in pnpm's own layout.
  { test: (folder) => /[\\/]dlx(-\d+)?[\\/](.*[\\/])?node_modules[\\/]\.pnpm[\\/]/.test(folder), name: 'pnpm dlx', run: ['pnpm', 'dlx'] },
  // bunx: in the temporary folder, as bunx-<uid>-<package>@<version>.
  { test: (folder) => /[\\/]bunx-(\d+-)?[^\\/]+[\\/]node_modules[\\/]/.test(folder), name: 'bunx', run: ['bunx'] },
];

/** Other tools that install packages globally, each keeping the versions it installed. */
const TOOLS: Array<{ test: RegExp; name: string; command: (version: string) => string }> = [
  { test: /[\\/]\.volta[\\/]/, name: 'Volta', command: (v) => command('volta', 'install', `${PACKAGE_NAME}@${v}`) },
  { test: /[\\/](\.pnpm|pnpm[\\/]global)[\\/]/, name: 'pnpm', command: (v) => command('pnpm', 'add', '--global', `${PACKAGE_NAME}@${v}`) },
  { test: /[\\/]\.?yarn[\\/](global|berry)[\\/]/, name: 'Yarn', command: (v) => command('yarn', 'global', 'add', `${PACKAGE_NAME}@${v}`) },
  { test: /[\\/]\.bun[\\/]install[\\/]global[\\/]/, name: 'Bun', command: (v) => command('bun', 'add', '--global', `${PACKAGE_NAME}@${v}`) },
  { test: /^\/nix\/store\//, name: 'Nix', command: () => 'nix profile upgrade --all' },
];

/** How the service manager would start Pelican again, when it runs as Pelican's service; else in place, or by hand. */
async function restartWay(): Promise<RestartWay> {
  const { platform, env, home, pid, uid, run } = ctx();
  if (platform === 'darwin' && launchdJob({ platform, env }) === LABEL && (await exists(plistFile(home)))) {
    const said = await run('launchctl', ['print', `gui/${uid}/${LABEL}`], { timeout: 10_000 });
    if (said.code === 0 && Number(/^\s*pid = (\d+)/m.exec(said.stdout)?.[1]) === pid) return 'launchd';
  }
  if (platform === 'linux' && env.INVOCATION_ID && (await exists(unitFile(home)))) {
    const said = await run('systemctl', ['--user', 'show', 'pelican.service', '--property=MainPID'], { timeout: 10_000 });
    if (said.code === 0 && Number(/^MainPID=(\d+)/m.exec(said.stdout)?.[1]) === pid) return 'systemd';
  }
  return ctx().execve && !ctx().ipc ? 'in-place' : 'by-hand';
}

/**
 * How this Pelican was installed: from where its script is (its real path, past npm's links),
 * and, for a global install, whether its prefix is npm's global folder and this account can write
 * there. Only an install npm itself put in npm's global folder is Pelican's to update: anything
 * else was put there some other way, and whatever did so may expect to keep its version.
 */
async function findInstall(): Promise<Install> {
  const { platform, script: started } = ctx();
  const restart = await restartWay();
  const unknown = (why: string, folder = ''): Install => ({
    kind: 'unknown', folder, self: false, restart, why, commandFor: (v) => command('npm', 'install', '--global', `${PACKAGE_NAME}@${v}`),
  });
  let script: string;
  try {
    script = await realpath(started);
  } catch {
    return unknown(`Pelican could not find the file it started from (${started || 'none'}).`);
  }
  const folder = await packageFolder(script);
  if (!folder) return unknown('Pelican could not find its own package folder.');
  const where = tilde(folder);
  const scriptIn = path.relative(folder, script);
  const managed = (why: string, commandFor?: (version: string) => string, prefix?: string): Install => ({
    kind: 'managed', folder, ...(prefix ? { prefix } : {}), self: false, restart, why, ...(commandFor ? { commandFor } : {}), scriptIn,
  });
  if (await exists(path.join(folder, '.git'))) {
    return {
      kind: 'source', folder, self: false, restart, scriptIn,
      why: `This Pelican runs from a source checkout in ${where}, which Pelican leaves to you.`,
      commandFor: () => `cd ${shellWord(where)} && git pull && npm ci && npm run build`,
    };
  }
  const runner = RUNNERS.find((each) => each.test(folder));
  if (runner) {
    return {
      kind: 'npx', folder, self: false, restart, scriptIn,
      why: `This Pelican runs from ${runner.name}’s cache, which ${runner.name} fills again: it starts the new version when asked for it by number.`,
      commandFor: (v) => command(...runner.run, `${PACKAGE_NAME}@${v}`, ...ctx().args),
    };
  }
  if (platform === 'win32') return managed('Pelican cannot replace itself while it runs on Windows.', (v) => command('npm', 'install', '--global', `${PACKAGE_NAME}@${v}`));
  const tool = TOOLS.find((each) => each.test.test(folder));
  if (tool) return managed(`${tool.name} installed this Pelican (in ${where}) and keeps its version.`, tool.command);
  const modules = path.dirname(folder);
  if (path.basename(modules) !== 'node_modules') return unknown(`This Pelican runs from ${where}, which no package manager put there.`, folder);
  const above = path.dirname(modules);
  if (path.basename(above) !== 'lib') {
    return managed(`This Pelican is a package of ${tilde(above)}, whose package.json says which version it gets.`, (v) => `cd ${shellWord(tilde(above))} && ${command('npm', 'install', `${PACKAGE_NAME}@${v}`)}`);
  }
  // Named as Pelican was started, when that was through the prefix's bin (/tmp, not /private/tmp, on a Mac).
  const through = path.dirname(path.dirname(started));
  const prefix = path.basename(path.dirname(started)) === 'bin' && (await sameFolder(through, path.dirname(above))) ? through : path.dirname(above);
  const withPrefix = (v: string) => command('npm', 'install', '--global', '--prefix', tilde(prefix), `${PACKAGE_NAME}@${v}`);
  if (!ctx().npm) return managed(`npm is not beside the Node that runs Pelican (${tilde(ctx().execPath)}).`, withPrefix, prefix);
  const global = await npmSays(['prefix', '--global']);
  if (!global) return managed('npm could not say where its global folder is.', withPrefix, prefix);
  if (!(await sameFolder(global, prefix))) {
    return managed(
      `This Pelican is installed in ${tilde(prefix)}, not in npm’s global folder (${tilde(global)}): something other than npm install -g put it there, such as a script of your own, and may expect to keep its version.`,
      withPrefix, prefix,
    );
  }
  if (!(await writable(modules)) || !(await writable(path.join(prefix, 'bin'))) || !(await writable(folder))) {
    return {
      kind: 'npm-elsewhere-owned', folder, prefix: global, self: false, restart, scriptIn,
      why: `npm’s global folder (${tilde(modules)}) belongs to another account, so updating it takes sudo, which Pelican never runs.`,
      commandFor: (v) => command('sudo', 'npm', 'install', '--global', `${PACKAGE_NAME}@${v}`),
    };
  }
  // The prefix as npm names it (the same folder), for the page and for npm.
  return { kind: 'npm', folder, prefix: global, self: true, restart, scriptIn };
}

const install = (): Promise<Install> => (found ??= findInstall());

/** A registry's address as npm would use it: http(s), with no user name or password, ending in a slash. */
function registryAddress(said: string | undefined): string | undefined {
  try {
    const url = new URL(said ?? '');
    if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) return url.href.endsWith('/') ? url.href : `${url.href}/`;
  } catch {
    // Not an address.
  }
  return undefined;
}

/**
 * The registry a global install comes from, as npm says (`npm config get registry --global`, from
 * the home folder: the user's and the global settings, never a project's), or its setting in the
 * environment, without npm; npm's own when neither says.
 */
async function registry(): Promise<string> {
  const { env } = ctx();
  const said = (await npmSays(['config', 'get', 'registry', '--global']).catch(() => undefined)) ?? env.npm_config_registry ?? env.NPM_CONFIG_REGISTRY;
  return registryAddress(said) ?? 'https://registry.npmjs.org/';
}

/** A version on the registry: where its tarball is, the integrity npm checks it against, and the Node it needs. */
type Release = { version: string; tarball: string; integrity: string; node?: string };
type Checked = { at: number; registry: string; latest?: Release };

let checked: Checked | undefined;
/** When the registry was last asked, whether it answered or not. */
let tried: number | undefined;
let checking: Promise<Checked | undefined> | undefined;

const stored = () => path.join(config.stateDir, 'update.json');

/** The last answer, kept across restarts, so a Pelican started often still asks once a day. */
async function remembered(): Promise<void> {
  if (checked) return;
  try {
    const kept = JSON.parse(await readFile(stored(), 'utf8')) as Checked;
    if (typeof kept.at === 'number' && typeof kept.registry === 'string') {
      checked = kept;
      tried = kept.at;
    }
  } catch {
    // None yet.
  }
}

/** Reads at most `limit` bytes of a response; more is refused. */
async function bodyOf(response: Response, limit: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'));
  if (declared > limit) throw new Error('too large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += (chunk as Uint8Array).length;
    if (size > limit) throw new Error('too large');
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

/** What the registry says is newest, as a Release; throws when it says nothing usable. */
async function askRegistry(base: string): Promise<Release | undefined> {
  const response = await ctx().fetch(new URL(PACKAGE_NAME, base), {
    headers: { accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`the registry answered ${response.status}`);
  const document = JSON.parse((await bodyOf(response, 16 * 1024 * 1024)).toString('utf8')) as {
    'dist-tags'?: { latest?: unknown };
    versions?: Record<string, { dist?: { tarball?: unknown; integrity?: unknown }; engines?: { node?: unknown } }>;
  };
  const latest = document['dist-tags']?.latest;
  if (typeof latest !== 'string' || !VERSION.test(latest)) throw new Error('the registry named no latest version');
  if (!isNewerVersion(latest, pkg.version)) return undefined;
  const dist = document.versions?.[latest]?.dist;
  const tarball = typeof dist?.tarball === 'string' ? new URL(dist.tarball) : undefined;
  if (!tarball || (tarball.protocol !== 'https:' && tarball.protocol !== 'http:') || typeof dist?.integrity !== 'string' || !/^sha512-/.test(dist.integrity)) {
    throw new Error(`the registry gave no tarball for ${latest}`);
  }
  const node = document.versions?.[latest]?.engines?.node;
  return { version: latest, tarball: tarball.href, integrity: dist.integrity, ...(typeof node === 'string' ? { node } : {}) };
}

/**
 * Asks npm's registry for the newest pelican-cc: by itself at most once a day (`everyMs`), and when
 * Settings opens (`settings`) unless it was asked a few minutes ago. A failed ask says nothing, and
 * keeps what the last one found.
 */
export async function checkForUpdate({ settings = false } = {}): Promise<Checked | undefined> {
  if (config.demo) return undefined;
  await remembered();
  const since = tried === undefined ? Infinity : ctx().now() - tried;
  if (since < (settings ? updateTiming.settingsMs : updateTiming.everyMs)) return checked;
  checking ??= (async () => {
    tried = ctx().now();
    try {
      const base = await registry();
      const latest = await askRegistry(base);
      checked = { at: tried, registry: base, ...(latest ? { latest } : {}) };
      await mkdir(config.stateDir, { recursive: true });
      await writeFile(stored(), JSON.stringify(checked));
    } catch {
      // Offline, or the registry said nothing usable: nothing to say.
    }
    return checked;
  })().finally(() => {
    checking = undefined;
  });
  return checking;
}

let watching: NodeJS.Timeout | undefined;

/** Asks the registry by itself, once a day, from a minute after Pelican starts (cli.ts). */
export function watchForUpdates(): () => void {
  if (config.demo || watching) return () => undefined;
  const look = () => {
    void checkForUpdate().finally(() => {
      watching = setTimeout(look, updateTiming.everyMs);
      watching.unref();
    });
  };
  watching = setTimeout(look, 60_000);
  watching.unref();
  return () => {
    clearTimeout(watching);
    watching = undefined;
  };
}

/** Whether `integrity` (npm's, `sha512-<base64>`, perhaps among others) is that of `data`. */
export function integrityHolds(data: Buffer, integrity: string): boolean {
  const digest = createHash('sha512').update(data).digest('base64');
  const wanted = integrity.split(/\s+/).filter((each) => each.startsWith('sha512-')).map((each) => each.slice('sha512-'.length).replace(/\?.*$/, ''));
  return wanted.length > 0 && wanted.includes(digest);
}

/** A file of a tar archive (npm's tarballs: ustar, perhaps with pax or GNU long names), by its name. */
export function fileInTar(tar: Buffer, name: string): Buffer | undefined {
  let at = 0;
  let long: string | undefined;
  while (at + 512 <= tar.length) {
    const header = tar.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) return undefined;
    const field = (start: number, length: number) => header.subarray(start, start + length).toString('utf8').replace(/\0[\s\S]*$/, '');
    const size = Number.parseInt(field(124, 12).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0) return undefined;
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]!);
    const prefix = field(345, 155);
    const entry = long ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    long = undefined;
    const body = tar.subarray(at + 512, at + 512 + size);
    if (type === 'x') long = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))?.[1];
    else if (type === 'L') long = body.toString('utf8').replace(/\0[\s\S]*$/, '');
    else if (type === '0' && entry === name) return Buffer.from(body);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return undefined;
}

const changelogs = new Map<string, Promise<string | undefined>>();

/**
 * What changed from the running version to `release`, from the CHANGELOG.md in its tarball on the
 * registry (the very file npm would install, its integrity checked), read once per version.
 */
function changesTo(release: Release): Promise<string | undefined> {
  let changes = changelogs.get(release.version);
  if (!changes) {
    changes = (async () => {
      const response = await ctx().fetch(release.tarball, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) return undefined;
      const data = await bodyOf(response, 64 * 1024 * 1024);
      if (!integrityHolds(data, release.integrity)) return undefined;
      const changelog = fileInTar(gunzipSync(data, { maxOutputLength: 256 * 1024 * 1024 }), 'package/CHANGELOG.md');
      return changelog ? changesBetween(changelog.toString('utf8'), pkg.version, release.version) : undefined;
    })().catch(() => undefined);
    changelogs.set(release.version, changes);
    // One that could not be read is tried again next time.
    void changes.then((text) => {
      if (text === undefined && changelogs.get(release.version) === changes) changelogs.delete(release.version);
    });
  }
  return changes;
}

/** Whether this Node satisfies `range` as a release's engines.node says it (>=x.y.z, the form Pelican uses); true when it cannot tell. */
export function nodeSatisfies(range: string | undefined, node = process.versions.node): boolean {
  if (!range) return true;
  const match = /^\s*>=\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/.exec(range);
  if (!match) return true;
  const want = [match[1], match[2], match[3]].map((part) => Number(part ?? 0));
  const have = node.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < 3; i += 1) if (have[i] !== want[i]) return (have[i] ?? 0) > want[i]!;
  return true;
}

// What would end -------------------------------------------------------------------------------

/** Where what an update would end is found; tests give stand-ins. */
export type RunningSources = {
  runs: () => Array<{ sessionId: string; cwd: string; busy: boolean; waiting: boolean; tasks: BackgroundTask[]; checks: number; unseen: boolean }>;
  terminals: () => Promise<Array<{ program: string; cwd: string }>>;
  shells: () => Array<{ sessionId: string; command: string }>;
  title: (sessionId: string) => Promise<string | undefined>;
};

export const runningHere: RunningSources = {
  runs: () => openRuns().map((run) => {
    const shown = run.state();
    return {
      sessionId: run.sessionId,
      cwd: run.cwd,
      busy: run.busy,
      waiting: run.status() === 'waiting',
      tasks: shown.tasks ?? [],
      checks: shown.scheduled?.length ?? 0,
      // Work Claude Code keeps running and shows no one (watchers).
      unseen: run.hasBackgroundTasks && (shown.tasks?.length ?? 0) === 0 && (shown.scheduled?.length ?? 0) === 0,
    };
  }),
  terminals: async () => {
    const shown = await Promise.all(listTerminals().map((terminal) => terminalRunning(terminal.id)));
    return shown.flatMap((each) => (each?.running ? [{ program: each.terminal.program, cwd: each.terminal.cwd }] : []));
  },
  shells: runningShellList,
  title: async (sessionId) => {
    const info = await sessionInfo(sessionId).catch(() => undefined);
    return info ? sessionTitle(info) : undefined;
  },
};

let sources = runningHere;

/** For tests: what runs, from these instead. */
export function useRunningSources(next?: RunningSources): void {
  sources = next ?? runningHere;
}

const count = (n: number, one: string, many = `${one}s`) => `${n === 1 ? (/^[aeiou]/.test(one) ? 'an' : 'a') : n} ${n === 1 ? one : many}`;
const listed = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const clipped = (text: string, max = 80) => {
  const line = text.split('\n')[0]!.trim();
  return line.length > max || text.includes('\n') ? `${line.slice(0, max).trimEnd()}…` : line;
};

/** What an update would end now: Claude at work or waiting, its background work, terminals with a program, `!` commands. */
export async function whatWouldEnd(): Promise<Interruption[]> {
  const ended: Interruption[] = [];
  const titles = new Map<string, string>();
  const title = async (sessionId: string, cwd?: string) => {
    if (!titles.has(sessionId)) titles.set(sessionId, (await sources.title(sessionId)) ?? (cwd ? path.basename(cwd) : 'A session'));
    return titles.get(sessionId)!;
  };
  for (const run of sources.runs()) {
    if (run.waiting) ended.push({ kind: 'session', title: await title(run.sessionId, run.cwd), detail: 'Claude waits for you', sessionId: run.sessionId });
    else if (run.busy) ended.push({ kind: 'session', title: await title(run.sessionId, run.cwd), detail: 'Claude is working', sessionId: run.sessionId });
    const workflows = run.tasks.filter((task) => task.type === 'local_workflow').length;
    const commands = run.tasks.filter((task) => task.type === 'local_bash' || task.type.startsWith('monitor')).length;
    const agents = run.tasks.length - workflows - commands;
    const work = [
      ...(agents ? [count(agents, 'agent')] : []),
      ...(workflows ? [count(workflows, 'workflow')] : []),
      ...(commands ? [count(commands, 'command')] : []),
      ...(run.checks ? [count(run.checks, 'check it scheduled', 'checks it scheduled')] : []),
      ...(run.unseen ? ['work it keeps running'] : []),
    ];
    if (work.length > 0) ended.push({ kind: 'work', title: await title(run.sessionId, run.cwd), detail: `${listed(work)} in the background`, sessionId: run.sessionId });
  }
  for (const terminal of await sources.terminals()) ended.push({ kind: 'terminal', title: terminal.program, detail: `in ${tilde(terminal.cwd)}` });
  for (const shell of sources.shells()) ended.push({ kind: 'command', title: `!${clipped(shell.command)}`, detail: `in ${await title(shell.sessionId)}`, sessionId: shell.sessionId });
  return ended;
}

// Updating -------------------------------------------------------------------------------------

let state: UpdateState | undefined;
/** An update asked for, from its request until it is under way or refused: one at a time. */
let claimed = false;
/** The update under way: stopped by Cancel while it prepares or waits. */
let job: { version: string; stop: AbortController } | undefined;
let waiting: NodeJS.Timeout | undefined;

function cancelWaiting(): void {
  clearInterval(waiting);
  waiting = undefined;
  job?.stop.abort();
  job = undefined;
}

/** A request the update turns down: why, and the status to answer with. */
export class UpdateRefused extends Error {
  constructor(message: string, readonly status: 400 | 403 | 409) {
    super(message);
  }
}

/** Something on the way failed: said on the page, while this Pelican goes on running. */
class UpdateFailed extends Error {}

/** The end of what a program printed, for saying why it failed: its last lines, at most 600 characters. */
function tail(ran: Ran): string {
  const lines = `${ran.stderr}\n${ran.stdout}`.split('\n').map((line) => line.trimEnd()).filter((line) => line && !/^npm (notice|warn)/i.test(line));
  const text = lines.slice(-6).join('\n');
  return (text.length > 600 ? `…${text.slice(-600)}` : text) || (ran.code === -1 ? 'it could not run, or took too long' : `exit code ${ran.code}`);
}

/**
 * What npm said went wrong, in a line: its error's code and first words (`ECONNREFUSED: request to
 * … failed`), without its stack, its fields, its advice and where its log is.
 */
export function npmSaid(ran: Ran): string {
  const said = `${ran.stderr}\n${ran.stdout}`.split('\n').flatMap((line) => {
    const match = /^npm (?:error|ERR!)(?: (.*))?$/.exec(line.trimEnd());
    return match ? [match[1] ?? ''] : [];
  });
  const code = said.map((line) => /^code (\S+)$/.exec(line)?.[1]).find(Boolean);
  const message = said.find((line) => line && !/^\s/.test(line) && !/^(code|syscall|errno|path|dest|signal|command|cwd) /.test(line)
    && !/^[{}]$/.test(line) && !/^(A complete log|If you are behind a proxy|In most cases|'?proxy'? config)/.test(line));
  if (!code && !message) return tail(ran);
  return clipped([code, message?.replace(/^(notarget|404|403|401) +/, '').trim()].filter(Boolean).join(': '), 400);
}

/**
 * npm installing exactly `version` of pelican-cc into `prefix`, from the registry checked: no
 * scripts, nothing else. `cached`: from what npm got moments ago, where it can (over this install,
 * after the same version was installed apart), so new work waits no longer than it must.
 */
function npmInstall(prefix: string, version: string, base: string, { signal, cached = false }: { signal?: AbortSignal; cached?: boolean } = {}): Promise<Ran> {
  return runNpm([
    'install', '--global', '--prefix', prefix, '--registry', base,
    '--ignore-scripts', '--no-audit', '--no-fund', '--no-update-notifier', '--loglevel=error', ...(cached ? ['--prefer-offline'] : []),
    `${PACKAGE_NAME}@${version}`,
  ], { timeout: 15 * 60_000, ...(signal ? { signal } : {}) });
}

/** Why the Pelican at `script` does not start as `version` (`pelican --version`); undefined when it does. */
async function startsAs(script: string, version: string, signal?: AbortSignal): Promise<string | undefined> {
  const { execPath, env, home, run } = ctx();
  const ran = await run(execPath, [script, '--version'], { timeout: 60_000, env, cwd: home, ...(signal ? { signal } : {}) });
  if (ran.code !== 0) return `pelican --version failed: ${tail(ran)}`;
  const line = ran.stdout.trim().split('\n').at(-1) ?? '';
  if (!line.startsWith(`${version} (Pelican)`)) return `pelican --version said ${clipped(line, 200) || 'nothing'}`;
  if (/Claude Code not found/.test(line)) return 'it has no Claude Code';
  return undefined;
}

/** The script a package installed at `folder` starts from, as its package.json says. */
async function scriptOf(folder: string): Promise<string> {
  const manifest = JSON.parse(await readFile(path.join(folder, 'package.json'), 'utf8')) as { bin?: Record<string, string> | string };
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.pelican ?? manifest.bin?.[PACKAGE_NAME];
  if (!bin) throw new UpdateFailed('the new version names no pelican command');
  return path.join(folder, bin);
}

/**
 * Gets `version` and checks it starts, apart from this install: npm installs it into a folder of
 * its own (with the integrity the registry gives each tarball), and `pelican --version` runs there.
 * Nothing of this install changes; the folder goes once looked at (npm keeps what it downloaded).
 */
async function prepare(version: string, base: string, stop: AbortSignal): Promise<void> {
  const staging = await mkdtemp(path.join(os.tmpdir(), 'pelican-update-'));
  try {
    const ran = await npmInstall(staging, version, base, { signal: stop });
    if (stop.aborted) return;
    if (ran.code !== 0) throw new UpdateFailed(`npm could not install ${version}: ${npmSaid(ran)}`);
    const folder = path.join(staging, 'lib', 'node_modules', PACKAGE_NAME);
    const problem = await startsAs(await scriptOf(folder).catch(() => path.join(folder, 'dist', 'server', 'index.js')), version, stop);
    if (problem && !stop.aborted) throw new UpdateFailed(`${version} does not start: ${problem}`);
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** How this Pelican stops serving and starts serving again, when it starts the new version in its place (server.ts). */
let serving: { stop: () => Promise<void>; again: () => Promise<void> } | undefined;

/** server.ts says how to stop serving, and how to serve again should starting in place fail. */
export function servedBy(hooks: typeof serving): void {
  serving = hooks;
}

/** The processes Pelican started that are still there, from ps: not the ps asked, which is one of them as it runs. */
async function children(): Promise<number[]> {
  const ran = await ctx().run('ps', ['-A', '-o', 'pid=,ppid=,stat=,comm='], { timeout: 10_000 });
  if (ran.code !== 0) return [];
  return ran.stdout.split('\n').flatMap((line) => {
    const [pid, ppid, stat, ...comm] = line.trim().split(/\s+/);
    return Number(ppid) === ctx().pid && !stat?.startsWith('Z') && path.basename(comm.join(' ')) !== 'ps' ? [Number(pid)] : [];
  });
}

/**
 * Starts Pelican again, now running the new version: its service manager starts it again, or it
 * starts in its own place (the same process, with the same terminal, arguments and environment),
 * once all it ran has ended (a process it started and left would be no one's to wait for). Where
 * neither can be done, it says to restart it by hand.
 */
async function restartAs(version: string, way: RestartWay): Promise<void> {
  const { uid, run, execve, execPath, execArgv, script, args, env } = ctx();
  await new Promise((resolve) => setTimeout(resolve, updateTiming.restartPauseMs));
  if (way === 'launchd' || way === 'systemd') {
    // The service manager stops this Pelican (SIGTERM: what runs ends as at any stop) and starts it again.
    const ran = way === 'launchd'
      ? await run('launchctl', ['kickstart', '-k', `gui/${uid}/${LABEL}`], { timeout: 60_000 })
      // Queued, not waited for: stopping the service ends every process of it, this one too.
      : await run('systemctl', ['--user', '--no-block', 'restart', 'pelican.service'], { timeout: 60_000 });
    if (ran.code !== 0) throw new UpdateFailed(`${version} is installed, but ${way} did not start it: ${tail(ran)}. Run pelican service restart.`);
    // Stopped by now, as asked; still here, it was not.
    await new Promise((resolve) => setTimeout(resolve, updateTiming.serviceStopMs).unref());
    throw new UpdateFailed(`${version} is installed, but ${way} did not stop this Pelican to start it. Run pelican service restart.`);
  }
  if (way === 'in-place' && execve && serving) {
    await serving.stop();
    for (const until = ctx().now() + updateTiming.childrenMs; (await children()).length > 0 && ctx().now() < until;) await new Promise((resolve) => setTimeout(resolve, 100));
    for (const pid of await children()) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Gone already.
      }
    }
    try {
      execve(execPath, [execPath, ...execArgv, script, ...args], env);
    } catch (error) {
      await serving.again().catch(() => undefined);
      throw new UpdateFailed(`${version} is installed, but Pelican could not start it in its place (${(error as Error).message}): restart Pelican to run it.`);
    }
    return;
  }
  const why = ctx().ipc ? 'another program started it and talks to it' : !execve ? `Node ${process.versions.node} has no process.execve` : 'it is not serving';
  state = { phase: 'installed', version, note: `Pelican ${version} is installed. This Pelican cannot start it in its own place here (${why}): stop it and start it again.` };
}

/** Installs `version` over this install, checks it starts, and starts it: new work waits meanwhile (whileUpdating). */
async function commit(version: string, base: string, found: Install): Promise<void> {
  const prefix = found.prefix!;
  state = { phase: 'installing', version };
  const ran = await npmInstall(prefix, version, base, { cached: true });
  // npm puts back what it was replacing when it fails.
  if (ran.code !== 0) throw new UpdateFailed(`npm could not install ${version} over this install: ${npmSaid(ran)}`);
  state = { phase: 'checking', version };
  const problem = await startsAs(path.join(found.folder, found.scriptIn ?? path.join('dist', 'server', 'index.js')), version);
  if (problem) {
    const back = await npmInstall(prefix, pkg.version, base, { cached: true });
    throw new UpdateFailed(`${version} was installed but does not start (${problem}); ${back.code === 0
      ? `npm put ${pkg.version} back.`
      : `putting ${pkg.version} back failed too: run ${command('npm', 'install', '--global', '--prefix', tilde(prefix), `${PACKAGE_NAME}@${pkg.version}`)}.`}`);
  }
  state = { phase: 'restarting', version };
  await restartAs(version, found.restart);
}

/** Runs the update to its end, or to where it failed: then the page says what failed, and this Pelican goes on. */
async function carryOut(version: string, when: 'now' | 'idle', base: string, found: Install): Promise<void> {
  const stop = new AbortController();
  job = { version, stop };
  try {
    state = { phase: 'preparing', version, when };
    await prepare(version, base, stop.signal);
    if (stop.signal.aborted) return;
    if (when === 'idle') {
      state = { phase: 'waiting', version, since: ctx().now() };
      waitForIdle(version, base, found);
      return;
    }
    job = undefined;
    await commit(version, base, found);
  } catch (error) {
    if (stop.signal.aborted) return;
    job = undefined;
    state = { phase: 'failed', version, error: error instanceof UpdateFailed ? error.message : `Updating failed: ${(error as Error).message}`, running: pkg.version };
  }
}

/** Waits until nothing has run for idleMs, looking every idleLookMs, then updates. */
function waitForIdle(version: string, base: string, found: Install): void {
  let looking = false;
  waiting = setInterval(() => {
    if (looking || state?.phase !== 'waiting') return;
    looking = true;
    void whatWouldEnd().then(async (ended) => {
      if (state?.phase !== 'waiting') return;
      const now = ctx().now();
      if (ended.length > 0) {
        if (state.idleSince !== undefined) state = { phase: 'waiting', version, since: state.since };
        return;
      }
      const idleSince = state.idleSince ?? now;
      state = { ...state, idleSince };
      if (now - idleSince < updateTiming.idleMs) return;
      clearInterval(waiting);
      waiting = undefined;
      job = undefined;
      try {
        await commit(version, base, found);
      } catch (error) {
        state = { phase: 'failed', version, error: error instanceof UpdateFailed ? error.message : `Updating failed: ${(error as Error).message}`, running: pkg.version };
      }
    }).catch(() => undefined).finally(() => {
      looking = false;
    });
  }, updateTiming.idleLookMs);
  waiting.unref();
}

/** Whether new work waits: the install is being replaced, or Pelican is about to start again. */
export const updating = (): boolean => state?.phase === 'installing' || state?.phase === 'checking' || state?.phase === 'restarting';

/**
 * What Settings shows: the running version, the newest when newer (asking the registry first when
 * `fresh`, at most every few minutes), what changed, how Pelican was installed and what it offers,
 * what an update would end now, and the update under way.
 */
export async function updateInfo(fresh = false): Promise<UpdateInfo> {
  const info: UpdateInfo = { current: pkg.version };
  if (config.demo) return info;
  if (state) info.state = state;
  const found = await checkForUpdate({ settings: fresh });
  const latest = found?.latest && isNewerVersion(found.latest.version, pkg.version) ? found.latest : undefined;
  if (!latest) return info;
  info.latest = latest.version;
  const [changes, how, busy] = await Promise.all([
    Promise.race([changesTo(latest), new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 20_000).unref())]),
    install(),
    whatWouldEnd(),
  ]);
  if (changes) info.changes = changes;
  else info.notes = `https://github.com/Ki-Seki/pelican/releases/tag/v${latest.version}`;
  const { commandFor, scriptIn: _scriptIn, ...shown } = how;
  info.install = { ...shown, ...(commandFor ? { command: commandFor(latest.version) } : {}) };
  if (how.self && !nodeSatisfies(latest.node)) {
    info.install = {
      ...info.install, self: false,
      why: `Pelican ${latest.version} needs Node ${latest.node!.replace(/^\s*>=\s*/, '')} or newer, and this one is ${process.versions.node}: update Node first.`,
      command: command('npm', 'install', '--global', '--prefix', tilde(how.prefix!), `${PACKAGE_NAME}@${latest.version}`),
    };
  }
  info.busy = busy;
  return info;
}

/**
 * Starts updating to `version`: the newest version the registry named, past the running one, and
 * nothing else. `now` restarts as soon as it is installed, which ends what runs, so it must be
 * `confirmed` while anything does (the page lists it first); `idle` waits until nothing has run
 * for a minute.
 */
export async function startUpdate(version: unknown, when: unknown, confirmed: unknown): Promise<UpdateState> {
  if (config.demo) throw new UpdateRefused('This is the demo: nothing is installed. Install Pelican to update it.', 403);
  if (typeof version !== 'string' || !VERSION.test(version)) throw new UpdateRefused('Not a version', 400);
  if (when !== 'now' && when !== 'idle') throw new UpdateRefused('when must be now or idle', 400);
  if (claimed || job || updating() || state?.phase === 'waiting' || state?.phase === 'preparing') throw new UpdateRefused('Pelican is already updating.', 409);
  const found = checked?.latest;
  if (!found || found.version !== version || !isNewerVersion(version, pkg.version)) {
    throw new UpdateRefused(`${version} is not the newest version npm’s registry named${found ? ` (${found.version})` : ''}. Open Settings again.`, 409);
  }
  const base = checked!.registry;
  // Claimed before anything is awaited: of two requests at once (a double tap, two pages), the
  // second is told an update is under way, as it will be once this one has looked.
  claimed = true;
  try {
    const how = await install();
    if (!how.self || !how.prefix) throw new UpdateRefused(how.why ?? 'Pelican cannot update itself here.', 409);
    if (!nodeSatisfies(found.node)) throw new UpdateRefused(`Pelican ${version} needs Node ${found.node}.`, 409);
    if (when === 'now' && confirmed !== true && (await whatWouldEnd()).length > 0) throw new UpdateRefused('Something runs that the update would end: confirm first.', 409);
    state = { phase: 'preparing', version, when };
    void carryOut(version, when, base, how);
    return state;
  } finally {
    claimed = false;
  }
}

/** Cancel: a wait for idle, or getting the version ready, stops; nothing of this install changed. */
export function cancelUpdate(): boolean {
  if (state?.phase !== 'waiting' && state?.phase !== 'preparing' && state?.phase !== 'failed' && state?.phase !== 'installed') return false;
  cancelWaiting();
  state = undefined;
  return true;
}

/** While the install is replaced and Pelican starts again, nothing new starts: a request to start something waits for the new version. */
export async function whileUpdating(c: Context, next: Next): Promise<Response | void> {
  if (updating() && c.req.method !== 'GET' && c.req.method !== 'HEAD' && !c.req.path.startsWith('/api/update') && !c.req.path.startsWith('/api/auth')) {
    return c.json({ error: `Pelican is updating to ${state!.version} and starts again in a moment.` }, 503);
  }
  return next();
}

/**
 * The routes (app.ts mounts them at api/update), behind the same checks as every other: Pelican's
 * own page, signed in, not the demo, which refuses whatever changes something.
 */
export const updateRoutes = new Hono();

updateRoutes.get('/', async (c) => c.json(await updateInfo(c.req.query('check') === '1')));

updateRoutes.post('/', async (c) => {
  const body = await c.req.json<{ version?: unknown; when?: unknown; confirmed?: unknown }>().catch(() => undefined);
  try {
    await startUpdate(body?.version, body?.when, body?.confirmed);
  } catch (error) {
    if (error instanceof UpdateRefused) return c.json({ error: error.message, ...(error.status === 409 ? { busy: await whatWouldEnd() } : {}) }, error.status);
    throw error;
  }
  return c.json(await updateInfo(), 202);
});

updateRoutes.post('/cancel', async (c) => {
  if (config.demo) return c.json({ error: 'This is the demo: nothing is installed.' }, 403);
  if (!cancelUpdate()) return c.json({ error: 'There is no update to cancel now.' }, 409);
  return c.json(await updateInfo());
});
