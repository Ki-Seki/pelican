import { stat } from 'node:fs/promises';
import path from 'node:path';

import { getSessionInfo, getSubagentMessages, renameSession } from '@anthropic-ai/claude-agent-sdk';
import type { SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk';

import type { ChatMessage, MessagesPage, RecordedSettings, SessionStatus, SessionSummary } from '../shared/protocol.js';
import { archivedIds } from './archive.js';
import { config } from './config.js';
import { folderKind } from './folders.js';
import { type LiveProcess, liveProcesses } from './live.js';
import { readHistory, readRecordedSettings } from './history.js';
import { toChatMessage } from './normalize.js';
import { firstTurnSession, forgetTranscripts, lastTurnTime, limiter, transcriptFiles, transcriptPath } from './transcripts.js';

export type StatusSource = (sessionId: string) => SessionStatus | undefined;

const infoCache = new Map<string, SDKSessionInfo>();

function titleOf(info: SDKSessionInfo): string {
  const title = info.customTitle || info.summary || info.firstPrompt || '';
  return title.replace(/\s+/g, ' ').trim() || 'Untitled session';
}

async function summarize(info: SDKSessionInfo, status: StatusSource, live: Map<string, LiveProcess>, archived: Set<string>): Promise<SessionSummary> {
  const known = files.get(info.sessionId);
  const file = known?.file ?? await transcriptPath(info.sessionId);
  const times = file ? await lastTurnTime(file, known) : undefined;
  const lastTurn = times?.lastTurn;
  const lastActivity = lastTurn?.time ?? info.lastModified;
  const own = status(info.sessionId);
  let state: SessionStatus = own ?? 'idle';
  // Another app's Claude process says it waits for an answer, or is busy; failing that, a turn
  // written moments ago (not one a fork just copied over: a new branch is idle until someone
  // sends to it). Idle here but at work in another app: that is what the session is doing.
  const other = live.get(info.sessionId);
  const elsewhere = !own || own === 'idle' ? other : undefined;
  const recent = lastTurn && !lastTurn.copied && Date.now() - lastTurn.time < config.liveWindowMs;
  if (elsewhere?.waiting) state = 'waiting';
  else if (elsewhere?.busy || (!own && recent)) state = 'live';
  // Where it needs you, or works: always said for a wait, since one in this app looks the same.
  const runningIn = state === 'waiting' && elsewhere?.waiting ? elsewhere.app ?? 'another app'
    : state === 'live' && elsewhere?.busy ? elsewhere.app : undefined;
  const cwd = info.cwd || lastTurn?.cwd || '';
  if (!info.cwd && cwd) infoCache.set(info.sessionId, { ...info, cwd });
  const gitBranch = lastTurn?.gitBranch ?? info.gitBranch;
  const title = titleOf(info);
  // Claude Desktop's side chats: a copy of a conversation with a question or two of its own.
  const copiedFrom = file && title === 'Side chat' ? await firstTurnSession(file) : undefined;
  const sideChatOf = copiedFrom && copiedFrom !== info.sessionId ? copiedFrom : undefined;
  return {
    id: info.sessionId,
    title,
    cwd,
    project: cwd ? path.basename(cwd) : '',
    ...(gitBranch && gitBranch !== 'HEAD' ? { gitBranch } : {}),
    lastActivity,
    ...(info.createdAt ? { createdAt: info.createdAt } : {}),
    status: state,
    ...(info.fileSize ? { sizeBytes: info.fileSize } : {}),
    ...(cwd && folderKind(cwd) === 'scratch' ? { scratch: true } : {}),
    ...(cwd && folderKind(cwd) === 'temp' ? { temp: true } : {}),
    ...(runningIn ? { runningIn } : {}),
    ...(lastTurn?.preview ? { preview: lastTurn.preview } : {}),
    ...(sideChatOf ? { sideChatOf } : {}),
    ...(archived.has(info.sessionId) ? { archived: true } : {}),
    // Open, idle, in another app too: its Claude does not see what is sent here until it reopens.
    ...(other && !other.busy ? { openIn: other.app ?? 'another app' } : {}),
  };
}

const defined = <T extends object>(value: T): Partial<T> =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;

/** A transcript as the list last saw it: its size and time then, and what the SDK made of it (null: nothing to list). */
type Seen = { id: string; file: string; size: number; mtimeMs: number; info: SDKSessionInfo | null; continuedIn?: string };

/** Every transcript the list has seen, by path. */
const seen = new Map<string, Seen>();
/** The transcript each listed session is shown from. */
const files = new Map<string, Seen>();
const statting = limiter(32);
const asking = limiter(8);
let refreshing: Promise<SDKSessionInfo[]> | undefined;

/**
 * Every session's info, as the SDK's `listSessions` gives it, without reading every transcript
 * each time: files are only stat'ed, and only those new or changed since the last look are read
 * again (`getSessionInfo`), a few at a time, so even a first look at thousands never stalls the
 * server. As in the SDK's listing, the newest copy of a session counts, and a session that went
 * on in another one with a transcript of its own is that one.
 */
async function refresh(): Promise<SDKSessionInfo[]> {
  const found = await transcriptFiles();
  const stats = await Promise.all(found.map(({ id, file }) => statting(async () => {
    const info = await stat(file).catch(() => undefined);
    return info?.isFile() ? { id, file, size: info.size, mtimeMs: info.mtimeMs } : undefined;
  })));
  const present = new Set<string>();
  const changed: Array<Omit<Seen, 'info'>> = [];
  for (const entry of stats) {
    if (!entry) continue;
    present.add(entry.file);
    const before = seen.get(entry.file);
    if (!before || before.size !== entry.size || before.mtimeMs !== entry.mtimeMs) changed.push(entry);
  }
  for (const file of seen.keys()) if (!present.has(file)) seen.delete(file);
  forgetTranscripts(present);
  await Promise.all(changed.map((entry) => asking(async () => {
    const turn = (await lastTurnTime(entry.file, entry))?.lastTurn;
    // The folder it ran in leads straight to the file; without one, every project is searched.
    const dir = seen.get(entry.file)?.info?.cwd ?? turn?.cwd;
    const info = (dir ? await getSessionInfo(entry.id, { dir }).catch(() => undefined) : undefined)
      ?? await getSessionInfo(entry.id).catch(() => undefined);
    seen.set(entry.file, { ...entry, info: info ?? null, ...(turn?.continuedIn ? { continuedIn: turn.continuedIn } : {}) });
  })));
  files.clear();
  for (const entry of seen.values()) {
    if (!entry.info) continue;
    const other = files.get(entry.id);
    if (!other || entry.mtimeMs > other.mtimeMs) files.set(entry.id, entry);
  }
  for (const [id, entry] of files) if (entry.continuedIn && files.has(entry.continuedIn)) files.delete(id);
  const infos = [...files.values()].map((entry) => entry.info!);
  // What a later look found (a folder the head of the file does not name) stays.
  for (const info of infos) infoCache.set(info.sessionId, { ...infoCache.get(info.sessionId), ...defined(info), sessionId: info.sessionId, summary: info.summary, lastModified: info.lastModified });
  return infos;
}

/** Requests that ask while one is being worked out share it. */
function sessionInfos(): Promise<SDKSessionInfo[]> {
  refreshing ??= refresh().finally(() => {
    refreshing = undefined;
  });
  return refreshing;
}

/** Every session on this machine, newest activity first. */
export async function listSummaries(status: StatusSource): Promise<SessionSummary[]> {
  const infos = await sessionInfos();
  const [live, archived] = await Promise.all([liveProcesses(), archivedIds()]);
  const summaries = await Promise.all(infos.map((info) => summarize(infoCache.get(info.sessionId) ?? info, status, live, archived)));
  return summaries.sort((a, b) => b.lastActivity - a.lastActivity);
}

export async function sessionInfo(sessionId: string): Promise<SDKSessionInfo | undefined> {
  // Without a project dir, `getSessionInfo` searches every project and may leave `cwd` out; the
  // list has both. One it has not seen yet is searched for, never a whole listing.
  const cached = infoCache.get(sessionId);
  // The folder it last ran in may not be the one its transcript is filed under: then search.
  const info = (cached?.cwd ? await getSessionInfo(sessionId, { dir: cached.cwd }).catch(() => undefined) : undefined)
    ?? await getSessionInfo(sessionId).catch(() => undefined);
  if (!info) return cached;
  let cwd = info.cwd || cached?.cwd;
  if (!cwd) {
    const file = await transcriptPath(sessionId);
    cwd = file ? (await lastTurnTime(file))?.lastTurn?.cwd : undefined;
  }
  const merged = { ...cached, ...defined(info), sessionId, summary: info.summary, lastModified: info.lastModified, ...(cwd ? { cwd } : {}) };
  infoCache.set(sessionId, merged);
  return merged;
}

export async function sessionSummary(sessionId: string, status: StatusSource): Promise<SessionSummary | undefined> {
  const info = await sessionInfo(sessionId);
  return info ? summarize(info, status, await liveProcesses(), await archivedIds()) : undefined;
}

export async function renameSessionTitle(sessionId: string, title: string): Promise<void> {
  const dir = infoCache.get(sessionId)?.cwd;
  await renameSession(sessionId, title, dir ? { dir } : {});
  infoCache.delete(sessionId);
}

/** What the session last ran with, from its transcript; empty for a session not written yet. */
export async function recordedSettings(sessionId: string): Promise<RecordedSettings> {
  const file = await transcriptPath(sessionId);
  return file ? readRecordedSettings(file) : {};
}

/** The whole conversation, oldest first, including what came before each compaction. */
export async function loadMessages(sessionId: string): Promise<ChatMessage[]> {
  const file = await transcriptPath(sessionId);
  return file ? readHistory(file) : [];
}

/**
 * Files Claude handed to the user in a session (SendUserFile, Artifact): the
 * only files outside the session's folder the app may show, and only these paths.
 */
export async function sentFiles(sessionId: string): Promise<Set<string>> {
  const paths = new Set<string>();
  for (const message of await loadMessages(sessionId)) {
    if (message.role !== 'assistant') continue;
    for (const block of message.blocks) {
      if (block.type !== 'tool_use') continue;
      if (block.name === 'SendUserFile' && Array.isArray(block.input.files)) {
        for (const file of block.input.files) if (typeof file === 'string') paths.add(file);
      } else if (block.name === 'Artifact' && typeof block.input.file_path === 'string') {
        paths.add(block.input.file_path);
      }
    }
  }
  return paths;
}

/** What a subagent did inside an Agent call: its own transcript, next to the session's. */
export async function loadSubagent(sessionId: string, agentId: string): Promise<ChatMessage[]> {
  if (!/^[\w-]{1,80}$/.test(agentId)) return [];
  const dir = infoCache.get(sessionId)?.cwd;
  const raw = await getSubagentMessages(sessionId, agentId, dir ? { dir } : {}).catch(() => []);
  return raw
    .map((message) => toChatMessage(message as unknown as Record<string, unknown>))
    .filter((message): message is ChatMessage => Boolean(message));
}

/** A page of messages ending before index `before` (default: the end). */
export async function loadPage(sessionId: string, before: number | undefined, limit: number): Promise<MessagesPage> {
  const all = await loadMessages(sessionId);
  const end = Math.min(before ?? all.length, all.length);
  const offset = Math.max(0, end - limit);
  return { messages: all.slice(offset, end), total: all.length, offset };
}
