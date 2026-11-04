import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { config } from './config.js';

const realpath = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** Where "New scratch session" makes its folders. */
export const scratchRoot = process.env.PELICAN_SCRATCH_DIR ?? path.join(config.home, 'scratch');

/**
 * Folders nobody chose as a project: the system's temp directories (Claude
 * Code's per-session scratchpads live there, and so do the folders tools
 * make inside them), Claude Desktop's scratch workspaces, and our own scratch
 * folders. Sessions in them are real conversations, but the folders are not
 * places to start new work in.
 */
const scratchRoots = [...new Set([
  '/tmp', '/private/tmp', '/var/folders', '/private/var/folders',
  os.tmpdir(), realpath(os.tmpdir()),
  path.join(config.home, 'Library/Application Support/Claude/scratch-workspaces'),
  scratchRoot,
])].map((p) => p.replace(/\/+$/, ''));

export function isScratchFolder(dir: string): boolean {
  const p = dir.replace(/\/+$/, '');
  return scratchRoots.some((root) => p === root || p.startsWith(`${root}/`));
}

export async function isDirectory(dir: string): Promise<boolean> {
  return stat(dir).then((s) => s.isDirectory(), () => false);
}

/** A new empty folder like `~/scratch/2026-11-05-a1b2`, for a session that belongs to no project. */
export async function createScratchFolder(): Promise<string> {
  const now = new Date();
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const dir = path.join(scratchRoot, `${day}-${randomBytes(2).toString('hex')}`);
  await mkdir(dir, { recursive: true });
  return dir;
}
