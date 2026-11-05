import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import type { ChatMessage, ToolResultBlock, ToolUseBlock, Workflow, WorkflowAgent, WorkflowAgentPage, WorkflowPhase, WorkflowStatus } from '../shared/protocol.js';
import { agentTokens, launchOf, parseMeta, parseTaskNotice, RUN_ID, type TaskNotice, unframedPrompt, workflowOf } from '../shared/workflows.js';
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

const str = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n…` : text);

/** What a run returned, as text: a string as it is, a value as JSON. */
function resultText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text ? clip(text, RESULT_MAX) : undefined;
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
    const title = str(p.title);
    return title ? [{ title, ...(str(p.detail) ? { detail: str(p.detail)! } : {}) }] : [];
  });
  const error = typeof value.error === 'string' ? value.error : isRecord(value.error) ? str(value.error.message) : undefined;
  return {
    ...(str(value.taskId) ? { taskId: str(value.taskId)! } : {}),
    ...(str(value.workflowName) ? { name: str(value.workflowName)! } : {}),
    ...(str(value.summary) ? { summary: str(value.summary)! } : {}),
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

const cut = (value: unknown, max: number) => (typeof value === 'string' && value ? (value.length > max ? `${value.slice(0, max - 1)}…` : value) : undefined);

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
    if (title && !out.some((p) => p.title.toLowerCase() === title.toLowerCase())) out.push({ title });
  }
  return out;
}

// ---- The journal ------------------------------------------------------------------------------

/** An agent as the journal tells it: started, done with a result, or failed; the latest line wins. */
type JournalAgent = { key: string; agentId?: string; label?: string; phase?: string; state: 'started' | 'done' | 'failed'; result?: string };

type Journal = { ino: number; offset: number; carry: string; agents: Map<string, JournalAgent> };

const journals = new Map<string, Journal>();

/** One journal line. A line cut short (Claude Code was stopped mid-write) or of another kind is passed over, as Claude Code does. */
function journalLine(journal: Journal, line: string): void {
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
  if (!key) return;
  const known = journal.agents.get(key);
  const agentId = str(event.agentId) ?? known?.agentId;
  if (event.type === 'started') {
    journal.agents.set(key, { key, ...(agentId ? { agentId } : {}), ...(str(event.label) ?? known?.label ? { label: str(event.label) ?? known!.label! } : {}), ...(str(event.phase) ?? known?.phase ? { phase: str(event.phase) ?? known!.phase! } : {}), state: 'started' });
  } else if (event.type === 'result') {
    const result = resultText(event.result);
    journal.agents.set(key, { ...(known ?? { key }), ...(agentId ? { agentId } : {}), state: 'done', ...(result ? { result } : {}) });
  } else if (event.type === 'failed') {
    journal.agents.set(key, { ...(known ?? { key }), ...(agentId ? { agentId } : {}), state: 'failed' });
  }
}

/** The run's journal, read once and then only by what was added to it. */
async function readJournal(dir: string, runId: string): Promise<JournalAgent[] | undefined> {
  const file = path.join(dir, 'subagents', 'workflows', runId, 'journal.jsonl');
  const real = await inside(dir, file);
  if (!real) return undefined;
  const handle = await openRegular(real).catch(() => undefined);
  if (!handle) return undefined;
  try {
    const info = await handle.stat();
    let journal = journals.get(real);
    if (!journal || journal.ino !== info.ino || info.size < journal.offset) journal = { ino: info.ino, offset: 0, carry: '', agents: new Map() };
    const end = Math.min(info.size, JOURNAL_MAX);
    while (journal.offset < end) {
      const buffer = Buffer.alloc(Math.min(4 * 1024 * 1024, end - journal.offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, journal.offset);
      if (bytesRead <= 0) break;
      journal.offset += bytesRead;
      const text = journal.carry + buffer.toString('utf8', 0, bytesRead);
      const lines = text.split('\n');
      journal.carry = lines.pop() ?? '';
      for (const line of lines) journalLine(journal, line);
    }
    remember(journals, real, journal, 64);
    // A last line without its newline yet counts if it is whole; it is read again with the rest.
    const agents = new Map(journal.agents);
    if (journal.carry) journalLine({ ...journal, agents }, journal.carry);
    return [...agents.values()];
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

// ---- Agents' own files ------------------------------------------------------------------------

type AgentMeta = { agentType?: string; label?: string; phase?: string; model?: string };

function agentMetaOf(value: unknown): AgentMeta | undefined {
  if (!isRecord(value)) return undefined;
  return {
    ...(str(value.agentType) ? { agentType: str(value.agentType)! } : {}),
    ...(str(value.description) ? { label: str(value.description)! } : {}),
    ...(str(value.workflowPhase) ? { phase: str(value.workflowPhase)! } : {}),
    ...(str(value.pickedEffortModel) ? { model: str(value.pickedEffortModel)! } : {}),
  };
}

/**
 * What an agent's transcript says of it, without keeping it: when it started and last wrote, its
 * model, its tool calls, its last tool, and its context at its latest response (Claude Code's
 * "tokens"). Read once, then only by what was added.
 */
type AgentStats = { ino: number; offset: number; carry: string; startedAt?: number; lastAt?: number; model?: string; tokens?: number; toolCalls: number; lastTool?: string };

const stats = new Map<string, AgentStats>();
const ASSISTANT = /"type":\s*"assistant"/;
const TIMESTAMP = /"timestamp":\s*"([^"]{10,40})"/;

function statLine(agent: AgentStats, line: string): void {
  // Rows of the conversation only: copies of API requests repeat it, and are no part of it.
  if (!line.startsWith('{"parentUuid"')) return;
  const time = TIMESTAMP.exec(line.length > 4096 ? line.slice(-4096) : line)?.[1] ?? TIMESTAMP.exec(line)?.[1];
  const at = time ? Date.parse(time) : NaN;
  if (!Number.isNaN(at)) {
    agent.startedAt ??= at;
    agent.lastAt = at;
  }
  if (line.length > 2 * 1024 * 1024 || !ASSISTANT.test(line)) return;
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
        if (str(block.name)) agent.lastTool = str(block.name);
      }
    }
  }
}

async function agentStats(real: string): Promise<AgentStats | undefined> {
  const handle = await openRegular(real).catch(() => undefined);
  if (!handle) return undefined;
  try {
    const info = await handle.stat();
    let agent = stats.get(real);
    if (!agent || agent.ino !== info.ino || info.size < agent.offset) agent = { ino: info.ino, offset: 0, carry: '', toolCalls: 0 };
    while (agent.offset < info.size) {
      const buffer = Buffer.alloc(Math.min(8 * 1024 * 1024, info.size - agent.offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, agent.offset);
      if (bytesRead <= 0) break;
      agent.offset += bytesRead;
      // Lines are cut on bytes, so a character split across reads comes out whole.
      const chunk = Buffer.concat([Buffer.from(agent.carry, 'latin1'), buffer.subarray(0, bytesRead)]);
      const last = chunk.lastIndexOf(0x0a);
      agent.carry = last < 0 ? chunk.toString('latin1') : chunk.subarray(last + 1).toString('latin1');
      if (last >= 0) for (const line of chunk.subarray(0, last).toString('utf8').split('\n')) statLine(agent, line);
      // A line too long to be a row worth reading is let go rather than carried.
      if (agent.carry.length > 8 * 1024 * 1024) agent.carry = '';
    }
    remember(stats, real, agent, 512);
    return agent;
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

/** An agent's transcript: in its run's folder, or (after an interrupt, Claude Code sometimes) beside the session's other subagents. */
async function agentFile(dir: string, runId: string, agentId: string): Promise<string | undefined> {
  if (!AGENT_ID.test(agentId)) return undefined;
  for (const file of [path.join(dir, 'subagents', 'workflows', runId, `agent-${agentId}.jsonl`), path.join(dir, 'subagents', `agent-${agentId}.jsonl`)]) {
    const real = await inside(dir, file);
    if (real) return real;
  }
  return undefined;
}

/** The journal's agents, with what each one's own files say. */
async function journalAgents(dir: string, runId: string): Promise<{ agents: WorkflowAgent[]; results: Map<string, string> }> {
  const entries = (await readJournal(dir, runId)) ?? [];
  const results = new Map<string, string>();
  const agents = await Promise.all(entries.map(async (entry, i): Promise<WorkflowAgent> => {
    const meta = entry.agentId
      ? await cachedJson(dir, path.join(dir, 'subagents', 'workflows', runId, `agent-${entry.agentId}.meta.json`), META_FILE_MAX, agentMetaOf)
      : undefined;
    const file = entry.agentId ? await agentFile(dir, runId, entry.agentId) : undefined;
    const seen = file ? await agentStats(file) : undefined;
    if (entry.agentId && entry.result) results.set(entry.agentId, entry.result);
    const label = entry.label ?? meta?.label ?? `Agent ${i + 1}`;
    const phase = entry.phase ?? meta?.phase;
    const model = seen?.model ?? meta?.model;
    const done = entry.state === 'done';
    return {
      index: i + 1,
      label,
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
  }));
  return { agents, results };
}

// ---- The Workflow call, in the conversation -----------------------------------------------------

/** What the conversation says about its workflows: the calls, their results, how each ended. */
type Index = {
  calls: Map<string, ToolUseBlock>;
  results: Map<string, { block: ToolResultBlock; at?: number }>;
  /** The end Claude Code wrote for each call, by its id; one from the Claude Code that ran it beats an orphan's. */
  notices: Map<string, TaskNotice>;
  /** Tasks Claude stopped (TaskStop calls that ran). */
  stopped: Set<string>;
  /** The calls of each run, in order: a run resumed later has more than one. */
  runs: Map<string, string[]>;
};

const indexes = new WeakMap<ChatMessage[], Index>();

function indexOf(messages: ChatMessage[]): Index {
  const known = indexes.get(messages);
  if (known) return known;
  const index: Index = { calls: new Map(), results: new Map(), notices: new Map(), stopped: new Set(), runs: new Map() };
  const stops = new Map<string, string>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === 'tool_use') {
        if (block.name === 'Workflow') index.calls.set(block.id, block);
        else if (block.name === 'TaskStop' && str(block.input.task_id ?? block.input.shell_id)) stops.set(block.id, str(block.input.task_id ?? block.input.shell_id)!);
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
        if (!before || before.orphan || !notice.orphan) index.notices.set(notice.toolUseId, notice);
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
  // A later call resumed this run (the same run id): it is that call's to show.
  const calls = runId ? index.runs.get(runId) ?? [] : [];
  const resumedLater = calls.indexOf(callId) >= 0 && calls.indexOf(callId) < calls.length - 1;
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
    const { agents } = runId && !resumedLater ? await journalAgents(where.dir, runId) : { agents: [] as WorkflowAgent[] };
    const lastAt = Math.max(0, ...agents.map((a) => a.lastProgressAt ?? 0));
    // Without word of its end, it runs while a Claude Code has the session open, or while its
    // agents still write: a look at the registry that missed a process must not end it.
    const ended = notice?.status && !notice.orphan ? ENDED[notice.status]
      : taskId && index.stopped.has(taskId) ? 'killed'
        : resumedLater ? 'killed'
          : Date.now() - lastAt < ACTIVE_MS || (await liveProcesses()).has(sessionId) ? 'running' : 'stopped';
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
      ...(notice?.result ? { result: clip(notice.result, RESULT_MAX) } : {}),
      source: 'journal',
    };
  }
  const tag = `"${createHash('sha256').update(JSON.stringify(workflow)).digest('base64url').slice(0, 27)}"`;
  return { workflow, tag };
}

/** How many of an agent's messages a page holds at most, and about how much text. */
const PAGE_MAX = 300;
const PAGE_BYTES = 768 * 1024;

/**
 * A page of one workflow agent's own transcript, ending before message `before` (default: the
 * end): its last `limit` messages, fewer when they come to more than a phone should load at once.
 * With its prompt, and what it returned, from the journal. Only agents of this call's run.
 */
export async function workflowAgentPage(
  sessionId: string, callId: string, agentId: string, before: number | undefined, limit: number, live?: Workflow,
): Promise<WorkflowAgentPage | undefined> {
  if (!AGENT_ID.test(agentId)) return undefined;
  const found = await findCall(sessionId, callId);
  if (!found?.runId) return undefined;
  const { where, runId, taskId } = found;
  const record = await cachedJson(where.dir, recordFile(where.dir, runId), RECORD_MAX, recordOf);
  const fromRecord = record && (!taskId || !record.taskId || record.taskId === taskId) ? record.items.map(agentItem).filter((a): a is WorkflowAgent => Boolean(a)) : [];
  const { agents: fromJournal, results } = await journalAgents(where.dir, runId);
  const agent = [...(live?.agents ?? []), ...fromRecord, ...fromJournal].find((a) => a.agentId === agentId);
  if (!agent) return undefined;
  const file = await agentFile(where.dir, runId, agentId);
  const all = file ? await readHistory(file, { sidechain: true }) : [];
  const end = Math.min(before ?? all.length, all.length);
  let offset = end;
  let bytes = 0;
  const wanted = Math.max(1, Math.min(limit, PAGE_MAX));
  while (offset > 0 && end - offset < wanted) {
    const size = JSON.stringify(all[offset - 1]).length;
    if (end - offset > 0 && bytes + size > PAGE_BYTES) break;
    bytes += size;
    offset -= 1;
  }
  const first = all.find((m) => m.role === 'user' && m.blocks.some((b) => b.type === 'text'));
  const framed = first?.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
  const prompt = framed ? unframedPrompt(framed) : agent.promptPreview;
  const result = results.get(agentId) ?? agent.resultPreview;
  return {
    messages: all.slice(offset, end),
    total: all.length,
    offset,
    ...(prompt ? { prompt: clip(prompt, PROMPT_MAX) } : {}),
    ...(result ? { result } : {}),
  };
}
