import { stat } from 'node:fs/promises';
import path from 'node:path';

import { getSessionInfo, getSessionMessages, listSessions, renameSession } from '@anthropic-ai/claude-agent-sdk';
import type { SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk';

import type { ChatMessage, MessagesPage, SessionStatus, SessionSummary } from '../shared/protocol.js';
import { config } from './config.js';
import { isScratchFolder } from './folders.js';
import { type LiveProcess, liveProcesses } from './live.js';
import { toChatMessage } from './normalize.js';
import { lastTurnTime, transcriptPath } from './transcripts.js';

export type StatusSource = (sessionId: string) => SessionStatus | undefined;

const infoCache = new Map<string, SDKSessionInfo>();

function titleOf(info: SDKSessionInfo): string {
  const title = info.customTitle || info.summary || info.firstPrompt || '';
  return title.replace(/\s+/g, ' ').trim() || 'Untitled session';
}

async function summarize(info: SDKSessionInfo, status: StatusSource, live: Map<string, LiveProcess>): Promise<SessionSummary> {
  const file = await transcriptPath(info.sessionId);
  const times = file ? await lastTurnTime(file) : undefined;
  const lastTurn = times?.lastTurn;
  const lastActivity = lastTurn?.time ?? info.lastModified;
  const own = status(info.sessionId);
  let state: SessionStatus = own ?? 'idle';
  // Another app's Claude process says it is busy; failing that, a turn written moments ago.
  const elsewhere = own ? undefined : live.get(info.sessionId);
  if (!own && (elsewhere?.busy || (lastTurn && Date.now() - lastTurn.time < config.liveWindowMs))) state = 'live';
  const cwd = info.cwd || lastTurn?.cwd || '';
  if (!info.cwd && cwd) infoCache.set(info.sessionId, { ...info, cwd });
  const gitBranch = lastTurn?.gitBranch ?? info.gitBranch;
  return {
    id: info.sessionId,
    title: titleOf(info),
    cwd,
    project: cwd ? path.basename(cwd) : '',
    ...(gitBranch && gitBranch !== 'HEAD' ? { gitBranch } : {}),
    lastActivity,
    ...(info.createdAt ? { createdAt: info.createdAt } : {}),
    status: state,
    ...(info.fileSize ? { sizeBytes: info.fileSize } : {}),
    ...(cwd && isScratchFolder(cwd) ? { scratch: true } : {}),
    ...(state === 'live' && elsewhere?.busy ? { runningIn: elsewhere.app } : {}),
    ...(lastTurn?.preview ? { preview: lastTurn.preview } : {}),
  };
}

/** Every session on this machine, newest activity first. */
export async function listSummaries(status: StatusSource): Promise<SessionSummary[]> {
  const infos = await listSessions({ includeProgrammatic: true });
  for (const info of infos) infoCache.set(info.sessionId, info);
  const live = await liveProcesses();
  const summaries = await Promise.all(infos.map((info) => summarize(info, status, live)));
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
  return info ? summarize(info, status, await liveProcesses()) : undefined;
}

export async function renameSessionTitle(sessionId: string, title: string): Promise<void> {
  const dir = infoCache.get(sessionId)?.cwd;
  await renameSession(sessionId, title, dir ? { dir } : {});
  infoCache.delete(sessionId);
}

type Cached = { size: number; mtimeMs: number; messages: ChatMessage[] };
const messageCache = new Map<string, Cached>();
const MAX_CACHED = 24;

/** The whole conversation chain, as Claude Code itself resolves it (forks, compactions). */
export async function loadMessages(sessionId: string): Promise<ChatMessage[]> {
  const file = await transcriptPath(sessionId);
  if (!file) return [];
  let info;
  try {
    info = await stat(file);
  } catch {
    return [];
  }
  const cached = messageCache.get(sessionId);
  if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.messages;
  const dir = infoCache.get(sessionId)?.cwd;
  const raw = await getSessionMessages(sessionId, dir ? { dir } : {});
  const messages = raw
    .map((message) => toChatMessage(message as unknown as Record<string, unknown>))
    .filter((message): message is ChatMessage => Boolean(message));
  messageCache.delete(sessionId);
  messageCache.set(sessionId, { size: info.size, mtimeMs: info.mtimeMs, messages });
  while (messageCache.size > MAX_CACHED) messageCache.delete(messageCache.keys().next().value!);
  return messages;
}

/** A page of messages ending before index `before` (default: the end). */
export async function loadPage(sessionId: string, before: number | undefined, limit: number): Promise<MessagesPage> {
  const all = await loadMessages(sessionId);
  const end = Math.min(before ?? all.length, all.length);
  const offset = Math.max(0, end - limit);
  return { messages: all.slice(offset, end), total: all.length, offset };
}
