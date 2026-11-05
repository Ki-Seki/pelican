import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { config } from './config.js';

/**
 * The Claude Code that Pelican runs: the one the Agent SDK bundles, or the one PELICAN_CLAUDE_PATH
 * names. Bug reports need its version, and the start banner says whether it is signed in, since a
 * signed-out Claude Code otherwise shows only when the first message fails.
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
