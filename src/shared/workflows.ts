// Workflows as Claude Code describes them: what a script says about itself, what a run's agents
// and phases are doing, and the words Claude Code uses for them, in the CLI and in Claude Desktop.

import type { ToolResultBlock, Workflow, WorkflowAgent, WorkflowLaunch, WorkflowPhase, WorkflowStatus } from './protocol';

const str = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// ---- The script's meta ------------------------------------------------------------------------

/** What a workflow script says about itself: `export const meta = { name, description, phases }`. */
export type WorkflowMeta = { name?: string; description?: string; phases: WorkflowPhase[]; whenToUse?: string };

/** The meta block is a few hundred bytes; no more than this is looked at. */
const META_MAX = 16 * 1024;

class NotALiteral extends Error {}

/**
 * Reads a JavaScript literal (objects, arrays, strings, numbers, true, false, null) from the start
 * of a script, as Claude Code requires the meta to be: "pure literal, no computed values". Strings
 * joined with `+` are joined, since scripts do that to wrap long descriptions. Anything else, a
 * template with `${…}` included, is no literal: nothing is ever evaluated.
 */
class Literal {
  private at = 0;

  constructor(private readonly text: string) {}

  private fail(): never {
    throw new NotALiteral();
  }

  space(): void {
    for (;;) {
      const c = this.text.charCodeAt(this.at);
      // Spaces, tabs, line breaks, a byte order mark and no-break spaces.
      if (c === 32 || (c >= 9 && c <= 13) || c === 0xfeff || c === 0xa0 || c === 0x2028 || c === 0x2029) {
        this.at += 1;
      } else if (this.text.startsWith('//', this.at)) {
        const end = this.text.indexOf('\n', this.at);
        this.at = end < 0 ? this.text.length : end + 1;
      } else if (this.text.startsWith('/*', this.at)) {
        const end = this.text.indexOf('*/', this.at + 2);
        if (end < 0) this.fail();
        this.at = end + 2;
      } else {
        return;
      }
    }
  }

  word(word: string): boolean {
    this.space();
    if (!this.text.startsWith(word, this.at) || /[\w$]/.test(this.text[this.at + word.length] ?? '')) return false;
    this.at += word.length;
    return true;
  }

  expect(char: string): void {
    this.space();
    if (this.text[this.at] !== char) this.fail();
    this.at += 1;
  }

  value(depth = 0): unknown {
    if (depth > 8) this.fail();
    this.space();
    const c = this.text[this.at];
    let value: unknown;
    if (c === '{') value = this.object(depth);
    else if (c === '[') value = this.array(depth);
    else if (c === "'" || c === '"' || c === '`') value = this.string();
    else if (c !== undefined && /[-+.\d]/.test(c)) value = this.number();
    else if (this.word('true')) value = true;
    else if (this.word('false')) value = false;
    else if (this.word('null')) value = null;
    else this.fail();
    // 'Review the server ' + 'and the client'
    for (;;) {
      this.space();
      if (typeof value !== 'string' || this.text[this.at] !== '+') return value;
      this.at += 1;
      this.space();
      const next = this.text[this.at];
      if (next !== "'" && next !== '"' && next !== '`') this.fail();
      value += this.string();
    }
  }

  private object(depth: number): Record<string, unknown> {
    this.at += 1;
    const out: Record<string, unknown> = {};
    for (;;) {
      this.space();
      if (this.text[this.at] === '}') {
        this.at += 1;
        return out;
      }
      const key = this.key();
      this.expect(':');
      const value = this.value(depth + 1);
      if (key !== '__proto__' && key !== 'constructor' && key !== 'prototype') out[key] = value;
      this.space();
      if (this.text[this.at] === ',') this.at += 1;
      else if (this.text[this.at] !== '}') this.fail();
    }
  }

  private array(depth: number): unknown[] {
    this.at += 1;
    const out: unknown[] = [];
    for (;;) {
      this.space();
      if (this.text[this.at] === ']') {
        this.at += 1;
        return out;
      }
      out.push(this.value(depth + 1));
      this.space();
      if (this.text[this.at] === ',') this.at += 1;
      else if (this.text[this.at] !== ']') this.fail();
    }
  }

  private key(): string {
    this.space();
    const c = this.text[this.at];
    if (c === "'" || c === '"') return this.string();
    const match = /^[A-Za-z_$][\w$]*|^\d+/.exec(this.text.slice(this.at, this.at + 128));
    if (!match) this.fail();
    this.at += match[0].length;
    return match[0];
  }

  private number(): number {
    const match = /^[-+]?(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][-+]?\d+)?/.exec(this.text.slice(this.at, this.at + 64));
    if (!match) this.fail();
    this.at += match[0].length;
    const value = Number(match[0].replace(/_/g, ''));
    if (!Number.isFinite(value)) this.fail();
    return value;
  }

  private string(): string {
    const quote = this.text[this.at]!;
    this.at += 1;
    let out = '';
    for (;;) {
      if (this.at >= this.text.length) this.fail();
      const c = this.text[this.at]!;
      this.at += 1;
      if (c === quote) return out;
      if (quote === '`' && c === '$' && this.text[this.at] === '{') this.fail();
      if (c === '\\') {
        out += this.escape();
      } else if ((c === '\n' || c === '\r') && quote !== '`') {
        this.fail();
      } else {
        out += c;
      }
    }
  }

  private escape(): string {
    const c = this.text[this.at];
    this.at += 1;
    const hex = (length: number) => {
      const digits = this.text.slice(this.at, this.at + length);
      if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(digits)) this.fail();
      this.at += length;
      return parseInt(digits, 16);
    };
    switch (c) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case 'b': return '\b';
      case 'f': return '\f';
      case 'v': return '\v';
      case '0': return '\0';
      case 'x': return String.fromCharCode(hex(2));
      case 'u': {
        if (this.text[this.at] !== '{') return String.fromCharCode(hex(4));
        const end = this.text.indexOf('}', this.at);
        const code = end > this.at + 1 && end - this.at <= 7 ? parseInt(this.text.slice(this.at + 1, end), 16) : NaN;
        if (!Number.isInteger(code) || code > 0x10ffff) this.fail();
        this.at = end + 1;
        return String.fromCodePoint(code);
      }
      case '\r':
        if (this.text[this.at] === '\n') this.at += 1;
        return '';
      case '\n':
      case ' ':
      case ' ':
        return '';
      case undefined:
        return this.fail();
      default:
        return c;
    }
  }
}

function metaOf(value: unknown): WorkflowMeta | undefined {
  if (!isRecord(value)) return undefined;
  const phases = (Array.isArray(value.phases) ? value.phases : [])
    .filter(isRecord)
    .flatMap((phase): WorkflowPhase[] => {
      const title = str(phase.title)?.trim();
      const detail = str(phase.detail)?.trim();
      return title ? [{ title, ...(detail ? { detail } : {}) }] : [];
    });
  const name = str(value.name)?.trim();
  const description = str(value.description)?.trim();
  const whenToUse = str(value.whenToUse)?.trim();
  return { ...(name ? { name } : {}), ...(description ? { description } : {}), phases, ...(whenToUse ? { whenToUse } : {}) };
}

/**
 * The meta a workflow script starts with, read as a literal and never run; undefined when the
 * script does not start with one Claude Code would take.
 */
export function parseMeta(script: string): WorkflowMeta | undefined {
  const reader = new Literal(script.slice(0, META_MAX));
  try {
    if (!reader.word('export') || !reader.word('const') || !reader.word('meta')) return undefined;
    reader.expect('=');
    reader.space();
    return metaOf(reader.value());
  } catch (error) {
    if (error instanceof NotALiteral) return undefined;
    throw error;
  }
}

/** A string field of a meta not written out yet (a call still streaming in), when its value is. */
function partialField(script: string, field: string): string | undefined {
  const match = new RegExp(`\\b${field}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1)[^\\\\\\n])*)\\1`).exec(script.slice(0, META_MAX));
  if (!match) return undefined;
  try {
    return new Literal(`${match[1]}${match[2]}${match[1]}`).value() as string;
  } catch {
    return undefined;
  }
}

/** The script file's own name, as Claude Code names its copies: `<name>-<run id>.js` shows as `<name>`. */
export function scriptName(file: string): string {
  const base = file.split(/[\\/]/).pop() ?? file;
  return base.replace(/-wf_[a-z0-9-]+\.js$/, '').replace(/\.js$/, '');
}

/**
 * A Workflow call's name and description, from what it was given: the script's meta, a predefined
 * workflow's name, or the script file it runs. A meta still streaming in gives what it has so far.
 */
export function workflowOf(input: Record<string, unknown>): { name?: string; description?: string; meta?: WorkflowMeta; file?: string } {
  const script = str(input.script);
  const file = str(input.scriptPath);
  const meta = script ? parseMeta(script) : undefined;
  // A meta not written out yet: its first fields, as far as they came.
  const partial = script && !meta;
  const name = meta?.name ?? (partial ? partialField(script, 'name') : undefined) ?? str(input.name) ?? (file ? scriptName(file) : undefined);
  const description = meta?.description ?? (partial ? partialField(script, 'description') : undefined);
  return { ...(name ? { name } : {}), ...(description ? { description } : {}), ...(meta ? { meta } : {}), ...(file ? { file } : {}) };
}

// ---- What a call launched, and how it ended ---------------------------------------------------

/** Claude Code's run ids: `wf_` and twelve characters of a UUID. */
export const RUN_ID = /^wf_[a-z0-9-]{6,64}$/;

/** What a Workflow call's result says it launched: recorded next to it, or else in its words. */
export function launchOf(result: ToolResultBlock | undefined): WorkflowLaunch | undefined {
  if (!result || result.is_error) return undefined;
  if (result.workflow) return result.workflow;
  const text = typeof result.content === 'string' ? result.content : result.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
  const runId = /^Run ID: (wf_[a-z0-9-]+)$/m.exec(text)?.[1];
  const taskId = /Task ID: ([\w-]+)/.exec(text)?.[1];
  if (!runId && !/^Workflow launched/.test(text)) return undefined;
  const summary = /^Summary: (.+)$/m.exec(text)?.[1]?.trim();
  const scriptFile = /^Script file: (.+)$/m.exec(text)?.[1]?.trim().split(/[\\/]/).pop();
  return {
    ...(runId && RUN_ID.test(runId) ? { runId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(summary ? { summary } : {}),
    ...(scriptFile && /^[\w.-]{1,200}\.js$/.test(scriptFile) ? { scriptFile } : {}),
  };
}

/** What Claude Code's `<task-notification>` says about a background task that ended. */
export type TaskNotice = {
  taskId?: string;
  toolUseId?: string;
  status?: 'completed' | 'failed' | 'killed' | 'stopped';
  /** Claude Code's sentence: `Dynamic workflow "…" completed`. */
  summary: string;
  /** For a failed run: why, as Claude Code gives it. */
  error?: string;
  result?: string;
  usage?: { agents?: number; done?: number; failed?: number; skipped?: number; tokens?: number; toolUses?: number; durationMs?: number };
  /**
   * Written by a Claude Code that found the task in the session without a record of its end: it
   * may still be running in the Claude Code that started it, which then says how it really ended.
   */
  orphan?: boolean;
};

const unescapeXml = (text: string) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

function tagOf(text: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
  return match ? match[1]!.trim() : undefined;
}

const count = (text: string | undefined, name: string) => {
  const value = text ? tagOf(text, name) : undefined;
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined;
};

/** A `<task-notification>` Claude Code wrote into the conversation, read; undefined for any other text. */
export function parseTaskNotice(text: string): TaskNotice | undefined {
  const body = text.trim();
  if (!body.startsWith('<task-notification>')) return undefined;
  const status = tagOf(body, 'status');
  const summary = unescapeXml(tagOf(body, 'summary') ?? '');
  const usageText = tagOf(body, 'usage');
  const result = tagOf(body, 'result');
  const usage = usageText ? {
    agents: count(usageText, 'agent_count'),
    done: count(usageText, 'agents_done'),
    failed: count(usageText, 'agents_error'),
    skipped: count(usageText, 'agents_skipped'),
    tokens: count(usageText, 'subagent_tokens') ?? count(usageText, 'total_tokens'),
    toolUses: count(usageText, 'tool_uses'),
    durationMs: count(usageText, 'duration_ms'),
  } : undefined;
  const known = status === 'completed' || status === 'failed' || status === 'killed' || status === 'stopped' ? status : undefined;
  // `Dynamic workflow "x" failed: TypeError: …`: the reason is said apart, as Desktop does.
  const failed = known === 'failed' ? /^(.*? failed): ([\s\S]+)$/.exec(summary) : null;
  const taskId = tagOf(body, 'task-id');
  const toolUseId = tagOf(body, 'tool-use-id');
  const cleanUsage = usage && Object.fromEntries(Object.entries(usage).filter(([, v]) => v !== undefined));
  return {
    ...(taskId ? { taskId } : {}),
    ...(toolUseId ? { toolUseId } : {}),
    ...(known ? { status: known } : {}),
    summary: failed ? failed[1]! : summary,
    ...(failed ? { error: failed[2]!.trim() } : {}),
    ...(result ? { result: unescapeXml(result) } : {}),
    ...(cleanUsage && Object.keys(cleanUsage).length > 0 ? { usage: cleanUsage } : {}),
    ...(tagOf(body, 'note') !== undefined && !tagOf(body, 'output-file') ? { orphan: true } : {}),
  };
}

// ---- Agents and phases, by Claude Code's rules ------------------------------------------------

/** A run that is still going: its agents may still start, run and end. */
export const isRunning = (status: WorkflowStatus) => status === 'running' || status === 'paused';

/** What Claude Code calls an agent's state: the CLI's run view, and its words for it. */
export type AgentStatus = 'queued' | 'running' | 'done' | 'failed' | 'skipped' | 'blocked' | 'stopped';

export const AGENT_WORDS: Record<AgentStatus, string> = {
  queued: 'Queued', running: 'Running', done: 'Completed', failed: 'Failed', skipped: 'Skipped', blocked: 'Blocked', stopped: 'Stopped',
};

/** What Claude Code writes on the agents a run left unfinished when it ended. */
const STOP_REASON = /^Stopped because the workflow (was stopped|failed|finished without waiting for it)/;

/**
 * An agent's state as the CLI tells it: an error is a skip, a block, a failure, or (when the run
 * ended and took it along) a stop; an agent that never finished in a run that ended was stopped.
 */
export function agentStatus(agent: WorkflowAgent, runStatus: WorkflowStatus): AgentStatus {
  if (agent.state === 'done') return 'done';
  if (agent.state === 'error') {
    if (agent.skipped) return 'skipped';
    if (agent.blocked) return 'blocked';
    return STOP_REASON.test(agent.error ?? '') && !isRunning(runStatus) ? 'stopped' : 'failed';
  }
  if (!isRunning(runStatus)) return 'stopped';
  return agent.queuedAt !== undefined && agent.startedAt === undefined ? 'queued' : 'running';
}

/** An agent quiet for this long is idle (the CLI) and, past Desktop's mark, stalled. */
export const IDLE_MS = 30_000;
export const STALLED_MS = 90_000;

export type PhaseStatus = 'running' | 'done' | 'failed' | 'stopped' | 'pending';

export type PhaseGroup = {
  title: string;
  detail?: string;
  agents: Array<WorkflowAgent & { status: AgentStatus }>;
  status: PhaseStatus;
  done: number;
  failed: number;
};

const same = (a: string, b: string) => {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  return x.length > 0 && y.length > 0 && (x.startsWith(y) || y.startsWith(x));
};

/**
 * The run's phases in order, each with its agents, as the CLI groups them: the script's phases
 * first, matched to the phases agents name by title (any case, either a prefix of the other), then
 * phases only the run opened, then agents of no phase, as "Agents" (Desktop's "Other agents" when
 * there are phases). An agent naming no title is in "Phase N".
 */
export function phaseGroups(workflow: Pick<Workflow, 'phases' | 'agents' | 'status'>): PhaseGroup[] {
  const groups: PhaseGroup[] = workflow.phases.map((phase) => ({ ...phase, agents: [], status: 'pending', done: 0, failed: 0 }));
  let loose: PhaseGroup | undefined;
  for (const agent of [...workflow.agents].sort((a, b) => a.index - b.index)) {
    const title = agent.phaseTitle?.trim() || (agent.phaseIndex !== undefined ? `Phase ${agent.phaseIndex}` : undefined);
    let group = title ? groups.find((g) => same(g.title, title)) : undefined;
    if (!group && title) {
      group = { title, agents: [], status: 'pending', done: 0, failed: 0 };
      groups.push(group);
    }
    if (!group) {
      loose ??= { title: 'Agents', agents: [], status: 'pending', done: 0, failed: 0 };
      group = loose;
    }
    group.agents.push({ ...agent, status: agentStatus(agent, workflow.status) });
  }
  if (loose) {
    if (groups.length > 0) loose.title = 'Other agents';
    groups.push(loose);
  }
  const running = isRunning(workflow.status);
  for (const group of groups) {
    group.done = group.agents.filter((a) => a.status === 'done').length;
    group.failed = group.agents.filter((a) => a.status === 'failed' || a.status === 'blocked').length;
    const live = group.agents.some((a) => a.status === 'running' || a.status === 'queued');
    group.status = group.agents.length === 0 ? 'pending'
      : live && running ? 'running'
        : group.failed > 0 ? 'failed'
          : group.agents.every((a) => a.status === 'done' || a.status === 'skipped') ? 'done'
            : 'stopped';
  }
  return groups;
}

/** A run's agents counted as Desktop counts them for its grid of cells. */
export function agentCounts(agents: WorkflowAgent[], status: WorkflowStatus, now = Date.now()) {
  const counts = { total: agents.length, done: 0, running: 0, stalled: 0, failed: 0, stopped: 0, queued: 0 };
  for (const agent of agents) {
    const state = agentStatus(agent, status);
    if (state === 'done') counts.done += 1;
    else if (state === 'running') {
      counts.running += 1;
      if (agent.lastProgressAt !== undefined && now - agent.lastProgressAt > STALLED_MS) counts.stalled += 1;
    } else if (state === 'failed' || state === 'blocked') counts.failed += 1;
    else if (state === 'queued') counts.queued += 1;
    else counts.stopped += 1;
  }
  return counts;
}

/** Claude Code's word for a run's status. */
export function statusWord(status: WorkflowStatus): string {
  switch (status) {
    case 'running': return 'Running';
    case 'paused': return 'Paused';
    case 'completed': return 'Completed';
    case 'failed': return 'Failed';
    default: return 'Stopped';
  }
}

// ---- Claude Code's numbers ----------------------------------------------------------------------

/** Tokens as Claude Code writes them: 412.3k, 2.8m, 1k, 950. */
export function tokensText(n: number): string {
  const trim = (value: number) => value.toFixed(1).replace(/\.0$/, '');
  if (n < 1000) return String(Math.max(0, Math.round(n)));
  if (n < 999_950) return `${trim(n / 1000)}k`;
  return `${trim(n / 1_000_000)}m`;
}

/** A length of time as Claude Code writes it: 45s, 6m 1s, 1h 3m 5s. */
export function durationText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Claude Code's mark for a workflow larger than most: past 25 agents or 1.5M tokens. */
export const isLarge = (agents: number, tokens: number) => agents > 25 || tokens > 1_500_000;

/** The time an agent took, or has taken so far. */
export function agentTime(agent: WorkflowAgent, now = Date.now()): number | undefined {
  if (agent.durationMs !== undefined) return agent.durationMs;
  if (agent.startedAt === undefined || agent.state === 'done' || agent.state === 'error') return undefined;
  return Math.max(0, now - agent.startedAt);
}

/** The sum of the agents' tokens, as Claude Code totals a run while it runs. */
export const agentTokens = (agents: WorkflowAgent[]) => agents.reduce((sum, a) => sum + (a.tokens ?? 0), 0);

/** The prompt an agent was given, without the frame the workflow harness puts around it. */
export function unframedPrompt(text: string): string {
  const marker = 'The computed task text follows:\n';
  const at = text.lastIndexOf(marker);
  if (at < 0 || !text.trimStart().startsWith('[Workflow harness')) return text.trim();
  return text.slice(at + marker.length).split('\n').map((line) => (line.startsWith('  ') ? line.slice(2) : line)).join('\n').trim();
}
