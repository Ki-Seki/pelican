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
const tempRoots = [...new Set(['/tmp', '/private/tmp', '/var/folders', '/private/var/folders', os.tmpdir(), realpath(os.tmpdir())])]
  .map((p) => p.replace(/\/+$/, ''));
const scratchRoots = [path.join(config.home, 'Library/Application Support/Claude/scratch-workspaces'), scratchRoot]
  .map((p) => p.replace(/\/+$/, ''));

const under = (dir: string, roots: string[]) => {
  const p = dir.replace(/\/+$/, '');
  return roots.some((root) => p === root || p.startsWith(`${root}/`));
};

/**
 * temp: inside the system's temp directory. Mostly runs another session
 * started (Claude Code's per-session scratchpads live there); the OS cleans
 * these folders up. scratch: a session you started without a project, in
 * Claude Desktop or here; a real conversation in a throwaway folder.
 */
export function folderKind(dir: string): 'project' | 'scratch' | 'temp' {
  // The demo's made-up home can itself be in a temp folder (the scripts that record it put it
  // there): its folders are what they pretend to be.
  if (config.demo && under(dir, [config.home.replace(/\/+$/, '')])) return under(dir, scratchRoots) ? 'scratch' : 'project';
  if (under(dir, tempRoots)) return 'temp';
  if (under(dir, scratchRoots)) return 'scratch';
  return 'project';
}

export function isScratchFolder(dir: string): boolean {
  return folderKind(dir) !== 'project';
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
