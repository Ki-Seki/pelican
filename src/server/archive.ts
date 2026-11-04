import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { config } from './config.js';

/**
 * Sessions put away from the list. Only Pelican keeps this, in its state folder: the transcripts
 * are not touched, so every Claude Code app still has the session, and unarchiving is instant.
 */
const file = () => path.join(config.stateDir, 'archived.json');
let loaded: Promise<Set<string>> | undefined;
let writing: Promise<void> = Promise.resolve();

async function load(): Promise<Set<string>> {
  let text: string;
  try {
    text = await readFile(file(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw error;
  }
  try {
    const ids = (JSON.parse(text) as { ids?: unknown }).ids;
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    // Not ours to throw away: kept beside, and the list starts over.
    await rename(file(), `${file()}.bad-${Date.now()}`).catch(() => undefined);
    console.warn('[pelican] archived.json could not be read; it was set aside and the archive starts empty');
    return new Set();
  }
}

function archived(): Promise<Set<string>> {
  loaded ??= load().catch((error: Error) => {
    loaded = undefined;
    throw error;
  });
  return loaded;
}

/** The archived session ids, for the list. */
export async function archivedIds(): Promise<Set<string>> {
  return archived().catch(() => new Set<string>());
}

/** Archives or unarchives; writes go one at a time, each with the whole list as it is then. */
export async function setArchived(sessionId: string, on: boolean): Promise<void> {
  const ids = await archived();
  const before = ids.has(sessionId);
  if (on) ids.add(sessionId);
  else ids.delete(sessionId);
  const write = writing.then(async () => {
    await mkdir(path.dirname(file()), { recursive: true, mode: 0o700 });
    const temp = `${file()}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify({ ids: [...ids] }, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, file());
  });
  writing = write.catch(() => undefined);
  try {
    await write;
  } catch (error) {
    if (before) ids.add(sessionId);
    else ids.delete(sessionId);
    throw error;
  }
}
