import { appendFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { getSessionInfo, renameSession } from '@anthropic-ai/claude-agent-sdk';
import type { SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk';

import type { ChatMessage, MessagesPage, RecordedSettings, Rewound, SessionStatus, SessionSummary, ToolResultBlock } from '../shared/protocol.js';
import { promptGist } from '../shared/quoted.js';
import { COMMIT_REQUEST, CREATE_PR_OPEN } from '../shared/requests.js';
import { shortTitle } from '../shared/titles.js';
import { config } from './config.js';
import { folderKind, pickedFolders } from './folders.js';
import { type Kept, kept } from './kept.js';
import { type LiveProcess, liveProcesses } from './live.js';
import { readHistory, readRecordedSettings } from './history.js';
import { beforeCut, liveCut, shownCut } from './rewound.js';
import { SIDE_CHAT_TITLE, type SideQuestion, sideChatQuestion, sideChatSource } from './side-chat.js';
import { forgetTranscripts, lastPromptExcept, lastTurnTime, limiter, transcriptFiles, transcriptPath } from './transcripts.js';

export type StatusSource = (sessionId: string) => SessionStatus | undefined;
/** How much background work runs in a session this app runs (runner's runTasks). */
export type TaskSource = (sessionId: string) => number;

const infoCache = new Map<string, SDKSessionInfo>();

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * What a session is called. A title it was given (a /rename, or the one Claude Code wrote for it)
 * and a summary Claude Code wrote stay as they are. Without either, the SDK names it by the text
 * of a prompt, the last or the first, a pasted page as likely as a line: that is shortened to a
 * title (shortTitle). `summarized`: the transcript ends on a summary Claude Code wrote, with no
 * last prompt after it, which is then what the SDK gives as `summary`.
 */
export function sessionTitle(info: SDKSessionInfo, summarized = false): string | undefined {
  if (info.customTitle && oneLine(info.customTitle)) return oneLine(info.customTitle);
  if (summarized && info.summary && oneLine(info.summary)) return oneLine(info.summary);
  // A prompt that quotes (Claude Desktop's replies, Pelican's too) is called by its words, not its markers.
  return shortTitle(promptGist(info.summary || info.firstPrompt || '')) || undefined;
}

/** One of Claude Desktop's requests that Pelican sends, Commit changes or Create PR: whole, or as much of it as Claude Code kept. */
export const namesRequest = (text: string): boolean => {
  const whole = text.trim();
  return whole === COMMIT_REQUEST || whole.startsWith(CREATE_PR_OPEN);
};

const namedBefore = new Map<string, { size: number; mtimeMs: number; name: string | undefined }>();

/** The prompt Claude Code last recorded as the session's name before Desktop's requests, cached by the file's size and time. */
async function nameBeforeRequests(file: string): Promise<string | undefined> {
  const now = await stat(file).catch(() => undefined);
  if (!now) return undefined;
  const cached = namedBefore.get(file);
  if (cached && cached.size === now.size && cached.mtimeMs === now.mtimeMs) return cached.name;
  const name = await lastPromptExcept(file, namesRequest);
  namedBefore.set(file, { size: now.size, mtimeMs: now.mtimeMs, name });
  return name;
}

/**
 * A session Claude Code names by its last prompt (no title of its own) keeps the name it had when
 * that prompt is one of Claude Desktop's requests, Commit changes or Create PR, as Desktop keeps a
 * session's title through them: the prompt Claude Code recorded before them, else the first. The
 * SDK's `summary`, which names it in the list, the header and the notifications, says so.
 */
async function named(info: SDKSessionInfo, transcript: () => Promise<string | undefined>): Promise<SDKSessionInfo> {
  if (info.customTitle || !info.summary || !namesRequest(info.summary)) return info;
  const file = await transcript();
  const name = (file && await nameBeforeRequests(file)) || (info.firstPrompt && !namesRequest(info.firstPrompt) ? info.firstPrompt : undefined);
  return name ? { ...info, summary: name } : info;
}

/**
 * Claude Code records a session's last prompt as it exits, its name for every app that names
 * sessions so (the terminal's /resume, Claude Desktop, an editor's): once a Claude process whose
 * last prompt was one of Desktop's requests has ended, the name the session had is recorded back
 * the same way, as a rewind keeps a session's name.
 */
export async function keepNameThroughRequests(sessionId: string): Promise<void> {
  const file = await transcriptPath(sessionId);
  const latest = file ? await lastPromptExcept(file) : undefined;
  if (!file || !latest || !namesRequest(latest)) return;
  const info = await sessionInfo(sessionId);
  if (!info || info.customTitle || namesRequest(info.summary)) return;
  await appendFile(file, `${JSON.stringify({ type: 'last-prompt', lastPrompt: info.summary, sessionId })}\n`);
}

/** `fresh`: the transcript as the list stat'ed it just now; otherwise it is looked at here. */
async function summarize(
  info: SDKSessionInfo, status: StatusSource, tasks: TaskSource, live: Map<string, LiveProcess>, { archived, pinned }: Kept, picked: ReadonlySet<string>, fresh?: Seen,
): Promise<SessionSummary> {
  const file = fresh?.file ?? await transcriptPath(info.sessionId);
  const times = file ? await lastTurnTime(file, fresh) : undefined;
  const lastTurn = times?.lastTurn;
  const lastActivity = lastTurn?.time ?? info.lastModified;
  const own = status(info.sessionId);
  const working = own ? tasks(info.sessionId) : 0;
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
  // Side chats, Claude Desktop's and Pelican's: a copy of a conversation with a question or two of its own.
  const sideChatOf = fresh ? fresh.sideChatOf : file ? await sideChatSource(file) : undefined;
  const question = !sideChatOf ? undefined : fresh ? fresh.sideQuestion : file ? await sideChatQuestion(file) : undefined;
  // A side chat is called by its first question, unless someone named it otherwise.
  const titled = sessionTitle(info, lastTurn?.summarized) ?? 'Untitled session';
  const title = question && titled === SIDE_CHAT_TITLE ? question.text : titled;
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
    ...(cwd && folderKind(cwd, picked) === 'scratch' ? { scratch: true } : {}),
    ...(cwd && folderKind(cwd, picked) === 'temp' ? { temp: true } : {}),
    ...(runningIn ? { runningIn } : {}),
    ...(lastTurn?.stopped ? { stopped: lastTurn.stopped } : lastTurn?.preview ? { preview: lastTurn.preview } : {}),
    ...(working > 0 ? { tasks: working } : {}),
    ...(sideChatOf ? { sideChatOf } : {}),
    ...(question ? { sideQuestion: question.text, sideStart: question.uuid } : {}),
    // Never both (kept.ts); should the files say both (written by hand), archived wins.
    ...(archived.has(info.sessionId) ? { archived: true } : pinned.has(info.sessionId) ? { pinned: true } : {}),
    // Open, idle, in another app too: its Claude does not see what is sent here until it reopens.
    ...(other && !other.busy ? { openIn: other.app ?? 'another app' } : {}),
  };
}

const defined = <T extends object>(value: T): Partial<T> =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;

/**
 * A transcript as the list last saw it: its size and time then, what the SDK made of it (null:
 * nothing to list), and the session it is a side chat of, with its first question.
 */
type Seen = { id: string; file: string; size: number; mtimeMs: number; info: SDKSessionInfo | null; continuedIn?: string; sideChatOf?: string; sideQuestion?: SideQuestion };

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
  for (const file of namedBefore.keys()) if (!present.has(file)) namedBefore.delete(file);
  forgetTranscripts(present);
  await Promise.all(changed.map((entry) => asking(async () => {
    const turn = (await lastTurnTime(entry.file, entry))?.lastTurn;
    // The folder it ran in leads straight to the file; without one, every project is searched.
    const dir = seen.get(entry.file)?.info?.cwd ?? turn?.cwd;
    const found = (dir ? await getSessionInfo(entry.id, { dir }).catch(() => undefined) : undefined)
      ?? await getSessionInfo(entry.id).catch(() => undefined);
    const info = found && await named(found, async () => entry.file);
    const sideChatOf = info ? await sideChatSource(entry.file) : undefined;
    const sideQuestion = sideChatOf ? await sideChatQuestion(entry.file) : undefined;
    seen.set(entry.file, {
      ...entry, info: info ?? null, ...(turn?.continuedIn ? { continuedIn: turn.continuedIn } : {}), ...(sideChatOf ? { sideChatOf } : {}), ...(sideQuestion ? { sideQuestion } : {}),
    });
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
export async function listSummaries(status: StatusSource, tasks: TaskSource = () => 0): Promise<SessionSummary[]> {
  const infos = await sessionInfos();
  const [live, ours, picked] = await Promise.all([liveProcesses(), kept(), pickedFolders()]);
  const summaries = await Promise.all(infos.map((info) => summarize(infoCache.get(info.sessionId) ?? info, status, tasks, live, ours, picked, files.get(info.sessionId))));
  return summaries.sort((a, b) => b.lastActivity - a.lastActivity);
}

export async function sessionInfo(sessionId: string): Promise<SDKSessionInfo | undefined> {
  // Without a project dir, `getSessionInfo` searches every project and may leave `cwd` out; the
  // list has both. One it has not seen yet is searched for, never a whole listing.
  const cached = infoCache.get(sessionId);
  // The folder it last ran in may not be the one its transcript is filed under: then search.
  const found = (cached?.cwd ? await getSessionInfo(sessionId, { dir: cached.cwd }).catch(() => undefined) : undefined)
    ?? await getSessionInfo(sessionId).catch(() => undefined);
  if (!found) return cached;
  const info = await named(found, () => transcriptPath(sessionId));
  let cwd = info.cwd || cached?.cwd;
  if (!cwd) {
    const file = await transcriptPath(sessionId);
    cwd = file ? (await lastTurnTime(file))?.lastTurn?.cwd : undefined;
  }
  const merged = { ...cached, ...defined(info), sessionId, summary: info.summary, lastModified: info.lastModified, ...(cwd ? { cwd } : {}) };
  infoCache.set(sessionId, merged);
  return merged;
}

export async function sessionSummary(sessionId: string, status: StatusSource, tasks: TaskSource = () => 0): Promise<SessionSummary | undefined> {
  const info = await sessionInfo(sessionId);
  if (!info) return undefined;
  const [live, ours, picked] = await Promise.all([liveProcesses(), kept(), pickedFolders()]);
  return summarize(info, status, tasks, live, ours, picked);
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
 * Files Claude handed to the user in a session: the only files the app shows by a path a request
 * names, and only these paths. For SendUserFile, each file Claude Code recorded it delivered, at
 * the path it checked, never the path Claude asked for; for Claude Desktop's Artifact, the file
 * it published. Only calls that ran: one Claude only wrote (no app answered it, or it failed)
 * hands over nothing.
 */
export async function sentFiles(sessionId: string): Promise<Set<string>> {
  const messages = await loadMessages(sessionId);
  const ran = new Map<string, ToolResultBlock>();
  for (const message of messages) {
    for (const block of message.blocks) if (block.type === 'tool_result' && !block.is_error) ran.set(block.tool_use_id, block);
  }
  const paths = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const block of message.blocks) {
      if (block.type !== 'tool_use') continue;
      const result = ran.get(block.id);
      if (!result) continue;
      if (block.name === 'SendUserFile') {
        for (const file of result.delivered?.files ?? []) paths.add(file.path);
      } else if (block.name === 'Artifact' && typeof block.input.file_path === 'string') {
        paths.add(block.input.file_path);
      }
    }
  }
  return paths;
}

/**
 * The conversation as it reads now: where it was rewound (Rewind to here), up to the cut, until
 * the next message (rewound.ts), and where it went back to before, for the pages to show.
 */
export async function shownMessages(sessionId: string): Promise<{ messages: ChatMessage[]; rewound?: Rewound }> {
  const cut = await liveCut(sessionId);
  const messages = beforeCut(await loadMessages(sessionId), cut);
  const rewound = shownCut(cut);
  return { messages, ...(rewound ? { rewound } : {}) };
}

/** A page of the conversation as it reads now, ending before index `before` (default: the end). */
export async function loadPage(sessionId: string, before: number | undefined, limit: number): Promise<MessagesPage> {
  const { messages: all, rewound } = await shownMessages(sessionId);
  const end = Math.min(before ?? all.length, all.length);
  const offset = Math.max(0, end - limit);
  return { messages: all.slice(offset, end), total: all.length, offset, ...(rewound && before === undefined ? { rewound } : {}) };
}
