import { execFile, spawn } from 'node:child_process';
import { constants, existsSync, readFileSync } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { config } from './config.js';

/**
 * The Claude Code that Pelican runs: the one the Agent SDK bundles, or the one PELICAN_CLAUDE_PATH
 * names. Bug reports need its version, and the start banner says whether it is signed in, since a
 * signed-out Claude Code otherwise shows only when the first message fails. The banner and About
 * also say when the user's own `claude` is newer, since its new features reach Pelican only with
 * an update.
 */

const require = createRequire(import.meta.url);

/** The Agent SDK's package.json: its own version and the version of the Claude Code it bundles. */
export function sdkPackage(): { version?: string; claudeCodeVersion?: string } {
  try {
    const entry = require.resolve('@anthropic-ai/claude-agent-sdk');
    return JSON.parse(readFileSync(path.join(path.dirname(entry), 'package.json'), 'utf8')) as { version?: string; claudeCodeVersion?: string };
  } catch {
    return {};
  }
}

/** The bundled binary, found the way the SDK finds it (its platform package). */
export function bundledClaude(): string | undefined {
  const exe = process.platform === 'win32' ? '.exe' : '';
  const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  const names = process.platform === 'linux' ? [base, `${base}-musl`] : [base];
  for (const name of names) {
    try {
      const file = require.resolve(`${name}/claude${exe}`);
      if (existsSync(file)) return file;
    } catch {
      // Not installed for this platform; try the next.
    }
  }
  return undefined;
}

/** The binary Pelican starts: PELICAN_CLAUDE_PATH, else the bundled one. */
export const claudeBinary = (): string | undefined => config.claudeExecutable ?? bundledClaude();

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

export type ClaudeCodeInfo = { version?: string; path?: string; missing?: boolean };

let info: Promise<ClaudeCodeInfo> | undefined;

/**
 * Which Claude Code runs and its version: the bundled one's from the SDK's package.json (nothing
 * runs), one named by PELICAN_CLAUDE_PATH by asking it. `path` is set only for the latter.
 */
export function claudeCodeInfo(): Promise<ClaudeCodeInfo> {
  info ??= (async () => {
    if (!config.claudeExecutable) {
      const version = sdkPackage().claudeCodeVersion;
      return bundledClaude() ? { ...(version ? { version } : {}) } : { missing: true };
    }
    const answer = await run(config.claudeExecutable, ['--version'], 5000);
    const version = answer?.stdout.match(/\d+\.\d+\.\d+/)?.[0];
    return { path: config.claudeExecutable, ...(version ? { version } : {}), ...(answer ? {} : { missing: true }) };
  })();
  return info;
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

/**
 * The first `claude` on PATH, as a shell finds it, but in absolute folders only: an empty or
 * relative entry would run a `claude` from whatever folder Pelican was started in.
 */
export async function claudeOnPath(PATH = process.env.PATH ?? ''): Promise<string | undefined> {
  const name = process.platform === 'win32' ? 'claude.exe' : 'claude';
  for (const dir of PATH.split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const file = path.join(dir, name);
    try {
      await access(file, constants.X_OK);
      if ((await stat(file)).isFile()) return file;
    } catch {
      // Not in this folder.
    }
  }
  return undefined;
}

/** The version of the `claude` on PATH when it is newer than `ours`; undefined when not, or when it cannot say in time. */
export async function newerOnPath(ours: string, PATH?: string, timeout = 3000): Promise<string | undefined> {
  const file = await claudeOnPath(PATH);
  if (!file) return undefined;
  const answer = await run(file, ['--version'], timeout);
  const version = answer?.code === 0 ? /\d+\.\d+\.\d+/.exec(answer.stdout)?.[0] : undefined;
  return version && isNewer(version, ours) ? version : undefined;
}

let newer: Promise<string | undefined> | undefined;
let newerFound: string | undefined;

/**
 * The version of the user's own `claude` when it is newer than the Claude Code Pelican brings:
 * that one has what Pelican gets only from an update. Asked once, at start, in the background.
 * Not when PELICAN_CLAUDE_PATH names the Claude Code to run, the user's choice already, nor in
 * the demo, which runs nothing.
 */
export function checkNewerClaude(): Promise<string | undefined> {
  newer ??= (async () => {
    const ours = config.claudeExecutable || config.demo ? undefined : (await claudeCodeInfo()).version;
    newerFound = ours ? await newerOnPath(ours) : undefined;
    return newerFound;
  })();
  return newer;
}

/** What the check at start found so far, without waiting for it. */
export const newerClaude = (): string | undefined => newerFound;

/** The banner's line when the user's own `claude` is newer than the Claude Code Pelican runs. */
export const newerClaudeLine = (version: string): string => `Your claude is newer (${version}): update Pelican to get it`;

export type SignIn = { loggedIn: boolean; email?: string } | undefined;

/** Whether Claude Code is signed in on this computer, as `claude auth status` says; undefined if it cannot say. */
export async function claudeSignIn(timeout = 5000): Promise<SignIn> {
  const binary = claudeBinary();
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

/** One line for the start banner: which Claude Code, and whether it can work. */
export function claudeCodeLine(code: ClaudeCodeInfo, signIn: SignIn, login: string): string {
  if (code.missing) {
    return code.path
      ? `Claude Code not found at ${code.path} (PELICAN_CLAUDE_PATH)`
      : 'Claude Code is missing: reinstall Pelican (npm install -g pelican-cc)';
  }
  const name = `Claude Code ${code.version ?? ''}`.trim() + (code.path ? ` (${code.path})` : '');
  if (!signIn) return name;
  return signIn.loggedIn
    ? `${name} · signed in${signIn.email ? ` as ${signIn.email}` : ''}`
    : `${name} · not signed in: run \`${login}\``;
}

/** Signs Claude Code in with its own `auth login`, in this terminal; resolves to its exit code. */
export function claudeLogin(): Promise<number> {
  const binary = claudeBinary();
  if (!binary) return Promise.reject(new Error('Claude Code is missing: reinstall Pelican (npm install -g pelican-cc).'));
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['auth', 'login'], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}
