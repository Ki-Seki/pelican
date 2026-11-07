import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Attachment } from '../shared/protocol.js';
import { config } from './config.js';

const uploadsDir = () => path.join(config.stateDir, 'uploads');
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const safeName = (name: string) => name.replace(/[/\\\0]/g, '_').replace(/^\.+/, '_').slice(0, 120) || 'file';

/** Saves an uploaded file where Claude can read it, and returns its handle. */
export async function saveUpload(file: File): Promise<Attachment> {
  if (file.size > MAX_UPLOAD_BYTES) throw new Error(`File is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
  const id = randomUUID();
  const dir = path.join(uploadsDir(), id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const name = safeName(file.name);
  const filePath = path.join(dir, name);
  await writeFile(filePath, Buffer.from(await file.arrayBuffer()), { mode: 0o600 });
  return { id, name, mime: file.type || 'application/octet-stream', size: file.size, path: filePath };
}

/** Looks an upload up by id; the path is rebuilt here, never taken from the client. */
export async function findUpload(id: string): Promise<Attachment | undefined> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return undefined;
  const dir = path.join(uploadsDir(), id);
  try {
    const [name] = await readdir(dir);
    if (!name) return undefined;
    const filePath = path.join(dir, name);
    const info = await stat(filePath);
    return { id, name, mime: mimeOf(name), size: info.size, path: filePath };
  } catch {
    return undefined;
  }
}

export async function readUpload(id: string): Promise<{ attachment: Attachment; data: Buffer } | undefined> {
  const attachment = await findUpload(id);
  if (!attachment) return undefined;
  return { attachment, data: await readFile(attachment.path) };
}

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', json: 'application/json', csv: 'text/csv',
};
// Only the table's own entries: `x.constructor` names what every object has, and is no type.
const mimeOf = (name: string) => {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return (Object.hasOwn(MIME, ext) ? MIME[ext] : undefined) ?? 'application/octet-stream';
};

export type DirListing = { path: string; parent?: string; dirs: Array<{ name: string; path: string }> };

/** Subfolders of a folder, for choosing where a new session runs. */
export async function listDirs(dir: string | undefined, showHidden: boolean): Promise<DirListing> {
  const target = path.resolve(dir || config.home);
  const entries = await readdir(target, { withFileTypes: true });
  const dirs = entries
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && (showHidden || !e.name.startsWith('.')))
    .map((e) => ({ name: e.name, path: path.join(target, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(target);
  return { path: target, ...(parent !== target ? { parent } : {}), dirs };
}

/** Why a folder could not be made, said to the person who asked, with the HTTP status that fits. */
export class FolderError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409) {
    super(message);
  }
}

/**
 * Makes a folder for a new session inside the one being browsed, as a system folder picker's New
 * Folder does: one level, a plain name, never an existing folder. It runs nothing in it.
 */
export async function makeDir(parent: string, name: string): Promise<string> {
  const clean = name.trim();
  if (!clean || clean === '.' || clean === '..' || clean.length > 255 || /[/\\]/.test(clean) || /[\u0000-\u001f\u007f]/.test(clean)) {
    throw new FolderError('Use a folder name without slashes', 400);
  }
  let base: string;
  try {
    base = await realpath(path.resolve(parent));
    if (!(await stat(base)).isDirectory()) throw new Error('not a folder');
  } catch {
    throw new FolderError('That folder is gone', 404);
  }
  const target = path.join(base, clean);
  try {
    await mkdir(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new FolderError(`There is already a ${clean} here`, 409);
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') throw new FolderError('You cannot make a folder here', 403);
    throw error;
  }
  return target;
}

/** Removes an upload (made for a message that was never sent). */
export async function removeUpload(id: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return;
  await rm(path.join(uploadsDir(), id), { recursive: true, force: true });
}

/**
 * How long Claude Code keeps sessions: `cleanupPeriodDays` in its settings, 30 days unless set.
 * Uploads are kept as long: past that, the conversations that used them are gone too.
 */
export async function keepDays(): Promise<number> {
  try {
    const days = (JSON.parse(await readFile(path.join(config.claudeHome, 'settings.json'), 'utf8')) as { cleanupPeriodDays?: unknown }).cleanupPeriodDays;
    // 0 keeps no transcripts at all; an upload still lives through the day it is sent.
    if (typeof days === 'number' && Number.isFinite(days) && days >= 0) return Math.max(1, days);
  } catch {
    // No settings, or not JSON: Claude Code's default.
  }
  return 30;
}

/** Removes uploads older than `maxAgeMs`; returns how many went. */
export async function sweepUploads(maxAgeMs: number, now = Date.now()): Promise<number> {
  let names: string[];
  try {
    names = await readdir(uploadsDir());
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!/^[0-9a-f-]{36}$/.test(name)) continue;
    const dir = path.join(uploadsDir(), name);
    const info = await stat(dir).catch(() => undefined);
    if (!info?.isDirectory() || now - info.mtimeMs < maxAgeMs) continue;
    await rm(dir, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}
