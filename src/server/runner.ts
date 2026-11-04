import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';

import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  CanUseTool,
  EffortLevel,
  Options,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

import type {
  Attachment,
  BackgroundTask,
  ChatMessage,
  McpServer,
  PartialBlock,
  PermissionDecision,
  PermissionRequest,
  RewindResult,
  RunSettings,
  RunState,
  SendMode,
  SessionStatus,
  ShellResult,
} from '../shared/protocol.js';
import { config } from './config.js';
import { DEMO_WAITING_SESSION, demoRunState } from './demo.js';
import { toMcpServers } from './models.js';
import { broadcastAll, feedFor, sessionsChanged } from './feed.js';
import { liveProcesses } from './live.js';
import { toChatMessage } from './normalize.js';
import { notify } from './push.js';
import { sessionInfo } from './sessions.js';
import { bashModeText } from './shell.js';
import { refreshTranscriptIndex } from './transcripts.js';
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

type Pending = {
  request: PermissionRequest;
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  resolve: (result: PermissionResult) => void;
};

export type SendInput = {
  text: string;
  attachments: Attachment[];
  settings: RunSettings;
  /** Id for the user message, so the client's optimistic copy matches the transcript row. */
  uuid?: string;
  /** While a turn runs: join it at Claude's next step, or wait for it to end. */
  mode?: SendMode;
};

const sdkModel = (model: string | undefined) => (model && model !== 'default' ? model : undefined);

/** One Claude Code process driving one session. It stays alive between turns until idle. */
/** Claude Code's error, or what it means for someone who edited their last prompt. */
function readableError(text: string): string {
  if (text.includes('Resume rejected by --resume-drops-turn')) {
    return 'The conversation changed after that prompt (another app added to it), so the prompt was not replaced. Reload, then edit it again or send a new message.';
  }
  return text;
}

export class SessionRun {
  busy = false;
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
  /** Set by Stop: the turn then ends with an error result that is not a failure. */
  private interrupted = false;
  private lastTurn?: RunState['lastTurn'];
  private context?: RunState['context'];
  private activity?: RunState['activity'];
  private tasks: BackgroundTask[] = [];

  get hasBackgroundTasks(): boolean {
    return this.tasks.length > 0;
  }
  /** Messages waiting for the turn to end, published when it does. */
  private queued: ChatMessage[] = [];
  private suggestion?: string;

  constructor(
    readonly sessionId: string,
    readonly cwd: string,
    private settings: RunSettings,
    private readonly resume: boolean,
    /** Resume only up to this entry, dropping the turn after it (an edited last prompt). */
    private readonly resumeAt?: { entry: string; dropsTurn: string },
  ) {}

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
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      tools: { type: 'preset', preset: 'claude_code' },
      canUseTool: this.canUseTool,
      ...(config.claudeExecutable ? { pathToClaudeCodeExecutable: config.claudeExecutable } : {}),
      stderr: (data) => {
        if (process.env.PELICAN_DEBUG) process.stderr.write(`[claude ${this.sessionId.slice(0, 8)}] ${data}`);
      },
    };
    this.q = query({ prompt: this.input, options });
    void this.pump();
    void sessionInfo(this.sessionId).then((info) => {
      if (info) this.title = info.customTitle || info.summary || '';
    });
  }

  state(): RunState {
    return {
      sessionId: this.sessionId,
      cwd: this.cwd,
      busy: this.busy,
      settings: this.settings,
      permissions: [...this.permissions.values()].map((p) => p.request),
      partial: this.partial.slice(this.completedBlocks).filter(Boolean),
      ...(this.error ? { error: this.error } : {}),
      ...(this.lastTurn ? { lastTurn: this.lastTurn } : {}),
      ...(this.context ? { context: this.context } : {}),
      ...(this.activity ? { activity: this.activity } : {}),
      ...(this.tasks.length > 0 ? { tasks: this.tasks } : {}),
      ...(this.queued.length > 0 ? { queued: this.queued.map((m) => m.uuid) } : {}),
      ...(this.suggestion && !this.busy ? { suggestion: this.suggestion } : {}),
    };
  }

  status(): SessionStatus {
    if (this.permissions.size > 0) return 'waiting';
    return this.busy ? 'running' : 'idle';
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

  private lastStatus?: SessionStatus;

  private emitNow(): void {
    const state = this.state();
    feedFor(this.sessionId).broadcast({ type: 'run', state });
    // Session lists only care about the status; streamed text stays with the session's viewers.
    const status = this.status();
    if (status !== this.lastStatus) {
      this.lastStatus = status;
      broadcastAll({ type: 'status', sessionId: this.sessionId, status });
    }
  }

  private setBusy(busy: boolean): void {
    if (this.busy === busy) return;
    this.busy = busy;
    this.lastActive = Date.now();
    if (!busy) {
      this.partial = [];
      this.completedBlocks = 0;
    }
    this.emit();
    sessionsChanged();
  }

  async send(input: SendInput): Promise<void> {
    await this.applySettings(input.settings);
    const uuid = input.uuid ?? randomUUID();
    const content: Array<Record<string, unknown>> = [];
    const fileLines: string[] = [];
    for (const attachment of input.attachments) {
      if (attachment.mime.startsWith('image/') && attachment.size <= 5 * 1024 * 1024) {
        const data = await readFile(attachment.path).catch(() => undefined);
        if (data) {
          content.push({ type: 'image', source: { type: 'base64', media_type: attachment.mime, data: data.toString('base64') } });
          continue;
        }
      }
      fileLines.push(`- ${attachment.path} (${attachment.name})`);
    }
    let text = input.text;
    if (fileLines.length > 0) text = `${text}${text ? '\n\n' : ''}Attached files:\n${fileLines.join('\n')}`;
    if (text) content.push({ type: 'text', text });
    // A running turn takes a new message at Claude's next step, unless it should wait for the turn to end.
    const queue = this.busy && input.mode === 'queue';
    const message = {
      type: 'user',
      uuid,
      session_id: this.sessionId,
      parent_tool_use_id: null,
      origin: { kind: 'human' },
      ...(this.busy ? { priority: queue ? 'later' : 'next' } : {}),
      message: { role: 'user', content },
    } as unknown as SDKUserMessage;
    this.error = undefined;
    this.suggestion = undefined;
    const chat = toChatMessage({ type: 'user', uuid, message: { role: 'user', content } });
    if (queue) {
      if (chat) this.queued.push({ ...chat, timestamp: Date.now() });
      this.emit();
    } else {
      this.setBusy(true);
      if (chat) await feedFor(this.sessionId).publish({ ...chat, timestamp: Date.now() });
    }
    this.input.push(message);
  }

  /**
   * Adds a `!` command and its output to the conversation without starting a
   * turn, the way Claude Code's bash mode does: Claude reads it with the next message.
   */
  async appendShell(result: ShellResult): Promise<void> {
    const uuid = randomUUID();
    const text = bashModeText(result);
    const message = {
      type: 'user',
      uuid,
      session_id: this.sessionId,
      parent_tool_use_id: null,
      origin: { kind: 'human' },
      shouldQuery: false,
      message: { role: 'user', content: text },
    } as unknown as SDKUserMessage;
    const chat = toChatMessage({ type: 'user', uuid, message: { role: 'user', content: text } });
    if (chat) await feedFor(this.sessionId).publish({ ...chat, timestamp: Date.now() });
    this.input.push(message);
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

  async stopTask(taskId: string): Promise<void> {
    await this.q?.stopTask(taskId);
  }

  async applySettings(next: RunSettings): Promise<void> {
    const q = this.q;
    if (!q) return;
    const prev = this.settings;
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
      if (next.permissionMode && next.permissionMode !== (prev.permissionMode ?? 'default')) await q.setPermissionMode(next.permissionMode);
    } catch (error) {
      console.warn('[pelican] could not apply settings', (error as Error).message);
    }
    this.settings = { ...prev, ...next };
  }

  async setPermissionMode(mode: RunSettings['permissionMode']): Promise<void> {
    await this.applySettings({ ...this.settings, permissionMode: mode });
    this.emit();
  }

  /** Settings changed in the composer, applied to Claude now: from its next step, also mid-turn. */
  async updateSettings(next: RunSettings): Promise<void> {
    await this.applySettings({ ...this.settings, ...next });
    this.emit();
  }

  private canUseTool: CanUseTool = (toolName, input, { signal, suggestions, blockedPath, decisionReason }) => {
    const id = randomUUID();
    const request: PermissionRequest = {
      id,
      sessionId: this.sessionId,
      toolName,
      input,
      canRemember: Boolean(suggestions && suggestions.length > 0),
      ...(decisionReason ? { reason: decisionReason } : {}),
      ...(blockedPath ? { blockedPath } : {}),
      createdAt: Date.now(),
    };
    return new Promise<PermissionResult>((resolve) => {
      this.permissions.set(id, { request, input, ...(suggestions ? { suggestions } : {}), resolve });
      signal.addEventListener('abort', () => {
        if (this.permissions.delete(id)) {
          resolve({ behavior: 'deny', message: 'Cancelled.' });
          this.emit();
          sessionsChanged();
        }
      });
      this.emit();
      sessionsChanged();
      const what = toolName === 'AskUserQuestion' ? 'has a question for you'
        : toolName === 'ExitPlanMode' ? 'has a plan for you to review'
          : `wants to use ${toolName}`;
      void notify({ title: this.title || 'Claude Code', body: `Claude ${what}`, sessionId: this.sessionId, tag: `${this.sessionId}:ask` });
    });
  };

  decide(id: string, decision: PermissionDecision): boolean {
    const pending = this.permissions.get(id);
    if (!pending) return false;
    this.permissions.delete(id);
    if (decision.behavior === 'allow') {
      pending.resolve({
        behavior: 'allow',
        updatedInput: decision.updatedInput ?? pending.input,
        ...(decision.remember && pending.suggestions ? { updatedPermissions: pending.suggestions } : {}),
      });
      if (decision.permissionMode) void this.setPermissionMode(decision.permissionMode);
    } else {
      pending.resolve({ behavior: 'deny', message: decision.message?.trim() || 'The user declined this.' });
    }
    this.emit();
    sessionsChanged();
    return true;
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
    for (const [id] of this.permissions) this.decide(id, { behavior: 'deny', message: 'Interrupted by the user.' });
    try {
      await this.q?.interrupt();
    } catch (error) {
      console.warn('[pelican] interrupt failed', (error as Error).message);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id] of this.permissions) this.decide(id, { behavior: 'deny', message: 'Session closed.' });
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
      const usage = await this.q?.getContextUsage();
      if (!usage) return;
      this.context = { percent: Math.round(usage.percentage), tokens: usage.totalTokens, max: usage.maxTokens };
      this.emit();
    } catch {
      // Older Claude Code; the header just shows no meter.
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

  private async pump(): Promise<void> {
    const q = this.q!;
    try {
      for await (const message of q as AsyncIterable<SDKMessage>) {
        this.lastActive = Date.now();
        const raw = message as unknown as Record<string, unknown>;
        switch (message.type) {
          case 'stream_event':
            if (!message.parent_tool_use_id) this.onStream(message.event as unknown as Record<string, unknown>);
            break;
          case 'assistant':
          case 'user': {
            if (raw.parent_tool_use_id) break;
            if (message.type === 'assistant') this.completedBlocks += 1;
            if (this.activity?.kind === 'retrying') this.activity = undefined;
            const chat = toChatMessage(raw);
            if (chat) await feedFor(this.sessionId).publish({ ...chat, timestamp: chat.timestamp ?? Date.now() } satisfies ChatMessage);
            this.emit(true);
            break;
          }
          case 'system':
            if (message.subtype === 'session_state_changed') {
              const state = (raw as { state?: string }).state;
              if (state === 'running' || state === 'requires_action') this.setBusy(true);
              else if (state === 'idle') this.setBusy(false);
            } else if (message.subtype === 'init') {
              void refreshTranscriptIndex().then(sessionsChanged);
            } else if (message.subtype === 'status') {
              this.activity = message.status === 'compacting' ? { kind: 'compacting' } : undefined;
              this.emit();
            } else if (message.subtype === 'api_retry') {
              this.activity = { kind: 'retrying', attempt: message.attempt, max: message.max_retries, delayMs: message.retry_delay_ms };
              this.emit();
            } else if (message.subtype === 'background_tasks_changed') {
              this.tasks = message.tasks
                .filter((t) => !t.ambient)
                .map((t) => ({ id: t.task_id, description: t.description, type: t.subagent_type ?? t.task_type }));
              this.emit();
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
            const failed = !stopped && (message.subtype !== 'success' || message.is_error);
            this.error = failed
              ? readableError('errors' in message && message.errors.length > 0 ? message.errors.join('\n') : ('result' in message ? String(message.result) : message.subtype))
              : undefined;
            this.lastTurn = {
              durationMs: message.duration_ms,
              ...(typeof message.total_cost_usd === 'number' ? { costUsd: message.total_cost_usd } : {}),
              ...(typeof message.usage?.output_tokens === 'number' ? { outputTokens: message.usage.output_tokens } : {}),
            };
            this.activity = undefined;
            // Messages that waited for this turn go in now: the next turn answers them.
            for (const waiting of this.queued.splice(0)) await feedFor(this.sessionId).publish(waiting);
            this.setBusy(false);
            this.emit();
            void this.readContext();
            if (!stopped) {
              void notify({
                title: this.title || 'Claude Code',
                body: failed ? `Stopped: ${this.error ?? 'error'}`.slice(0, 180) : 'Finished',
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
      this.error = readableError((error as Error).message);
      console.warn(`[pelican] session ${this.sessionId.slice(0, 8)} ended with an error:`, this.error);
    } finally {
      this.closed = true;
      for (const [, pending] of this.permissions) pending.resolve({ behavior: 'deny', message: 'Session closed.' });
      this.permissions.clear();
      this.setBusy(false);
      this.emit();
      // A newer run may have taken this session's place already (see sendMessage).
      if (runs.get(this.sessionId) === this) runs.delete(this.sessionId);
      sessionsChanged();
    }
  }
}

const runs = new Map<string, SessionRun>();

export function getRun(sessionId: string): SessionRun | undefined {
  const run = runs.get(sessionId);
  return run && !run.closed ? run : undefined;
}

/** Status of a session this app runs; undefined when it has no Claude process here. */
export function runStatus(sessionId: string): SessionStatus | undefined {
  if (config.demo) return sessionId === DEMO_WAITING_SESSION ? 'waiting' : undefined;
  return getRun(sessionId)?.status();
}

export function runState(sessionId: string): RunState | undefined {
  if (config.demo) return demoRunState(sessionId);
  return getRun(sessionId)?.state();
}

async function isDirectory(dir: string): Promise<boolean> {
  return stat(dir).then((s) => s.isDirectory(), () => false);
}

/**
 * Sends a message, starting (or resuming) the session's Claude process when
 * none is running. Without a session id a new session starts in `cwd`.
 */
/**
 * Whether another app (Claude Desktop, the terminal) has worked on the session since this
 * run's Claude last did. Its process then holds a conversation this one has not seen, and a
 * message sent to it would continue an old version, beside the other: it is started afresh.
 */
async function staleRun(run: SessionRun): Promise<boolean> {
  if (run.busy || run.hasBackgroundTasks) return false;
  const other = (await liveProcesses()).get(run.sessionId);
  return Boolean(other?.updatedAt && other.updatedAt > run.lastActive);
}

export async function sendMessage(target: { sessionId?: string; cwd?: string }, input: SendInput): Promise<string> {
  if (config.demo) throw new Error('This is the demo: nothing runs. Start Pelican without --demo to talk to Claude.');
  if (target.sessionId) {
    const existing = getRun(target.sessionId);
    if (existing && (await staleRun(existing))) {
      existing.close();
      runs.delete(existing.sessionId);
    } else if (existing) {
      await existing.send(input);
      return existing.sessionId;
    }
    const info = await sessionInfo(target.sessionId);
    const cwd = info?.cwd ?? target.cwd;
    if (!cwd || !(await isDirectory(cwd))) throw new Error(`The session's folder is missing: ${cwd ?? '(unknown)'}`);
    const run = new SessionRun(target.sessionId, cwd, input.settings, true);
    runs.set(run.sessionId, run);
    run.start();
    await run.send(input);
    return run.sessionId;
  }
  const cwd = target.cwd;
  if (!cwd || !(await isDirectory(cwd))) throw new Error(`Not a folder: ${cwd ?? '(none)'}`);
  const run = new SessionRun(randomUUID(), cwd, input.settings, false);
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
  const existing = getRun(sessionId);
  if (existing?.busy) throw new Error('Stop Claude before editing a prompt.');
  if (existing) {
    existing.close();
    runs.delete(sessionId);
  }
  const run = new SessionRun(sessionId, cwd, input.settings, true, { entry, dropsTurn: prompt });
  runs.set(sessionId, run);
  run.start();
  await run.send(input);
  return sessionId;
}

/**
 * The session's Claude process, started (resumed, with no turn) when there is
 * none: for what only a running process can do, like rewinding files.
 */
export async function ensureRun(sessionId: string, settings: RunSettings = {}): Promise<SessionRun> {
  if (config.demo) throw new Error('This is the demo: nothing runs.');
  const existing = getRun(sessionId);
  if (existing) return existing;
  const info = await sessionInfo(sessionId);
  const cwd = info?.cwd;
  if (!cwd || !(await isDirectory(cwd))) throw new Error(`The session's folder is missing: ${cwd ?? '(unknown)'}`);
  const run = new SessionRun(sessionId, cwd, settings, true);
  runs.set(sessionId, run);
  run.start();
  return run;
}

/** Closes Claude processes that have been idle for a while; the next message resumes them. */
setInterval(() => {
  for (const run of runs.values()) {
    if (!run.busy && run.status() === 'idle' && Date.now() - run.lastActive > config.idleCloseMs) run.close();
  }
}, 60_000).unref();

export function closeAll(): void {
  for (const run of runs.values()) run.close();
}
