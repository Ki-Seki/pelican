import { stat } from 'node:fs/promises';
import path from 'node:path';

import { getSessionInfo, getSubagentMessages, listSessions, renameSession } from '@anthropic-ai/claude-agent-sdk';
import type { SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk';

import type { ChatMessage, MessagesPage, RecordedSettings, SessionStatus, SessionSummary } from '../shared/protocol.js';
import { archivedIds } from './archive.js';
import { config } from './config.js';
import { folderKind } from './folders.js';
import { type LiveProcess, liveProcesses } from './live.js';
import { readHistory, readRecordedSettings } from './history.js';
import { toChatMessage } from './normalize.js';
import { firstTurnSession, lastTurnTime, transcriptPath } from './transcripts.js';

export type StatusSource = (sessionId: string) => SessionStatus | undefined;

const infoCache = new Map<string, SDKSessionInfo>();

function titleOf(info: SDKSessionInfo): string {
  const title = info.customTitle || info.summary || info.firstPrompt || '';
  return title.replace(/\s+/g, ' ').trim() || 'Untitled session';
}

async function summarize(info: SDKSessionInfo, status: StatusSource, live: Map<string, LiveProcess>, archived: Set<string>): Promise<SessionSummary> {
  const file = await transcriptPath(info.sessionId);
  const times = file ? await lastTurnTime(file) : undefined;
  const lastTurn = times?.lastTurn;
  const lastActivity = lastTurn?.time ?? info.lastModified;
  const own = status(info.sessionId);
  let state: SessionStatus = own ?? 'idle';
  // Another app's Claude process says it is busy; failing that, a turn written moments ago
  // (not one a fork just copied over: a new branch is idle until someone sends to it).
  const other = live.get(info.sessionId);
  const elsewhere = own ? undefined : other;
  const recent = lastTurn && !lastTurn.copied && Date.now() - lastTurn.time < config.liveWindowMs;
  if (!own && (elsewhere?.busy || recent)) state = 'live';
  // Idle here but working in another app: that is what the session is doing.
  else if (own === 'idle' && other?.busy) state = 'live';
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
    ...(state === 'live' && other?.busy && other.app ? { runningIn: other.app } : {}),
    ...(lastTurn?.preview ? { preview: lastTurn.preview } : {}),
    ...(sideChatOf ? { sideChatOf } : {}),
    ...(archived.has(info.sessionId) ? { archived: true } : {}),
    // Open, idle, in another app too: its Claude does not see what is sent here until it reopens.
    ...(other && !other.busy ? { openIn: other.app ?? 'another app' } : {}),
  };
}

/** Every session on this machine, newest activity first. */
export async function listSummaries(status: StatusSource): Promise<SessionSummary[]> {
  const infos = await listSessions({ includeProgrammatic: true });
  for (const info of infos) infoCache.set(info.sessionId, info);
  const [live, archived] = await Promise.all([liveProcesses(), archivedIds()]);
  const summaries = await Promise.all(infos.map((info) => summarize(info, status, live, archived)));
  return summaries.sort((a, b) => b.lastActivity - a.lastActivity);
}

export async function sessionInfo(sessionId: string): Promise<SDKSessionInfo | undefined> {
  // Without a project dir, `getSessionInfo` leaves `cwd` out; the list has it.
  if (!infoCache.has(sessionId)) {
    for (const info of await listSessions({ includeProgrammatic: true }).catch(() => [])) infoCache.set(info.sessionId, info);
  }
  const cached = infoCache.get(sessionId);
  const info = await getSessionInfo(sessionId, cached?.cwd ? { dir: cached.cwd } : {}).catch(() => undefined);
  if (!info) return cached;
  let cwd = info.cwd || cached?.cwd;
  if (!cwd) {
    const file = await transcriptPath(sessionId);
    cwd = file ? (await lastTurnTime(file))?.lastTurn?.cwd : undefined;
  }
  const merged = { ...cached, ...info, ...(cwd ? { cwd } : {}) };
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
  const messages = await loadMessages(sessionId);
  // Only calls that ran: one Claude only wrote (no app answered it, or it failed) hands over nothing.
  const ran = new Set<string>();
  for (const message of messages) {
    for (const block of message.blocks) if (block.type === 'tool_result' && !block.is_error) ran.add(block.tool_use_id);
  }
  const paths = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const block of message.blocks) {
      if (block.type !== 'tool_use' || !ran.has(block.id)) continue;
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
