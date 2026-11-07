import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { config } from './config.js';

/**
 * A set of session ids only Pelican keeps, in one file of its state folder (the archive, the
 * pins): the transcripts are not touched, and no other app's state is read or written. The file
 * is read once, for the state folder there is then (the demo moves to one of its own); writes go
 * one at a time, each with the whole set as it is then. A file that cannot be read is set aside,
 * not thrown away, and the set starts empty. `emptied` says what that means, for the warning.
 */
export function sessionSet(name: string, emptied: string) {
  const fileNow = () => path.join(config.stateDir, name);
  let loaded: { file: string; ids: Promise<Set<string>> } | undefined;
  let writing: Promise<void> = Promise.resolve();

  async function load(file: string): Promise<Set<string>> {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
      throw error;
    }
    try {
      const ids = (JSON.parse(text) as { ids?: unknown }).ids;
      return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []);
    } catch {
      // Not ours to throw away: kept beside, and the set starts over.
      await rename(file, `${file}.bad-${Date.now()}`).catch(() => undefined);
      console.warn(`[pelican] ${name} could not be read; it was set aside and ${emptied}`);
      return new Set();
    }
  }

  /** The set, and the file it is kept in. */
  function current(): { file: string; ids: Promise<Set<string>> } {
    const file = fileNow();
    if (loaded?.file !== file) {
      const ids = load(file).catch((error: Error) => {
        if (loaded?.ids === ids) loaded = undefined;
        throw error;
      });
      loaded = { file, ids };
    }
    return loaded;
  }

  return {
    /** The ids, for the list; none while the file cannot be read. */
    ids: (): Promise<Set<string>> => current().ids.catch(() => new Set<string>()),
    /** Adds the id (`on`) or takes it out, and writes the set. */
    async set(sessionId: string, on: boolean): Promise<void> {
      const { file, ids: loading } = current();
      const ids = await loading;
      const before = ids.has(sessionId);
      if (on) ids.add(sessionId);
      else ids.delete(sessionId);
      const write = writing.then(async () => {
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        const temp = `${file}.${randomUUID()}.tmp`;
        try {
          await writeFile(temp, `${JSON.stringify({ ids: [...ids] }, null, 2)}\n`, { mode: 0o600 });
          await rename(temp, file);
        } catch (error) {
          await rm(temp, { force: true }).catch(() => undefined);
          throw error;
        }
      });
      writing = write.catch(() => undefined);
      try {
        await write;
      } catch (error) {
        if (before) ids.add(sessionId);
        else ids.delete(sessionId);
        throw error;
      }
    },
  };
}
