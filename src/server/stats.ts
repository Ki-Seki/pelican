import { createHash, randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  type AppName, appOf, type LimitKind, limitKind, modelName, noTokens, type SessionUsage, type Tokens, tokenTotal,
  type UsageRange, type UsageSession, type UsageSummary,
} from '../shared/usage.js';
import { config } from './config.js';
import { connect } from './feed.js';
import { folderKind } from './folders.js';
import { openRegular } from './open.js';
import { limiter } from './transcripts.js';

/**
 * Usage and activity across every Claude Code session on this computer, whichever app ran it,
 * from the transcripts Claude Code writes (`~/.claude/projects`), as Claude Code's /usage and
 * /stats count them:
 * - Tokens by kind come from each API reply's `usage`. Claude Code writes a reply that has several
 *   content blocks as several rows with the same usage, and copies conversations into side chats,
 *   branches and forks: each reply counts once, for the transcript it first appeared in.
 * - A subagent's transcript (`<session>/subagents/…/agent-*.jsonl`) adds to its session's tokens,
 *   but is not a session of its own; neither are subagent rows in the main transcript.
 * - Days are UTC dates, as /stats counts them; hours of the day are this computer's.
 *
 * Each transcript is read once, then only what it gains (keyed by its size and mtime, checked by a
 * print of the bytes before where reading stopped), a few at a time, in chunks, so thousands of
 * sessions and gigabytes of transcripts never hold up the server. What was read is kept in
 * Pelican's state folder, one file per project folder, and read back after a restart.
 */

const DAY = 86_400_000;
const MINUTE = 60_000;
/** Bumped when what a record holds changes: records of another version are read afresh. */
export const RECORD_VERSION = 1;
const CHUNK = 1024 * 1024;
/** Rows past this size are a tool's output or a picture, except a reply (a long Write); a reply can be this big. */
const SMALL_ROW = 256 * 1024;
const LARGEST_REPLY = 32 * 1024 * 1024;
const HEAD = 1024;
const PRINT = 256;
/** Each reply keeps five numbers: input, output, cache reads, cache writes, and of those the 1-hour ones. */
const FIELDS = 5;

const SESSION_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const SESSION_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_FILE = /^agent-[\w.-]{1,160}\.jsonl$/;

/** What one transcript holds for usage. */
export type FileRecord = {
  v: number;
  file: string;
  /** The project folder it is filed under: Claude Code's name for the session's folder. */
  dir: string;
  /** The session its usage counts toward: its own, or for a subagent's transcript, its session's. */
  session: string;
  sub: boolean;
  ino: number;
  size: number;
  mtimeMs: number;
  /** When the file was made (0 where the file system does not say): an original is older than its copies. */
  born: number;
  /** Bytes read, to the end of the last whole line, and a print of the bytes just before: an append keeps them. */
  offset: number;
  print: string;
  cwd?: string;
  /** The first and last row of the conversation itself: not a subagent's, not one copied from another session. */
  first?: number;
  last?: number;
  /** UTC days with such rows. */
  days: number[];
  /** One entry per API reply: a hash of its id, its minute, its model and app (indexes), and FIELDS token counts. */
  keys: number[];
  minutes: number[];
  model: number[];
  app: number[];
  tokens: number[];
  models: string[];
  /** Claude Code's entrypoints: cli, claude-desktop, sdk-ts… */
  apps: string[];
  compactions: number[];
  limits: Array<[number, LimitKind]>;
  /**
   * Claude Code's own cost estimate, from its cost-state rows: the session's total so far (each run
   * of a Claude process counts on from where the last one left off, or from zero), and per model the
   * dollars and the tokens they price, for the price of a token on this computer.
   */
  cost: number;
  costRun: number;
  rates: Array<[string, number, number]>;
  runRates: Array<[string, number, number]>;
};

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(Math.round(value), 4_000_000_000) : 0);
const str = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
const utcDay = (ms: number) => Math.floor(ms / DAY);
export const dayString = (day: number) => new Date(day * DAY).toISOString().slice(0, 10);

/** A 53-bit hash (cyrb53): replies are told apart by it, and two of a million collide about never. */
export function hash53(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * What a reply's tokens cost relative to one input token, by the shape of Anthropic's prices: output
 * five times input, cache reads a tenth, cache writes 1.25 times (2 times for the 1-hour cache).
 * Multiplied by a model's price per input token, which comes from Claude Code's own estimates.
 */
export const weighted = (input: number, output: number, cacheRead: number, cacheWrite: number, cacheWrite1h: number) =>
  input + 5 * output + 0.1 * cacheRead + 1.25 * Math.max(0, cacheWrite - cacheWrite1h) + 2 * cacheWrite1h;

function emptyRecord(file: string, found: Found, info: { ino: number; size: number; mtimeMs: number; birthtimeMs: number }): FileRecord {
  return {
    v: RECORD_VERSION, file, dir: found.dir, session: found.session, sub: found.sub,
    ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, born: info.birthtimeMs || 0, offset: 0, print: '',
    days: [], keys: [], minutes: [], model: [], app: [], tokens: [], models: [], apps: [],
    compactions: [], limits: [], cost: 0, costRun: 0, rates: [], runRates: [],
  };
}

/** What reading a record goes on with: its replies by hash, and its days, rebuilt from the record. */
type Reading = { replies: Map<number, number>; days: Set<number>; fileId: string };

function reading(record: FileRecord): Reading {
  return {
    replies: new Map(record.keys.map((key, i) => [key, i])),
    days: new Set(record.days),
    fileId: path.basename(record.file, '.jsonl'),
  };
}

const indexOf = (list: string[], value: string) => {
  const at = list.indexOf(value);
  if (at >= 0) return at;
  // A file with hundreds of models or apps is not one Claude Code wrote: the rest share the last slot.
  if (list.length >= 255) return 254;
  list.push(value);
  return list.length - 1;
};

type Row = {
  type?: unknown; subtype?: unknown; timestamp?: unknown; isSidechain?: unknown; sessionId?: unknown; forkedFrom?: unknown;
  cwd?: unknown; entrypoint?: unknown; requestId?: unknown; uuid?: unknown; isApiErrorMessage?: unknown; error?: unknown;
  message?: { id?: unknown; model?: unknown; usage?: Record<string, unknown>; content?: unknown };
  totalCostUSD?: unknown; startTime?: unknown; totalDuration?: unknown; modelUsage?: unknown;
};

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b: { type?: unknown; text?: unknown }) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('\n');
}

/** Claude Code's cost-state row: the session's estimate so far, and per model what it priced. */
function costRow(record: FileRecord, row: Row): void {
  const usd = typeof row.totalCostUSD === 'number' && Number.isFinite(row.totalCostUSD) && row.totalCostUSD >= 0 ? row.totalCostUSD : undefined;
  if (usd === undefined) return;
  // A Claude process that did not carry the total on starts from zero: what the last one reached stays.
  if (usd + 1e-9 < record.costRun) {
    record.cost += record.costRun;
    for (const rate of record.runRates) addRate(record.rates, rate[0], rate[1], rate[2]);
  }
  record.costRun = usd;
  const runRates: Array<[string, number, number]> = [];
  const usage = row.modelUsage && typeof row.modelUsage === 'object' ? row.modelUsage as Record<string, Record<string, unknown>> : {};
  for (const [model, u] of Object.entries(usage)) {
    if (!u || typeof u !== 'object' || model.startsWith('<')) continue;
    const cost = typeof u.costUSD === 'number' && Number.isFinite(u.costUSD) ? u.costUSD - 0.01 * num(u.webSearchRequests) : 0;
    const write1h = num(u.cacheCreationEphemeral1hInputTokens);
    const priced = weighted(num(u.inputTokens), num(u.outputTokens), num(u.cacheReadInputTokens), num(u.cacheCreationInputTokens), write1h);
    if (cost > 0 && priced > 0) runRates.push([model, cost, priced]);
  }
  record.runRates = runRates;
}

function addRate(rates: Array<[string, number, number]>, model: string, usd: number, priced: number): void {
  const known = rates.find((r) => r[0] === model);
  if (known) {
    known[1] += usd;
    known[2] += priced;
  } else {
    rates.push([model, usd, priced]);
  }
}

/** Adds one row of the transcript. Rows that cannot matter are looked at only as far as it takes to tell. */
function addLine(record: FileRecord, state: Reading, line: Buffer): void {
  if (line.length < 2 || line[0] !== 0x7b) return;
  const head = line.toString('latin1', 0, Math.min(HEAD, line.length));
  // Titles, requests, snapshots, queue operations: rows of Claude Code's own, with "type" first.
  if (head.startsWith('{"type":"')) {
    if (!head.startsWith('{"type":"cost-state"')) return;
    const row = parse(line);
    if (row && (record.sub || row.sessionId === undefined || row.sessionId === state.fileId)) costRow(record, row);
    return;
  }
  const reply = head.includes('"role":"assistant"') || head.includes('"type":"assistant"');
  // A tool's result sits between two replies: it has no usage and adds nothing to the times.
  if (!reply && (line.length > SMALL_ROW || line.includes('"tool_use_id"'))) return;
  const row = parse(line);
  if (!row) return;
  // Rows a side chat, branch or fork copied from another session: they ran there, not here.
  if (!record.sub && ((typeof row.sessionId === 'string' && row.sessionId !== state.fileId) || (row.forkedFrom !== undefined && row.forkedFrom !== null))) return;
  const time = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
  const side = row.isSidechain === true;
  const own = !record.sub && !side && Number.isFinite(time);
  if (row.type !== 'user' && row.type !== 'assistant' && row.type !== 'system') return;
  if (!record.cwd && typeof row.cwd === 'string' && row.cwd) record.cwd = row.cwd;
  if (own) {
    record.first = Math.min(record.first ?? time, time);
    record.last = Math.max(record.last ?? time, time);
    state.days.add(utcDay(time));
  }
  if (row.type === 'system') {
    if (row.subtype === 'compact_boundary' && !side && Number.isFinite(time)) record.compactions.push(time);
    return;
  }
  if (row.type !== 'assistant' || !Number.isFinite(time)) return;
  const message = row.message;
  if (!message || typeof message !== 'object') return;
  if (message.model === '<synthetic>') {
    // Claude Code's note that a usage limit was reached, written in place of a reply.
    if (row.isApiErrorMessage === true || typeof row.error === 'string') {
      const kind = limitKind(textOf(message.content));
      if (kind) record.limits.push([time, kind]);
    }
    return;
  }
  const usage = message.usage;
  if (!usage || typeof usage !== 'object') return;
  const creation = usage.cache_creation && typeof usage.cache_creation === 'object' ? usage.cache_creation as Record<string, unknown> : undefined;
  const counts = [
    num(usage.input_tokens), num(usage.output_tokens), num(usage.cache_read_input_tokens), num(usage.cache_creation_input_tokens),
    num(creation?.ephemeral_1h_input_tokens),
  ];
  if (counts[0] === 0 && counts[1] === 0 && counts[2] === 0 && counts[3] === 0) return;
  const id = str(message.id) ?? str(row.uuid);
  if (!id) return;
  const key = hash53(`${id}\u0000${str(row.requestId) ?? ''}`);
  const known = state.replies.get(key);
  if (known !== undefined) {
    // The same reply again (one row per content block): its usage only ever grows.
    for (let k = 0; k < FIELDS; k += 1) record.tokens[known * FIELDS + k] = Math.max(record.tokens[known * FIELDS + k]!, counts[k]!);
    return;
  }
  state.replies.set(key, record.keys.length);
  record.keys.push(key);
  record.minutes.push(Math.floor(time / MINUTE));
  record.model.push(indexOf(record.models, str(message.model) ?? 'unknown'));
  record.app.push(indexOf(record.apps, str(row.entrypoint) ?? ''));
  record.tokens.push(...counts);
}

function parse(line: Buffer): Row | undefined {
  try {
    const row = JSON.parse(line.toString('utf8')) as unknown;
    return row && typeof row === 'object' && !Array.isArray(row) ? row as Row : undefined;
  } catch {
    // Half written: read again with the rest of it.
    return undefined;
  }
}

/** A print of the bytes just before `offset`, which an append leaves as they are and a rewrite does not. */
async function printAt(handle: Awaited<ReturnType<typeof openRegular>>, offset: number): Promise<string> {
  if (offset <= 0) return '';
  const length = Math.min(PRINT, offset);
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, offset - length);
  return createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('base64url').slice(0, 22);
}

/** Whether a line too long to keep whole might still be one to read: a reply, or Claude Code's cost. */
function worthKeeping(pieces: Buffer[]): boolean {
  const head = Buffer.concat(pieces.length > 1 ? pieces.slice(0, 4) : pieces).toString('latin1', 0, HEAD);
  return head.startsWith('{"type":"cost-state"') || head.includes('"role":"assistant"') || head.includes('"type":"assistant"');
}

/** Reads the lines of `handle` from the record's offset to `size`, one chunk at a time. */
async function readLines(handle: Awaited<ReturnType<typeof openRegular>>, record: FileRecord, size: number, onLine: (line: Buffer) => void): Promise<void> {
  let position = record.offset;
  let pieces: Buffer[] = [];
  let pending = 0;
  let skipping = false;
  while (position < size) {
    const length = Math.min(CHUNK, size - position);
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead <= 0) break;
    const data = bytesRead < length ? buffer.subarray(0, bytesRead) : buffer;
    let from = 0;
    for (;;) {
      const end = data.indexOf(0x0a, from);
      if (end < 0) {
        if (!skipping && from < data.length) {
          pieces.push(data.subarray(from));
          pending += data.length - from;
          // A picture or a tool's long output: its bytes are passed over, not kept.
          if (pending > SMALL_ROW && (pending > LARGEST_REPLY || !worthKeeping(pieces))) {
            skipping = true;
            pieces = [];
          }
        }
        break;
      }
      if (!skipping) {
        const piece = data.subarray(from, end);
        onLine(pieces.length > 0 ? Buffer.concat([...pieces, piece]) : piece);
      }
      pieces = [];
      pending = 0;
      skipping = false;
      from = end + 1;
      record.offset = position + from;
    }
    position += bytesRead;
  }
}

type Found = { file: string; dir: string; session: string; sub: boolean };

/**
 * Reads what a transcript gained since `old` was read, or all of it when it is new, was replaced
 * (another inode), got shorter, or changed before where reading stopped. Undefined when it cannot
 * be read (gone, not a regular file).
 */
export async function readRecord(found: Found, old?: FileRecord): Promise<FileRecord | undefined> {
  let handle: Awaited<ReturnType<typeof openRegular>>;
  try {
    handle = await openRegular(found.file);
  } catch {
    return undefined;
  }
  try {
    const info = await handle.stat();
    const unchanged = old && old.v === RECORD_VERSION && old.ino === info.ino && old.size === info.size && old.mtimeMs === info.mtimeMs;
    if (unchanged) return old;
    const appended = old && old.v === RECORD_VERSION && old.ino === info.ino && info.size >= old.offset && (await printAt(handle, old.offset)) === old.print;
    const record = appended && old ? old : emptyRecord(found.file, found, info);
    Object.assign(record, { ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, born: info.birthtimeMs || record.born });
    const state = reading(record);
    await readLines(handle, record, info.size, (line) => addLine(record, state, line));
    record.days = [...state.days].sort((a, b) => a - b);
    record.print = await printAt(handle, record.offset);
    return record;
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

// --- Finding every transcript -----------------------------------------------------------------

const listing = limiter(8);
const listingSubagents = limiter(16);

async function entries(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** A session's subagents, and those of its workflows, each in a folder of its own. */
async function subagentFiles(dir: string, project: string, session: string, found: Found[], depth = 0): Promise<void> {
  const list = await listingSubagents(() => entries(dir));
  for (const entry of list) {
    if (entry.isFile() && AGENT_FILE.test(entry.name)) found.push({ file: path.join(dir, entry.name), dir: project, session, sub: true });
  }
  if (depth > 0 || !list.some((e) => e.isDirectory() && e.name === 'workflows')) return;
  const runs = await listingSubagents(() => entries(path.join(dir, 'workflows')));
  await Promise.all(runs.filter((r) => r.isDirectory() && /^[\w.-]{1,160}$/.test(r.name))
    .map((r) => subagentFiles(path.join(dir, 'workflows', r.name), project, session, found, 1)));
}

/** Every transcript Claude Code keeps on this computer: each session's, and its subagents'. Links are not followed. */
export async function findTranscripts(): Promise<Found[]> {
  const root = path.join(config.claudeHome, 'projects');
  const found: Found[] = [];
  const projects = (await entries(root)).filter((d) => d.isDirectory());
  await Promise.all(projects.map(async (project) => {
    const dir = path.join(root, project.name);
    const list = await listing(() => entries(dir));
    for (const entry of list) {
      const id = entry.isFile() ? SESSION_FILE.exec(entry.name)?.[1] : undefined;
      if (id) found.push({ file: path.join(dir, entry.name), dir: project.name, session: id, sub: false });
    }
    await Promise.all(list.filter((e) => e.isDirectory() && SESSION_DIR.test(e.name))
      .map((e) => subagentFiles(path.join(dir, e.name, 'subagents'), project.name, e.name, found)));
  }));
  return found;
}

// --- What has been read, kept in the state folder ---------------------------------------------

const records = new Map<string, FileRecord>();
/** Bumped whenever a record changes: what was worked out from them is worked out again. */
let version = 0;
const storeDir = () => path.join(config.stateDir, 'usage');
const shardOf = (dir: string) => path.join(storeDir(), 'files', `${createHash('sha256').update(dir).digest('hex').slice(0, 24)}.json`);

function encode(values: number[], Kind: Float64ArrayConstructor | Uint32ArrayConstructor | Uint8ArrayConstructor): string {
  return Buffer.from(Kind.from(values).buffer).toString('base64');
}

function decode(text: unknown, Kind: Float64ArrayConstructor | Uint32ArrayConstructor | Uint8ArrayConstructor): number[] | undefined {
  if (typeof text !== 'string') return undefined;
  const bytes = Buffer.from(text, 'base64');
  if (bytes.length % Kind.BYTES_PER_ELEMENT !== 0) return undefined;
  // Copied, so the view starts where its type needs it to.
  const aligned = new Uint8Array(bytes.length);
  aligned.set(bytes);
  return Array.from(new Kind(aligned.buffer));
}

function serialize(record: FileRecord): Record<string, unknown> {
  return {
    ...record,
    keys: encode(record.keys, Float64Array),
    minutes: encode(record.minutes, Uint32Array),
    model: encode(record.model, Uint8Array),
    app: encode(record.app, Uint8Array),
    tokens: encode(record.tokens, Uint32Array),
  };
}

function deserialize(raw: Record<string, unknown>): FileRecord | undefined {
  if (raw.v !== RECORD_VERSION || typeof raw.file !== 'string' || typeof raw.dir !== 'string' || typeof raw.session !== 'string') return undefined;
  const keys = decode(raw.keys, Float64Array);
  const minutes = decode(raw.minutes, Uint32Array);
  const model = decode(raw.model, Uint8Array);
  const app = decode(raw.app, Uint8Array);
  const tokens = decode(raw.tokens, Uint32Array);
  const n = keys?.length ?? -1;
  if (!keys || minutes?.length !== n || model?.length !== n || app?.length !== n || tokens?.length !== n * FIELDS) return undefined;
  const numbers = (value: unknown) => (Array.isArray(value) && value.every((v) => typeof v === 'number') ? value as number[] : undefined);
  const strings = (value: unknown) => (Array.isArray(value) && value.every((v) => typeof v === 'string') ? value as string[] : undefined);
  const days = numbers(raw.days);
  const compactions = numbers(raw.compactions);
  const models = strings(raw.models);
  const apps = strings(raw.apps);
  if (!days || !compactions || !models || !apps || !Array.isArray(raw.limits) || !Array.isArray(raw.rates) || !Array.isArray(raw.runRates)) return undefined;
  return {
    ...(raw as unknown as FileRecord), keys, minutes, model, app, tokens, days, compactions, models, apps,
  };
}

let loaded: Promise<void> | undefined;

/** Reads back what earlier runs of Pelican read; a file that cannot be read is read from the transcripts again. */
function load(): Promise<void> {
  loaded ??= (async () => {
    const dir = path.join(storeDir(), 'files');
    const names = (await entries(dir)).filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => e.name);
    const reads = limiter(8);
    await Promise.all(names.map((name) => reads(async () => {
      try {
        const shard = JSON.parse(await readFile(path.join(dir, name), 'utf8')) as { records?: unknown };
        for (const raw of Array.isArray(shard.records) ? shard.records : []) {
          const record = raw && typeof raw === 'object' ? deserialize(raw as Record<string, unknown>) : undefined;
          if (record && !records.has(record.file)) records.set(record.file, record);
        }
      } catch {
        // Written by a Pelican that stopped half way, or not ours: read the transcripts again.
      }
    })));
    version += 1;
  })();
  return loaded;
}

const dirty = new Set<string>();
let saveTimer: NodeJS.Timeout | undefined;
let saving: Promise<void> = Promise.resolve();

function changed(record: FileRecord): void {
  version += 1;
  dirty.add(record.dir);
  saveTimer ??= setTimeout(() => {
    saveTimer = undefined;
    saving = saving.then(saveShards, saveShards);
  }, 5000);
  saveTimer.unref?.();
}

async function writeAtomically(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, text, { mode: 0o600 });
  await rename(temp, file);
}

async function saveShards(): Promise<void> {
  const dirs = [...dirty];
  dirty.clear();
  for (const dir of dirs) {
    const kept = [...records.values()].filter((r) => r.dir === dir);
    try {
      if (kept.length === 0) await rm(shardOf(dir), { force: true });
      else await writeAtomically(shardOf(dir), JSON.stringify({ v: RECORD_VERSION, dir, records: kept.map(serialize) }));
    } catch (error) {
      dirty.add(dir);
      console.warn('[pelican] could not keep usage figures:', (error as Error).message);
    }
  }
}

/** Writes what is not written yet, now (for tests, and before the server stops). */
export async function flushUsage(): Promise<void> {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  saving = saving.then(saveShards, saveShards);
  await saving;
  await saveOwn();
}

// --- Reading everything, a little at a time -----------------------------------------------------

const progress = { files: 0, read: 0 };
let scanning: Promise<void> | undefined;
let scannedAt = 0;
let scannedOnce = false;
const statting = limiter(32);
const parsing = limiter(2);
const locks = new Map<string, Promise<FileRecord | undefined>>();

/**
 * Reads a transcript into its record, one read per file at a time: a record grows in place, so
 * two reads of one file at once (the page's look at everything, a session menu) would add its new
 * lines twice.
 */
function readLocked(found: Found): Promise<FileRecord | undefined> {
  const previous = locks.get(found.file) ?? Promise.resolve(undefined);
  const next = previous.catch(() => undefined).then(async () => {
    const old = records.get(found.file);
    const before = old ? `${old.size}:${old.mtimeMs}:${old.offset}` : '';
    const record = await readRecord(found, old);
    if (record && (record !== old || `${record.size}:${record.mtimeMs}:${record.offset}` !== before)) {
      records.set(found.file, record);
      changed(record);
    }
    return record;
  });
  locks.set(found.file, next);
  void next.finally(() => {
    if (locks.get(found.file) === next) locks.delete(found.file);
  }).catch(() => undefined);
  return next;
}

async function scan(): Promise<void> {
  await load();
  const found = await findTranscripts();
  const present = new Set(found.map((f) => f.file));
  for (const [file, record] of records) {
    if (present.has(file)) continue;
    records.delete(file);
    changed(record);
  }
  progress.files = found.length;
  progress.read = 0;
  const stats = await Promise.all(found.map((f) => statting(async () => ({ f, info: await stat(f.file).catch(() => undefined) }))));
  const toRead: Array<{ f: Found; mtimeMs: number }> = [];
  for (const { f, info } of stats) {
    const old = records.get(f.file);
    if (!info?.isFile()) {
      if (old) {
        records.delete(f.file);
        changed(old);
      }
      progress.read += 1;
    } else if (old && old.v === RECORD_VERSION && old.ino === info.ino && old.size === info.size && old.mtimeMs === info.mtimeMs) {
      progress.read += 1;
    } else {
      toRead.push({ f, mtimeMs: info.mtimeMs });
    }
  }
  // The newest first: the last few days fill in before older months.
  toRead.sort((a, b) => b.mtimeMs - a.mtimeMs);
  await Promise.all(toRead.map(({ f }) => parsing(async () => {
    await readLocked(f);
    progress.read += 1;
  })));
  scannedOnce = true;
}

/** Starts a look at the transcripts when the last one is older than `maxAgeMs`; shared while it runs. */
export function refreshUsage(maxAgeMs = 15_000): Promise<void> {
  if (scanning) return scanning;
  if (scannedOnce && Date.now() - scannedAt < maxAgeMs) return Promise.resolve();
  scanning = scan().catch((error: Error) => console.warn('[pelican] reading usage:', error.message)).finally(() => {
    scanning = undefined;
    scannedAt = Date.now();
  });
  return scanning;
}

/** Ready once every transcript was read once; later looks only add what changed, quietly. */
export const usageProgress = () => ({ files: progress.files, read: Math.min(progress.read, progress.files), ready: scannedOnce });

// --- What Pelican itself knows: the sessions it ran, and how long Claude waited for you there ---

type Own = { sessions: Record<string, number>; waits: Array<[string, number, number]> };
const ownFile = () => path.join(storeDir(), 'pelican.json');
let own: Promise<Own> | undefined;
let ownChanged = false;
let ownTimer: NodeJS.Timeout | undefined;
const MAX_WAITS = 5000;

function ownRecord(): Promise<Own> {
  own ??= readFile(ownFile(), 'utf8').then((text) => {
    const raw = JSON.parse(text) as { sessions?: unknown; waits?: unknown };
    const sessions: Record<string, number> = {};
    if (raw.sessions && typeof raw.sessions === 'object') {
      for (const [id, at] of Object.entries(raw.sessions)) if (typeof at === 'number') sessions[id] = at;
    }
    const waits = Array.isArray(raw.waits)
      ? raw.waits.filter((w): w is [string, number, number] => Array.isArray(w) && typeof w[0] === 'string' && typeof w[1] === 'number' && typeof w[2] === 'number' && w[2] >= w[1])
      : [];
    return { sessions, waits };
  }).catch(() => ({ sessions: {}, waits: [] }));
  return own;
}

async function saveOwn(): Promise<void> {
  if (!ownChanged || !own) return;
  ownChanged = false;
  try {
    await writeAtomically(ownFile(), JSON.stringify(await own));
  } catch (error) {
    ownChanged = true;
    console.warn('[pelican] could not keep usage figures:', (error as Error).message);
  }
}

function ownSoon(): void {
  ownChanged = true;
  ownTimer ??= setTimeout(() => {
    ownTimer = undefined;
    void saveOwn();
  }, 2000);
  ownTimer.unref?.();
}

const waitingSince = new Map<string, number>();

/**
 * Pelican's runs say when their status changes (the session lists hear it too): a session that
 * says so is one Pelican runs, and the time it spends waiting for an approval, an answer or a
 * plan is time Claude waited for you.
 */
export function noteRunStatus(sessionId: string, status: string, now = Date.now()): void {
  void ownRecord().then((record) => {
    if (!(sessionId in record.sessions)) {
      record.sessions[sessionId] = now;
      ownSoon();
    }
    if (status === 'waiting') {
      if (!waitingSince.has(sessionId)) waitingSince.set(sessionId, now);
      return;
    }
    const since = waitingSince.get(sessionId);
    if (since === undefined) return;
    waitingSince.delete(sessionId);
    record.waits.push([sessionId, since, now]);
    if (record.waits.length > MAX_WAITS) record.waits.splice(0, record.waits.length - MAX_WAITS);
    ownSoon();
  });
}

connect((event) => {
  if (event.type === 'status') noteRunStatus(event.sessionId, event.status);
});

// --- Claude Code's own stats (read only) --------------------------------------------------------

type StatsCache = { through: number; days: Map<number, { sessions: number; active: boolean }>; longest?: { id: string; ms: number; at: number }; first?: number };

/**
 * Claude Code's `stats-cache.json`, which /stats keeps of every day it counted, also of sessions
 * whose transcripts are gone: per UTC day the sessions started and whether anything happened, the
 * longest session and the first session, through the last day it counted. Read only.
 */
export async function readStatsCache(): Promise<StatsCache | undefined> {
  let text: string;
  try {
    const handle = await openRegular(path.join(config.claudeHome, 'stats-cache.json'));
    try {
      if ((await handle.stat()).size > 16 * 1024 * 1024) return undefined;
      text = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const date = (value: unknown) => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) && Number.isFinite(Date.parse(value)) ? utcDay(Date.parse(value.slice(0, 10))) : undefined);
  const through = date(raw.lastComputedDate);
  if (through === undefined || !Array.isArray(raw.dailyActivity)) return undefined;
  const days = new Map<number, { sessions: number; active: boolean }>();
  for (const entry of raw.dailyActivity as Array<Record<string, unknown>>) {
    const day = entry && typeof entry === 'object' ? date(entry.date) : undefined;
    if (day === undefined || day > through) continue;
    days.set(day, { sessions: num(entry.sessionCount), active: num(entry.messageCount) > 0 || num(entry.sessionCount) > 0 });
  }
  const longest = raw.longestSession as Record<string, unknown> | null | undefined;
  const at = longest ? date(longest.timestamp) : undefined;
  const first = date(raw.firstSessionDate);
  return {
    through,
    days,
    ...(longest && typeof longest.sessionId === 'string' && at !== undefined && num(longest.duration) > 0
      ? { longest: { id: longest.sessionId, ms: num(longest.duration), at } } : {}),
    ...(first !== undefined ? { first } : {}),
  };
}

// --- Working it out -------------------------------------------------------------------------------

/** Which replies each transcript owns: a reply found in several (a copy of a conversation) belongs to the oldest. */
type Ownership = { version: number; order: FileRecord[]; skip: Map<FileRecord, Uint8Array> };
let ownership: Ownership | undefined;

const age = (r: FileRecord) => r.born || (r.minutes[0] !== undefined ? r.minutes[0] * MINUTE : r.mtimeMs);

function owners(): Ownership {
  if (ownership?.version === version) return ownership;
  const order = [...records.values()].sort((a, b) => age(a) - age(b) || (a.first ?? Infinity) - (b.first ?? Infinity) || (a.file < b.file ? -1 : 1));
  let total = 0;
  for (const r of order) total += r.keys.length;
  const all = new Float64Array(total);
  let i = 0;
  for (const r of order) for (const key of r.keys) all[i++] = key;
  all.sort();
  const shared = new Set<number>();
  for (let j = 1; j < all.length; j += 1) if (all[j] === all[j - 1]) shared.add(all[j]!);
  const claimed = new Set<number>();
  const skip = new Map<FileRecord, Uint8Array>();
  if (shared.size > 0) {
    for (const r of order) {
      let mask: Uint8Array | undefined;
      for (let j = 0; j < r.keys.length; j += 1) {
        const key = r.keys[j]!;
        if (!shared.has(key)) continue;
        if (claimed.has(key)) (mask ??= new Uint8Array(r.keys.length))[j] = 1;
        else claimed.add(key);
      }
      if (mask) skip.set(r, mask);
    }
  }
  ownership = { version, order, skip };
  return ownership;
}

/** Per model, what one weighted token cost in Claude Code's own estimates on this computer. */
function pricesFrom(list: Iterable<FileRecord>): Map<string, number> {
  const sums = new Map<string, [number, number]>();
  for (const r of list) {
    for (const [model, usd, priced] of [...r.rates, ...r.runRates]) {
      const sum = sums.get(model) ?? [0, 0];
      sum[0] += usd;
      sum[1] += priced;
      sums.set(model, sum);
    }
  }
  return new Map([...sums].filter(([, [, priced]]) => priced > 0).map(([model, [usd, priced]]) => [model, usd / priced]));
}

const add = (into: Tokens, t: number[], at: number) => {
  into.input += t[at]!;
  into.output += t[at + 1]!;
  into.cacheRead += t[at + 2]!;
  into.cacheWrite += t[at + 3]!;
};

type SessionInfo = { title: string; project: string };
export type Titles = (ids: string[]) => Promise<Map<string, SessionInfo>>;

const projectName = (cwd: string) => path.basename(cwd) || cwd;

/** Throwaway folders are one project each kind: the scratch folders, and the system's temp folders. */
const SCRATCH = 'scratch:';
const TEMP = 'temp:';
const projectOfFolder = (cwd: string) => {
  const kind = cwd.startsWith('/') ? folderKind(cwd) : 'project';
  return kind === 'scratch' ? SCRATCH : kind === 'temp' ? TEMP : cwd;
};

/** The first and last UTC day of a period that ends today. */
export function period(range: UsageRange, now: number, first: number | undefined): { from: number; to: number } {
  const to = utcDay(now);
  if (range === '7d') return { from: to - 6, to };
  if (range === '30d') return { from: to - 29, to };
  return { from: Math.min(first ?? to, to), to };
}

/** Consecutive days with activity: the run that ends today (none if today has none, as /stats says), and the longest. */
export function streaks(active: Set<number>, from: number, to: number): { current: number; longest: number } {
  let current = 0;
  for (let d = to; d >= from && active.has(d); d -= 1) current += 1;
  let longest = 0;
  let run = 0;
  for (let d = from; d <= to; d += 1) {
    run = active.has(d) ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return { current, longest };
}

/**
 * Limits reached, each once: the sessions running when a limit is reached each say so, and a limit
 * reached again before it resets (5 hours, a week) is the same one.
 */
export function distinctLimits(hits: Array<[number, LimitKind]>): Array<{ kind: LimitKind; at: number }> {
  const span: Record<LimitKind, number> = { session: 5 * 60 * MINUTE, weekly: 7 * DAY, model: 7 * DAY };
  const out: Array<{ kind: LimitKind; at: number }> = [];
  const last = new Map<LimitKind, number>();
  for (const [at, kind] of [...hits].sort((a, b) => a[0] - b[0])) {
    const since = last.get(kind);
    if (since !== undefined && at - since < span[kind]) continue;
    last.set(kind, at);
    out.push({ kind, at });
  }
  return out;
}

export type SummaryInput = { range: UsageRange; now: number; titles: Titles; statsCache?: StatsCache | undefined };

/** Everything the page shows for a period, from what has been read so far. */
export async function summarize({ range, now, titles, statsCache: cache }: SummaryInput): Promise<UsageSummary> {
  const { order, skip } = owners();
  const mine = await ownRecord();
  // As /stats does, Claude Code's own record counts for everything; the last 7 or 30 days come from the transcripts.
  const statsCache = range === 'all' ? cache : undefined;
  const mainOf = new Map<string, FileRecord>();
  for (const r of order) if (!r.sub && (!mainOf.has(r.session) || (r.last ?? 0) > (mainOf.get(r.session)!.last ?? 0))) mainOf.set(r.session, r);
  let firstData: number | undefined;
  for (const r of order) {
    if (r.minutes[0] !== undefined) firstData = Math.min(firstData ?? Infinity, utcDay(r.minutes[0] * MINUTE));
    if (r.days[0] !== undefined) firstData = Math.min(firstData ?? Infinity, r.days[0]);
  }
  let firstKnown = firstData ?? Infinity;
  if (statsCache?.first !== undefined) firstKnown = Math.min(firstKnown, statsCache.first);
  for (const day of statsCache?.days.keys() ?? []) firstKnown = Math.min(firstKnown, day);
  const { from, to } = period(range, now, Number.isFinite(firstKnown) ? firstKnown : undefined);
  const fromMs = from * DAY;
  const toMs = (to + 1) * DAY;
  const prices = pricesFrom(order);

  const tokens = noTokens();
  const byDay = new Map<number, number>();
  const byModel = new Map<string, number>();
  const bySession = new Map<string, { tokens: number; at: number; apps: Map<AppName, number> }>();
  const byProject = new Map<string, { tokens: number; sessions: Set<string> }>();
  const byApp = new Map<AppName, { tokens: number; sessions: Set<string> }>();
  let usd = 0;
  const unpriced = new Set<string>();
  let firstTokens: number | undefined;

  for (const r of order) {
    const mask = skip.get(r);
    const pelican = r.session in mine.sessions;
    const cwd = projectOfFolder(mainOf.get(r.session)?.cwd ?? r.cwd ?? r.dir);
    for (let j = 0; j < r.keys.length; j += 1) {
      if (mask?.[j]) continue;
      const at = r.minutes[j]! * MINUTE;
      if (at < fromMs || at >= toMs) continue;
      const t = j * FIELDS;
      add(tokens, r.tokens, t);
      const total = r.tokens[t]! + r.tokens[t + 1]! + r.tokens[t + 2]! + r.tokens[t + 3]!;
      const day = utcDay(at);
      firstTokens = Math.min(firstTokens ?? day, day);
      byDay.set(day, (byDay.get(day) ?? 0) + total);
      const model = r.models[r.model[j]!] ?? 'unknown';
      byModel.set(model, (byModel.get(model) ?? 0) + total);
      const app = appOf(r.apps[r.app[j]!], pelican);
      const session = bySession.get(r.session) ?? { tokens: 0, at: 0, apps: new Map() };
      session.tokens += total;
      session.at = Math.max(session.at, at);
      session.apps.set(app, (session.apps.get(app) ?? 0) + total);
      bySession.set(r.session, session);
      const project = byProject.get(cwd) ?? { tokens: 0, sessions: new Set() };
      project.tokens += total;
      project.sessions.add(r.session);
      byProject.set(cwd, project);
      const used = byApp.get(app) ?? { tokens: 0, sessions: new Set() };
      used.tokens += total;
      used.sessions.add(r.session);
      byApp.set(app, used);
      const price = prices.get(model);
      if (price === undefined) unpriced.add(r.session);
      else usd += price * weighted(r.tokens[t]!, r.tokens[t + 1]!, r.tokens[t + 2]!, r.tokens[t + 3]!, r.tokens[t + 4]!);
    }
  }

  // Activity, as /stats counts it: a session (not a subagent's) counts on the day it started, and
  // lasts from its first row to its last; a day is active when any session has a row on it. For the
  // days Claude Code's own record counted, its figures win over the transcripts.
  const counted = (day: number) => !statsCache || day > statsCache.through;
  const active = new Set<number>();
  let sessionCount = 0;
  let longest: { id: string; ms: number } | undefined;
  for (const [id, r] of mainOf) {
    for (const day of r.days) if (day >= from && day <= to && counted(day)) active.add(day);
    if (r.first === undefined || r.last === undefined) continue;
    const started = utcDay(r.first);
    if (started < from || started > to || !counted(started)) continue;
    sessionCount += 1;
    if (!longest || r.last - r.first > longest.ms) longest = { id, ms: r.last - r.first };
  }
  if (statsCache) {
    for (const [day, entry] of statsCache.days) {
      if (day < from || day > to) continue;
      sessionCount += entry.sessions;
      if (entry.active) active.add(day);
    }
    const theirs = statsCache.longest;
    if (theirs && (!longest || theirs.ms > longest.ms)) longest = { id: theirs.id, ms: theirs.ms };
  }
  const { current, longest: longestStreak } = streaks(active, from, to);

  // Limits, compactions and waits in the period.
  const hits: Array<[number, LimitKind]> = [];
  const compactions = new Map<string, number>();
  for (const r of order) {
    for (const hit of r.limits) if (hit[0] >= fromMs && hit[0] < toMs) hits.push(hit);
    if (r.sub) continue;
    const times = r.compactions.filter((t) => t >= fromMs && t < toMs).length;
    if (times > 0) compactions.set(r.session, (compactions.get(r.session) ?? 0) + times);
  }
  const waits = mine.waits.filter(([, since]) => since >= fromMs && since < toMs);

  const sessionsShown = [...bySession].sort((a, b) => b[1].tokens - a[1].tokens).slice(0, 20);
  const compacted = [...compactions].filter(([, times]) => times >= 3).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const named = await titles([...new Set([...sessionsShown.map(([id]) => id), ...compacted.map(([id]) => id), ...(longest ? [longest.id] : [])])]);
  const title = (id: string) => named.get(id)?.title ?? 'Untitled session';
  const projectOf = (id: string) => named.get(id)?.project || projectName(mainOf.get(id)?.cwd ?? '');

  // Two folders with the same name are told apart by their parent, as the new-session picker does.
  const names = new Map<string, number>();
  for (const cwd of byProject.keys()) names.set(projectName(cwd), (names.get(projectName(cwd)) ?? 0) + 1);
  const nameOf = (cwd: string) => (cwd === SCRATCH ? 'Scratch' : cwd === TEMP ? 'Temporary folders'
    : (names.get(projectName(cwd)) ?? 0) > 1 ? `${path.basename(path.dirname(cwd))}/${projectName(cwd)}` : projectName(cwd));

  // Everything: the chart starts where the transcripts do (Claude Code's own record has no tokens per kind).
  const chartFrom = range === 'all' && firstTokens !== undefined ? Math.max(from, firstTokens) : from;
  const long = to - chartFrom + 1 > 45;
  const points = new Map<number, number>();
  for (let d = chartFrom; d <= to; d += 1) {
    // Weeks start on Monday (day 0, 1 January 1970, was a Thursday).
    const key = long ? d - ((d + 3) % 7) : d;
    points.set(key, (points.get(key) ?? 0) + (byDay.get(d) ?? 0));
  }

  const summary: UsageSummary = {
    range,
    from: dayString(from),
    to: dayString(to),
    tokens,
    ...(range === 'all' && firstTokens !== undefined && firstTokens > from ? { tokensSince: dayString(firstTokens) } : {}),
    series: { unit: long ? 'week' : 'day', points: [...points].map(([day, value]) => ({ day: dayString(day), tokens: value })) },
    models: [...byModel].sort((a, b) => b[1] - a[1]).map(([model, value]) => ({ model, name: modelName(model), tokens: value })),
    projects: [...byProject].sort((a, b) => b[1].tokens - a[1].tokens).slice(0, 30)
      .map(([cwd, p]) => ({ cwd, name: nameOf(cwd), tokens: p.tokens, sessions: p.sessions.size })),
    apps: [...byApp].sort((a, b) => b[1].tokens - a[1].tokens).map(([app, a]) => ({ app, tokens: a.tokens, sessions: a.sessions.size })),
    sessions: sessionsShown.map(([id, s]): UsageSession => ({
      id, title: title(id), project: projectOf(id), app: [...s.apps].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'Other', tokens: s.tokens, at: s.at,
    })),
    activity: {
      sessions: sessionCount,
      activeDays: active.size,
      days: to - from + 1,
      currentStreak: current,
      longestStreak,
      ...(longest && longest.ms > 0 ? { longest: { id: longest.id, title: title(longest.id), ms: longest.ms } } : {}),
      ...(range === 'all' && statsCache?.first !== undefined && firstData !== undefined && statsCache.first < firstData ? { since: dayString(statsCache.first) } : {}),
    },
    limits: distinctLimits(hits),
    compacted: compacted.map(([id, times]) => ({ id, title: title(id), times })),
    ...(waits.length > 0 ? {
      waits: {
        ms: waits.reduce((sum, [, since, until]) => sum + (until - since), 0),
        count: waits.length,
        longest: Math.max(...waits.map(([, since, until]) => until - since)),
      },
    } : {}),
    ...(prices.size > 0 && tokenTotal(tokens) > 0 ? { cost: { usd, without: unpriced.size } } : {}),
    progress: usageProgress(),
  };
  return summary;
}

/** One session's usage, from its own transcript and its subagents', read now if they changed. */
export async function sessionUsage(sessionId: string, files: Found[]): Promise<SessionUsage | undefined> {
  await load();
  const mine = (await Promise.all(files.map((f) => readLocked(f)))).filter((r): r is FileRecord => Boolean(r));
  if (mine.length === 0) return undefined;
  // Which of its replies were copied from another session is known once every transcript was read.
  const skip = scannedOnce ? owners().skip : new Map<FileRecord, Uint8Array>();
  const prices = pricesFrom(records.values());
  const tokens = noTokens();
  const byModel = new Map<string, number>();
  let usd = 0;
  let priced = true;
  let compactions = 0;
  for (const r of mine) {
    const mask = skip.get(r);
    for (let j = 0; j < r.keys.length; j += 1) {
      if (mask?.[j]) continue;
      const t = j * FIELDS;
      add(tokens, r.tokens, t);
      const model = r.models[r.model[j]!] ?? 'unknown';
      byModel.set(model, (byModel.get(model) ?? 0) + r.tokens[t]! + r.tokens[t + 1]! + r.tokens[t + 2]! + r.tokens[t + 3]!);
      const price = prices.get(model);
      if (price === undefined) priced = false;
      else usd += price * weighted(r.tokens[t]!, r.tokens[t + 1]!, r.tokens[t + 2]!, r.tokens[t + 3]!, r.tokens[t + 4]!);
    }
    if (!r.sub) compactions += r.compactions.length;
  }
  const waits = (await ownRecord()).waits.filter(([id]) => id === sessionId);
  return {
    tokens,
    models: [...byModel].sort((a, b) => b[1] - a[1]).map(([model, value]) => ({ model, name: modelName(model), tokens: value })),
    compactions,
    ...(waits.length > 0 ? { waits: { ms: waits.reduce((sum, [, since, until]) => sum + (until - since), 0), count: waits.length } } : {}),
    ...(priced && prices.size > 0 && tokenTotal(tokens) > 0 ? { cost: { usd } } : {}),
  };
}

/** A session's transcripts: its own (the one the session list shows) and its subagents'. */
export async function sessionFiles(sessionId: string, main: string): Promise<Found[]> {
  if (!SESSION_DIR.test(sessionId)) return [];
  const dir = path.basename(path.dirname(main));
  const found: Found[] = [{ file: main, dir, session: sessionId, sub: false }];
  await subagentFiles(path.join(path.dirname(main), sessionId, 'subagents'), dir, sessionId, found);
  return found;
}

/** Forgets everything read (tests). */
export function resetUsage(): void {
  records.clear();
  loaded = undefined;
  own = undefined;
  ownChanged = false;
  ownership = undefined;
  waitingSince.clear();
  scannedOnce = false;
  scannedAt = 0;
  progress.files = 0;
  progress.read = 0;
  dirty.clear();
  clearTimeout(saveTimer);
  saveTimer = undefined;
  clearTimeout(ownTimer);
  ownTimer = undefined;
  version += 1;
}

/** How many transcripts have a record now (tests). */
export const recordCount = () => records.size;
