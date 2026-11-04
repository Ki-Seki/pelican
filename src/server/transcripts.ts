import { createReadStream } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import readline from 'node:readline';
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

/** Text blocks of an assistant row, as one line for a session-list preview. */
function replyText(row: { message?: { content?: unknown } }): string | undefined {
  const content = row.message?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((b): b is { type: string; text: string } => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join(' ')
    .replace(/[`*_#>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, 160) : undefined;
}

/**
 * The last user or assistant row, read backwards from the end: its time, the
 * folder and branch it ran in, and the text of Claude's latest reply.
 *
 * Claude Desktop appends metadata rows (titles, cost state) and queued
 * notifications to idle sessions, which moves the file's mtime although
 * nothing was said; only turns count as activity.
 */
export type LastTurn = {
  time: number; cwd?: string; gitBranch?: string; preview?: string;
  /** The row was copied from another session by a fork (it carries `forkedFrom`): nothing ran here then. */
  copied?: boolean;
};

/** After the last turn, how far back to look for a reply with text (tool calls in between). */
const PREVIEW_SCAN = 4 * 1024 * 1024;

export async function readLastTurn(file: string): Promise<LastTurn | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let found: LastTurn | undefined;
  let foundAt = 0;
  try {
    handle = await open(file, 'r');
    const { size } = await handle.stat();
    let end = size;
    let carry = Buffer.alloc(0);
    while (end > 0 && size - end < MAX_SCAN && !(found && foundAt - end > PREVIEW_SCAN)) {
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
        // Past the last turn, only rows with text matter: a reply, or the prompt that started the turn.
        if (found && !line.includes('"type":"text"') && !line.includes('"content":"')) continue;
        try {
          const row = JSON.parse(line) as {
            type?: string; timestamp?: string; isSidechain?: boolean; cwd?: unknown; gitBranch?: unknown; message?: { content?: unknown }; forkedFrom?: unknown;
          };
          if ((row.type !== 'user' && row.type !== 'assistant') || row.isSidechain || typeof row.timestamp !== 'string') continue;
          if (!found) {
            const time = Date.parse(row.timestamp);
            if (Number.isNaN(time)) continue;
            found = {
              time,
              ...(typeof row.cwd === 'string' ? { cwd: row.cwd } : {}),
              ...(typeof row.gitBranch === 'string' ? { gitBranch: row.gitBranch } : {}),
              ...(row.forkedFrom ? { copied: true } : {}),
            };
            foundAt = end;
          }
          if (row.type === 'assistant') {
            const preview = replyText(row);
            if (preview) return { ...found, preview };
          } else if (found && row.type === 'user' && typeof (row.message as { content?: unknown })?.content === 'string') {
            // Reached the prompt before any reply text: the turn has said nothing yet.
            return found;
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
  return found;
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

const HEAD_SCAN = 64 * 1024 * 1024;
const headCache = new Map<string, string | null>();

/**
 * The session id on the first prompt or reply of a transcript. It is the file's own id, except
 * in a copy of another session: Claude Desktop's side chats start with the whole conversation
 * they came from, rows and ids unchanged. A file only grows at its end, so an answer is kept;
 * a file that holds no turn yet is asked again next time.
 */
export async function firstTurnSession(file: string): Promise<string | undefined> {
  const cached = headCache.get(file);
  if (cached !== undefined) return cached ?? undefined;
  let found: string | undefined;
  let read = 0;
  try {
    const lines = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        read += line.length + 1;
        if (read > HEAD_SCAN) break;
        if (!line.includes('"sessionId"') || !(line.includes('"type":"user"') || line.includes('"type":"assistant"'))) continue;
        try {
          const row = JSON.parse(line) as { type?: string; sessionId?: unknown; isSidechain?: boolean };
          if ((row.type === 'user' || row.type === 'assistant') && !row.isSidechain && typeof row.sessionId === 'string') {
            found = row.sessionId;
            break;
          }
        } catch {
          // A row being written.
        }
      }
    } finally {
      lines.close();
    }
  } catch {
    return undefined; // Missing or unreadable.
  }
  if (found) {
    if (headCache.size > 10_000) headCache.clear();
    headCache.set(file, found);
  }
  return found;
}

/** An image of a prompt as the transcript holds it, in full (the message list leaves big ones out). */
export type RawImage = { type: 'base64'; mediaType: string; data: string } | { type: 'url' };

/**
 * The images of one message, in the order and by the rules the message list uses (base64 and
 * url images; anything else is not an image there), read from the transcript row itself.
 */
export async function rawImages(file: string, uuid: string): Promise<RawImage[]> {
  const needle = `"uuid":"${uuid}"`;
  const lines = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.includes(needle)) continue;
      let row: { uuid?: unknown; message?: { content?: unknown } };
      try {
        row = JSON.parse(line) as typeof row;
      } catch {
        continue;
      }
      if (row.uuid !== uuid) continue;
      const content = row.message?.content;
      if (!Array.isArray(content)) return [];
      const images: RawImage[] = [];
      for (const block of content as Array<{ type?: unknown; source?: { type?: unknown; data?: unknown; media_type?: unknown; url?: unknown } }>) {
        if (block?.type !== 'image' || !block.source) continue;
        if (block.source.type === 'base64' && typeof block.source.data === 'string') {
          images.push({ type: 'base64', mediaType: typeof block.source.media_type === 'string' ? block.source.media_type : 'image/png', data: block.source.data });
        } else if (block.source.type === 'url' && typeof block.source.url === 'string') {
          images.push({ type: 'url' });
        }
      }
      return images;
    }
  } finally {
    lines.close();
  }
  return [];
}
