import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
const mimeOf = (name: string) => MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

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

/** Removes an upload (made for a message that was never sent). */
export async function removeUpload(id: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return;
  await rm(path.join(uploadsDir(), id), { recursive: true, force: true });
}
