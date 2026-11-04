import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { config } from './config.js';

/**
 * Sessions put away from the list. Only Pelican keeps this, in its state folder: the transcripts
 * are not touched, so every Claude Code app still has the session, and unarchiving is instant.
 */
const file = () => path.join(config.stateDir, 'archived.json');
let loaded: Promise<Set<string>> | undefined;

function archived(): Promise<Set<string>> {
  loaded ??= readFile(file(), 'utf8')
    .then((text) => new Set((JSON.parse(text) as { ids?: unknown }).ids instanceof Array ? ((JSON.parse(text) as { ids: unknown[] }).ids.filter((id): id is string => typeof id === 'string')) : []))
    .catch(() => new Set<string>());
  return loaded;
}

/** The archived session ids, for the list. */
export async function archivedIds(): Promise<Set<string>> {
  return archived();
}

export async function setArchived(sessionId: string, on: boolean): Promise<void> {
  const ids = await archived();
  if (on) ids.add(sessionId);
  else ids.delete(sessionId);
  await mkdir(path.dirname(file()), { recursive: true, mode: 0o700 });
  const temp = `${file()}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify({ ids: [...ids] }, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file());
}
