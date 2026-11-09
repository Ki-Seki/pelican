import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { sdkPackage } from './agent-sdk.js';
import { config } from './config.js';

/**
 * The Claude Code that Pelican runs: the user's own, the one their terminal runs, which Claude
 * Code's installer keeps up to date (`claude update`). PELICAN_CLAUDE_PATH names one; otherwise the
 * first `claude` on PATH, else one where Claude Code's installers put it, for a Pelican started with
 * a PATH that has none (a service, an app). Bug reports need its version, and the start banner says
 * whether it is signed in, since a signed-out Claude Code otherwise shows only when the first
 * message fails. The banner and About also say when it is older than the Claude Code the Agent SDK
 * Pelican pins was released with, which is the one Pelican was tested with, and, where there is
 * none, how to install it.
 */

/** Claude Code's own command that installs it, as its setup docs give it (code.claude.com/docs/en/setup). */
export const INSTALL_COMMAND = process.platform === 'win32' ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash';

/**
 * Where Claude Code's installers put `claude`, as their docs and packages say, in the order looked
 * in: the native installer's launcher (`~/.local/bin/claude`, on Windows too), Homebrew's cask in
 * Homebrew's prefix (Apple silicon, Intel, Linux), the apt, dnf and apk packages (`/usr/bin`), a
 * global npm install by the npm beside the Node running Pelican, and the local install of older
 * versions of Claude Code (`~/.claude/local`), which a shell alias runs.
 */
export function installedPlaces(home = os.homedir(), env: NodeJS.ProcessEnv = process.env, execPath = process.execPath, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'win32') return [path.join(home, '.local', 'bin', 'claude.exe')];
  const brew = [env.HOMEBREW_PREFIX, '/opt/homebrew', '/usr/local', '/home/linuxbrew/.linuxbrew'].filter((prefix): prefix is string => Boolean(prefix && path.isAbsolute(prefix)));
  return [...new Set([
    path.join(home, '.local', 'bin', 'claude'),
    ...brew.map((prefix) => path.join(prefix, 'bin', 'claude')),
    '/usr/bin/claude',
    path.join(path.dirname(execPath), 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
  ])];
}

/** The first of `files` that is a file this account may run. */
async function firstRunnable(files: string[]): Promise<string | undefined> {
  for (const file of files) {
    try {
      await access(file, constants.X_OK);
      if ((await stat(file)).isFile()) return file;
    } catch {
      // Not there.
    }
  }
  return undefined;
}

/**
 * The first `claude` on PATH, as a shell finds it, but in absolute folders only: an empty or
 * relative entry would run a `claude` from whatever folder Pelican was started in.
 */
export function claudeOnPath(PATH = process.env.PATH ?? ''): Promise<string | undefined> {
  const name = process.platform === 'win32' ? 'claude.exe' : 'claude';
  return firstRunnable(PATH.split(path.delimiter).filter((dir) => path.isAbsolute(dir)).map((dir) => path.join(dir, name)));
}

let placesInstead: string[] | undefined;
/** For tests: look in these places instead of where Claude Code's installers put it (undefined: there again). */
export function useClaudePlaces(places?: string[]): void {
  placesInstead = places;
}

/**
 * The claude Pelican runs: the one PELICAN_CLAUDE_PATH names, as it is; else the first on PATH;
 * else the first where Claude Code's installers put it. Undefined where there is none.
 */
export async function claudePath(PATH?: string): Promise<string | undefined> {
  if (config.claudeExecutable) return config.claudeExecutable;
  return (await claudeOnPath(PATH)) ?? firstRunnable(placesInstead ?? installedPlaces());
}

/** Where no Claude Code was found: how to install it, or to name the one to run. */
export const notFoundLine = (): string => `Claude Code not found: install it with \`${INSTALL_COMMAND}\`, or set PELICAN_CLAUDE_PATH to it`;

/** No Claude Code to start: said where a message or a look at its models would start one. */
export class ClaudeCodeMissing extends Error {
  constructor() {
    super(`Claude Code is not installed on ${config.machine}, or not where Pelican looks. Install it there with\n${INSTALL_COMMAND}\nor set PELICAN_CLAUDE_PATH to the claude program.`);
  }
}

/** The claude to start: ClaudeCodeMissing where there is none. */
export async function claudeToRun(): Promise<string> {
  const file = await claudePath();
  if (!file) throw new ClaudeCodeMissing();
  return file;
}

type Output = { code: number; stdout: string };

function run(file: string, args: string[], timeout: number): Promise<Output | undefined> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, maxBuffer: 1024 * 1024, env: process.env }, (error, stdout) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : -1) : 0;
      // Missing or not runnable: no answer at all.
      if (error && code === -1) resolve(undefined);
      else resolve({ code, stdout: String(stdout) });
    });
  });
}

/** Each binary's answer to `--version`, by its real path, size and time: an update, or another claude on PATH, is asked afresh. */
const versions = new Map<string, Promise<string | null>>();

/** The version a claude says it is: null where it does not run, undefined where it says none. */
async function versionOf(file: string): Promise<string | null | undefined> {
  const real = await realpath(file).catch(() => undefined);
  const found = real ? await stat(real).catch(() => undefined) : undefined;
  if (!real || !found) return null;
  const key = `${real}\0${found.size}\0${found.mtimeMs}`;
  let answer = versions.get(key);
  if (!answer) {
    answer = run(file, ['--version'], 5000).then((output) => (output ? (/\d+\.\d+\.\d+/.exec(output.stdout)?.[0] ?? '') : null));
    versions.set(key, answer);
    // One that did not answer is asked again next time.
    void answer.then((said) => {
      if (said === null) versions.delete(key);
    });
  }
  const said = await answer;
  return said === null ? null : said || undefined;
}

/**
 * Which Claude Code runs: its path and version, and `tested`, the version Pelican was tested with,
 * where this one is older. `missing` where there is none, or PELICAN_CLAUDE_PATH names one that is
 * not there (then with that `path`). The demo runs nothing: its made-up sessions were written by
 * the Claude Code Pelican was tested with.
 */
export type ClaudeCodeInfo = { version?: string; path?: string; missing?: boolean; tested?: string };

export async function claudeCodeInfo(): Promise<ClaudeCodeInfo> {
  const tested = sdkPackage().claudeCodeVersion;
  if (config.demo) return tested ? { version: tested } : {};
  const file = await claudePath();
  if (!file) return { missing: true };
  const version = await versionOf(file);
  if (version === null && config.claudeExecutable) return { path: file, missing: true };
  return {
    path: file,
    ...(version ? { version } : {}),
    ...(version && tested && isNewer(tested, version) ? { tested } : {}),
  };
}

/** Whether version `a` (x.y.z) comes after `b`. */
export function isNewer(a: string, b: string): boolean {
  const [x, y] = [a, b].map((version) => version.split('.').map((part) => Number.parseInt(part, 10) || 0));
  for (let i = 0; i < 3; i += 1) {
    const difference = (x?.[i] ?? 0) - (y?.[i] ?? 0);
    if (difference) return difference > 0;
  }
  return false;
}

/** The banner's line, and About's, when the Claude Code that runs is older than the one Pelican was tested with. */
export const olderLine = (version: string, tested: string): string => `Claude Code ${version} is older than ${tested}, which Pelican was tested with: run \`claude update\``;

export type SignIn = { loggedIn: boolean; email?: string } | undefined;

/** Whether Claude Code is signed in on this computer, as `claude auth status` says; undefined if it cannot say. */
export async function claudeSignIn(timeout = 5000): Promise<SignIn> {
  const binary = await claudePath();
  if (!binary) return undefined;
  const answer = await run(binary, ['auth', 'status', '--json'], timeout);
  if (!answer) return undefined;
  try {
    const status = JSON.parse(answer.stdout) as { loggedIn?: unknown; email?: unknown };
    if (typeof status.loggedIn !== 'boolean') return undefined;
    return { loggedIn: status.loggedIn, ...(typeof status.email === 'string' && status.email ? { email: status.email } : {}) };
  } catch {
    return undefined;
  }
}

const tilde = (file: string) => {
  const home = os.homedir();
  return file.startsWith(`${home}${path.sep}`) ? `~${file.slice(home.length)}` : file;
};

/** One line for the start banner: which Claude Code, and whether it can work. */
export function claudeCodeLine(code: ClaudeCodeInfo, signIn: SignIn, login: string): string {
  if (code.missing) return code.path ? `Claude Code not found at ${code.path} (PELICAN_CLAUDE_PATH)` : notFoundLine();
  const name = `Claude Code ${code.version ?? ''}`.trim() + (code.path ? ` (${tilde(code.path)})` : '');
  if (!signIn) return name;
  return signIn.loggedIn
    ? `${name} · signed in${signIn.email ? ` as ${signIn.email}` : ''}`
    : `${name} · not signed in: run \`${login}\``;
}

/** Signs Claude Code in with its own `auth login`, in this terminal; resolves to its exit code. */
export async function claudeLogin(): Promise<number> {
  const binary = await claudePath();
  if (!binary) throw new Error(`${notFoundLine()}.`);
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['auth', 'login'], { stdio: 'inherit' });
    // Not there, where PELICAN_CLAUDE_PATH names it: said as the banner says it.
    child.on('error', (error: NodeJS.ErrnoException) => reject(error.code === 'ENOENT' ? new Error(`${claudeCodeLine({ path: binary, missing: true }, undefined, '')}.`) : error));
    child.on('exit', (code) => resolve(code ?? 1));
  });
}
