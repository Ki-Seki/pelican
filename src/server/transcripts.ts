import { readdir, stat } from 'node:fs/promises';
import readline from 'node:readline';
import path from 'node:path';

import { stoppedBecause } from '../shared/errors.js';
import { config } from './config.js';
import { openRegular } from './open.js';

const projectsDir = () => path.join(config.claudeHome, 'projects');

let index = new Map<string, string>();
let indexBuiltAt = 0;

/** A session's transcript, as Claude Code names it: `<session uuid>.jsonl`. */
const TRANSCRIPT = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export type TranscriptFile = { id: string; file: string };

/**
 * Rebuilds the sessionId → transcript path index from `~/.claude/projects/<dir>/<id>.jsonl`, and
 * returns every transcript found (a session copied into two projects has two).
 */
async function rebuildIndex(): Promise<TranscriptFile[]> {
  const next = new Map<string, string>();
  const found: TranscriptFile[] = [];
  let dirs: string[] = [];
  try {
    dirs = await readdir(projectsDir());
  } catch {
    // No projects yet.
  }
  await Promise.all(dirs.map(async (dir) => {
    try {
      for (const name of await readdir(path.join(projectsDir(), dir))) {
        if (!name.endsWith('.jsonl')) continue;
        const file = path.join(projectsDir(), dir, name);
        next.set(name.slice(0, -'.jsonl'.length), file);
        const id = TRANSCRIPT.exec(name)?.[1];
        if (id) found.push({ id, file });
      }
    } catch {
      // Not a directory, or removed meanwhile.
    }
  }));
  index = next;
  indexBuiltAt = Date.now();
  return found;
}

/** Every session transcript on this machine, looked up afresh. */
export function transcriptFiles(): Promise<TranscriptFile[]> {
  return rebuildIndex();
}

/** Runs at most `max` of the jobs given to it at a time; the others wait their turn. */
export function limiter(max: number): <T>(job: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async (job) => {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await job();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

/** Path of a session's transcript, or undefined when it does not exist (yet). */
export async function transcriptPath(sessionId: string): Promise<string | undefined> {
  if (!index.has(sessionId) && Date.now() - indexBuiltAt > 1000) await rebuildIndex();
  return index.get(sessionId);
}

export async function refreshTranscriptIndex(): Promise<void> {
  await rebuildIndex();
}

/** The last turn is usually in the last few kilobytes; each read back takes twice the one before. */
const FIRST_CHUNK = 32 * 1024;
const MAX_CHUNK = 1024 * 1024;
const MAX_SCAN = 16 * 1024 * 1024;

/**
 * Markdown as one line of plain text. Marks go by where they stand, not wherever the characters
 * appear: `export_rows`, `__init__.py` and `a > b` keep theirs, which a coding session's replies
 * are full of.
 */
export function plainText(markdown: string): string {
  return markdown
    // Claude Desktop's tag for a pull request Claude made, which the conversation shows as a card: on
    // a line of its own it reads as nothing, among words as its address, as there.
    .replace(/^[ \t]*<pr-created>\s*(https?:\/\/\S+?)\s*<\/pr-created>[ \t]*$/gim, '')
    .replace(/<pr-created>\s*(https?:\/\/\S+?)\s*<\/pr-created>/gi, '$1')
    .replace(/^ {0,3}(`{3,}|~{3,}).*$/gm, '')
    .replace(/^[\s|:-]*-{3,}[\s|:-]*$/gm, '')
    .replace(/^ {0,3}#{1,6}\s+/gm, '')
    .replace(/^ {0,3}(?:>\s?)+/gm, '')
    .replace(/!?\[([^\]\n]*)\]\([^)\s]*\)/g, '$1')
    // Code as it is; emphasis unwrapped only around whole words, so `__init__.py` stays.
    .replace(INLINE, (_, ticks: string | undefined, code: string, before: string, _mark: string, inner: string) => (ticks ? code : `${before}${inner}`))
    .replace(/`+/g, '')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A code span, or emphasis around words: `**`, `__`, `*` or `_`, closed before a space, punctuation
 * or the end. Emphasis spans a few hundred characters at most: a mark that never closes is then
 * looked past in that many steps, not in as many as the rest of its line has, which made a long line
 * of `_names` take seconds.
 */
const INLINE = /(`+)([^`]*?)\1|(^|[\s(])(\*\*|__|\*|_)(?![*_\s])(.{0,300}?[^*_\s])\4(?=$|\s|[).,;:!?](?:\s|$))/gm;

/** How much of a reply can reach its 160-character preview, with room for the marks it loses on the way. */
const PREVIEW_SOURCE = 4000;

/** The text blocks of a row's message, joined. */
function textOf(row: { message?: { content?: unknown } }): string {
  const content = row.message?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: string; text: string } => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n\n');
}

/** Text blocks of an assistant row, as one line for a session-list preview: only its start is read. */
function replyText(row: { message?: { content?: unknown } }): string | undefined {
  const text = plainText(textOf(row).slice(0, PREVIEW_SOURCE));
  return text ? text.slice(0, 160) : undefined;
}

type Row = {
  type?: string; timestamp?: string; isSidechain?: boolean; cwd?: unknown; gitBranch?: unknown; forkedFrom?: unknown;
  message?: { content?: unknown; model?: unknown }; isApiErrorMessage?: unknown; error?: unknown;
};

/** Claude Code's note that the API call failed, written as a reply of its own (in the stream: an `error` on a synthetic message). */
const apiError = (row: Row) => row.isApiErrorMessage === true || (typeof row.error === 'string' && row.message?.model === '<synthetic>');

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
  /** The latest turn ended on an API error Claude Code noted in place of a reply: why, in a few words. */
  stopped?: string;
  /** The row was copied from another session by a fork (it carries `forkedFrom`): nothing ran here then. */
  copied?: boolean;
  /** After its last turn the session went on in another one (a background session handed off). */
  continuedIn?: string;
  /**
   * The end of the file holds a summary Claude Code wrote and no last prompt: the SDK titles the
   * session with that summary, not with a prompt (see sessionTitle).
   */
  summarized?: boolean;
};

/** After the last turn, how far back to look for a reply with text (tool calls in between). */
const PREVIEW_SCAN = 4 * 1024 * 1024;

export async function readLastTurn(file: string): Promise<LastTurn | undefined> {
  let handle: Awaited<ReturnType<typeof openRegular>> | undefined;
  let found: LastTurn | undefined;
  let foundAt = 0;
  let continuedIn: string | undefined;
  let summarized: boolean | undefined;
  const done = (turn: LastTurn | undefined) => (turn && summarized ? { ...turn, summarized: true } : turn);
  try {
    handle = await openRegular(file);
    const { size } = await handle.stat();
    let end = size;
    let carry = Buffer.alloc(0);
    let step = FIRST_CHUNK;
    while (end > 0 && size - end < MAX_SCAN && !(found && foundAt - end > PREVIEW_SCAN)) {
      const start = Math.max(0, end - step);
      step = Math.min(step * 2, MAX_CHUNK);
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
      const text = data.toString('utf8');
      // Where the SDK finds a session's title: a last prompt, else a summary row, in the file's end.
      summarized ??= !text.includes('"lastPrompt":"') && text.includes('"type":"summary"');
      const lines = text.split('\n');
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i]!;
        if (!found && !continuedIn && line.includes('"type":"continued-in"')) {
          try {
            const id = (JSON.parse(line) as { continuedInSessionId?: unknown }).continuedInSessionId;
            if (typeof id === 'string') continuedIn = id;
          } catch {
            // Half written.
          }
          continue;
        }
        if (!line.includes('"timestamp"') || !(line.includes('"type":"user"') || line.includes('"type":"assistant"'))) continue;
        // Past the last turn, only rows with text matter: a reply, or the prompt that started the turn.
        if (found && !line.includes('"type":"text"') && !line.includes('"content":"')) continue;
        try {
          const row = JSON.parse(line) as Row;
          if ((row.type !== 'user' && row.type !== 'assistant') || row.isSidechain || typeof row.timestamp !== 'string') continue;
          if (!found) {
            const time = Date.parse(row.timestamp);
            if (Number.isNaN(time)) continue;
            found = {
              time,
              ...(typeof row.cwd === 'string' ? { cwd: row.cwd } : {}),
              ...(typeof row.gitBranch === 'string' ? { gitBranch: row.gitBranch } : {}),
              ...(row.forkedFrom ? { copied: true } : {}),
              ...(continuedIn ? { continuedIn } : {}),
            };
            foundAt = end;
          }
          if (row.type === 'assistant') {
            // Not Claude's words: the list says why the turn stopped instead.
            if (apiError(row)) return done({ ...found, stopped: stoppedBecause(textOf(row), typeof row.error === 'string' ? row.error : undefined) });
            const preview = replyText(row);
            if (preview) return done({ ...found, preview });
          } else if (found && row.type === 'user' && typeof row.message?.content === 'string') {
            // Reached the prompt before any reply text: the turn has said nothing yet.
            return done(found);
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
  return done(found);
}

const lastTurnCache = new Map<string, { size: number; mtimeMs: number; value: LastTurn | undefined }>();
/** A first list after a start reads every transcript's end: a few at a time, not thousands at once. */
const reading = limiter(16);

/**
 * `readLastTurn`, cached by file size and mtime. The row also gives the
 * session's folder and branch, which the SDK misses when Desktop has put
 * metadata rows at the head of the file. `known` is a stat the caller made
 * just now.
 */
export async function lastTurnTime(file: string, known?: { size: number; mtimeMs: number }): Promise<{ lastTurn?: LastTurn; mtimeMs: number; size: number } | undefined> {
  let info = known;
  if (!info) {
    try {
      info = await stat(file);
    } catch {
      return undefined;
    }
  }
  const { size, mtimeMs } = info;
  const cached = lastTurnCache.get(file);
  if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return { lastTurn: cached.value, mtimeMs, size };
  const value = await reading(() => readLastTurn(file));
  lastTurnCache.set(file, { size, mtimeMs, value });
  return { lastTurn: value, mtimeMs, size };
}

/** Forgets what was read of files that are gone. */
export function forgetTranscripts(present: Set<string>): void {
  for (const file of lastTurnCache.keys()) if (!present.has(file)) lastTurnCache.delete(file);
  for (const key of titleScans.keys()) if (!present.has(key.slice(0, key.lastIndexOf('\n')))) titleScans.delete(key);
}

const HEAD_SCAN = 64 * 1024 * 1024;
const headCache = new Map<string, string | null>();

/**
 * The session id on the first prompt or reply of a transcript. It is the file's own id, except
 * in a copy of another session: Claude Desktop's side chats start with the whole conversation
 * they came from, rows and ids unchanged, and the Agent SDK's forks (Pelican's side chats) with
 * rows that carry the copy's id and name the session each came from (`forkedFrom`). A file only
 * grows at its end, so an answer is kept; a file that holds no turn yet is asked again next time.
 */
export async function firstTurnSession(file: string): Promise<string | undefined> {
  const cached = headCache.get(file);
  if (cached !== undefined) return cached ?? undefined;
  const own = path.basename(file, '.jsonl');
  let found: string | undefined;
  let read = 0;
  try {
    const input = (await openRegular(file)).createReadStream();
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        read += line.length + 1;
        if (read > HEAD_SCAN) break;
        if (!line.includes('"sessionId"') || !(line.includes('"type":"user"') || line.includes('"type":"assistant"'))) continue;
        try {
          const row = JSON.parse(line) as { type?: string; sessionId?: unknown; isSidechain?: boolean; forkedFrom?: { sessionId?: unknown } };
          if ((row.type === 'user' || row.type === 'assistant') && !row.isSidechain && typeof row.sessionId === 'string') {
            const from = row.forkedFrom?.sessionId;
            found = row.sessionId === own && typeof from === 'string' && from ? from : row.sessionId;
            break;
          }
        } catch {
          // A row being written.
        }
      }
    } finally {
      lines.close();
      input.destroy();
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

/** How much of a transcript a look for a title reads at a time. */
export const TITLE_READ = 1024 * 1024;
/** A title row is far shorter: a line longer than this is something else, and is not kept while it is read. */
const TITLE_LINE = 64 * 1024;
const titleScans = new Map<string, { ino: number; size: number; offset: number; found: boolean }>();

/**
 * Whether a transcript's session was ever given this title, anywhere in the file: a custom-title
 * row under the file's own id, not one copied with another session's rows. Claude Code and Claude
 * Desktop add title rows as they go, so the last title need not be it. A file only grows at its
 * end: each look reads on from the last whole line the one before read, and a title once found
 * stays found.
 */
export async function everTitled(file: string, title: string): Promise<boolean> {
  const key = `${file}\n${title}`;
  const known = titleScans.get(key);
  if (known?.found) return true;
  const own = path.basename(file, '.jsonl');
  // As Claude Code writes the row; quotes inside a string are escaped, so text that names it never matches.
  const needle = Buffer.from(`"customTitle":${JSON.stringify(title)}`);
  const isTitle = (line: Buffer) => {
    if (!line.includes(needle)) return false;
    try {
      const row = JSON.parse(line.toString('utf8')) as { type?: unknown; customTitle?: unknown; sessionId?: unknown };
      return row.type === 'custom-title' && row.customTitle === title && row.sessionId === own;
    } catch {
      return false;
    }
  };
  let handle: Awaited<ReturnType<typeof openRegular>> | undefined;
  try {
    handle = await openRegular(file);
    const { size, ino } = await handle.stat();
    // Rewritten rather than grown: from the start again.
    const again = !known || known.ino !== ino || known.size > size;
    if (!again && known.size === size) return false;
    let offset = again ? 0 : known.offset;
    let found = false;
    // The start of the line the last read left open; undefined once it is too long to be a title row.
    let open: Buffer | undefined = Buffer.alloc(0);
    for (let position = offset; position < size && !found;) {
      const chunk = Buffer.alloc(Math.min(TITLE_READ, size - position));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      const data = chunk.subarray(0, bytesRead);
      position += bytesRead;
      const first = data.indexOf(0x0a);
      if (first < 0) {
        open = open && open.length + data.length <= TITLE_LINE ? Buffer.concat([open, data]) : undefined;
        continue;
      }
      if (open && open.length + first <= TITLE_LINE && isTitle(Buffer.concat([open, data.subarray(0, first)]))) found = true;
      const last = data.lastIndexOf(0x0a);
      for (let at = data.indexOf(needle, first); at >= 0 && at < last && !found; at = data.indexOf(needle, at + 1)) {
        if (isTitle(data.subarray(data.lastIndexOf(0x0a, at) + 1, data.indexOf(0x0a, at)))) found = true;
      }
      const rest = data.subarray(last + 1);
      open = rest.length <= TITLE_LINE ? rest : undefined;
      offset = position - rest.length;
    }
    titleScans.set(key, { ino, size, offset, found });
    return found;
  } catch {
    return false; // Missing or unreadable.
  } finally {
    await handle?.close();
  }
}

/** An image of a prompt as the transcript holds it, in full (the message list leaves big ones out). */
export type RawImage = { type: 'base64'; mediaType: string; data: string } | { type: 'url' };

/** One row of a transcript, as written: what it follows in the chain, and its content. */
export type RawEntry = { parentUuid: string | null; content: unknown };

/** The transcript row with this uuid, read from the file itself. */
export async function rawEntry(file: string, uuid: string): Promise<RawEntry | undefined> {
  const needle = `"uuid":"${uuid}"`;
  const input = await openRegular(file).then((handle) => handle.createReadStream(), () => undefined);
  if (!input) return undefined;
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.includes(needle)) continue;
      let row: { uuid?: unknown; parentUuid?: unknown; type?: unknown; message?: { content?: unknown }; attachment?: { type?: unknown; prompt?: unknown } };
      try {
        row = JSON.parse(line) as typeof row;
      } catch {
        continue;
      }
      if (row.uuid !== uuid) continue;
      // A message sent while Claude worked is an attachment row; its prompt is the content.
      const content = row.type === 'attachment' && row.attachment?.type === 'queued_command' ? row.attachment.prompt : row.message?.content;
      return { parentUuid: typeof row.parentUuid === 'string' ? row.parentUuid : null, content };
    }
  } catch {
    return undefined;
  } finally {
    lines.close();
    input.destroy();
  }
  return undefined;
}

/**
 * The images of one message, in the order and by the rules the message list uses (base64 and
 * url images; anything else is not an image there), read from the transcript row itself.
 */
export async function rawImages(file: string, uuid: string): Promise<RawImage[]> {
  const content = (await rawEntry(file, uuid))?.content;
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
