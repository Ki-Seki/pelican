import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * The PTY under each terminal: @lydell/node-pty, which carries the binaries of Microsoft's
 * node-pty (the one VS Code uses) one package per platform, with no install script. It is an
 * optional dependency, loaded the first time a terminal is asked for: where it is missing or cannot
 * load (an install with --omit=optional, musl, a glibc older than 2.28, 32-bit ARM), the terminal
 * says why and nothing else changes. scripts/pty-binaries.mjs checks its binaries against
 * Microsoft's own package.
 */

/** What Pelican uses of node-pty's IPty. */
export type Pty = {
  readonly pid: number;
  /** The program in front: the name of the PTY's foreground process. */
  readonly process: string;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  kill(signal?: string): void;
  /** Closes Pelican's end, then hangs the shell up (Unix). */
  destroy?(): void;
};

export type PtyOptions = { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> };
export type PtySpawn = (file: string, args: string[], options: PtyOptions) => Pty;

const PACKAGE = '@lydell/node-pty';
const platformPackage = () => `${PACKAGE}-${process.platform}-${process.arch}`;
const WORKS_WITHOUT = '! commands work without it.';

/** Where the package is, without running any of it; undefined when it is not installed. */
function located(): string | undefined {
  try {
    return createRequire(import.meta.url).resolve(PACKAGE);
  } catch {
    return undefined;
  }
}

/** The platforms the package has a binary for, from its own package.json. */
function platforms(index: string): string[] {
  try {
    const manifest = JSON.parse(readFileSync(path.join(path.dirname(index), 'package.json'), 'utf8')) as { optionalDependencies?: Record<string, string> };
    return Object.keys(manifest.optionalDependencies ?? {}).map((name) => name.slice(PACKAGE.length + 1));
  } catch {
    return [];
  }
}

/**
 * Why no terminal can start here, found without loading anything; undefined when one may (whether
 * the binary loads shows when it is first used).
 */
export function ptyMissing(): string | undefined {
  if (process.platform === 'win32') return 'There is no terminal on Windows yet. In WSL there is one.';
  const index = located();
  const omitted = (name: string) => `The terminal needs ${name}, which this install left out (npm's --omit=optional does). Install Pelican again without it; ${WORKS_WITHOUT}`;
  if (!index) return omitted(PACKAGE);
  const here = `${process.platform}-${process.arch}`;
  if (!platforms(index).includes(here)) return `There is no terminal for ${here} yet. ${WORKS_WITHOUT}`;
  try {
    createRequire(index).resolve(platformPackage());
  } catch {
    return omitted(platformPackage());
  }
  return undefined;
}

/** The first line of what went wrong, without the package's own advice after it. */
const firstLine = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0]!.trim().replace(/\.$/, '');

let loading: Promise<PtySpawn> | undefined;
let failed: string | undefined;

const importPty = async (): Promise<PtySpawn> => {
  const loaded = (await import('@lydell/node-pty')) as unknown as { spawn?: PtySpawn; default?: { spawn?: PtySpawn } };
  const spawn = loaded.spawn ?? loaded.default?.spawn;
  if (typeof spawn !== 'function') throw new Error(`${PACKAGE} has no spawn`);
  return spawn;
};
let load = importPty;

/** node-pty's spawn, loaded on first use. Rejects with why there is no terminal here. */
export function loadPty(): Promise<PtySpawn> {
  loading ??= (async () => {
    const missing = ptyMissing();
    if (missing) throw new Error(missing);
    try {
      return await load();
    } catch (error) {
      throw new Error(`The terminal could not start here: ${firstLine(error)}. ${WORKS_WITHOUT}`);
    }
  })();
  loading.catch((error: Error) => {
    failed = error.message;
  });
  return loading;
}

/** Why the PTY failed to load, once it was tried and did. */
export const ptyFailure = () => failed;

/** For tests: load the PTY with this instead (the real one when undefined), and forget the last try. */
export function usePtyLoader(loader?: () => Promise<PtySpawn>): void {
  load = loader ?? importPty;
  loading = undefined;
  failed = undefined;
}
