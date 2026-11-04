import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { config } from './config.js';

const projectsDir = () => path.join(config.claudeHome, 'projects');

let index = new Map<string, string>();
let indexBuiltAt = 0;

/** Rebuilds the sessionId → transcript path index from `~/.claude/projects/<dir>/<id>.jsonl`. */
async function rebuildIndex(): Promise<void> {
  const next = new Map<string, string>();
  let dirs: string[] = [];
  try {
    dirs = await readdir(projectsDir());
  } catch {
    // No projects yet.
  }
  await Promise.all(dirs.map(async (dir) => {
    try {
      for (const name of await readdir(path.join(projectsDir(), dir))) {
        if (name.endsWith('.jsonl')) next.set(name.slice(0, -'.jsonl'.length), path.join(projectsDir(), dir, name));
      }
    } catch {
      // Not a directory, or removed meanwhile.
    }
  }));
  index = next;
  indexBuiltAt = Date.now();
}

/** Path of a session's transcript, or undefined when it does not exist (yet). */
export async function transcriptPath(sessionId: string): Promise<string | undefined> {
  if (!index.has(sessionId) && Date.now() - indexBuiltAt > 1000) await rebuildIndex();
  return index.get(sessionId);
}

export async function refreshTranscriptIndex(): Promise<void> {
  await rebuildIndex();
}

const CHUNK = 256 * 1024;
const MAX_SCAN = 16 * 1024 * 1024;

/**
 * Timestamp (ms) of the last user or assistant row, read backwards from the end.
 *
 * Claude Desktop appends metadata rows (titles, cost state) and queued
 * notifications to idle sessions, which moves the file's mtime although
 * nothing was said; only turns count as activity.
 */
export type LastTurn = { time: number; cwd?: string; gitBranch?: string };

export async function readLastTurn(file: string): Promise<LastTurn | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, 'r');
    const { size } = await handle.stat();
    let end = size;
    let carry = Buffer.alloc(0);
    while (end > 0 && size - end < MAX_SCAN) {
      const start = Math.max(0, end - CHUNK);
      const chunk = Buffer.alloc(end - start);
      await handle.read(chunk, 0, chunk.length, start);
      let data = Buffer.concat([chunk, carry]);
      end = start;
      if (start > 0) {
        const firstBreak = data.indexOf(0x0a);
        if (firstBreak < 0) {
          carry = data;
          continue;
        }
        carry = data.subarray(0, firstBreak);
        data = data.subarray(firstBreak + 1);
      }
      const lines = data.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i]!;
        if (!line.includes('"timestamp"') || !(line.includes('"type":"user"') || line.includes('"type":"assistant"'))) continue;
        try {
          const row = JSON.parse(line) as { type?: string; timestamp?: string; isSidechain?: boolean; cwd?: unknown; gitBranch?: unknown };
          if ((row.type === 'user' || row.type === 'assistant') && !row.isSidechain && typeof row.timestamp === 'string') {
            const time = Date.parse(row.timestamp);
            if (!Number.isNaN(time)) {
              return {
                time,
                ...(typeof row.cwd === 'string' ? { cwd: row.cwd } : {}),
                ...(typeof row.gitBranch === 'string' ? { gitBranch: row.gitBranch } : {}),
              };
            }
          }
        } catch {
          // A row can be half-written while Claude is streaming into the file.
        }
      }
    }
  } catch {
    // Missing or unreadable.
  } finally {
    await handle?.close();
  }
  return undefined;
}

const lastTurnCache = new Map<string, { size: number; mtimeMs: number; value: LastTurn | undefined }>();

/**
 * `readLastTurn`, cached by file size and mtime. The row also gives the
 * session's folder and branch, which the SDK misses when Desktop has put
 * metadata rows at the head of the file.
 */
export async function lastTurnTime(file: string): Promise<{ lastTurn?: LastTurn; mtimeMs: number; size: number } | undefined> {
  let info;
  try {
    info = await stat(file);
  } catch {
    return undefined;
  }
  const cached = lastTurnCache.get(file);
  if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
    return { lastTurn: cached.value, mtimeMs: info.mtimeMs, size: info.size };
  }
  const value = await readLastTurn(file);
  lastTurnCache.set(file, { size: info.size, mtimeMs: info.mtimeMs, value });
  return { lastTurn: value, mtimeMs: info.mtimeMs, size: info.size };
}
