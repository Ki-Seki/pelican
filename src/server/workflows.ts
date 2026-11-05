import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import type { Block, ChatMessage, ToolResultBlock, ToolUseBlock, Workflow, WorkflowAgent, WorkflowAgentPage, WorkflowPhase, WorkflowStatus } from '../shared/protocol.js';
import { addPhase, agentTokens, launchOf, parseMeta, parseTaskNotice, RUN_ID, type TaskNotice, unframedPrompt, workflowOf } from '../shared/workflows.js';
import { readHistory } from './history.js';
import { liveProcesses } from './live.js';
import { openRegular } from './open.js';
import { loadMessages } from './sessions.js';
import { transcriptPath } from './transcripts.js';

/**
 * Workflows as Claude Code leaves them on disk, beside a session's transcript, in the session's own
 * folder (`<project>/<session id>/`):
 * - `workflows/<run id>.json`: its record, written once the run ends (what the CLI's /workflows reads);
 * - `subagents/workflows/<run id>/journal.jsonl`: each agent started, and its result, as it goes;
 * - `subagents/workflows/<run id>/agent-<id>.jsonl` and `.meta.json`: each agent's own transcript;
 * - `workflows/scripts/<name>-<run id>.js`: the script it ran.
 * Only those names are read, each checked to be a regular file whose real path is inside that
 * folder, and within a size: nothing else on the computer can be reached through them.
 */

const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A tool call's id, as the transcript holds it (`toolu_…`); only ever looked up there. */
export const CALL_ID = /^[\w-]{1,128}$/;
/** An agent's id, as Claude Code names its transcript `agent-<id>.jsonl`. */
export const AGENT_ID = /^[\w-]{1,80}$/;

const RECORD_MAX = 8 * 1024 * 1024;
const META_FILE_MAX = 64 * 1024;
const SCRIPT_MAX = 256 * 1024;
const JOURNAL_MAX = 64 * 1024 * 1024;
const RESULT_MAX = 16 * 1024;
const PROMPT_MAX = 8 * 1024;
const SCRIPT_SHOWN_MAX = 64 * 1024;
/** An agent that wrote this recently is at work. */
const ACTIVE_MS = 60_000;
/**
 * Longer than Claude Code lets a workflow's agents go silent: it gives up on one after ten minutes
 * without progress (more with a tool at work) and starts it again, and the new one writes.
 */
const QUIET_MS = 20 * 60_000;
/** Agents' transcripts read at once, at most, a little at a time: a run can have dozens of large ones. */
const READERS = 3;
const CHUNK = 1024 * 1024;

const str = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n…` : text);
const cut = (value: unknown, max: number) => (typeof value === 'string' && value ? (value.length > max ? `${value.slice(0, max - 1)}…` : value) : undefined);

/**
 * A long result cut where a line ends, saying how much was left out, as Claude Code cuts the one it
 * hands Claude: JSON cut there stays readable as JSON, line by line.
 */
function clipLines(text: string, max: number): string {
  if (text.length <= max) return text;
  const at = text.lastIndexOf('\n', max);
  const end = at > max / 2 ? at : max;
  return `${text.slice(0, end)}\n... (truncated ${text.length - end} chars)`;
}

/** What a run or an agent returned, as text: a string as it is, a value as JSON, laid out. */
function resultText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text ? clipLines(text, RESULT_MAX) : undefined;
}

/**
 * One read at a time per file, for the readers below that carry on from where the last one
 * stopped: two pages asking at once (a phone and a computer, a run and one of its agents) would
 * otherwise both read the same new bytes and both count them.
 */
const reading = new Map<string, Promise<unknown>>();
function oneAtATime<T>(file: string, read: () => Promise<T>): Promise<T> {
  const previous = reading.get(file) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(read);
  reading.set(file, next);
  void next.finally(() => {
    if (reading.get(file) === next) reading.delete(file);
  }).catch(() => undefined);
  return next;
}

/** `fn` over `items`, `limit` at a time, the results in order. */
async function inTurn<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i]!, i);
    }
  }));
  return out;
}

// ---- Files inside the session's folder ---------------------------------------------------------

type Where = { dir: string; file: string };

/** The session's own folder, next to its transcript: where Claude Code keeps its workflows. */
async function sessionDir(sessionId: string): Promise<Where | undefined> {
  if (!SESSION.test(sessionId)) return undefined;
  const file = await transcriptPath(sessionId);
  return file ? { file, dir: path.join(path.dirname(file), sessionId) } : undefined;
}

/** `file`'s real path, when that is inside the session's folder (links followed and checked). */
async function inside(dir: string, file: string): Promise<string | undefined> {
  try {
    const [root, real] = await Promise.all([realpath(dir), realpath(file)]);
    return real.startsWith(`${root}${path.sep}`) ? real : undefined;
  } catch {
    return undefined;
  }
}

type Read = { text: string; mtimeMs: number; size: number };

/** A regular file inside the session's folder, whole when it is no larger than `max`; else its first `max` bytes if `head`. */
async function readInside(dir: string, file: string, max: number, head = false): Promise<Read | undefined> {
  const real = await inside(dir, file);
  if (!real) return undefined;
  const handle = await openRegular(real).catch(() => undefined);
  if (!handle) return undefined;
  try {
    const info = await handle.stat();
    if (info.size > max && !head) return undefined;
    const buffer = Buffer.alloc(Math.min(info.size, max));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return { text: buffer.toString('utf8', 0, bytesRead), mtimeMs: info.mtimeMs, size: info.size };
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

/** Kept reads of small files that change seldom (records, meta files), by path, while unchanged. */
const kept = new Map<string, { mtimeMs: number; size: number; value: unknown }>();

async function cachedJson<T>(dir: string, file: string, max: number, shape: (value: unknown) => T | undefined): Promise<T | undefined> {
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile()) return undefined;
  const known = kept.get(file);
  if (known && known.mtimeMs === info.mtimeMs && known.size === info.size) return known.value as T | undefined;
  const read = await readInside(dir, file, max);
  let value: T | undefined;
  try {
    value = read ? shape(JSON.parse(read.text)) : undefined;
  } catch {
    value = undefined;
  }
  // A record being written is read again once it is whole.
  if (read) remember(kept, file, { mtimeMs: read.mtimeMs, size: read.size, value }, 256);
  return value;
}

function remember<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value as K);
}

/** Each line of `data` that a newline ends, as text, cut on bytes: a character split across reads comes out whole. */
function lines(data: Buffer, each: (line: string) => void): Buffer {
  const last = data.lastIndexOf(0x0a);
  if (last < 0) return Buffer.from(data);
  for (const line of data.toString('utf8', 0, last).split('\n')) each(line);
  return Buffer.from(data.subarray(last + 1));
}

// ---- The run's record ------------------------------------------------------------------------

type RunRecord = {
  taskId?: string;
  name?: string;
  summary?: string;
  status: WorkflowStatus;
  startTime?: number;
  durationMs?: number;
  totalTokens?: number;
  totalToolCalls?: number;
  phases: WorkflowPhase[];
  items: unknown[];
  error?: string;
  result?: string;
  script?: string;
};

function recordOf(value: unknown): RunRecord | undefined {
  if (!isRecord(value)) return undefined;
  const status = value.status === 'completed' || value.status === 'failed' || value.status === 'killed' ? value.status : undefined;
  if (!status) return undefined;
  const phases = (Array.isArray(value.phases) ? value.phases : []).filter(isRecord).flatMap((p): WorkflowPhase[] => {
    const title = cut(p.title, 120);
    const detail = cut(p.detail, 400);
    return title ? [{ title, ...(detail ? { detail } : {}) }] : [];
  });
  const error = typeof value.error === 'string' ? value.error : isRecord(value.error) ? str(value.error.message) : undefined;
  return {
    ...(str(value.taskId) ? { taskId: str(value.taskId)! } : {}),
    ...(cut(value.workflowName, 200) ? { name: cut(value.workflowName, 200)! } : {}),
    ...(cut(value.summary, 2000) ? { summary: cut(value.summary, 2000)! } : {}),
    status,
    ...(num(value.startTime) !== undefined ? { startTime: num(value.startTime)! } : {}),
    ...(num(value.durationMs) !== undefined ? { durationMs: num(value.durationMs)! } : {}),
    ...(num(value.totalTokens) !== undefined ? { totalTokens: num(value.totalTokens)! } : {}),
    ...(num(value.totalToolCalls) !== undefined ? { totalToolCalls: num(value.totalToolCalls)! } : {}),
    phases,
    items: Array.isArray(value.workflowProgress) ? value.workflowProgress : [],
    ...(error ? { error: clip(error, 4000) } : {}),
    ...(resultText(value.result) ? { result: resultText(value.result)! } : {}),
    ...(str(value.script) ? { script: clip(str(value.script)!, SCRIPT_SHOWN_MAX) } : {}),
  };
}

const recordFile = (dir: string, runId: string) => path.join(dir, 'workflows', `${runId}.json`);

// ---- Progress items, as Claude Code reports them ---------------------------------------------

/** A `workflow_agent` item, its long texts cut. */
export function agentItem(item: unknown): WorkflowAgent | undefined {
  if (!isRecord(item) || item.type !== 'workflow_agent') return undefined;
  const index = num(item.index);
  const state = item.state;
  if (index === undefined || (state !== 'start' && state !== 'progress' && state !== 'done' && state !== 'error')) return undefined;
  const out: WorkflowAgent = { index, label: cut(item.label, 200) ?? `Agent ${index}`, state };
  for (const key of ['phaseIndex', 'tokens', 'toolCalls', 'durationMs', 'queuedAt', 'startedAt', 'lastProgressAt', 'attempt'] as const) {
    const value = num(item[key]);
    if (value !== undefined) out[key] = value;
  }
  for (const key of ['phaseTitle', 'agentId', 'agentType', 'model', 'fallbackModel', 'lastToolName'] as const) {
    const value = cut(item[key], 120);
    if (value) out[key] = value;
  }
  const texts: Array<[keyof WorkflowAgent, number]> = [['error', 600], ['lastToolSummary', 160], ['resultPreview', 400], ['promptPreview', 400]];
  for (const [key, max] of texts) {
    const value = cut(item[key], max);
    if (value) (out as Record<string, unknown>)[key] = value;
  }
  if (item.isolation === 'worktree' || item.isolation === 'remote') out.isolation = item.isolation;
  if (item.lastAttemptReason === 'stalled' || item.lastAttemptReason === 'throttled' || item.lastAttemptReason === 'user-retry') out.lastAttemptReason = item.lastAttemptReason;
  for (const key of ['skipped', 'blocked', 'cached'] as const) if (item[key] === true) out[key] = true;
  return out;
}

/** Phases as the run lists them (`workflow_phase` items), after the script's own. */
function withPhases(phases: WorkflowPhase[], items: unknown[]): WorkflowPhase[] {
  const out = [...phases];
  for (const item of items) {
    if (!isRecord(item) || item.type !== 'workflow_phase') continue;
    const title = cut(item.title, 120);
    if (title) addPhase(out, title);
  }
  return out;
}

// ---- The journal ------------------------------------------------------------------------------

/** An agent as the journal tells it: started, done with a result, or failed; the latest line wins. */
type JournalAgent = { key: string; agentId?: string; label?: string; phase?: string; state: 'started' | 'done' | 'failed'; result?: string };

type Journal = { ino: number; offset: number; carry: Buffer; agents: Map<string, JournalAgent> };

const journals = new Map<string, Journal>();

/** One journal line. A line cut short (Claude Code was stopped mid-write) or of another kind is passed over, as Claude Code does. */
function journalLine(agents: Map<string, JournalAgent>, line: string): void {
  if (!line.trim()) return;
  let event: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed)) return;
    event = parsed;
  } catch {
    return;
  }
  const key = str(event.key);
  if (!key || key.length > 200) return;
  const known = agents.get(key);
  const agentId = cut(event.agentId, 80) ?? known?.agentId;
  // The script names them: as long as it likes, in the journal; as long as the record has them, here.
  const label = (event.type === 'started' ? cut(event.label, 200) : undefined) ?? known?.label;
  const phase = (event.type === 'started' ? cut(event.phase, 120) : undefined) ?? known?.phase;
  const base = { key, ...(agentId ? { agentId } : {}), ...(label ? { label } : {}), ...(phase ? { phase } : {}) };
  if (event.type === 'started') {
    agents.set(key, { ...base, state: 'started' });
  } else if (event.type === 'result') {
    const result = resultText(event.result);
    agents.set(key, { ...base, state: 'done', ...(result ? { result } : {}) });
  } else if (event.type === 'failed') {
    agents.set(key, { ...base, state: 'failed' });
  }
}

/** The run's journal, read once and then only by what was added to it. */
async function readJournal(dir: string, runId: string): Promise<JournalAgent[] | undefined> {
  const file = path.join(dir, 'subagents', 'workflows', runId, 'journal.jsonl');
  const real = await inside(dir, file);
  if (!real) return undefined;
  return oneAtATime(real, async () => {
    const handle = await openRegular(real).catch(() => undefined);
    if (!handle) return undefined;
    try {
      const info = await handle.stat();
      let journal = journals.get(real);
      if (!journal || journal.ino !== info.ino || info.size < journal.offset) journal = { ino: info.ino, offset: 0, carry: Buffer.alloc(0), agents: new Map() };
      const end = Math.min(info.size, JOURNAL_MAX);
      while (journal.offset < end) {
        const buffer = Buffer.allocUnsafe(Math.min(4 * CHUNK, end - journal.offset));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, journal.offset);
        if (bytesRead <= 0) break;
        const data = journal.carry.length > 0 ? Buffer.concat([journal.carry, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead);
        // The offset moves with the line it may leave unfinished: a read that fails part way carries on from there.
        const agents = journal.agents;
        journal.carry = lines(data, (line) => journalLine(agents, line));
        journal.offset += bytesRead;
      }
      remember(journals, real, journal, 64);
      // A last line without its newline yet counts if it is whole; it is read again with the rest.
      const agents = new Map(journal.agents);
      if (journal.carry.length > 0) journalLine(agents, journal.carry.toString('utf8'));
      return [...agents.values()];
    } catch {
      return undefined;
    } finally {
      await handle.close();
    }
  });
}

// ---- Agents' own files ------------------------------------------------------------------------

type AgentMeta = { agentType?: string; label?: string; phase?: string; model?: string };

function agentMetaOf(value: unknown): AgentMeta | undefined {
  if (!isRecord(value)) return undefined;
  const agentType = cut(value.agentType, 120);
  const label = cut(value.description, 200);
  const phase = cut(value.workflowPhase, 120);
  const model = cut(value.pickedEffortModel, 120);
  return { ...(agentType ? { agentType } : {}), ...(label ? { label } : {}), ...(phase ? { phase } : {}), ...(model ? { model } : {}) };
}

/**
 * What an agent's transcript says of it, without keeping it: when it started and last wrote, its
 * model, its tool calls, its last tool, and its context at its latest response (Claude Code's
 * "tokens"). Read once, then only by what was added, a little at a time.
 */
type AgentStats = {
  ino: number;
  offset: number;
  /** The start of a line not finished yet; of one too long to keep, its first bytes and its last. */
  carry: Buffer;
  long?: { head: Buffer; tail: Buffer };
  startedAt?: number;
  lastAt?: number;
  model?: string;
  tokens?: number;
  toolCalls: number;
  lastTool?: string;
};

const stats = new Map<string, AgentStats>();
const ASSISTANT = /"type":\s*"assistant"/;
const TIMESTAMP = /"timestamp":\s*"([^"]{10,40})"/;
/** A row longer than this (a copy of an API request, a huge tool output) is only looked at for its time. */
const LINE_MAX = 2 * 1024 * 1024;
const TAIL = 4096;
const ROW = Buffer.from('{"parentUuid"');

function noteTime(agent: AgentStats, text: string): void {
  const time = TIMESTAMP.exec(text)?.[1];
  const at = time ? Date.parse(time) : NaN;
  if (Number.isNaN(at)) return;
  agent.startedAt ??= at;
  agent.lastAt = at;
}

function statLine(agent: AgentStats, line: string): void {
  // Rows of the conversation only: copies of API requests repeat it, and are no part of it.
  if (!line.startsWith('{"parentUuid"')) return;
  noteTime(agent, line.length > TAIL ? line.slice(-TAIL) : line);
  if (!ASSISTANT.test(line)) return;
  let row: { type?: unknown; message?: { model?: unknown; content?: unknown; usage?: Record<string, unknown> } };
  try {
    row = JSON.parse(line) as typeof row;
  } catch {
    return;
  }
  if (row.type !== 'assistant') return;
  const model = str(row.message?.model);
  if (model && !model.startsWith('<')) agent.model = model;
  const usage = row.message?.usage;
  if (usage) {
    const total = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'].reduce((sum, key) => sum + (num(usage[key]) ?? 0), 0);
    if (total > 0) agent.tokens = total;
  }
  if (Array.isArray(row.message?.content)) {
    for (const block of row.message.content) {
      if (isRecord(block) && block.type === 'tool_use') {
        agent.toolCalls += 1;
        if (str(block.name)) agent.lastTool = cut(block.name, 120);
      }
    }
  }
}

/** The end of a line: read it, or for one too long, only its time. */
function endLine(agent: AgentStats, piece: Buffer): void {
  if (agent.long) {
    const { head } = agent.long;
    const tail = Buffer.concat([agent.long.tail, piece]).subarray(-TAIL);
    agent.long = undefined;
    if (head.subarray(0, ROW.length).equals(ROW)) noteTime(agent, tail.toString('utf8'));
    return;
  }
  const line = agent.carry.length > 0 ? Buffer.concat([agent.carry, piece]) : piece;
  agent.carry = Buffer.alloc(0);
  if (line.length > LINE_MAX) {
    if (line.subarray(0, ROW.length).equals(ROW)) noteTime(agent, line.subarray(-TAIL).toString('utf8'));
    return;
  }
  statLine(agent, line.toString('utf8'));
}

/** A line goes on past this read: kept, or of one too long, only its ends. */
function carryOn(agent: AgentStats, piece: Buffer): void {
  if (agent.long) {
    agent.long.tail = Buffer.from(Buffer.concat([agent.long.tail, piece]).subarray(-TAIL));
    return;
  }
  agent.carry = Buffer.concat([agent.carry, piece]);
  if (agent.carry.length > LINE_MAX) {
    agent.long = { head: Buffer.from(agent.carry.subarray(0, ROW.length)), tail: Buffer.from(agent.carry.subarray(-TAIL)) };
    agent.carry = Buffer.alloc(0);
  }
}

function agentStats(real: string): Promise<AgentStats | undefined> {
  return oneAtATime(real, async () => {
    const handle = await openRegular(real).catch(() => undefined);
    if (!handle) return undefined;
    try {
      const info = await handle.stat();
      let agent = stats.get(real);
      if (!agent || agent.ino !== info.ino || info.size < agent.offset) agent = { ino: info.ino, offset: 0, carry: Buffer.alloc(0), toolCalls: 0 };
      const buffer = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(1, info.size - agent.offset)));
      while (agent.offset < info.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, info.size - agent.offset), agent.offset);
        if (bytesRead <= 0) break;
        agent.offset += bytesRead;
        const chunk = buffer.subarray(0, bytesRead);
        for (let from = 0; ;) {
          const end = chunk.indexOf(0x0a, from);
          if (end < 0) {
            if (from < chunk.length) carryOn(agent, chunk.subarray(from));
            break;
          }
          endLine(agent, chunk.subarray(from, end));
          from = end + 1;
        }
      }
      remember(stats, real, agent, 512);
      return agent;
    } catch {
      return undefined;
    } finally {
      await handle.close();
    }
  });
}

/** An agent's figures over its files: its tool calls in all of them, its latest response's in the newest. */
type Seen = { startedAt?: number; lastAt?: number; model?: string; tokens?: number; toolCalls: number; lastTool?: string };

function together(parts: AgentStats[]): Seen | undefined {
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  const newest = parts.reduce((a, b) => ((b.lastAt ?? 0) > (a.lastAt ?? 0) ? b : a));
  const times = (pick: (s: AgentStats) => number | undefined) => parts.map(pick).filter((t): t is number => t !== undefined);
  const started = times((s) => s.startedAt);
  const last = times((s) => s.lastAt);
  const model = newest.model ?? parts.find((s) => s.model)?.model;
  const tokens = newest.tokens ?? parts.find((s) => s.tokens)?.tokens;
  const lastTool = newest.lastTool ?? parts.find((s) => s.lastTool)?.lastTool;
  return {
    ...(started.length > 0 ? { startedAt: Math.min(...started) } : {}),
    ...(last.length > 0 ? { lastAt: Math.max(...last) } : {}),
    ...(model ? { model } : {}),
    ...(tokens ? { tokens } : {}),
    toolCalls: parts.reduce((sum, s) => sum + s.toolCalls, 0),
    ...(lastTool ? { lastTool } : {}),
  };
}

/**
 * An agent's transcript: in its run's folder, and (after an interrupt, Claude Code sometimes goes
 * on there) beside the session's other subagents, where the rest of it is: both, in that order.
 */
async function agentFiles(dir: string, runId: string, agentId: string): Promise<string[]> {
  if (!AGENT_ID.test(agentId)) return [];
  const found = await Promise.all([
    inside(dir, path.join(dir, 'subagents', 'workflows', runId, `agent-${agentId}.jsonl`)),
    inside(dir, path.join(dir, 'subagents', `agent-${agentId}.jsonl`)),
  ]);
  return [...new Set(found.filter((f): f is string => Boolean(f)))];
}

/**
 * The journal's agents, with what each one's own files say. For a call that resumed the run
 * (`since`: when it was made), only the agents at work since: the journal also holds those of the
 * attempts before it, which it did not run again.
 */
async function journalAgents(dir: string, runId: string, since?: number): Promise<WorkflowAgent[]> {
  const entries = (await readJournal(dir, runId)) ?? [];
  const agents = await inTurn(entries, READERS, async (entry): Promise<WorkflowAgent | undefined> => {
    const meta = entry.agentId
      ? await cachedJson(dir, path.join(dir, 'subagents', 'workflows', runId, `agent-${entry.agentId}.meta.json`), META_FILE_MAX, agentMetaOf)
      : undefined;
    const files = entry.agentId ? await agentFiles(dir, runId, entry.agentId) : [];
    const parts: AgentStats[] = [];
    for (const file of files) {
      const seen = await agentStats(file);
      if (seen) parts.push(seen);
    }
    const seen = together(parts);
    // An agent an earlier attempt ran, not run again by this call.
    if (since !== undefined && seen?.lastAt !== undefined && seen.lastAt < since) return undefined;
    const label = entry.label ?? meta?.label;
    const phase = entry.phase ?? meta?.phase;
    const model = cut(seen?.model, 120) ?? meta?.model;
    const done = entry.state === 'done';
    return {
      index: 0,
      label: label ?? '',
      state: done ? 'done' : entry.state === 'failed' ? 'error' : 'progress',
      ...(phase ? { phaseTitle: phase } : {}),
      ...(entry.agentId ? { agentId: entry.agentId } : {}),
      ...(meta?.agentType && meta.agentType !== 'workflow-subagent' ? { agentType: meta.agentType } : {}),
      ...(model ? { model } : {}),
      ...(seen?.tokens ? { tokens: seen.tokens } : {}),
      ...(seen && seen.toolCalls > 0 ? { toolCalls: seen.toolCalls } : {}),
      ...(seen?.lastTool ? { lastToolName: seen.lastTool } : {}),
      ...(seen?.startedAt !== undefined ? { startedAt: seen.startedAt } : {}),
      ...(seen?.lastAt !== undefined ? { lastProgressAt: seen.lastAt } : {}),
      ...(done && seen?.startedAt !== undefined && seen.lastAt !== undefined ? { durationMs: Math.max(0, seen.lastAt - seen.startedAt) } : {}),
      ...(done && entry.result ? { resultPreview: cut(entry.result.replace(/\s+/g, ' ').trim(), 400)! } : {}),
    };
  });
  return agents.filter((a): a is WorkflowAgent => Boolean(a)).map((agent, i) => ({ ...agent, index: i + 1, label: agent.label || `Agent ${i + 1}` }));
}

// ---- The Workflow call, in the conversation -----------------------------------------------------

/** A notice of a run's end, with when Claude Code wrote it. */
type Notice = TaskNotice & { at?: number };

/** What the conversation says about its workflows: the calls, their results, how each ended. */
type Index = {
  calls: Map<string, ToolUseBlock>;
  /** When each call was made: an agent at work since is that call's. */
  madeAt: Map<string, number>;
  results: Map<string, { block: ToolResultBlock; at?: number }>;
  /** The end Claude Code wrote for each call, by its id; one from the Claude Code that ran it beats an orphan's. */
  notices: Map<string, Notice>;
  /** Tasks Claude stopped (TaskStop calls that ran). */
  stopped: Set<string>;
  /** The calls of each run, in order: a run resumed later has more than one. */
  runs: Map<string, string[]>;
};

const indexes = new WeakMap<ChatMessage[], Index>();

function indexOf(messages: ChatMessage[]): Index {
  const known = indexes.get(messages);
  if (known) return known;
  const index: Index = { calls: new Map(), madeAt: new Map(), results: new Map(), notices: new Map(), stopped: new Set(), runs: new Map() };
  const stops = new Map<string, string>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === 'tool_use') {
        if (block.name === 'Workflow') {
          index.calls.set(block.id, block);
          if (message.timestamp) index.madeAt.set(block.id, message.timestamp);
        } else if (block.name === 'TaskStop' && str(block.input.task_id ?? block.input.shell_id)) {
          stops.set(block.id, str(block.input.task_id ?? block.input.shell_id)!);
        }
      } else if (block.type === 'tool_result') {
        if (index.calls.has(block.tool_use_id)) {
          index.results.set(block.tool_use_id, { block, ...(message.timestamp ? { at: message.timestamp } : {}) });
          const runId = launchOf(block)?.runId;
          if (runId) index.runs.set(runId, [...(index.runs.get(runId) ?? []), block.tool_use_id]);
        } else if (stops.has(block.tool_use_id) && !block.is_error) {
          index.stopped.add(stops.get(block.tool_use_id)!);
        }
      } else if (block.type === 'text' && message.role === 'user' && block.text.trimStart().startsWith('<task-notification>')) {
        const notice = parseTaskNotice(block.text);
        if (!notice?.toolUseId) continue;
        const before = index.notices.get(notice.toolUseId);
        if (!before || before.orphan || !notice.orphan) index.notices.set(notice.toolUseId, { ...notice, ...(message.timestamp ? { at: message.timestamp } : {}) });
      }
    }
  }
  indexes.set(messages, index);
  return index;
}

const ENDED: Record<NonNullable<TaskNotice['status']>, WorkflowStatus> = { completed: 'completed', failed: 'failed', killed: 'killed', stopped: 'killed' };

/** The Workflow calls of a session, oldest first: what the site saves, and what the routes take. */
export async function workflowCalls(sessionId: string): Promise<Array<{ toolUseId: string; runId?: string; name?: string }>> {
  if (!(await sessionDir(sessionId))) return [];
  const index = indexOf(await loadMessages(sessionId));
  return [...index.calls.values()].map((call) => {
    const runId = launchOf(index.results.get(call.id)?.block)?.runId;
    const name = launchOf(index.results.get(call.id)?.block)?.name ?? workflowOf(call.input).name;
    return { toolUseId: call.id, ...(runId ? { runId } : {}), ...(name ? { name } : {}) };
  });
}

type Found = { where: Where; call: ToolUseBlock; index: Index; runId?: string; taskId?: string };

async function findCall(sessionId: string, callId: string): Promise<Found | undefined> {
  if (!CALL_ID.test(callId)) return undefined;
  const where = await sessionDir(sessionId);
  if (!where) return undefined;
  const index = indexOf(await loadMessages(sessionId));
  const call = index.calls.get(callId);
  if (!call) return undefined;
  const launch = launchOf(index.results.get(callId)?.block);
  const runId = launch?.runId && RUN_ID.test(launch.runId) ? launch.runId : undefined;
  return { where, call, index, ...(runId ? { runId } : {}), ...(launch?.taskId ? { taskId: launch.taskId } : {}) };
}

/**
 * A script copy Claude Code kept in the session's scripts folder, by its file name: wherever the
 * path a call names, only that folder is read.
 */
async function scriptFile(dir: string, name: string | undefined): Promise<string | undefined> {
  const base = name?.split(/[\\/]/).pop();
  if (!base || !/^[\w.-]{1,200}\.js$/.test(base)) return undefined;
  return (await readInside(dir, path.join(dir, 'workflows', 'scripts', base), SCRIPT_MAX, true))?.text;
}

/** One Workflow call's run as a page shows it, and a tag that changes when it does. */
export type WorkflowAnswer = { workflow: Workflow; tag: string };

const tagOf = (value: unknown) => `"${createHash('sha256').update(JSON.stringify(value)).digest('base64url').slice(0, 27)}"`;

/**
 * Whether a run nothing has said the end of is still at work. Its agents writing now say so.
 * Without word of its end, a Claude Code with the session open may be running it. A Claude Code
 * that found it in the session without a record of its end wrote an orphan's notice: then it runs
 * only while a Claude Code has the session open, and that alone is not enough, as the one that wrote
 * the notice has it open too: its agents went on after the notice (the Claude Code that started it,
 * still at it), or write now.
 */
async function stillRunning(sessionId: string, lastAt: number, orphan: Notice | undefined): Promise<boolean> {
  const quiet = Date.now() - lastAt;
  if (!orphan) return quiet < ACTIVE_MS || (await liveProcesses()).has(sessionId);
  const wentOn = quiet < ACTIVE_MS || (orphan.at !== undefined && lastAt > orphan.at && quiet < QUIET_MS);
  return wentOn && (await liveProcesses()).has(sessionId);
}

/**
 * A Workflow call's run: what this Pelican's Claude reports of it (`live`), else Claude Code's
 * record of it once it ended, else its journal and its agents' files. How it ended comes from what
 * Claude Code wrote into the conversation; without that, it runs while a Claude Code still has the
 * session open, and otherwise ended with it. A run another call resumed later shows there.
 */
export async function workflowView(sessionId: string, callId: string, live?: Workflow): Promise<WorkflowAnswer | undefined> {
  const found = await findCall(sessionId, callId);
  if (!found) return undefined;
  const { where, call, index, runId, taskId } = found;
  const own = workflowOf(call.input);
  const launch = launchOf(index.results.get(callId)?.block);
  const notice = index.notices.get(callId);
  const record = runId ? await cachedJson(where.dir, recordFile(where.dir, runId), RECORD_MAX, recordOf) : undefined;
  const ours = record && (!taskId || !record.taskId || record.taskId === taskId) ? record : undefined;
  // The call holds its script; one run from a file is read from the session's copy.
  const script = str(call.input.script) ? undefined
    : ours?.script ?? await scriptFile(where.dir, launch?.scriptFile) ?? await scriptFile(where.dir, str(call.input.scriptPath)) ?? record?.script;
  const meta = own.meta ?? (script ? parseMeta(script) : undefined);
  const base = {
    ...(runId ? { runId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(launch?.name ?? meta?.name ?? own.name ? { name: launch?.name ?? meta?.name ?? own.name! } : {}),
    ...(meta?.description ?? launch?.summary ?? own.description ? { description: meta?.description ?? launch?.summary ?? own.description! } : {}),
    ...(script ? { script: clip(script, SCRIPT_SHOWN_MAX) } : {}),
  };
  const phases = meta?.phases ?? [];
  const startedAt = index.results.get(callId)?.at;
  let workflow: Workflow;
  // A later call resumed this run (the same run id): it is that call's to show. This one resumed
  // an earlier call's run: the journal goes back to that one's attempt.
  const calls = runId ? index.runs.get(runId) ?? [] : [];
  const position = calls.indexOf(callId);
  const resumedLater = position >= 0 && position < calls.length - 1;
  const resumed = position > 0;
  if (live) {
    workflow = { ...base, ...live, ...(live.phases.length > 0 ? {} : { phases }), source: 'live' };
  } else if (ours) {
    const agents = ours.items.map(agentItem).filter((a): a is WorkflowAgent => Boolean(a));
    workflow = {
      ...base,
      ...(ours.name ? { name: ours.name } : {}),
      ...(ours.summary && !base.description ? { description: ours.summary } : {}),
      status: ours.status,
      ...(ours.startTime ?? startedAt ? { startedAt: ours.startTime ?? startedAt! } : {}),
      ...(ours.durationMs !== undefined ? { durationMs: ours.durationMs } : {}),
      ...(ours.totalTokens !== undefined ? { totalTokens: ours.totalTokens } : {}),
      ...(ours.totalToolCalls !== undefined ? { totalToolCalls: ours.totalToolCalls } : {}),
      phases: withPhases(ours.phases.length > 0 ? ours.phases : phases, ours.items),
      agents,
      ...(ours.error ? { error: ours.error } : {}),
      ...(ours.result ? { result: ours.result } : {}),
      source: 'record',
    };
  } else {
    // Another call carries the run on: its card shows the run, this one how it ended here.
    const since = resumed ? index.madeAt.get(callId) ?? startedAt : undefined;
    const agents = runId && !resumedLater ? await journalAgents(where.dir, runId, since) : [];
    const lastAt = Math.max(0, ...agents.map((a) => a.lastProgressAt ?? 0));
    const ended = notice?.status && !notice.orphan ? ENDED[notice.status]
      : taskId && index.stopped.has(taskId) ? 'killed'
        : resumedLater ? 'killed'
          : await stillRunning(sessionId, lastAt, notice?.orphan ? notice : undefined) ? 'running' : 'stopped';
    const running = ended === 'running';
    const tokens = notice?.usage?.tokens ?? agentTokens(agents);
    const toolUses = notice?.usage?.toolUses ?? agents.reduce((sum, a) => sum + (a.toolCalls ?? 0), 0);
    const duration = notice?.usage?.durationMs ?? (!running && startedAt && lastAt > startedAt ? lastAt - startedAt : undefined);
    workflow = {
      ...base,
      status: ended,
      ...(startedAt ? { startedAt } : {}),
      ...(duration !== undefined ? { durationMs: duration } : {}),
      ...(tokens > 0 ? { totalTokens: tokens } : {}),
      ...(toolUses > 0 ? { totalToolCalls: toolUses } : {}),
      phases,
      agents,
      ...(notice?.error ? { error: notice.error } : {}),
      ...(notice?.result ? { result: clipLines(notice.result, RESULT_MAX) } : {}),
      source: 'journal',
    };
  }
  return { workflow, tag: tagOf(workflow) };
}

// ---- A workflow agent's own transcript --------------------------------------------------------

/** How many of an agent's messages a page holds at most, and about how much text. */
const PAGE_MAX = 300;
const PAGE_BYTES = 768 * 1024;
/** One message, at most, on a page: a call with a large value (a StructuredOutput of findings) is cut to this. */
const MESSAGE_MAX = 128 * 1024;
const PART_MAX = 8 * 1024;

/** A value as text no longer than `max`: a string cut, anything else as its JSON, cut. */
function shortValue(value: unknown, max: number): unknown {
  if (typeof value === 'string') return value.length > max ? `${value.slice(0, max)}\n…` : value;
  if (value === null || typeof value !== 'object') return value;
  const text = JSON.stringify(value) ?? '';
  return text.length > max ? `${text.slice(0, max)}\n…` : value;
}

/** A block of a message too large for a page, each of its parts cut to a few kilobytes. */
function shortBlock(block: Block): Block {
  switch (block.type) {
    case 'text':
      return block.text.length > PART_MAX ? { ...block, text: `${block.text.slice(0, PART_MAX)}\n…`, truncated: true } : block;
    case 'thinking':
      return block.thinking.length > PART_MAX / 4 ? { ...block, thinking: `${block.thinking.slice(0, PART_MAX / 4)}\n…` } : block;
    case 'tool_use':
      return { ...block, input: Object.fromEntries(Object.entries(block.input).map(([key, value]) => [key, shortValue(value, PART_MAX)])) };
    case 'tool_result': {
      if (typeof block.content === 'string') return block.content.length > PART_MAX ? { ...block, content: `${block.content.slice(0, PART_MAX)}\n…`, truncated: true } : block;
      const content = block.content.map((part) => (part.type === 'text' && part.text.length > PART_MAX ? { ...part, text: `${part.text.slice(0, PART_MAX)}\n…`, truncated: true } : part));
      return { ...block, content, ...(content.some((p) => p.type === 'text' && p.truncated) ? { truncated: true } : {}) };
    }
    default:
      return block;
  }
}

/** A message as a page carries it, with its size: one too large has its parts cut, and then as many of them as fit. */
const sized = new WeakMap<ChatMessage, { message: ChatMessage; size: number }>();
function onPage(message: ChatMessage): { message: ChatMessage; size: number } {
  const known = sized.get(message);
  if (known) return known;
  let shown = message;
  let size = JSON.stringify(message).length;
  if (size > MESSAGE_MAX) {
    const blocks: Block[] = [];
    let total = 0;
    const parts = message.blocks.map(shortBlock);
    for (const [i, block] of parts.entries()) {
      const weight = JSON.stringify(block).length;
      if (total + weight > MESSAGE_MAX - 1024 && blocks.length > 0) {
        blocks.push({ type: 'text', text: `… (${parts.length - i} more parts)`, truncated: true });
        break;
      }
      blocks.push(block);
      total += weight;
    }
    shown = { ...message, blocks };
    size = JSON.stringify(shown).length;
  }
  const out = { message: shown, size };
  sized.set(message, out);
  return out;
}

/** An agent's messages over its two files, the run folder's first: the second goes on where the first stopped. */
const joined = new WeakMap<ChatMessage[], { rest: ChatMessage[]; all: ChatMessage[] }>();
function joinParts(parts: ChatMessage[][]): ChatMessage[] {
  const [first = [], rest = []] = parts;
  if (rest.length === 0) return first;
  if (first.length === 0) return rest;
  const known = joined.get(first);
  if (known?.rest === rest) return known.all;
  // The earlier one first, should the files be the other way round.
  const [a, b] = (rest[0]?.timestamp ?? Infinity) < (first[0]?.timestamp ?? Infinity) ? [rest, first] : [first, rest];
  const seen = new Set(a.map((m) => m.uuid));
  const all = [...a, ...b.filter((m) => !seen.has(m.uuid))];
  joined.set(first, { rest, all });
  return all;
}

/**
 * What the agent was asked, as Claude Code shows it: the last of the user messages its transcript
 * starts with (Claude Code relays the user's request in one, then the computed task), the one with
 * the computed task if any, without the harness's frame.
 */
function promptOf(messages: ChatMessage[]): string | undefined {
  const leading: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role !== 'user' || (message.meta && leading.length > 0)) break;
    if (!message.blocks.some((b) => b.type === 'text')) break;
    leading.push(message);
  }
  const text = (message: ChatMessage) => message.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
  const task = [...leading].reverse().find((m) => text(m).includes('The computed task text follows:\n')) ?? leading.at(-1);
  return task ? unframedPrompt(text(task)) : undefined;
}

/**
 * A page of one workflow agent's own transcript: its last `limit` messages before message `before`
 * (default: the end), or with `after`, those from that message on (what a page that has the rest
 * asks for while the agent works); fewer when they come to more than a phone should load at once.
 * With its prompt, and what it returned, from the journal. Only agents of this call's run. Read
 * from that agent's own files only, whatever the run's size.
 */
export async function workflowAgentPage(
  sessionId: string, callId: string, agentId: string, { before, after, limit = 60 }: { before?: number; after?: number; limit?: number }, live?: Workflow,
): Promise<(WorkflowAgentPage & { tag: string }) | undefined> {
  if (!AGENT_ID.test(agentId)) return undefined;
  const found = await findCall(sessionId, callId);
  if (!found?.runId) return undefined;
  const { where, runId, taskId } = found;
  const record = await cachedJson(where.dir, recordFile(where.dir, runId), RECORD_MAX, recordOf);
  const ours = record && (!taskId || !record.taskId || record.taskId === taskId) ? record : undefined;
  const fromRecord = (ours?.items ?? []).map(agentItem).find((a) => a?.agentId === agentId);
  const entry = ((await readJournal(where.dir, runId)) ?? []).find((e) => e.agentId === agentId);
  const agent = live?.agents.find((a) => a.agentId === agentId) ?? fromRecord;
  if (!agent && !entry) return undefined;
  const files = await agentFiles(where.dir, runId, agentId);
  const all = joinParts(await Promise.all(files.map((file) => readHistory(file, { sidechain: true }))));
  const wanted = Math.max(1, Math.min(limit, PAGE_MAX));
  let offset: number;
  let end: number;
  if (after !== undefined) {
    // From `after` on, as far as a page goes.
    offset = Math.min(after, all.length);
    end = offset;
    for (let bytes = 0; end < all.length && end - offset < wanted; end += 1) {
      const { size } = onPage(all[end]!);
      if (end > offset && bytes + size > PAGE_BYTES) break;
      bytes += size;
    }
  } else {
    end = Math.min(before ?? all.length, all.length);
    offset = end;
    for (let bytes = 0; offset > 0 && end - offset < wanted; offset -= 1) {
      const { size } = onPage(all[offset - 1]!);
      if (end - offset > 0 && bytes + size > PAGE_BYTES) break;
      bytes += size;
    }
  }
  const prompt = promptOf(all) ?? agent?.promptPreview ?? fromRecord?.promptPreview;
  const result = entry?.state === 'done' ? entry.result : undefined;
  const shown = result ?? agent?.resultPreview ?? fromRecord?.resultPreview;
  // Done by its run's word while the journal has it only started: its result follows there.
  const coming = !shown && agent?.state === 'done' && entry?.state === 'started';
  const page: WorkflowAgentPage = {
    messages: all.slice(offset, end).map((m) => onPage(m).message),
    total: all.length,
    offset,
    ...(prompt ? { prompt: clip(prompt, PROMPT_MAX) } : {}),
    ...(shown ? { result: shown } : {}),
    ...(coming ? { resultComing: true } : {}),
  };
  return { ...page, tag: tagOf(page) };
}
