// Types shared by the server and the web app: REST payloads and WebSocket events.

import type { PermissionMode } from './modes';

export type { PermissionMode } from './modes';

/** idle: nothing running · running: this app is running a turn · waiting: a turn waits for an
 *  approval or an answer (in another app when `runningIn` says so) · live: another client
 *  (Desktop, the terminal) is working on it, or wrote to it just now. */
export type SessionStatus = 'idle' | 'running' | 'waiting' | 'live';

export type SessionSummary = {
  id: string;
  title: string;
  cwd: string;
  /** Last path segment of `cwd`. */
  project: string;
  gitBranch?: string;
  /** Last user or assistant turn, ms since epoch (not the file's mtime). */
  lastActivity: number;
  createdAt?: number;
  status: SessionStatus;
  sizeBytes?: number;
  /** Started without a project, in a scratch folder (Claude Desktop's or ~/scratch). */
  scratch?: boolean;
  /** Runs inside the system temp directory: usually a run another session started. */
  temp?: boolean;
  /** A Claude Desktop side chat: a copy of this session (the id) with a question or two of its own. */
  sideChatOf?: string;
  /** Put away from the list in Pelican; the transcript is untouched. */
  archived?: boolean;
  /** Open (idle) in another app too, which does not see what is sent here until it reopens the session. */
  openIn?: string;
  /** The other app working on it right now, or waiting there for an answer: "the terminal", "Claude Desktop". */
  runningIn?: string;
  /** Start of Claude's latest reply. */
  preview?: string;
};

export type TextBlock = { type: 'text'; text: string; truncated?: boolean };
export type ThinkingBlock = { type: 'thinking'; thinking: string };
export type ImageBlock = {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string };
  omitted?: boolean;
};
export type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
export type ToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: string | Array<TextBlock | ImageBlock>;
  is_error?: boolean;
  truncated?: boolean;
  /** The call was refused before it ran (by the user, a rule or auto mode), as the transcript records it. */
  denied?: boolean;
};
export type Block = TextBlock | ThinkingBlock | ImageBlock | ToolUseBlock | ToolResultBlock;

export type ChatMessage = {
  uuid: string;
  role: 'user' | 'assistant' | 'system';
  blocks: Block[];
  /** ms since epoch, when the transcript records it. */
  timestamp?: number;
  /** Set on messages a subagent produced inside a tool call. */
  parentToolUseId?: string | null;
  model?: string;
  /** API message id; Claude Code writes one row per content block of the same API message. */
  messageId?: string;
  /** Injected context the user did not type (skill text, caveats); hidden by default. */
  meta?: boolean;
  /** The summary a compaction left in place of the earlier conversation. */
  compactSummary?: boolean;
  /** Local-only message shown before the transcript confirms it. */
  pending?: boolean;
  /** A local message that waits for the running turn to end. */
  queued?: boolean;
  /** Sent while Claude was working and read at its next step (Claude Code keeps it as a queued command). */
  steered?: boolean;
  /** The id the sending client gave this message, when the transcript row has its own. */
  sourceUuid?: string;
  /** Not Claude's reply: Claude Code's note that the API call failed (overloaded, too long, signed out). */
  apiError?: boolean;
};

export type MessagesPage = {
  messages: ChatMessage[];
  /** Messages in the whole conversation; `offset` is the index of the first returned one. */
  total: number;
  offset: number;
};

export type ModelOption = {
  value: string;
  label: string;
  description: string;
  efforts: string[];
  supportsFast: boolean;
  /** Whether the auto permission mode works with this model; unknown when absent. */
  supportsAuto?: boolean;
  resolvedModel?: string;
};

export type Command = { name: string; description: string; argumentHint: string };

export type RunSettings = {
  model?: string;
  effort?: string;
  fast?: boolean;
  /** Ultracode: standing workflow orchestration, on top of any effort level. */
  ultracode?: boolean;
  permissionMode?: PermissionMode;
};

export type Attachment = {
  id: string;
  name: string;
  mime: string;
  size: number;
  /** Absolute path on the machine, so Claude can read the file. */
  path: string;
};

export type PermissionRequest = {
  id: string;
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  /**
   * What allowing it from now on saves, in words, as Claude Code offers it ("Don't ask again for
   * npm test * in this project", "Allow all edits this session"). Absent when there is no such choice.
   */
  always?: string;
  /** Claude Code's own sentence for the request, and a line under it. */
  title?: string;
  description?: string;
  /** Open on Deny: this one must not be approved by a stray tap. */
  defaultToNo?: boolean;
  /** The subagent asking, when the request does not come from the main conversation. */
  agent?: string;
  /** For an MCP tool: the server's name as configured (someone else's text, shown as text). */
  server?: string;
  /** For a plan: the mode the session was in before planning, and whether auto mode can carry it out. */
  plan?: { before?: PermissionMode; auto: boolean };
  /** An MCP server asking for values (a form) or a step in the browser (a link), not a tool call. */
  elicitation?: { server: string; message: string; mode: 'form' | 'url'; url?: string; schema?: Record<string, unknown> };
  reason?: string;
  blockedPath?: string;
  createdAt: number;
};

export type PermissionDecision =
  | { behavior: 'allow'; remember?: boolean; updatedInput?: Record<string, unknown>; permissionMode?: PermissionMode }
  | { behavior: 'deny'; message?: string };

/** In-flight assistant output streamed before the complete message arrives. */
export type PartialBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; name: string; inputJson: string };

export type RunState = {
  sessionId: string;
  /** Folder the session runs in. */
  cwd: string;
  busy: boolean;
  /** When the running turn began, ms since epoch; present while busy. */
  startedAt?: number;
  settings: RunSettings;
  permissions: PermissionRequest[];
  partial: PartialBlock[];
  /** Error of the last turn, if it failed. */
  error?: string;
  /**
   * The last finished turn: how long it took and what it used. The cost is that turn's alone,
   * an estimate, and absent where it is not known or a subscription pays.
   */
  lastTurn?: { durationMs: number; costUsd?: number; outputTokens?: number };
  /** How full the context window is, when Claude Code reported it. */
  context?: { percent: number; tokens: number; max: number };
  /** What Claude is doing besides writing: condensing the conversation, or waiting to retry the API. */
  activity?: { kind: 'compacting' } | { kind: 'retrying'; attempt: number; max: number; delayMs: number };
  /** Commands and agents running in the background; each can be stopped. */
  tasks?: BackgroundTask[];
  /**
   * Prompts sent to wait for the turn to end, oldest first. They are not part of the conversation
   * until Claude gets them, all together, when the turn ends; until then each can be taken back.
   */
  queued?: QueuedPrompt[];
  /** Stop was asked for; the turn is ending. */
  stopping?: boolean;
  /** What a running subagent or background task last reported, by the id of the tool call that started it. */
  progress?: Record<string, TaskProgress>;
  /** Check-ins Claude scheduled in this session (/loop, reminders): Claude stays running here for them. */
  scheduled?: ScheduledCheck[];
  /** The permission mode changed without being picked here: said once, until the next message. */
  modeChanged?: PermissionMode;
  /** Claude Code's guess at what you will ask next, after a turn. */
  suggestion?: string;
};

export type QueuedPrompt = { uuid: string; text: string; attachments?: Attachment[] };

export type TaskProgress = {
  /** One line on what it is doing now (Claude Code's summary), else the tool it used last. */
  summary?: string;
  lastTool?: string;
  toolUses?: number;
  durationMs?: number;
};

export type ScheduledCheck = { id: string; what: string; next?: number; repeats: boolean };

/** `output`: a command or watcher whose output can be read while it runs; `summary`: what an agent says it is doing. */
export type BackgroundTask = { id: string; description: string; type: string; output?: boolean; summary?: string };

export type TaskOutput = { output: string; truncated: boolean };

/**
 * What a session last ran with, as its transcript records it: the model Claude Code asked for,
 * the effort, whether output was fast, whether ultracode was on, and the permission mode.
 */
export type RecordedSettings = { model?: string; effort?: string; fast?: boolean; ultracode?: boolean; permissionMode?: PermissionMode };

/** While Claude works, a new message joins the turn at Claude's next step (steer) or waits for the turn to end (queue). */
export type SendMode = 'steer' | 'queue';

/** A `!` command run in the session's folder; Claude sees it with the next message. */
export type ShellResult = {
  command: string;
  stdout: string;
  stderr: string;
  /** Exit code; null when it was stopped for taking too long. */
  code: number | null;
  durationMs: number;
  truncated?: boolean;
  /** It left a process running in the background (`npm run dev &`), which goes on after it. */
  background?: boolean;
};

/** One of the account's usage limits, as Claude Code last reported it. */
/** The plan's usage as claude.ai reports it (what `/usage` shows in Claude Code). */
export type PlanUsage = {
  /** Windows that fill up and reset: 5-hour, weekly, per model. Utilization 0–1 (above 1 once over). */
  windows: Array<{ type: string; label?: string; utilization: number; resetsAt?: number }>;
  /** Spending past the plan (Team and Enterprise set a monthly cap). Amounts in cents. */
  extra?: { enabled: boolean; usedCents?: number; limitCents?: number; utilization?: number; currency?: string };
};

export type UsageLimit = {
  type: string;
  status: 'allowed' | 'allowed_warning' | 'rejected';
  /** 0–1. */
  utilization?: number;
  /** ms since epoch. */
  resetsAt?: number;
  at: number;
};

export type Account = { email?: string; organization?: string; plan?: string };

export type GitFile = { path: string; status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted'; added?: number; removed?: number; from?: string };
export type GitStatus = { repo: false; untrusted?: boolean } | { repo: true; branch?: string; ahead?: number; behind?: number; files: GitFile[] };
export type TreeEntry = { name: string; path: string; dir: boolean; size?: number };
export type FileContent = { path: string; size: number; text?: string; binary?: boolean; truncated?: boolean; image?: string };
export type McpServer = { name: string; status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'; error?: string; tools: number; scope?: string };
export type RewindResult = { canRewind: boolean; error?: string; files?: string[]; insertions?: number; deletions?: number };
export type Agent = { name: string; description: string };

/** Text streamed into a run's partial block `index` since the last update: `text` goes at `from`. */
export type PartialAppend = { index: number; from: number; text: string };

export type ServerEvent =
  | { type: 'session'; session: SessionSummary }
  | { type: 'sessions_changed' }
  | { type: 'message'; sessionId: string; message: ChatMessage }
  | { type: 'run'; state: RunState; sessionId?: string }
  /** The answer to a subscribe when no Claude runs for the session here: the client clears what it had. */
  | { type: 'run'; sessionId: string; state: null }
  /**
   * While Claude writes, only what was added: applied to the run the client has when each `from` is
   * where its copy ends. A client whose copy does not match subscribes again and gets the whole run.
   */
  | { type: 'partial'; sessionId: string; appends: PartialAppend[] }
  /** A session's status changed; sent to every client, for session lists. */
  | { type: 'status'; sessionId: string; status: SessionStatus }
  | { type: 'reload'; sessionId: string }
  /** Every 25 s: pages cannot see pings, and a socket that has gone quiet is a dead one. */
  | { type: 'tick' };

export type ClientEvent =
  | { type: 'subscribe'; sessionId: string }
  | { type: 'unsubscribe'; sessionId: string };

export type ServerInfo = {
  machine: string;
  home: string;
  version: string;
  pushKey?: string;
  /** A password protects this server; the page can offer to sign out. */
  auth: boolean;
  demo: boolean;
  /**
   * The Claude Code this server runs: its version, and its path when it is not the one Pelican
   * brings; `newer`, the version of the user's own `claude` when that one is newer.
   */
  claudeCode?: { version?: string; path?: string; newer?: string };
};
