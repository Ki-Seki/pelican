import { stat } from 'node:fs/promises';
import path from 'node:path';

import { isPermissionMode } from '../shared/modes.js';
import type { ChatMessage, RecordedSettings } from '../shared/protocol.js';
import { config } from './config.js';
import { type ImageAddress, storedImages, toChatMessage } from './normalize.js';
import { openRegular } from './open.js';

/**
 * A session's whole conversation, read from its transcript, across compactions.
 *
 * Each row of a transcript points at the one before it (`parentUuid`), so the
 * conversation is the chain from the newest message back to the first. A
 * compaction starts a new chain: its boundary row has no parent and points
 * back only through `logicalParentUuid`. Claude Code's own reader stops there,
 * which would leave everything before the last compaction out of reach; here
 * the walk carries on through every boundary. When a boundary points at a row
 * that was never written, the walk carries on from the last message the
 * compaction kept, or else from the row just before the boundary.
 *
 * The messages a compaction keeps verbatim stay where they were, before the
 * boundary; Claude Code's reader shows them again after the summary.
 *
 * A transcript only grows while its session runs, so it is read incrementally:
 * each read parses only the bytes added since the last one.
 */

type Node = {
  uuid: string;
  parent: string | undefined;
  /** On a compaction boundary: the last row before the compaction, and the last message it kept verbatim. */
  logicalParent: string | undefined;
  preservedTail: string | undefined;
  /** Position among the rows that have a uuid, in file order. */
  index: number;
  /** Where the row is in the file, in bytes: its pictures are read from there when a page asks. */
  at: number;
  bytes: number;
  /** What the app shows for this row; rows like attachments only link the chain. */
  message: ChatMessage | undefined;
  /** Roughly what the message keeps in memory. */
  weight: number;
};

type Transcript = {
  /** Where pages load the pictures its messages hold as data. */
  address: ((uuid: string) => ImageAddress) | undefined;
  /** A subagent's own transcript, whose rows are all on a side chain; its pictures are left out. */
  sidechain: boolean;
  /** The settings the session last ran with, in file order. */
  recorded: RecordedSettings;
  ino: number;
  /** Bytes parsed so far, and the start of a line not finished yet. */
  offset: number;
  carry: Buffer;
  nodes: Map<string, Node>;
  order: Node[];
  /** The newest user or assistant row: where the conversation ends. */
  leaf: Node | undefined;
  /** The last walk, reused when the conversation only grew. */
  chain: Node[];
  chainIndex: Map<string, number>;
  chainLeaf: string | undefined;
  messages: ChatMessage[];
  /** What its messages keep in memory, roughly, and when it was last read. */
  weight: number;
  readAt: number;
};

const CHUNK = 8 * 1024 * 1024;
/**
 * Parsed transcripts are kept, so a page or a poll reads only what was added since. They are let
 * go oldest first past this much text (a few long sessions, not a count of files that may each be
 * hundreds of megabytes), and once nobody has read them for a while.
 */
const MAX_WEIGHT = 64 * 1024 * 1024;
const MAX_FILES = 32;
const KEEP_UNREAD_MS = 10 * 60_000;
/**
 * A transcript read this recently is in use (a page follows its session, which grows): it is kept
 * past the budget, or two long sessions in use at once would each evict the other, and every look
 * at one would parse it whole again.
 */
const IN_USE_MS = 60_000;
const transcripts = new Map<string, Transcript>();
const locks = new Map<string, Promise<unknown>>();

const str = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

/** Roughly the characters a value holds: what a parsed message costs to keep. */
function weightOf(value: unknown, depth = 0): number {
  if (typeof value === 'string') return value.length;
  if (value === null || typeof value !== 'object' || depth > 6) return 8;
  let weight = 32;
  for (const item of Array.isArray(value) ? value : Object.values(value)) weight += weightOf(item, depth + 1);
  return weight;
}

function empty(file: string, ino: number, sidechain: boolean): Transcript {
  // The demo's pages are saved as files for the project site, which has no server to ask for a picture.
  const id = encodeURIComponent(path.basename(file, '.jsonl'));
  const address = config.demo || sidechain ? undefined : (uuid: string) => (n: number) => `api/sessions/${id}/images/${encodeURIComponent(uuid)}/${n}`;
  return {
    address, sidechain, recorded: {}, ino, offset: 0, carry: Buffer.alloc(0), nodes: new Map(), order: [], leaf: undefined,
    chain: [], chainIndex: new Map(), chainLeaf: undefined, messages: [], weight: 0, readAt: Date.now(),
  };
}

/**
 * Lets go of transcripts nobody has read for a while, then of the least recently read past the
 * budget, but not of those in use. The one read last stays, however large. One let go while a read
 * of it is under way only means the next read parses it again.
 */
function trim(now = Date.now()): void {
  const newest = [...transcripts.keys()].at(-1);
  let total = 0;
  for (const [file, t] of transcripts) {
    if (file !== newest && now - t.readAt > KEEP_UNREAD_MS) transcripts.delete(file);
    else total += t.weight;
  }
  // In the order they were last read: past the first one in use, all are.
  for (const [file, t] of transcripts) {
    if (file === newest || now - t.readAt < IN_USE_MS || (total <= MAX_WEIGHT && transcripts.size <= MAX_FILES)) break;
    transcripts.delete(file);
    total -= t.weight;
  }
}

setInterval(() => trim(), 60_000).unref();

/** Keeps the settings a row shows the session ran with: the latest row wins. */
function note(recorded: RecordedSettings, row: Record<string, unknown>): void {
  if (row.type === 'assistant') {
    const model = str(row.requestedModel) ?? str((row.message as { model?: unknown } | undefined)?.model);
    if (model && !model.startsWith('<')) recorded.model = model;
    if (str(row.effort)) recorded.effort = str(row.effort);
    const speed = str((row.message as { usage?: { speed?: unknown } } | undefined)?.usage?.speed);
    if (speed) recorded.fast = speed === 'fast';
    recorded.ultracode ??= false;
  } else if (row.type === 'user' && isPermissionMode(row.permissionMode)) {
    recorded.permissionMode = row.permissionMode;
  } else if (row.type === 'attachment') {
    const kind = str((row.attachment as { type?: unknown } | undefined)?.type) ?? '';
    // Claude Code notes ultracode turning on (and off) as attachments.
    if (kind === 'ultra_effort_enter') recorded.ultracode = true;
    else if (/^ultra_effort_(exit|leave|off)/.test(kind)) recorded.ultracode = false;
  }
}

/**
 * A message the user sent while Claude was working, which Claude read at its
 * next step: Claude Code records it as a `queued_command` attachment where it
 * was taken in, not as a user row.
 */
function steeredMessage(row: Record<string, unknown>, uuid: string, address: ImageAddress | undefined): ChatMessage | undefined {
  const attachment = row.attachment as { type?: string; prompt?: unknown; source_uuid?: unknown; commandMode?: unknown } | undefined;
  if (row.type !== 'attachment' || attachment?.type !== 'queued_command') return undefined;
  if (attachment.commandMode !== undefined && attachment.commandMode !== 'prompt') return undefined;
  const message = toChatMessage({ type: 'user', uuid, timestamp: row.timestamp, message: { role: 'user', content: attachment.prompt } }, address);
  if (!message) return undefined;
  const source = str(attachment.source_uuid);
  return { ...message, steered: true, ...(source ? { sourceUuid: source } : {}) };
}

/**
 * A background task's end that came while Claude worked (a workflow's, a command's): Claude Code
 * keeps it as a queued command where Claude took it in, with the same `<task-notification>` it
 * writes as a message of its own between turns.
 */
function queuedNotice(row: Record<string, unknown>, uuid: string): ChatMessage | undefined {
  const attachment = row.attachment as { type?: string; prompt?: unknown; commandMode?: unknown } | undefined;
  if (row.type !== 'attachment' || attachment?.type !== 'queued_command' || attachment.commandMode !== 'task-notification') return undefined;
  if (typeof attachment.prompt !== 'string' || !attachment.prompt.trimStart().startsWith('<task-notification>')) return undefined;
  return toChatMessage({ type: 'user', uuid, timestamp: row.timestamp, message: { role: 'user', content: attachment.prompt } });
}

/** A line of Claude Code's own in the conversation, shown as a note, never as a prompt. */
function noteOf(row: Record<string, unknown>, uuid: string, text: string | undefined): ChatMessage | undefined {
  if (!text?.trim()) return undefined;
  const timestamp = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
  return { uuid, role: 'system', blocks: [{ type: 'text', text }], ...(Number.isNaN(timestamp) ? {} : { timestamp }) };
}

/**
 * What Claude Code wrote into the conversation itself when a command ran in it locally (/cost,
 * /context): the command and its output.
 */
function localCommand(row: Record<string, unknown>, uuid: string): ChatMessage | undefined {
  return row.type === 'system' && row.subtype === 'local_command' ? noteOf(row, uuid, str(row.content)) : undefined;
}

/**
 * Hook feedback (why a tool call was blocked), warnings and notices, as the run showed them while
 * the turn ran, under the same id: without them here, a page that reads the transcript again once
 * the turn ends would lose them. A hook's message is an attachment, which Claude Code says as
 * "<hook> says: …" line by line; 'info' lines are the terminal's transcript view only.
 */
function notice(row: Record<string, unknown>, uuid: string): ChatMessage | undefined {
  if (row.type === 'system' && row.subtype === 'informational') return row.level === 'info' ? undefined : noteOf(row, uuid, str(row.content));
  const hook = row.attachment as { type?: unknown; content?: unknown; hookName?: unknown } | undefined;
  if (row.type !== 'attachment' || hook?.type !== 'hook_system_message' || !str(hook.content)) return undefined;
  const lines = (text: string) => text.replace(/\r\n?|[\v\f\u0085\u2028\u2029]/g, '\n').split('\n');
  const says = `${lines(str(hook.hookName) ?? '').join(' ')} says: `;
  return noteOf(row, uuid, lines(str(hook.content)!).map((line) => says + line).join('\n'));
}

/** Adds one row, found `at` bytes into the file and `bytes` long. */
function addLine(t: Transcript, line: string, at: number, bytes: number): void {
  // Rows that take part in the conversation carry a uuid; skip the rest (titles, costs, requests) unparsed.
  if (line.length < 2 || line.charCodeAt(0) !== 123 || !line.includes('"uuid"')) return;
  let row: Record<string, unknown>;
  try {
    row = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  const uuid = str(row.uuid);
  if (!uuid || (row.isSidechain === true && !t.sidechain)) return;
  note(t.recorded, row);
  const turn = row.type === 'user' || row.type === 'assistant';
  const address = t.address?.(uuid);
  const message = turn
    ? toChatMessage(row, t.sidechain ? 'omit' : address)
    : steeredMessage(row, uuid, address) ?? queuedNotice(row, uuid) ?? localCommand(row, uuid) ?? notice(row, uuid);
  const weight = message ? weightOf(message.blocks) : 0;
  const existing = t.nodes.get(uuid);
  if (existing) {
    t.weight += weight - existing.weight;
    Object.assign(existing, { message, weight, at, bytes });
    return;
  }
  const metadata = row.compactMetadata as { preservedSegment?: { tailUuid?: unknown } } | undefined;
  const node: Node = {
    uuid,
    parent: str(row.parentUuid),
    logicalParent: str(row.logicalParentUuid),
    preservedTail: str(metadata?.preservedSegment?.tailUuid),
    index: t.order.length,
    at,
    bytes,
    message,
    weight,
  };
  t.nodes.set(uuid, node);
  t.order.push(node);
  t.weight += weight + 200;
  if (turn) t.leaf = node;
}

async function readNew(file: string, t: Transcript, size: number): Promise<void> {
  const handle = await openRegular(file);
  try {
    // The offset moves with each chunk, together with the line it may leave unfinished: a read
    // that fails part way carries on from there next time, without reading a line twice.
    while (t.offset < size) {
      const buffer = Buffer.allocUnsafe(Math.min(CHUNK, size - t.offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, t.offset);
      if (bytesRead <= 0) break;
      const data = t.carry.length > 0 ? Buffer.concat([t.carry, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead);
      // Where `data` starts in the file.
      const start = t.offset - t.carry.length;
      const lastBreak = data.lastIndexOf(0x0a);
      t.offset += bytesRead;
      if (lastBreak < 0) {
        t.carry = Buffer.from(data);
        continue;
      }
      t.carry = Buffer.from(data.subarray(lastBreak + 1));
      for (let from = 0; from <= lastBreak;) {
        const end = data.indexOf(0x0a, from);
        addLine(t, data.toString('utf8', from, end), start + from, end - from);
        from = end + 1;
      }
    }
    // A last row without its newline yet: use it if it is whole; it is read again with the rest later.
    if (t.carry.length > 0) addLine(t, t.carry.toString('utf8'), t.offset - t.carry.length, t.carry.length);
  } finally {
    await handle.close();
  }
}

/**
 * The row a compaction boundary continues from. Its logical parent when that
 * was written; otherwise the last message the compaction kept, or the row
 * just before the boundary in the file.
 */
function before(t: Transcript, boundary: Node): Node | undefined {
  return t.nodes.get(boundary.logicalParent!)
    ?? (boundary.preservedTail ? t.nodes.get(boundary.preservedTail) : undefined)
    ?? (boundary.index > 0 ? t.order[boundary.index - 1] : undefined);
}

/** The chain from `from` back to the start, oldest first; stops early where it meets `known`. */
function walk(t: Transcript, from: Node, known?: Map<string, number>): { nodes: Node[]; joinedAt: number } {
  const out: Node[] = [];
  const seen = new Set<string>();
  let node: Node | undefined = from;
  while (node && !seen.has(node.uuid)) {
    const at = known?.get(node.uuid);
    if (at !== undefined) return { nodes: out.reverse(), joinedAt: at };
    seen.add(node.uuid);
    out.push(node);
    if (node.parent) node = t.nodes.get(node.parent);
    else if (node.logicalParent) node = before(t, node);
    else node = undefined;
  }
  return { nodes: out.reverse(), joinedAt: -1 };
}

function conversation(t: Transcript): ChatMessage[] {
  const leaf = t.leaf;
  if (!leaf) return [];
  if (t.chainLeaf === leaf.uuid) return t.messages;
  const { nodes, joinedAt } = walk(t, leaf, t.chainIndex);
  t.chain = joinedAt >= 0 ? t.chain.slice(0, joinedAt + 1).concat(nodes) : nodes;
  t.chainIndex = new Map(t.chain.map((n, i) => [n.uuid, i]));
  t.chainLeaf = leaf.uuid;
  t.messages = t.chain.flatMap((n) => (n.message ? [n.message] : []));
  return t.messages;
}

async function read(file: string, sidechain: boolean): Promise<ChatMessage[]> {
  let info;
  try {
    info = await stat(file);
  } catch {
    transcripts.delete(file);
    return [];
  }
  let t = transcripts.get(file);
  // Replaced or cut short: start over.
  if (!t || t.ino !== info.ino || info.size < t.offset || t.sidechain !== sidechain) t = empty(file, info.ino, sidechain);
  transcripts.delete(file);
  transcripts.set(file, t);
  t.readAt = Date.now();
  if (info.size > t.offset) await readNew(file, t, info.size);
  trim();
  return conversation(t);
}

/** What the session in a transcript file last ran with. */
export async function readRecordedSettings(file: string): Promise<RecordedSettings> {
  await readHistory(file);
  return { ...(transcripts.get(file)?.recorded ?? {}) };
}

/**
 * The conversation in a transcript file, oldest message first. `sidechain`: a subagent's own
 * transcript (a workflow agent's), read the same way, without its pictures.
 */
export function readHistory(file: string, { sidechain = false }: { sidechain?: boolean } = {}): Promise<ChatMessage[]> {
  // One read per file at a time: reads build on each other's state.
  const previous = locks.get(file) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => read(file, sidechain));
  locks.set(file, next);
  void next.finally(() => {
    if (locks.get(file) === next) locks.delete(file);
  }).catch(() => undefined);
  return next;
}

/**
 * A transcript row as Claude Code wrote it, read again from its own place in the file (one row,
 * however long the file): for what its message does not carry, such as its pictures' data or the
 * session it was copied from.
 */
export async function transcriptRow(file: string, uuid: string): Promise<Record<string, unknown> | undefined> {
  await readHistory(file);
  const node = transcripts.get(file)?.nodes.get(uuid);
  if (!node) return undefined;
  let row: Record<string, unknown>;
  const handle = await openRegular(file);
  try {
    const buffer = Buffer.alloc(node.bytes);
    await handle.read(buffer, 0, node.bytes, node.at);
    row = JSON.parse(buffer.toString('utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
  return row.uuid === uuid ? row : undefined;
}

/**
 * The `n`th picture a transcript row holds as data (`storedImages`), decoded: what a page loads
 * by the address its message carries. Read from the row's own place in the file.
 */
export async function transcriptImage(file: string, uuid: string, n: number): Promise<{ mediaType: string; data: Buffer } | undefined> {
  const row = await transcriptRow(file, uuid) as { type?: unknown; message?: { content?: unknown }; attachment?: { type?: unknown; prompt?: unknown } } | undefined;
  if (!row) return undefined;
  // A message sent while Claude worked is an attachment row; its prompt is the content.
  const content = row.type === 'attachment' && row.attachment?.type === 'queued_command' ? row.attachment.prompt : row.message?.content;
  const image = storedImages(content)[n];
  return image && { mediaType: image.mediaType, data: Buffer.from(image.data, 'base64') };
}
