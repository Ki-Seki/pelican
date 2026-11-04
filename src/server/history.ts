import { open, stat } from 'node:fs/promises';

import type { ChatMessage } from '../shared/protocol.js';
import { toChatMessage } from './normalize.js';

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
  /** What the app shows for this row; rows like attachments only link the chain. */
  message: ChatMessage | undefined;
};

type Transcript = {
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
};

const CHUNK = 8 * 1024 * 1024;
const MAX_FILES = 16;
const transcripts = new Map<string, Transcript>();
const locks = new Map<string, Promise<unknown>>();

const str = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

function empty(ino: number): Transcript {
  return {
    ino, offset: 0, carry: Buffer.alloc(0), nodes: new Map(), order: [], leaf: undefined,
    chain: [], chainIndex: new Map(), chainLeaf: undefined, messages: [],
  };
}

function addLine(t: Transcript, line: string): void {
  // Rows that take part in the conversation carry a uuid; skip the rest (titles, costs, requests) unparsed.
  if (line.length < 2 || line.charCodeAt(0) !== 123 || !line.includes('"uuid"')) return;
  let row: Record<string, unknown>;
  try {
    row = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  const uuid = str(row.uuid);
  if (!uuid || row.isSidechain === true) return;
  const turn = row.type === 'user' || row.type === 'assistant';
  const message = turn ? toChatMessage(row) : undefined;
  const existing = t.nodes.get(uuid);
  if (existing) {
    existing.message = message;
    return;
  }
  const metadata = row.compactMetadata as { preservedSegment?: { tailUuid?: unknown } } | undefined;
  const node: Node = {
    uuid,
    parent: str(row.parentUuid),
    logicalParent: str(row.logicalParentUuid),
    preservedTail: str(metadata?.preservedSegment?.tailUuid),
    index: t.order.length,
    message,
  };
  t.nodes.set(uuid, node);
  t.order.push(node);
  if (turn) t.leaf = node;
}

async function readNew(file: string, t: Transcript, size: number): Promise<void> {
  const handle = await open(file, 'r');
  try {
    let position = t.offset;
    while (position < size) {
      const buffer = Buffer.allocUnsafe(Math.min(CHUNK, size - position));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead <= 0) break;
      position += bytesRead;
      const data = t.carry.length > 0 ? Buffer.concat([t.carry, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead);
      const lastBreak = data.lastIndexOf(0x0a);
      if (lastBreak < 0) {
        t.carry = Buffer.from(data);
        continue;
      }
      t.carry = Buffer.from(data.subarray(lastBreak + 1));
      for (const line of data.subarray(0, lastBreak).toString('utf8').split('\n')) addLine(t, line);
    }
    t.offset = position;
    // A last row without its newline yet: use it if it is whole; it is read again with the rest later.
    if (t.carry.length > 0) addLine(t, t.carry.toString('utf8'));
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

async function read(file: string): Promise<ChatMessage[]> {
  let info;
  try {
    info = await stat(file);
  } catch {
    transcripts.delete(file);
    return [];
  }
  let t = transcripts.get(file);
  // Replaced or cut short: start over.
  if (!t || t.ino !== info.ino || info.size < t.offset) t = empty(info.ino);
  transcripts.delete(file);
  transcripts.set(file, t);
  while (transcripts.size > MAX_FILES) transcripts.delete(transcripts.keys().next().value!);
  if (info.size > t.offset) await readNew(file, t, info.size);
  return conversation(t);
}

/** The conversation in a transcript file, oldest message first. */
export function readHistory(file: string): Promise<ChatMessage[]> {
  // One read per file at a time: reads build on each other's state.
  const previous = locks.get(file) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => read(file));
  locks.set(file, next);
  void next.finally(() => {
    if (locks.get(file) === next) locks.delete(file);
  }).catch(() => undefined);
  return next;
}
