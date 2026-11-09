import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import pkg from '../../package.json' with { type: 'json' };
import { config } from './config.js';
import { type Npm, npmBeside, npmEnvironment, npmSaid, type Ran, shellWord } from './npm.js';

/**
 * Anthropic's Agent SDK, which Pelican starts Claude Code through, loaded here and nowhere else.
 * Its license lets no one else ship its code, so Pelican's package holds none of it: Pelican loads
 * Anthropic's own npm package where npm installed it (in development, and in the tests), or else its
 * own copy in its state folder, which it fetches from npm the first time it needs it, once for each
 * version it pins. Only the package and what it lists as its peers: not its optional packages, each
 * a copy of Claude Code, as Pelican runs the user's own (claude-code.ts). The demo never loads it.
 */

export type AgentSdk = typeof import('@anthropic-ai/claude-agent-sdk');

export const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';
/** The version Pelican is built and tested with: package.json pins it exactly. */
export const SDK_VERSION: string = pkg.devDependencies[SDK_PACKAGE];

/** What Pelican reads of the SDK's package.json: its version, and the Claude Code it was released with. */
export type SdkManifest = { version?: string; claudeCodeVersion?: string; main?: string };

/** The SDK the server was built with, and the Claude Code it was released with: scripts/build-server.mjs writes them in. */
declare const PELICAN_SDK_VERSION: string | undefined;
declare const PELICAN_SDK_CLAUDE_CODE: string | undefined;

const require = createRequire(import.meta.url);

/** The npm arguments that fetch the SDK into `prefix`: exactly the version pinned, its JavaScript alone, nothing run. */
export const npmInstall = (prefix: string): string[] => [
  'install', '--prefix', prefix, '--no-save', '--no-package-lock', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund', `${SDK_PACKAGE}@${SDK_VERSION}`,
];

/** Where Pelican keeps its copies, a folder for each version. */
export const sdkFolder = (): string => path.join(config.stateDir, 'agent-sdk');
const copyFolder = () => path.join(sdkFolder(), SDK_VERSION);
const packageIn = (folder: string) => path.join(folder, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');

const tilde = (file: string) => {
  const home = os.homedir();
  return file === home ? '~' : file.startsWith(`${home}${path.sep}`) ? `~${file.slice(home.length)}` : file;
};

/** The command that fetches Pelican's copy, for someone to run where Pelican could not. */
export const fetchCommand = (): string => ['npm', ...npmInstall(tilde(copyFolder()))].map(shellWord).join(' ');

type Loaded = { module: AgentSdk; manifest: SdkManifest };

/** The SDK could not be fetched: why, and the command that fetches it by hand. Said in the terminal once, as it happens. */
export class SdkUnavailable extends Error {}

/** What loading the SDK needs of the computer; tests give stand-ins. */
export type SdkContext = {
  /** The SDK where npm installed it, as `import()` finds it from Pelican's own code. */
  installed: () => Promise<Loaded>;
  /** The npm that fetches Pelican's copy; undefined where there is none. */
  npm: () => Npm | undefined;
  /** Says what Pelican fetches, and why it could not. */
  say: (line: string) => void;
};

let installedFound: { manifest: SdkManifest } | null | undefined;
/** The package.json of the SDK npm installed beside Pelican's code, without loading the SDK. */
function installedManifest(): SdkManifest | undefined {
  if (installedFound === undefined) {
    try {
      installedFound = { manifest: JSON.parse(readFileSync(path.join(path.dirname(require.resolve(SDK_PACKAGE)), 'package.json'), 'utf8')) as SdkManifest };
    } catch {
      installedFound = null;
    }
  }
  return installedFound?.manifest;
}

/**
 * npm: the one beside the Node running Pelican, else the first on PATH (in absolute folders only),
 * run with this Node where it is npm's own script.
 */
export function findNpm(execPath = process.execPath, PATH = process.env.PATH ?? '', platform: NodeJS.Platform = process.platform): Npm | undefined {
  const beside = npmBeside(execPath, platform);
  if (beside) return beside;
  for (const dir of PATH.split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const script = npmBeside(path.join(dir, 'node'), platform);
    if (script) return { file: execPath, args: script.args };
    const file = path.join(dir, 'npm');
    try {
      accessSync(file, constants.X_OK);
      if (platform !== 'win32' && statSync(file).isFile()) return { file, args: [] };
    } catch {
      // No npm in this folder.
    }
  }
  return undefined;
}

const thisComputer: SdkContext = {
  installed: async () => ({ module: await import('@anthropic-ai/claude-agent-sdk'), manifest: installedManifest() ?? {} }),
  npm: () => findNpm(),
  // Beside the start banner, in the terminal or the service's log.
  say: (line) => console.log(line),
};
let context = thisComputer;

let loaded: Loaded | undefined;
let loading: Promise<Loaded> | undefined;
/** The last fetch that failed: said again, rather than tried again, for a while. */
let failed: { error: Error; at: number } | undefined;
/** What was last said of the SDK, so a failure that repeats is said once. */
let lastSaid: string | undefined;
let fetchSaid = false;

/** How long a fetch that failed is said again rather than tried again. */
export const sdkTiming = { retryMs: 30_000, fetchMs: 10 * 60_000 };
/** A temporary folder this old is what a fetch that stopped left: no fetch takes this long. */
const STALE_MS = 60 * 60_000;

/** For tests: load with this context instead (this computer's where not given), and forget what was loaded. */
export function useSdkContext(next: Partial<SdkContext> = {}): void {
  context = { ...thisComputer, ...next };
  loaded = undefined;
  loading = undefined;
  failed = undefined;
  lastSaid = undefined;
  fetchSaid = false;
}

function say(line: string): void {
  if (line === lastSaid) return;
  lastSaid = line;
  context.say(line);
}

/**
 * Anthropic's Agent SDK, loaded once: where npm installed it beside Pelican, else Pelican's own
 * copy of the version it pins, fetched first where there is none. A fetch that fails says why, with
 * the command that fetches it by hand, and is tried again when the SDK is next needed. The demo
 * runs nothing, and never loads it.
 */
export function sdk(): Promise<AgentSdk> {
  if (loaded) return Promise.resolve(loaded.module);
  if (config.demo) return Promise.reject(new Error('This is the demo: nothing runs.'));
  loading ??= load().then(
    (found) => {
      loaded = found;
      return found;
    },
    (error: Error) => {
      loading = undefined;
      say(`pelican: ${error.message}`);
      throw error;
    },
  );
  return loading.then((found) => found.module);
}

/** Starts loading the SDK as Pelican starts, outside the demo, so the first session does not wait for it. */
export function loadSdkSoon(): void {
  if (!config.demo) sdk().catch(() => undefined);
}

/** Whether an error is the SDK's AbortError; only a loaded SDK throws one, so this loads nothing. */
export const isAbortError = (error: unknown): boolean => Boolean(loaded && error instanceof loaded.module.AbortError);

/**
 * The SDK's package.json: its version, and the Claude Code it was released with, which is the one
 * Pelican was tested with. The loaded copy's, wherever it came from; until then, the one the
 * server was built with, or, run from source, the one npm installed.
 */
export function sdkPackage(): SdkManifest {
  if (loaded) return loaded.manifest;
  if (typeof PELICAN_SDK_VERSION === 'string' && typeof PELICAN_SDK_CLAUDE_CODE === 'string') return { version: PELICAN_SDK_VERSION, claudeCodeVersion: PELICAN_SDK_CLAUDE_CODE };
  return installedManifest() ?? { version: SDK_VERSION };
}

async function load(): Promise<Loaded> {
  try {
    return await context.installed();
  } catch (error) {
    // Not installed beside Pelican, as it never is from npm: Pelican's own copy.
    if ((error as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw error;
  }
  return (await ownCopy()) ?? (await fetchCopy());
}

/** The module a copy loads (its package.json's main), where the copy holds the pinned version whole. */
function entryIn(folder: string): { entry: string; manifest: SdkManifest } | undefined {
  const dir = packageIn(folder);
  try {
    const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as SdkManifest;
    const entry = path.join(dir, manifest.main ?? 'sdk.mjs');
    if (manifest.version !== SDK_VERSION || path.relative(dir, entry).startsWith('..') || !existsSync(entry)) return undefined;
    return { entry, manifest };
  } catch {
    return undefined;
  }
}

/** Pelican's own copy of the version it pins, where it has one. */
async function ownCopy(): Promise<Loaded | undefined> {
  const found = entryIn(copyFolder());
  if (!found) return undefined;
  return { module: (await import(pathToFileURL(found.entry).href)) as AgentSdk, manifest: found.manifest };
}

async function fetchCopy(): Promise<Loaded> {
  if (failed && Date.now() - failed.at < sdkTiming.retryMs) throw failed.error;
  try {
    await fetchInto(copyFolder());
  } catch (error) {
    failed = {
      error: new SdkUnavailable(`Pelican could not fetch Anthropic's Agent SDK ${SDK_VERSION} from npm: ${(error as Error).message}. It tries again when it next needs it; to fetch it yourself, run:\n${fetchCommand()}`),
      at: Date.now(),
    };
    throw failed.error;
  }
  if (failed) say(`pelican: Anthropic's Agent SDK ${SDK_VERSION} is in ${tilde(copyFolder())} now.`);
  failed = undefined;
  const copy = await ownCopy();
  if (!copy) throw new Error(`Anthropic's Agent SDK ${SDK_VERSION} is not in ${tilde(copyFolder())} after all.`);
  return copy;
}

function runNpm(npm: Npm, args: string[], cwd: string): Promise<Ran> {
  return new Promise((resolve) => {
    execFile(npm.file, [...npm.args, ...args], { cwd, env: npmEnvironment(process.env), timeout: sdkTiming.fetchMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : -1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (error && code === -1 ? error.message : '')) });
    });
  });
}

/**
 * Fetches the SDK into `target` with npm, run in a new folder beside it, where no project's
 * .npmrc applies but the user's own npm settings do (registry, proxy): into that folder, which
 * then takes the target's place whole, so a Pelican starting meanwhile finds the copy or not,
 * never half of it. Then the copies of other versions go.
 */
async function fetchInto(target: string): Promise<void> {
  const npm = context.npm();
  if (!npm) throw new Error(`there is no npm beside the Node running Pelican (${tilde(process.execPath)}), nor on PATH`);
  const root = path.dirname(target);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(path.join(root, `.${SDK_VERSION}-`));
  try {
    if (!fetchSaid) {
      fetchSaid = true;
      say(`pelican: Fetching Anthropic's Agent SDK ${SDK_VERSION} from npm (${SDK_PACKAGE}), once for this version: about 60 MB, into ${tilde(root)}`);
    }
    const ran = await runNpm(npm, npmInstall(temporary), temporary);
    if (ran.code !== 0) throw new Error(ran.code === -1 && !ran.stderr.trim() ? `npm did not finish in ${sdkTiming.fetchMs / 60_000} minutes` : `npm said ${npmSaid(ran)}`);
    if (!entryIn(temporary)) throw new Error('npm finished, but left no package where it was asked to');
    await putInPlace(temporary, target);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  await removeOthers(root);
}

async function putInPlace(temporary: string, target: string): Promise<void> {
  try {
    await rename(temporary, target);
  } catch (error) {
    // Another Pelican put a whole copy there first: that one stays.
    if (entryIn(target)) return;
    if (!existsSync(target)) throw error;
    // What is there does not load (a fetch by hand that stopped half way): it makes way.
    const old = `${temporary}-old`;
    await rename(target, old);
    await rename(temporary, target);
    await rm(old, { recursive: true, force: true });
  }
}

/** The copies of other versions, and what a fetch that stopped left behind: the copy in place is the one loaded. */
async function removeOthers(root: string): Promise<void> {
  for (const name of await readdir(root).catch((): string[] => [])) {
    if (name === SDK_VERSION) continue;
    const folder = path.join(root, name);
    // Another Pelican's fetch under way.
    if (name.startsWith('.') && Date.now() - ((await stat(folder).catch(() => undefined))?.mtimeMs ?? 0) < STALE_MS) continue;
    await rm(folder, { recursive: true, force: true }).catch(() => undefined);
  }
}
