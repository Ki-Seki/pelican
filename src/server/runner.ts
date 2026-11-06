import { randomUUID, type UUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  CanUseTool,
  EffortLevel,
  ElicitationResult,
  OnElicitation,
  Options,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

import { plainError } from '../shared/errors.js';
import { pickerValue } from '../shared/model-names.js';
import type { PermissionMode } from '../shared/modes.js';
import type {
  Attachment,
  BackgroundTask,
  ChatMessage,
  McpServer,
  PartialBlock,
  PermissionDecision,
  PermissionRequest,
  QueuedPrompt,
  RewindResult,
  RunSettings,
  RunState,
  ScheduledCheck,
  SendMode,
  SessionStatus,
  TaskOutput,
  TaskProgress,
  Workflow,
  WorkflowAgent,
  WorkflowPhase,
  WorkflowStatus,
} from '../shared/protocol.js';
import { addPhase, agentTokens, parseMeta, RUN_ID } from '../shared/workflows.js';
import { fork, remove } from './actions.js';
import { describeAlways, sessionModeOf } from './approvals.js';
import { sdkPackage } from './claude-code.js';
import { config } from './config.js';
import { demoRunState, demoRunStatus, demoRunTasks } from './demo.js';
import { type Completions, forgetCompletions, knownModels, noteTerminalCommands, onSubscription, startError, toCompletions, toMcpServers } from './models.js';
import { broadcastAll, feedFor, sessionsChanged } from './feed.js';
import { isDirectory } from './folders.js';
import { liveProcesses } from './live.js';
import { toChatMessage } from './normalize.js';
import { answerable, notify, oneLine } from './push.js';
import { sessionInfo, sessionTitle } from './sessions.js';
import { bashModeMessages, type ForClaude } from './shell.js';
import { isSideChat, SIDE_CHAT_COMMAND, SIDE_CHAT_TITLE, sideChatOptions, sideChatPrompt, sideChatSettings } from './side-chat.js';
import { lastTurnTime, refreshTranscriptIndex, transcriptPath } from './transcripts.js';
import { FULL_SETTINGS, type Launch, launchFor } from './trust.js';
import { recordLimit } from './usage.js';

/** Messages the user sends, handed to the Claude process as they come. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiters: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];
  private done = false;

  push(item: SDKUserMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    this.done = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

/** A request Claude Code waits on: a tool to approve, or an MCP server asking for input. */
type Pending =
  | {
    kind: 'tool';
    request: PermissionRequest;
    input: Record<string, unknown>;
    /** What "always" applies, when the request offers it. */
    suggestions?: PermissionUpdate[];
    /** Asked in the main conversation, not by a subagent: a plain Deny ends the turn there. */
    main: boolean;
    resolve: (result: PermissionResult) => void;
  }
  | { kind: 'elicitation'; request: PermissionRequest; resolve: (result: ElicitationResult) => void };

export type SendInput = {
  text: string;
  attachments: Attachment[];
  settings: RunSettings;
  /** Id for the user message, so the client's optimistic copy matches the transcript row. */
  uuid?: string;
  /** While a turn runs: join it at Claude's next step, or wait for it to end. */
  mode?: SendMode;
};

type Prompt = { uuid: string; text: string; attachments: Attachment[] };

/** The run closed while a message to it was on its way: it never reached Claude, and can go to another. */
class RunClosed extends Error {
  constructor() {
    super('Claude Code stopped in this session');
  }
}

/** What a user message holds, as the SDK types it, so an SDK change fails the typecheck here. */
type UserContent = Exclude<Extract<SDKUserMessage['message'], { role: 'user' }>['content'], string>;

const sdkModel = (model: string | undefined) => (model && model !== 'default' ? model : undefined);

/** The image types the API takes inline; other pictures go to Claude as files to read. */
const INLINE_IMAGES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
const inlineImage = (mime: string): mime is (typeof INLINE_IMAGES)[number] => (INLINE_IMAGES as readonly string[]).includes(mime);

async function contentOf(text: string, attachments: Attachment[]): Promise<UserContent> {
  const content: UserContent = [];
  const fileLines: string[] = [];
  for (const attachment of attachments) {
    const mime = attachment.mime;
    if (inlineImage(mime) && attachment.size <= 5 * 1024 * 1024) {
      const data = await readFile(attachment.path).catch(() => undefined);
      if (data) {
        content.push({ type: 'image', source: { type: 'base64', media_type: mime, data: data.toString('base64') } });
        continue;
      }
    }
    fileLines.push(`- ${attachment.path} (${attachment.name})`);
  }
  let body = text;
  if (fileLines.length > 0) body = `${body}${body ? '\n\n' : ''}Attached files:\n${fileLines.join('\n')}`;
  if (body) content.push({ type: 'text', text: body });
  return content;
}

/** Claude Code's own words for a refused tool use, so Claude takes a Deny here as it takes the CLI's No. */
const REFUSED = 'The user doesn\'t want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file).';
const STOP_AND_WAIT = `${REFUSED} STOP what you are doing and wait for the user to tell you how to proceed.`;
const refusedWith = (note: string) => `${REFUSED} To tell you how to proceed, the user said:\n${note}`;

/** /clear and its aliases start a new conversation inside the same Claude Code process, under a new id. */
const CLEARS = /^\/(clear|reset|new)(\s|$)/;
const AFRESH = 'To start afresh, open a new session in this folder.';

/** Claude Code's error, or what it means for someone who edited their last prompt, in plain words. */
export function readableError(text: string): string {
  if (text.includes('Resume rejected by --resume-drops-turn')) {
    return 'The conversation changed after that prompt (another app added to it), so the prompt was not replaced. Reload, then edit it again or send a new message.';
  }
  return startError(text) ?? plainError(text, config.machine) ?? text;
}

const str = (value: unknown) => (typeof value === 'string' ? value : '');

/** What a waiting request asks for, as a notification says it: the command, the file, the question. */
export function askedFor(request: PermissionRequest, cwd: string): string {
  const input = request.input;
  const file = (value: unknown) => {
    const full = str(value);
    return full.startsWith(`${cwd}/`) ? full.slice(cwd.length + 1) : full;
  };
  if (request.elicitation) return `${request.elicitation.server}: ${request.elicitation.message}`;
  switch (request.toolName) {
    case 'AskUserQuestion': {
      const first = Array.isArray(input.questions) ? (input.questions[0] as Record<string, unknown> | undefined) : undefined;
      return str(first?.question) || 'Claude has a question for you';
    }
    case 'ExitPlanMode':
      return 'Claude’s plan is ready for you to review';
    case 'Bash':
    case 'PowerShell': {
      // The command itself, never Claude's words about it; of several lines, the first and "…".
      const lines = str(input.command).split(/\r?\n/).filter((line) => line.trim());
      return lines.length > 1 ? `${lines[0]} …` : lines[0] || 'Run a command';
    }
    case 'Edit':
    case 'MultiEdit':
      return `Edit ${file(input.file_path)}`;
    case 'NotebookEdit':
      return `Edit ${file(input.notebook_path)}`;
    case 'Write':
      return `Write ${file(input.file_path)}`;
    case 'WebFetch': {
      try {
        return `Fetch ${new URL(str(input.url)).host}`;
      } catch {
        return 'Fetch a page';
      }
    }
    default:
      return request.title || `Use ${request.toolName.startsWith('mcp__') ? request.toolName.split('__').slice(1).join(' · ') : request.toolName}`;
  }
}

/** Form values as an MCP server takes them: strings, numbers, booleans and lists of strings. */
function formValues(input: Record<string, unknown>): Record<string, string | number | boolean | string[]> {
  const out: Record<string, string | number | boolean | string[]> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    else if (Array.isArray(value) && value.every((v) => typeof v === 'string')) out[key] = value;
  }
  return out;
}

/**
 * A workflow Claude runs in this process, as its task events tell it: started, its progress (the
 * whole list of its phases and agents, on the frames that carry one), its status, its end.
 */
type LiveFlow = {
  taskId: string;
  toolUseId?: string;
  runId?: string;
  name?: string;
  description?: string;
  status: WorkflowStatus;
  startedAt: number;
  endedAt?: number;
  /** When it was paused, which stops it as a stop does. */
  pausedAt?: number;
  /** The script's own phases, with their details. */
  phases: WorkflowPhase[];
  /** Progress items by `type:index`, as Claude Code merges them: a newer one replaces the old whole. */
  items: Map<string, Record<string, unknown>>;
  /** Claude Code's totals, from its notification at the end. */
  totals?: { tokens: number; toolUses: number; durationMs: number };
  error?: string;
  /** The page's copy, made again only when something changed. */
  shown?: Workflow;
};

/** An ended workflow stays in the run state this long: its card then reads Claude Code's record of it. */
const FLOW_KEEP_MS = 2 * 60_000;

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const clipped = (value: unknown, max: number) => (typeof value === 'string' && value ? (value.length > max ? `${value.slice(0, max - 1)}…` : value) : undefined);

/** A `workflow_agent` item as pages get it: Claude Code's fields, its long texts cut. */
function liveAgent(item: Record<string, unknown>): WorkflowAgent | undefined {
  const index = num(item.index);
  const state = item.state;
  if (index === undefined || (state !== 'start' && state !== 'progress' && state !== 'done' && state !== 'error')) return undefined;
  const text = (key: string, max = 200) => clipped(item[key], max);
  const out: WorkflowAgent = { index, label: text('label', 200) ?? `Agent ${index}`, state };
  for (const key of ['phaseIndex', 'tokens', 'toolCalls', 'durationMs', 'queuedAt', 'startedAt', 'lastProgressAt', 'attempt'] as const) {
    const value = num(item[key]);
    if (value !== undefined) out[key] = value;
  }
  for (const key of ['phaseTitle', 'agentId', 'agentType', 'model', 'fallbackModel', 'lastToolName'] as const) {
    const value = text(key, 120);
    if (value) out[key] = value;
  }
  // Its prompt and what it returned are not sent with every frame: nothing shows them but the
  // agent opened, which reads them from its transcript and the run's journal. One with no
  // transcript yet (queued, or ended before it started) has only Claude Code's preview of its
  // prompt (400 characters at most) to show.
  const error = text('error', 600);
  const tool = text('lastToolSummary', 160);
  const prompt = out.agentId ? undefined : text('promptPreview', 401);
  if (error) out.error = error;
  if (tool) out.lastToolSummary = tool;
  if (prompt) out.promptPreview = prompt;
  if (item.isolation === 'worktree' || item.isolation === 'remote') out.isolation = item.isolation;
  if (item.lastAttemptReason === 'stalled' || item.lastAttemptReason === 'throttled' || item.lastAttemptReason === 'user-retry') out.lastAttemptReason = item.lastAttemptReason;
  for (const key of ['skipped', 'blocked', 'cached'] as const) if (item[key] === true) out[key] = true;
  return out;
}

/** A workflow as pages show it: the script's phases and those the run opened, and its agents. */
function liveWorkflow(flow: LiveFlow): Workflow {
  if (flow.shown) return flow.shown;
  const phases = [...flow.phases];
  const agents: WorkflowAgent[] = [];
  for (const item of flow.items.values()) {
    if (item.type === 'workflow_phase') {
      const title = clipped(item.title, 120);
      if (title) addPhase(phases, title);
    } else if (item.type === 'workflow_agent') {
      const agent = liveAgent(item);
      if (agent) agents.push(agent);
    }
  }
  const tokens = flow.totals?.tokens ?? agentTokens(agents);
  const toolUses = flow.totals?.toolUses ?? agents.reduce((sum, a) => sum + (a.toolCalls ?? 0), 0);
  flow.shown = {
    ...(flow.runId ? { runId: flow.runId } : {}),
    taskId: flow.taskId,
    ...(flow.name ? { name: flow.name } : {}),
    ...(flow.description ? { description: flow.description } : {}),
    status: flow.status,
    startedAt: flow.startedAt,
    ...(flow.totals ? { durationMs: flow.totals.durationMs }
      : flow.endedAt ? { durationMs: flow.endedAt - flow.startedAt }
        : flow.status === 'paused' && flow.pausedAt ? { durationMs: flow.pausedAt - flow.startedAt } : {}),
    ...(tokens > 0 ? { totalTokens: tokens } : {}),
    ...(toolUses > 0 ? { totalToolCalls: toolUses } : {}),
    phases,
    agents,
    ...(flow.error ? { error: clipped(flow.error, 2000)! } : {}),
    source: 'live',
  };
  return flow.shown;
}

/** A scheduled check stays counted this long after it was due, in case it fires late. */
const DUE_GRACE_MS = 10 * 60_000;
/** Claude Code lets a recurring check go this long after it was made (CronCreate: "auto-expired after 7 days"). */
const RECURRING_MAX_AGE_MS = 7 * 24 * 3600_000;

/** One Claude Code process driving one session. It stays alive between turns until idle. */
export class SessionRun {
  busy = false;
  /** When the running turn began: the chat counts its time from here, not from when it was opened. */
  private startedAt?: number;
  closed = false;
  error?: string;
  lastActive = Date.now();
  private partial: PartialBlock[] = [];
  private completedBlocks = 0;
  private permissions = new Map<string, Pending>();
  private input = new InputQueue();
  private q?: Query;
  private emitTimer?: NodeJS.Timeout;
  private title = '';
  /** Set by Stop during a turn: it then ends with an error result that is not a failure. */
  private interrupted = false;
  private lastTurn?: RunState['lastTurn'];
  private context?: RunState['context'];
  private activity?: RunState['activity'];
  /** Background tasks to show (and stop), and how many run in all, watchers included. */
  private tasks: BackgroundTask[] = [];
  private taskCount = 0;
  /** What each running subagent or task last reported, the tool call that started it, and its name. */
  private progress = new Map<string, TaskProgress>();
  private taskTools = new Map<string, string>();
  private agentNames = new Map<string, string>();
  /** Workflows running in this process, by task id. */
  private flows = new Map<string, LiveFlow>();
  /** Claude's calls to schedule tools, until their results say what was scheduled. */
  private scheduling = new Map<string, { name: string; input: Record<string, unknown> }>();
  private wakeup?: ScheduledCheck;
  private crons = new Map<string, ScheduledCheck>();
  /** When Claude Code lets each recurring check go. */
  private cronEnds = new Map<string, number>();
  /** Prompts waiting for the turn to end; Claude gets them together when it does. */
  private queued: Prompt[] = [];
  /** The turn ended with prompts waiting, which went out at once: the idle that follows is not the end. */
  private continuing = false;
  /** Of the prompts that went out when a turn ended, those no result has answered yet: Claude goes on with them. */
  private unanswered = new Set<string>();
  /** The session's total cost after the last turn; unknown for a resumed session until its first turn. */
  private costSoFar?: number;
  /** While settings picked here are being applied, Claude Code's reports of the old ones are stale. */
  private applying = 0;
  private modeChanged?: PermissionMode;
  private modeBeforePlan?: PermissionMode;
  private lastReply = '';
  private started!: { resolve: () => void; reject: (error: Error) => void };
  /** Settles once Claude has started (its first message), or fails when it ends before that. */
  readonly ready = new Promise<void>((resolve, reject) => {
    this.started = { resolve, reject };
  });
  // Most callers never wait for it: a failure here must not count as unhandled.
  private readonly readyHandled = this.ready.catch(() => undefined);
  /** Claude Code said something: it started, and the session is there to resume. */
  private began = false;
  private suggestion?: string;

  constructor(
    readonly sessionId: string,
    readonly cwd: string,
    private settings: RunSettings,
    private readonly resume: boolean,
    /** Resume only up to this entry, dropping the turn after it (an edited last prompt). */
    private readonly resumeAt?: { entry: string; dropsTurn: string },
    /** Which settings Claude Code loads: a folder nobody trusted runs none of its own (trust.ts). */
    private readonly launch: Launch = FULL_SETTINGS,
    /** A side chat (side-chat.ts): it reads, changes nothing, and runs in its own mode whatever is picked. */
    readonly sideChat = false,
  ) {
    if (!resume) this.costSoFar = 0;
    if (sideChat) this.settings = sideChatSettings(settings);
  }

  /**
   * Work in this process that ends with it and says nothing while it runs: background tasks
   * (watchers included), a wake-up Claude scheduled, session crons. Closing or restarting the
   * process would cut it off.
   */
  get hasBackgroundTasks(): boolean {
    if (this.forgetPastChecks()) this.emit();
    return this.taskCount > 0 || Boolean(this.wakeup) || this.crons.size > 0;
  }

  /**
   * How much of that work there is to show: background tasks and subagents (watchers aside, which
   * Claude Code says are no activity) and the checks Claude stays running for. A session with some,
   * and no turn running, is still at work.
   */
  get backgroundCount(): number {
    if (this.forgetPastChecks()) this.emit();
    return this.work();
  }

  private work(): number {
    return this.tasks.length + (this.wakeup ? 1 : 0) + this.crons.size;
  }

  /**
   * The checks still to come at `now`: not one-off checks long past due, nor recurring ones Claude
   * Code has let go. A recurring check that fired shows no time: Claude Code works out the next one
   * as it goes, its own way, and a time gone by would say it is late.
   */
  private checksAt(now: number): { wakeup: ScheduledCheck | undefined; crons: Map<string, ScheduledCheck> } {
    const wakeup = this.wakeup && (this.wakeup.next ?? 0) + DUE_GRACE_MS < now ? undefined : this.wakeup;
    const crons = new Map<string, ScheduledCheck>();
    for (const [id, cron] of this.crons) {
      if (cron.repeats ? (this.cronEnds.get(id) ?? Infinity) < now : (cron.next ?? 0) + DUE_GRACE_MS < now) continue;
      if (cron.repeats && cron.next !== undefined && cron.next < now) {
        const { next: _fired, ...rest } = cron;
        crons.set(id, rest);
      } else {
        crons.set(id, cron);
      }
    }
    return { wakeup, crons };
  }

  /** Keeps only the checks still to come; whether that changed anything. */
  private forgetPastChecks(now = Date.now()): boolean {
    const { wakeup, crons } = this.checksAt(now);
    const changed = wakeup !== this.wakeup || crons.size !== this.crons.size || [...crons].some(([id, cron]) => this.crons.get(id) !== cron);
    this.wakeup = wakeup;
    this.crons = crons;
    for (const id of this.cronEnds.keys()) if (!crons.has(id)) this.cronEnds.delete(id);
    return changed;
  }

  start(): void {
    const settings = this.settings;
    const options: Options = {
      cwd: this.cwd,
      ...(this.resume ? { resume: this.sessionId } : { sessionId: this.sessionId }),
      // Claude Code checks that everything past the entry belongs to the dropped turn, so a
      // message another app added meanwhile is never thrown away unseen.
      ...(this.resume && this.resumeAt ? { resumeSessionAt: this.resumeAt.entry, resumeDropsTurn: this.resumeAt.dropsTurn } : {}),
      ...(sdkModel(settings.model) ? { model: sdkModel(settings.model) } : {}),
      ...(settings.effort ? { effort: settings.effort as EffortLevel } : {}),
      permissionMode: settings.permissionMode ?? 'default',
      allowDangerouslySkipPermissions: true,
      ...(settings.fast || settings.ultracode ? {
        settings: {
          ...(settings.fast ? { fastMode: true } : {}),
          // Ultracode needs workflows; both are session settings, like the CLI's --settings.
          ...(settings.ultracode ? { ultracode: true, enableWorkflows: true } : {}),
        },
      } : {}),
      includePartialMessages: true,
      // Lets "Rewind code" put files back the way they were before a prompt.
      enableFileCheckpointing: true,
      promptSuggestions: true,
      // Running subagents say what they are doing, for the line under their step.
      agentProgressSummaries: true,
      // Each background task has its own Stop here, so Stop ends the turn and spares them, as Esc does.
      perTaskStopAffordance: true,
      toolConfig: { askUserQuestion: { previewFormat: 'markdown' } },
      settingSources: this.launch.settingSources,
      ...(this.launch.env ? { env: { ...process.env, ...this.launch.env } } : {}),
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      tools: { type: 'preset', preset: 'claude_code' },
      canUseTool: this.canUseTool,
      onElicitation: this.onElicitation,
      ...(config.claudeExecutable ? { pathToClaudeCodeExecutable: config.claudeExecutable } : {}),
      stderr: (data) => {
        if (process.env.PELICAN_DEBUG) process.stderr.write(`[claude ${this.sessionId.slice(0, 8)}] ${data}`);
      },
      // Last, so nothing above can give a side chat a tool, a server or a mode of the session's.
      ...(this.sideChat ? sideChatOptions() : {}),
    };
    this.q = query({ prompt: this.input, options });
    void this.pump();
    void sessionInfo(this.sessionId).then((info) => {
      if (info) this.title = sessionTitle(info) ?? '';
    });
  }

  state(): RunState {
    const progress = Object.fromEntries([...this.progress].flatMap(([task, report]) => {
      const tool = this.taskTools.get(task);
      return tool ? [[tool, report]] : [];
    }));
    const checks = this.checksAt(Date.now());
    const scheduled = [...(checks.wakeup ? [checks.wakeup] : []), ...checks.crons.values()];
    return {
      sessionId: this.sessionId,
      cwd: this.cwd,
      busy: this.busy,
      ...(this.busy && this.startedAt ? { startedAt: this.startedAt } : {}),
      settings: this.settings,
      permissions: [...this.permissions.values()].map((p) => p.request),
      partial: this.partial.slice(this.completedBlocks).filter(Boolean),
      ...(this.error ? { error: this.error } : {}),
      ...(this.lastTurn ? { lastTurn: this.lastTurn } : {}),
      ...(this.context ? { context: this.context } : {}),
      ...(this.activity ? { activity: this.activity } : {}),
      ...(this.tasks.length > 0 ? {
        tasks: this.tasks.map((task) => {
          // A workflow, by its name, as Claude Code's task panel lists it, with how far its agents got.
          const flow = this.flows.get(task.id);
          if (flow) {
            const { agents } = liveWorkflow(flow);
            const done = agents.filter((a) => a.state === 'done').length;
            return { ...task, description: flow.name ?? task.description, ...(agents.length > 0 ? { summary: `${done}/${agents.length} agents` } : {}) };
          }
          const report = this.progress.get(task.id);
          const summary = report?.summary ?? report?.lastTool;
          return summary ? { ...task, summary } : task;
        }),
      } : {}),
      ...(this.queued.length > 0 ? { queued: this.queued.map(queuedPrompt) } : {}),
      ...(this.busy && this.interrupted ? { stopping: true } : {}),
      ...(Object.keys(progress).length > 0 ? { progress } : {}),
      ...(this.flows.size > 0 ? { workflows: this.workflowStates() } : {}),
      ...(scheduled.length > 0 ? { scheduled } : {}),
      ...(this.modeChanged ? { modeChanged: this.modeChanged } : {}),
      ...(this.suggestion && !this.busy ? { suggestion: this.suggestion } : {}),
    };
  }

  status(): SessionStatus {
    if (this.permissions.size > 0) return 'waiting';
    return this.busy ? 'running' : 'idle';
  }

  /** The workflows Claude runs here, by the Workflow call that started each. */
  private workflowStates(): Record<string, Workflow> {
    return Object.fromEntries([...this.flows.values()].flatMap((flow) => (flow.toolUseId ? [[flow.toolUseId, liveWorkflow(flow)]] : [])));
  }

  /** What this process knows of a workflow it runs, by its Workflow call. */
  workflow(toolUseId: string): Workflow | undefined {
    for (const flow of this.flows.values()) if (flow.toolUseId === toolUseId) return liveWorkflow(flow);
    return undefined;
  }

  /** A workflow agent asking for something, by the label its script gave it, cut as its card cuts it. */
  private workflowAgent(agentId: string): string | undefined {
    for (const flow of this.flows.values()) {
      for (const item of flow.items.values()) {
        if (item.type === 'workflow_agent' && item.agentId === agentId) return clipped(item.label, 200);
      }
    }
    return undefined;
  }

  /** A workflow's task event: it started, made progress, changed status or ended. */
  private noteFlow(message: Record<string, unknown>): boolean {
    const taskId = str(message.task_id);
    const subtype = message.subtype;
    let flow = this.flows.get(taskId);
    if (subtype === 'task_started') {
      if (message.task_type !== 'local_workflow') return false;
      const meta = typeof message.prompt === 'string' ? parseMeta(message.prompt) : undefined;
      flow = {
        taskId,
        ...(str(message.tool_use_id) ? { toolUseId: str(message.tool_use_id) } : {}),
        ...(str(message.workflow_name) || meta?.name ? { name: str(message.workflow_name) || meta!.name! } : {}),
        ...(str(message.description) ? { description: str(message.description) } : {}),
        status: 'running',
        startedAt: Date.now(),
        phases: meta?.phases ?? [],
        items: new Map(),
      };
      this.flows.set(taskId, flow);
      this.emit();
      return true;
    }
    const items = (message as { workflow_progress?: unknown }).workflow_progress;
    // A frame of a workflow this process saw start before Pelican listened, or a late start.
    if (!flow && subtype === 'task_progress' && Array.isArray(items) && taskId) {
      flow = { taskId, ...(str(message.tool_use_id) ? { toolUseId: str(message.tool_use_id) } : {}), status: 'running', startedAt: Date.now(), phases: [], items: new Map() };
      this.flows.set(taskId, flow);
    }
    if (!flow) return false;
    flow.shown = undefined;
    if (subtype === 'task_progress') {
      flow.toolUseId ??= str(message.tool_use_id) || undefined;
      // Only some frames carry the list, and each carries it whole; the others only tick usage.
      if (!Array.isArray(items)) return true;
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const { type, index } = item as { type?: unknown; index?: unknown };
        if ((type === 'workflow_agent' || type === 'workflow_phase') && typeof index === 'number') flow.items.set(`${type}:${index}`, item as Record<string, unknown>);
      }
      this.emit(true);
      return true;
    }
    if (subtype === 'task_updated') {
      const patch = (message.patch ?? {}) as { status?: unknown; error?: unknown; end_time?: unknown };
      const status = patch.status;
      if (status === 'running' || status === 'pending') flow.status = 'running';
      else if (status === 'paused' || status === 'completed' || status === 'failed' || status === 'killed') flow.status = status;
      if (typeof patch.error === 'string' && patch.error) flow.error = patch.error;
      if (typeof patch.end_time === 'number') flow.endedAt = patch.end_time;
      // A pause stops the run, as a stop does: its time stops there.
      if (status === 'paused') flow.pausedAt ??= Date.now();
      else if (status === 'running') flow.pausedAt = undefined;
      this.emit();
      return true;
    }
    if (subtype === 'task_notification') {
      const status = message.status;
      flow.status = status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'killed';
      flow.endedAt ??= Date.now();
      const usage = message.usage as { total_tokens?: unknown; tool_uses?: unknown; duration_ms?: unknown } | undefined;
      if (usage && num(usage.total_tokens) !== undefined) {
        flow.totals = { tokens: num(usage.total_tokens)!, toolUses: num(usage.tool_uses) ?? 0, durationMs: num(usage.duration_ms) ?? flow.endedAt - flow.startedAt };
      }
      // A while after, the card reads Claude Code's own record of the run.
      const ended = flow;
      setTimeout(() => {
        if (this.flows.get(taskId) !== ended) return;
        this.flows.delete(taskId);
        this.emit();
      }, FLOW_KEEP_MS).unref();
      this.emit();
      return true;
    }
    return false;
  }

  /** Sends the run state now, or within 80 ms when called for streamed text. */
  private emit(soon = false): void {
    if (soon) {
      if (this.emitTimer) return;
      this.emitTimer = setTimeout(() => {
        this.emitTimer = undefined;
        this.emitNow();
      }, 80);
      return;
    }
    clearTimeout(this.emitTimer);
    this.emitTimer = undefined;
    this.emitNow();
  }

  private lastStatus?: string;
  /** Its process has ended and its last word is said: nothing it does after that reaches a page. */
  private finished = false;

  /**
   * A newer run has taken the session (an edited last prompt, a restart): what this one, closed,
   * still says while its process exits would undo the newer one's state on every page.
   */
  private replaced(): boolean {
    const current = runs.get(this.sessionId);
    return current !== undefined && current !== this;
  }

  private emitNow(): void {
    if (this.finished || this.replaced()) return;
    this.forgetPastChecks();
    const state = this.state();
    feedFor(this.sessionId).broadcast({ type: 'run', state });
    this.sayStatus();
  }

  /** Session lists only care about the status and the work left running; streamed text stays with the session's viewers. */
  private sayStatus(): void {
    const status = this.status();
    const tasks = this.work();
    if (`${status}:${tasks}` !== this.lastStatus) {
      this.lastStatus = `${status}:${tasks}`;
      broadcastAll({ type: 'status', sessionId: this.sessionId, status, ...(tasks > 0 ? { tasks } : {}) });
    }
  }

  private setBusy(busy: boolean): void {
    if (this.busy === busy) return;
    this.busy = busy;
    this.lastActive = Date.now();
    this.startedAt = busy ? this.lastActive : undefined;
    if (!busy) {
      this.partial = [];
      this.completedBlocks = 0;
    }
    this.emit();
    sessionsChanged();
  }

  async send(input: SendInput): Promise<void> {
    // In the same process Claude Code would go on under a new id, beside this session's.
    if (CLEARS.test(input.text.trim())) throw new Error(AFRESH);
    if (this.sideChat && SIDE_CHAT_COMMAND.test(input.text.trim())) throw new Error('A side chat takes questions, not / commands.');
    await this.applySettings(input.settings);
    // Closed meanwhile (the idle close, an exit): queued or sent, it would wait for nobody.
    if (this.closed) throw new RunClosed();
    const prompt = { uuid: input.uuid ?? randomUUID(), text: input.text, attachments: input.attachments };
    // Queued: not part of the conversation until the turn ends and Claude gets it.
    if (this.busy && input.mode === 'queue') {
      this.queued.push(prompt);
      this.emit();
      return;
    }
    // While a turn runs, Claude reads it at its next step.
    await this.deliver(prompt, this.busy);
  }

  private async deliver(prompt: Prompt, steer: boolean): Promise<void> {
    const content = await contentOf(this.sideChat ? sideChatPrompt(prompt.text) : prompt.text, prompt.attachments);
    if (this.closed) throw new RunClosed();
    const message: SDKUserMessage = {
      type: 'user',
      uuid: prompt.uuid as UUID,
      session_id: this.sessionId,
      parent_tool_use_id: null,
      origin: { kind: 'human' },
      ...(steer ? { priority: 'next' as const } : {}),
      message: { role: 'user', content },
    };
    this.error = undefined;
    this.suggestion = undefined;
    this.modeChanged = undefined;
    if (!this.busy) {
      this.interrupted = false;
      this.lastReply = '';
    }
    this.setBusy(true);
    const chat = toChatMessage({ type: 'user', uuid: prompt.uuid, message: { role: 'user', content } });
    if (chat) await feedFor(this.sessionId).publish({ ...chat, timestamp: Date.now() });
    // Shown already: the Claude it goes to instead publishes it under the same id, which the feed has.
    if (this.closed) throw new RunClosed();
    this.input.push(message);
  }

  /** Takes a queued prompt back before Claude gets it; false when it is not waiting any more. */
  unqueue(uuid: string): boolean {
    const before = this.queued.length;
    this.queued = this.queued.filter((p) => p.uuid !== uuid);
    if (this.queued.length === before) return false;
    this.emit();
    return true;
  }

  /**
   * Adds a `!` command and its output to the conversation the way Claude Code's bash mode does:
   * the command, then what it printed, as typed text that is no prompt to expand. With `respond`
   * Claude answers it, as the CLI's Claude does; without, Claude keeps it for later and the caveat
   * before it says so. `uuid`: the id of the message holding the command.
   */
  async appendShell(result: ForClaude, respond: boolean, uuid: string = randomUUID()): Promise<void> {
    if (this.closed) throw new RunClosed();
    const parts = bashModeMessages(result, respond);
    const messages = parts.map(({ text, meta }, i): SDKUserMessage => ({
      type: 'user',
      uuid: (i === parts.length - 2 ? uuid : randomUUID()) as UUID,
      session_id: this.sessionId,
      parent_tool_use_id: null,
      origin: { kind: 'human' },
      // Typed as it stands: an @ or a / in the output is no file to attach or command to run.
      client_composed: true,
      ...(meta ? { isSynthetic: true } : {}),
      shouldQuery: respond && i === parts.length - 1,
      message: { role: 'user', content: text },
    }));
    // Rows of the shape Claude Code's bash mode writes from 2.1.80 on (Pelican builds them so), which
    // the page reads by that version, as it reads the transcript's.
    const version = sdkPackage().claudeCodeVersion ?? '2.1.80';
    for (const message of messages) {
      const chat = toChatMessage({ type: 'user', uuid: message.uuid, version, ...(message.isSynthetic ? { isMeta: true } : {}), message: message.message });
      if (chat) await feedFor(this.sessionId).publish({ ...chat, timestamp: Date.now() });
    }
    if (this.closed) throw new RunClosed();
    if (respond) {
      // A turn starts with the output, as with a prompt: the page shows Claude at work at once.
      this.error = undefined;
      this.suggestion = undefined;
      this.modeChanged = undefined;
      if (!this.busy) {
        this.interrupted = false;
        this.lastReply = '';
      }
      this.setBusy(true);
    }
    for (const message of messages) this.input.push(message);
  }

  /** Puts files back the way they were before the prompt `uuid`; `dryRun` only says what would change. */
  async rewind(uuid: string, dryRun: boolean): Promise<RewindResult> {
    if (!this.q) throw new Error('Claude is not running in this session');
    const result = await this.q.rewindFiles(uuid, { dryRun });
    return {
      canRewind: result.canRewind,
      ...(result.error ? { error: result.error } : {}),
      ...(result.filesChanged ? { files: result.filesChanged } : {}),
      ...(typeof result.insertions === 'number' ? { insertions: result.insertions } : {}),
      ...(typeof result.deletions === 'number' ? { deletions: result.deletions } : {}),
    };
  }

  async mcpServers(): Promise<McpServer[]> {
    if (!this.q) return [];
    return toMcpServers(await this.q.mcpServerStatus());
  }

  async setMcpServer(name: string, change: { enabled?: boolean; reconnect?: boolean }): Promise<void> {
    if (!this.q) throw new Error('Claude is not running in this session');
    if (change.reconnect) await this.q.reconnectMcpServer(name);
    if (change.enabled !== undefined) await this.q.toggleMcpServer(name, change.enabled);
  }

  /** The commands and agents of this very session, up to date (skills it found as it worked included). */
  async completions(): Promise<Completions> {
    if (!this.q) throw new Error('Claude is not running in this session');
    const [commands, agents] = await Promise.all([this.q.supportedCommands(), this.q.supportedAgents().catch(() => [])]);
    return toCompletions(commands, agents);
  }

  async stopTask(taskId: string): Promise<void> {
    await this.q?.stopTask(taskId);
  }

  /** The end of what a background command printed (the last 8 KiB), as the terminal's /tasks shows it. */
  async taskOutput(taskId: string): Promise<TaskOutput> {
    // A control request the SDK has but does not type yet.
    const q = this.q as (Query & { getTaskOutput?: (taskId: string) => Promise<{ output: string; truncated: boolean }> }) | undefined;
    if (!q?.getTaskOutput) throw new Error('This Claude Code cannot show a task’s output');
    const answer = await q.getTaskOutput(taskId);
    return { output: String(answer?.output ?? ''), truncated: Boolean(answer?.truncated) };
  }

  /**
   * Settings picked here, applied to Claude now: from its next step, also mid-turn. A mode picked
   * here (`pick`) is always sent, even when Pelican thinks Claude is in it already.
   *
   * They are all the settings the page has: one left out is its default (Default effort is no
   * effort at all), which Claude gets and the run then says it has. Only the mode stays as it is
   * when none is given, as Claude Code changes it too.
   */
  async applySettings(asked: RunSettings, pick = false): Promise<void> {
    const q = this.q;
    if (!q) return;
    // A side chat keeps its own mode, whatever its session's is.
    const next = this.sideChat ? sideChatSettings(asked) : asked;
    const prev = this.settings;
    const mode = next.permissionMode ?? prev.permissionMode;
    this.settings = { ...next, ...(mode ? { permissionMode: mode } : {}) };
    if (next.permissionMode) this.modeChanged = undefined;
    if (next.permissionMode === 'plan' && prev.permissionMode !== 'plan') this.modeBeforePlan = prev.permissionMode ?? 'default';
    this.applying += 1;
    try {
      if ((next.model ?? 'default') !== (prev.model ?? 'default')) await q.setModel(sdkModel(next.model));
      // A new effort level sent without the ultracode key turns ultracode off, so both go together.
      if ((next.effort ?? '') !== (prev.effort ?? '') || Boolean(next.ultracode) !== Boolean(prev.ultracode)) {
        await q.applyFlagSettings({
          effortLevel: (next.effort as EffortLevel) ?? null,
          ultracode: Boolean(next.ultracode),
          ...(next.ultracode ? { enableWorkflows: true } : {}),
        });
      }
      if (Boolean(next.fast) !== Boolean(prev.fast)) await q.applyFlagSettings({ fastMode: Boolean(next.fast) });
      if (next.permissionMode && (pick || next.permissionMode !== (prev.permissionMode ?? 'default'))) await q.setPermissionMode(next.permissionMode);
    } catch (error) {
      console.warn('[pelican] could not apply settings', (error as Error).message);
    } finally {
      this.applying -= 1;
    }
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (this.sideChat) return;
    await this.applySettings({ ...this.settings, permissionMode: mode }, true);
    this.emit();
  }

  /** Settings changed in the composer, all of them, applied to Claude now: from its next step, also mid-turn. */
  async updateSettings(next: RunSettings): Promise<void> {
    await this.applySettings(next);
    this.emit();
  }

  /** The mode Claude Code says the session is in now; said once when it was not picked here. */
  private noteMode(mode: PermissionMode): void {
    if (this.applying > 0) return;
    const before = this.settings.permissionMode ?? 'default';
    if (mode === before) return;
    if (mode === 'plan') this.modeBeforePlan = before;
    this.settings = { ...this.settings, permissionMode: mode };
    this.modeChanged = mode;
    this.emit();
  }

  /** Each turn starts with what it runs with: the chips show that, not what was last picked. */
  private noteInit(init: Extract<SDKMessage, { type: 'system'; subtype: 'init' }>): void {
    if (init.terminal_slash_commands) noteTerminalCommands(init.terminal_slash_commands);
    if (this.applying > 0) return;
    const next = { ...this.settings };
    // Named as the picker names it: an id the list does not know would show raw, so it is left.
    const models = knownModels();
    if (init.model && models?.some((m) => m.value === init.model || m.resolvedModel === init.model)) next.model = pickerValue(init.model, models, next.model ?? 'default');
    if (typeof init.effort === 'string') next.effort = init.effort;
    if (init.fast_mode_state === 'on' || init.fast_mode_state === 'off') next.fast = init.fast_mode_state === 'on';
    const changed = JSON.stringify(next) !== JSON.stringify(this.settings);
    this.settings = next;
    if (init.permissionMode) this.noteMode(init.permissionMode);
    if (changed) this.emit();
  }

  /** Whether auto mode can carry out a plan with the model this session runs, when that is known. */
  private autoAvailable(): boolean {
    const model = this.settings.model ?? 'default';
    return knownModels()?.find((m) => m.value === model)?.supportsAuto === true;
  }

  private park(pending: Pending, signal: AbortSignal, onAbort: () => void): void {
    const id = pending.request.id;
    this.permissions.set(id, pending);
    signal.addEventListener('abort', () => {
      if (this.permissions.delete(id)) {
        onAbort();
        this.emit();
        sessionsChanged();
      }
    });
    this.emit();
    sessionsChanged();
    // A notification that can answer says, as its whole body, all that Allow approves.
    void notify({ title: this.title || 'Claude Code', body: oneLine(askedFor(pending.request, this.cwd)), sessionId: this.sessionId, tag: `${this.sessionId}:ask`, ...answerable(pending.request) });
  }

  private canUseTool: CanUseTool = (toolName, input, options) => {
    const { signal, suggestions, blockedPath, decisionReason, title, description, defaultToNo, suppressAlwaysAllowRule, agentID, mcpServer } = options;
    // No "always" where Claude Code says the rule would grant more than this request, or a plugin asked.
    const always = suppressAlwaysAllowRule ? undefined : describeAlways(suggestions, config.home);
    const agent = agentID ? this.agentNames.get(agentID) ?? this.workflowAgent(agentID) ?? 'a subagent' : undefined;
    const request: PermissionRequest = {
      id: randomUUID(),
      sessionId: this.sessionId,
      toolName,
      input,
      ...(always ? { always } : {}),
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      ...(defaultToNo ? { defaultToNo: true } : {}),
      ...(agent ? { agent } : {}),
      ...(mcpServer?.name ? { server: mcpServer.name } : {}),
      ...(toolName === 'ExitPlanMode' ? { plan: { ...(this.modeBeforePlan ? { before: this.modeBeforePlan } : {}), auto: this.autoAvailable() } } : {}),
      ...(decisionReason ? { reason: decisionReason } : {}),
      ...(blockedPath ? { blockedPath } : {}),
      createdAt: Date.now(),
    };
    return new Promise<PermissionResult>((resolve) => {
      this.park(
        { kind: 'tool', request, input, ...(always && suggestions ? { suggestions } : {}), main: !agentID, resolve },
        signal,
        () => resolve({ behavior: 'deny', message: 'Cancelled.' }),
      );
    });
  };

  private onElicitation: OnElicitation = (asked, { signal }) => {
    // Only a web page may be offered to open.
    const url = asked.mode === 'url' && asked.url && /^https?:\/\//i.test(asked.url) ? asked.url : undefined;
    const request: PermissionRequest = {
      id: randomUUID(),
      sessionId: this.sessionId,
      toolName: `mcp__${asked.serverName}`,
      input: {},
      ...(asked.title ? { title: asked.title } : {}),
      ...(asked.description ? { description: asked.description } : {}),
      elicitation: {
        server: asked.serverName,
        message: asked.message,
        mode: asked.mode === 'url' ? 'url' : 'form',
        ...(url ? { url } : {}),
        ...(asked.requestedSchema ? { schema: asked.requestedSchema } : {}),
      },
      createdAt: Date.now(),
    };
    return new Promise<ElicitationResult>((resolve) => {
      this.park({ kind: 'elicitation', request, resolve }, signal, () => resolve({ action: 'cancel' }));
    });
  };

  decide(id: string, decision: PermissionDecision): boolean {
    const pending = this.permissions.get(id);
    if (!pending) return false;
    this.permissions.delete(id);
    if (pending.kind === 'elicitation') {
      pending.resolve(decision.behavior === 'allow'
        ? { action: 'accept', ...(decision.updatedInput ? { content: formValues(decision.updatedInput) } : {}) }
        : { action: 'decline' });
    } else if (decision.behavior === 'allow') {
      const remember = Boolean(decision.remember && pending.suggestions);
      // A plan approved into a mode: Claude Code switches with the approval, as its own options do.
      const updates: PermissionUpdate[] = [
        ...(remember ? pending.suggestions! : []),
        ...(decision.permissionMode ? [{ type: 'setMode' as const, mode: decision.permissionMode, destination: 'session' as const }] : []),
      ];
      const mode = sessionModeOf(updates);
      if (mode) {
        if (mode === 'plan' && this.settings.permissionMode !== 'plan') this.modeBeforePlan = this.settings.permissionMode ?? 'default';
        this.settings = { ...this.settings, permissionMode: mode };
        this.modeChanged = undefined;
      }
      pending.resolve({
        behavior: 'allow',
        updatedInput: decision.updatedInput ?? pending.input,
        ...(updates.length > 0 ? { updatedPermissions: updates } : {}),
        decisionClassification: remember ? 'user_permanent' : 'user_temporary',
      });
    } else {
      pending.resolve(this.refusal(pending, decision.message));
    }
    this.emit();
    sessionsChanged();
    return true;
  }

  /** A Deny, as Claude Code's No: without a note the turn stops and Claude waits; with one, Claude goes on with it. */
  private refusal(pending: Extract<Pending, { kind: 'tool' }>, message: string | undefined): PermissionResult {
    const note = message?.trim();
    // A question skipped and a plan sent back are answers, not refusals: Claude carries on with them.
    if (pending.request.toolName === 'AskUserQuestion' || pending.request.toolName === 'ExitPlanMode') {
      return { behavior: 'deny', message: note || 'The user declined this.', decisionClassification: 'user_reject' };
    }
    if (note) return { behavior: 'deny', message: refusedWith(note), decisionClassification: 'user_reject' };
    // A subagent's request ends only that step of the subagent, as in Claude Code.
    if (!pending.main) return { behavior: 'deny', message: STOP_AND_WAIT, decisionClassification: 'user_reject' };
    if (this.busy) this.interrupted = true;
    return { behavior: 'deny', message: STOP_AND_WAIT, interrupt: true, decisionClassification: 'user_reject' };
  }

  /** Answers a request nobody decided: the turn was stopped, or the session closed. */
  private settleAll(why: string): void {
    for (const [id, pending] of this.permissions) {
      this.permissions.delete(id);
      if (pending.kind === 'elicitation') pending.resolve({ action: 'cancel' });
      else pending.resolve({ behavior: 'deny', message: why });
    }
  }

  async interrupt(): Promise<void> {
    // A Stop that comes after the turn ended stops nothing, and must not cost the next turn its notice.
    if (!this.busy) return;
    this.interrupted = true;
    this.settleAll('Interrupted by the user.');
    this.emit();
    sessionsChanged();
    try {
      await this.q?.interrupt();
    } catch (error) {
      console.warn('[pelican] interrupt failed', (error as Error).message);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.settleAll('Session closed.');
    this.input.close();
    try {
      this.q?.close();
    } catch {
      // Already exited.
    }
  }

  /** How full the context window is now; shown in the session header. */
  private async readContext(): Promise<void> {
    try {
      // The summary comes from the last response's usage: no token-count calls after every turn.
      const usage = await this.q?.getContextUsage({ detail: 'summary' });
      if (!usage) return;
      this.context = { percent: Math.round(usage.percentage), tokens: usage.totalTokens, max: usage.maxTokens };
      this.emit();
    } catch {
      // Older Claude Code; the header just shows no meter.
    }
  }

  /** This turn's cost: the result carries the session's running total. */
  private turnCost(total: number | undefined): number | undefined {
    if (typeof total !== 'number' || !Number.isFinite(total)) return undefined;
    const before = this.costSoFar;
    this.costSoFar = total;
    if (before === undefined) return undefined;
    // A total that went down started again (/clear, or a result after a crash).
    return total >= before ? total - before : total;
  }

  /** Remembers Claude's calls to the tools that schedule work, to read what their results scheduled. */
  private noteCalls(content: unknown): void {
    if (!Array.isArray(content)) return;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block?.type !== 'tool_use' || typeof block.id !== 'string') continue;
      const name = str(block.name);
      if (name === 'ScheduleWakeup' || name === 'CronCreate' || name === 'CronDelete') {
        this.scheduling.set(block.id, { name, input: (block.input ?? {}) as Record<string, unknown> });
      }
    }
  }

  private noteResults(raw: Record<string, unknown>): void {
    const content = (raw.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) return;
    // A workflow's run id is only in its call's result: the folder its agents write to.
    const launched = (raw.tool_use_result ?? {}) as { taskId?: unknown; runId?: unknown };
    const flow = typeof launched.taskId === 'string' ? this.flows.get(launched.taskId) : undefined;
    if (flow && typeof launched.runId === 'string' && RUN_ID.test(launched.runId)) {
      flow.runId = launched.runId;
      // The call it answers, should its start not have said.
      const answered = (content as Array<Record<string, unknown>>).find((b) => b?.type === 'tool_result' && typeof b.tool_use_id === 'string');
      flow.toolUseId ??= answered?.tool_use_id as string | undefined;
      flow.shown = undefined;
      this.emit(true);
    }
    for (const block of content as Array<Record<string, unknown>>) {
      if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
      const call = this.scheduling.get(block.tool_use_id);
      if (!call) continue;
      this.scheduling.delete(block.tool_use_id);
      if (block.is_error === true) continue;
      const output = (raw.tool_use_result ?? {}) as Record<string, unknown>;
      if (call.name === 'ScheduleWakeup') {
        const at = typeof output.scheduledFor === 'number' ? output.scheduledFor : undefined;
        this.wakeup = call.input.stop === true || !at ? undefined : { id: 'wakeup', what: str(call.input.reason) || 'Claude checks back', next: at, repeats: false };
      } else if (call.name === 'CronCreate') {
        const id = str(output.id);
        if (!id) continue;
        const prompt = str(call.input.prompt);
        const repeats = output.recurring !== false;
        this.crons.set(id, {
          id,
          what: oneLine(`${str(output.humanSchedule) || str(call.input.cron)}${prompt ? `: ${prompt}` : ''}`, 100),
          ...(typeof output.nextFireAt === 'number' ? { next: output.nextFireAt } : {}),
          repeats,
        });
        if (repeats) this.cronEnds.set(id, Date.now() + RECURRING_MAX_AGE_MS);
      } else {
        this.crons.delete(str(call.input.id));
        this.cronEnds.delete(str(call.input.id));
      }
    }
  }

  private onStream(event: Record<string, unknown>): void {
    const index = typeof event.index === 'number' ? event.index : -1;
    switch (event.type) {
      case 'message_start':
        this.partial = [];
        this.completedBlocks = 0;
        break;
      case 'content_block_start': {
        const block = (event.content_block ?? {}) as Record<string, unknown>;
        if (block.type === 'text') this.partial[index] = { type: 'text', text: '' };
        else if (block.type === 'thinking') this.partial[index] = { type: 'thinking', thinking: '' };
        else if (block.type === 'tool_use' || block.type === 'server_tool_use') {
          this.partial[index] = { type: 'tool_use', name: String(block.name ?? ''), inputJson: '' };
        }
        break;
      }
      case 'content_block_delta': {
        const delta = (event.delta ?? {}) as Record<string, unknown>;
        const block = this.partial[index];
        if (!block) break;
        if (block.type === 'text' && delta.type === 'text_delta') block.text += String(delta.text ?? '');
        else if (block.type === 'thinking' && delta.type === 'thinking_delta') block.thinking += String(delta.thinking ?? '');
        else if (block.type === 'tool_use' && delta.type === 'input_json_delta') block.inputJson += String(delta.partial_json ?? '');
        break;
      }
      default:
        return;
    }
    this.setBusy(true);
    this.emit(true);
  }

  /** A line Claude Code shows in the conversation that is no message of Claude's: hook feedback, a command's output. */
  private async publishNotice(uuid: string, text: string): Promise<void> {
    if (!text.trim()) return;
    await feedFor(this.sessionId).publish({ uuid, role: 'system', blocks: [{ type: 'text', text }], timestamp: Date.now() });
  }

  private async pump(): Promise<void> {
    const q = this.q!;
    try {
      for await (const message of q as AsyncIterable<SDKMessage>) {
        this.lastActive = Date.now();
        this.began = true;
        this.started.resolve();
        const raw = message as unknown as Record<string, unknown>;
        switch (message.type) {
          case 'stream_event':
            if (!message.parent_tool_use_id) this.onStream(message.event as unknown as Record<string, unknown>);
            break;
          case 'assistant':
          case 'user': {
            if (raw.parent_tool_use_id) break;
            if (message.type === 'assistant') {
              this.completedBlocks += 1;
              this.noteCalls(message.message.content);
              const text = message.message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim();
              if (text) this.lastReply = text;
            } else {
              this.noteResults(raw);
            }
            if (this.activity?.kind === 'retrying') this.activity = undefined;
            const chat = toChatMessage(raw);
            if (chat) await feedFor(this.sessionId).publish({ ...chat, timestamp: chat.timestamp ?? Date.now() } satisfies ChatMessage);
            this.emit(true);
            break;
          }
          case 'system':
            if (message.subtype === 'session_state_changed') {
              const state = (raw as { state?: string }).state;
              if (state === 'running' || state === 'requires_action') {
                this.continuing = false;
                if (!this.busy) this.interrupted = false;
                this.setBusy(true);
              } else if (state === 'idle') {
                if (this.continuing) this.continuing = false;
                else this.setBusy(false);
              }
            } else if (message.subtype === 'init') {
              this.noteInit(message);
              void refreshTranscriptIndex().then(sessionsChanged);
            } else if (message.subtype === 'status') {
              this.activity = message.status === 'compacting' ? { kind: 'compacting' } : undefined;
              if (message.permissionMode) this.noteMode(message.permissionMode);
              this.emit();
            } else if (message.subtype === 'api_retry') {
              this.activity = { kind: 'retrying', attempt: message.attempt, max: message.max_retries, delayMs: message.retry_delay_ms };
              this.emit();
            } else if (message.subtype === 'background_tasks_changed') {
              // Watchers count for keeping Claude running, not as something to show.
              this.taskCount = message.tasks.length;
              this.tasks = message.tasks
                .filter((t) => !t.ambient)
                .map((t) => ({
                  id: t.task_id,
                  description: t.description,
                  type: t.subagent_type ?? t.task_type,
                  ...(t.task_type === 'local_bash' || t.task_type.startsWith('monitor') ? { output: true } : {}),
                }));
              this.emit();
            } else if ((message.subtype === 'task_started' || message.subtype === 'task_progress' || message.subtype === 'task_updated' || message.subtype === 'task_notification')
              && this.noteFlow(raw)) {
              // A workflow's: its card shows it, from what noteFlow kept.
              if (message.subtype === 'task_notification') this.taskTools.delete(message.task_id);
            } else if (message.subtype === 'task_started') {
              if (message.tool_use_id) this.taskTools.set(message.task_id, message.tool_use_id);
              if (message.subagent_type) this.agentNames.set(message.task_id, message.subagent_type);
            } else if (message.subtype === 'task_progress') {
              if (message.tool_use_id) this.taskTools.set(message.task_id, message.tool_use_id);
              this.progress.set(message.task_id, {
                ...(message.summary ? { summary: message.summary } : {}),
                ...(message.last_tool_name ? { lastTool: message.last_tool_name } : {}),
                toolUses: message.usage.tool_uses,
                durationMs: message.usage.duration_ms,
              });
              this.emit(true);
            } else if (message.subtype === 'task_notification') {
              this.progress.delete(message.task_id);
              this.taskTools.delete(message.task_id);
              this.agentNames.delete(message.task_id);
              this.emit(true);
            } else if (message.subtype === 'commands_changed') {
              void forgetCompletions(this.cwd);
            } else if (message.subtype === 'informational') {
              // Hook feedback (why a prompt was blocked), warnings and notices; 'info' lines are the terminal's transcript view only.
              if (message.level !== 'info') await this.publishNotice(message.uuid, message.content);
            } else if (message.subtype === 'local_command_output') {
              await this.publishNotice(message.uuid, `<local-command-stdout>${message.content}</local-command-stdout>`);
            }
            break;
          case 'rate_limit_event':
            recordLimit(message.rate_limit_info);
            break;
          case 'prompt_suggestion':
            this.suggestion = message.suggestion;
            this.emit();
            break;
          case 'result': {
            const stopped = this.interrupted;
            this.interrupted = false;
            this.continuing = false;
            const failed = !stopped && (message.subtype !== 'success' || message.is_error);
            this.error = failed
              ? readableError('errors' in message && message.errors.length > 0 ? message.errors.join('\n') : ('result' in message ? String(message.result) : message.subtype))
              : undefined;
            const cost = this.turnCost(message.total_cost_usd);
            this.lastTurn = {
              durationMs: message.duration_ms,
              // A plan's subscription pays, not per turn: a dollar figure would only mislead.
              ...(cost !== undefined && !onSubscription() ? { costUsd: cost } : {}),
              ...(typeof message.usage?.output_tokens === 'number' ? { outputTokens: message.usage.output_tokens } : {}),
            };
            this.activity = undefined;
            // A turn Claude starts on its own (a scheduled check) may say nothing: it must not repeat the last reply.
            const reply = this.lastReply;
            this.lastReply = '';
            // Claude Code says which prompts a result answers. One that answers none of those still
            // waiting is about something else, or from a Claude Code that does not say: the turn ends.
            const answered = message.user_message_uuids ?? (message.user_message_uuid ? [message.user_message_uuid] : []);
            const before = this.unanswered.size;
            for (const uuid of answered) this.unanswered.delete(uuid);
            if (this.unanswered.size === before) this.unanswered.clear();
            // What waited for this turn goes out now, each prompt as it was typed, as Claude Code takes
            // what is typed while it works: plain prompts together, a command as a command. Joined
            // into one text, a command would take the prompts after it as its arguments.
            const waiting = this.queued.splice(0);
            if (waiting.length > 0) {
              this.continuing = true;
              // A turn of its own: its time counts from now, not from the turn that just ended.
              this.startedAt = Date.now();
              for (const prompt of waiting) {
                this.unanswered.add(prompt.uuid);
                await this.deliver(prompt, false);
              }
            }
            // A command is answered on its own, before the prompts that went with it.
            const goesOn = this.unanswered.size > 0;
            if (!goesOn) this.setBusy(false);
            this.emit();
            void this.readContext();
            // A side chat is answered while it is looked at; its session's own turns are what to hear about.
            if (!stopped && !goesOn && !this.sideChat) {
              void notify({
                title: this.title || 'Claude Code',
                body: failed ? oneLine(`Stopped: ${this.error ?? 'error'}`, 180) : oneLine(reply.split('\n').find((line) => line.trim()) ?? '') || 'Finished',
                sessionId: this.sessionId,
                tag: `${this.sessionId}:done`,
              });
            }
            break;
          }
          default:
            break;
        }
      }
    } catch (error) {
      // Closed here while what was queued went out: no error of Claude's.
      if (!(error instanceof RunClosed)) {
        this.error = readableError((error as Error).message);
        console.warn(`[pelican] session ${this.sessionId.slice(0, 8)} ended with an error:`, this.error);
      }
    } finally {
      // Closed here (idle, replaced, Pelican shutting down), or ended on its own: a crash, a kill.
      const closedHere = this.closed;
      this.closed = true;
      this.started.reject(new Error(this.error ?? 'Claude Code stopped before it started'));
      this.settleAll('Session closed.');
      const leftover = this.queued.splice(0);
      // Its background work and checks ended with the process, and what they last said with it.
      this.tasks = [];
      this.taskCount = 0;
      this.wakeup = undefined;
      this.crons.clear();
      this.cronEnds.clear();
      this.progress.clear();
      this.taskTools.clear();
      this.agentNames.clear();
      this.flows.clear();
      this.activity = undefined;
      this.busy = false;
      this.startedAt = undefined;
      this.partial = [];
      this.completedBlocks = 0;
      clearTimeout(this.emitTimer);
      this.emitTimer = undefined;
      // A newer run may have taken the session's place already (an edited last prompt, a restart):
      // it speaks for the session, and this one says nothing more.
      if (!this.replaced()) {
        runs.delete(this.sessionId);
        // Pages show why it ended, if it did on an error, until they next ask and find no run;
        // otherwise they forget it now, as a page opened now finds no run.
        if (this.error) {
          this.emit();
        } else {
          feedFor(this.sessionId).broadcast({ type: 'run', sessionId: this.sessionId, state: null });
          this.sayStatus();
        }
        // What waited for the turn goes when it ends, also when Claude Code ended it by exiting: to the
        // session's Claude, resumed. Not when Pelican closed it (shutting down closes every one), nor
        // when it never started: that one would only fail again.
        if (leftover.length > 0 && !closedHere && this.began) void sendLeftovers(this.sessionId, this.cwd, this.settings, leftover);
      }
      this.finished = true;
      sessionsChanged();
    }
  }
}

const queuedPrompt = ({ uuid, text, attachments }: Prompt): QueuedPrompt => ({ uuid, text, ...(attachments.length > 0 ? { attachments } : {}) });

/**
 * Prompts queued for a turn whose Claude Code ended part way, sent to the session's Claude, resumed,
 * in order: the first starts a turn and the others wait for it, listed, as they waited before.
 */
async function sendLeftovers(sessionId: string, cwd: string, settings: RunSettings, prompts: Prompt[]): Promise<void> {
  for (const { uuid, text, attachments } of prompts) {
    try {
      await sendMessage({ sessionId, cwd }, { text, attachments, settings, uuid, mode: 'queue' });
    } catch (error) {
      console.warn(`[pelican] what was queued in ${sessionId.slice(0, 8)} could not be sent:`, (error as Error).message);
      return;
    }
  }
}

const runs = new Map<string, SessionRun>();

export function getRun(sessionId: string): SessionRun | undefined {
  const run = runs.get(sessionId);
  return run && !run.closed ? run : undefined;
}

/** A Claude running in this folder, to ask instead of starting another. */
export function runIn(cwd: string): SessionRun | undefined {
  for (const run of runs.values()) if (!run.closed && run.cwd === cwd) return run;
  return undefined;
}

/** Status of a session this app runs; undefined when it has no Claude process here. */
export function runStatus(sessionId: string): SessionStatus | undefined {
  if (config.demo) return demoRunStatus(sessionId);
  return getRun(sessionId)?.status();
}

/** Background work running in a session this app runs (see SessionRun.backgroundCount); 0 for none. */
export function runTasks(sessionId: string): number {
  if (config.demo) return demoRunTasks(sessionId);
  return getRun(sessionId)?.backgroundCount ?? 0;
}

export function runState(sessionId: string): RunState | undefined {
  if (config.demo) return demoRunState(sessionId);
  return getRun(sessionId)?.state();
}

/**
 * Whether another app (Claude Desktop, the terminal) has worked on the session since this
 * run's Claude last did. Its process then holds a conversation this one has not seen, and a
 * message sent to it would continue an old version, beside the other: it is started afresh.
 */
async function staleRun(run: SessionRun): Promise<boolean> {
  if (run.busy || run.hasBackgroundTasks) return false;
  const other = (await liveProcesses()).get(run.sessionId);
  if (other?.updatedAt && other.updatedAt > run.lastActive) return true;
  // An app that has closed since leaves no process to ask: a turn in the transcript newer than
  // anything this run did is the sign.
  const file = await transcriptPath(run.sessionId);
  const last = file ? (await lastTurnTime(file))?.lastTurn : undefined;
  return Boolean(last && !last.copied && last.time > run.lastActive + 2000);
}

/** The session's run, unless it holds an older version of the conversation: then it is closed. */
async function currentRun(sessionId: string): Promise<SessionRun | undefined> {
  const run = getRun(sessionId);
  if (run && (await staleRun(run))) {
    run.close();
    if (runs.get(sessionId) === run) runs.delete(sessionId);
    return getRun(sessionId);
  }
  // It may have closed while that was looked into (the idle close, an exit): then it is not current.
  return run?.closed ? getRun(sessionId) : run;
}

/** Sends to a run that is there; false when it closed before the message reached it, for the caller to resume the session. */
async function sentTo(run: SessionRun, input: SendInput): Promise<boolean> {
  try {
    await run.send(input);
    return true;
  } catch (error) {
    if (error instanceof RunClosed) return false;
    throw error;
  }
}

/**
 * Sends a message, starting (or resuming) the session's Claude process when
 * none is running. Without a session id a new session starts in `cwd`.
 */
export async function sendMessage(target: { sessionId?: string; cwd?: string; sideChat?: boolean }, input: SendInput): Promise<string> {
  if (config.demo) throw new Error('This is the demo: nothing runs. Start Pelican without --demo to talk to Claude.');
  if (CLEARS.test(input.text.trim())) throw new Error(AFRESH);
  if (target.sessionId) {
    const existing = await currentRun(target.sessionId);
    if (existing && (await sentTo(existing, input))) return existing.sessionId;
    const info = await sessionInfo(target.sessionId);
    const cwd = info?.cwd ?? target.cwd;
    if (!cwd || !(await isDirectory(cwd))) throw new Error(`The session's folder is missing: ${cwd ?? '(unknown)'}`);
    const launch = await launchFor(cwd);
    // A side chat goes on as one, whichever app made it and wherever it is continued from.
    const side = target.sideChat === true || (await isSideChat(target.sessionId));
    // Another request may have started one while this one looked the folder up.
    const started = getRun(target.sessionId);
    if (started && (await sentTo(started, input))) return started.sessionId;
    const run = new SessionRun(target.sessionId, cwd, input.settings, true, undefined, launch, side);
    runs.set(run.sessionId, run);
    run.start();
    await run.send(input);
    return run.sessionId;
  }
  const cwd = target.cwd;
  if (!cwd || !(await isDirectory(cwd))) throw new Error(`Not a folder: ${cwd ?? '(none)'}`);
  const run = new SessionRun(randomUUID(), cwd, input.settings, false, undefined, await launchFor(cwd));
  runs.set(run.sessionId, run);
  run.start();
  await run.send(input);
  return run.sessionId;
}

/**
 * Replaces the session's last turn: Claude resumes it up to `entry` (the row just before the
 * prompt being replaced) and gets `input` instead, in the same session, as rewinding does in
 * Claude Code. The old turn stays in the transcript, off the conversation's line.
 */
export async function replaceLastTurn(sessionId: string, cwd: string, entry: string, prompt: string, input: SendInput): Promise<string> {
  if (config.demo) throw new Error('This is the demo: nothing runs.');
  // Turned away before anything changes: the running Claude stays as it is.
  if (CLEARS.test(input.text.trim())) throw new Error(AFRESH);
  const launch = await launchFor(cwd);
  const side = await isSideChat(sessionId);
  const existing = getRun(sessionId);
  if (existing?.busy) throw new Error('Stop Claude before editing a prompt.');
  if (existing) {
    existing.close();
    runs.delete(sessionId);
  }
  const run = new SessionRun(sessionId, cwd, input.settings, true, { entry, dropsTurn: prompt }, launch, side);
  runs.set(sessionId, run);
  run.start();
  try {
    await run.send(input);
  } catch (error) {
    // This Claude resumed from before the last turn: left running, it would take the next message
    // and the last turn would drop out of the conversation. Without it, that message resumes it whole.
    run.close();
    if (runs.get(sessionId) === run) runs.delete(sessionId);
    throw error;
  }
  return sessionId;
}

/**
 * The session's Claude process, started (resumed, with no turn) when there is
 * none: for what only a running process can do, like rewinding files.
 */
export async function ensureRun(sessionId: string, settings: RunSettings = {}): Promise<SessionRun> {
  if (config.demo) throw new Error('This is the demo: nothing runs.');
  const existing = await currentRun(sessionId);
  if (existing) return existing;
  const info = await sessionInfo(sessionId);
  const cwd = info?.cwd;
  if (!cwd || !(await isDirectory(cwd))) throw new Error(`The session's folder is missing: ${cwd ?? '(unknown)'}`);
  const launch = await launchFor(cwd);
  const side = await isSideChat(sessionId);
  const started = getRun(sessionId);
  if (started) return started;
  const run = new SessionRun(sessionId, cwd, settings, true, undefined, launch, side);
  runs.set(sessionId, run);
  run.start();
  return run;
}

/**
 * Asks a side question about a session, as Claude Desktop's side chats do: the session so far is
 * copied (the Agent SDK's forkSession) under Desktop's title for one, and the copy's own Claude,
 * which only reads, answers there. The session itself, running or not, is not touched. A copy the
 * question could not be sent to is removed again, so nothing is left behind; one whose Claude
 * fails later stays, with the question, to be asked again.
 */
export async function startSideChat(sessionId: string, input: Omit<SendInput, 'attachments' | 'mode'>): Promise<string> {
  if (config.demo) throw new Error('This is the demo: nothing runs.');
  if (!input.text.trim()) throw new Error('Ask a question');
  if (SIDE_CHAT_COMMAND.test(input.text.trim())) throw new Error('A side chat takes questions, not / commands.');
  const side = await fork(sessionId, undefined, SIDE_CHAT_TITLE);
  try {
    await sendMessage({ sessionId: side, sideChat: true }, { ...input, attachments: [] });
  } catch (error) {
    getRun(side)?.close();
    await remove(side).catch(() => undefined);
    throw error;
  }
  return side;
}

/**
 * Closes Claude processes that have been idle for a while; the next message resumes them. Not
 * those with work that says nothing while it runs (a dev server, a watcher, a scheduled check):
 * Claude Code ends that work with the process, where the terminal and Desktop keep it going.
 */
export function closeIdle(now = Date.now()): void {
  for (const run of runs.values()) {
    if (!run.busy && run.status() === 'idle' && !run.hasBackgroundTasks && now - run.lastActive > config.idleCloseMs) run.close();
  }
}

setInterval(() => closeIdle(), 60_000).unref();

export function closeAll(): void {
  for (const run of runs.values()) run.close();
}

/** Whether Claude is in a turn in any session this app runs (working, or waiting for an answer). */
export function anyRunBusy(): boolean {
  for (const run of runs.values()) if (!run.closed && run.busy) return true;
  return false;
}
