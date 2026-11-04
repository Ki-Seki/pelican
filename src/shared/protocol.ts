// Types shared by the server and the web app: REST payloads and WebSocket events.

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions';

/** idle: nothing running · running: this app is running a turn · waiting: a turn waits for an
 *  approval or an answer · live: another client (Desktop, the terminal) wrote to it just now. */
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
  /** Which Claude Code client is working on it right now, when that is not this app and is known. */
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
  /** Present when the CLI can remember the decision ("always allow"). */
  canRemember: boolean;
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
  settings: RunSettings;
  permissions: PermissionRequest[];
  partial: PartialBlock[];
  /** Error of the last turn, if it failed. */
  error?: string;
  /** The last finished turn: how long it took and what it used. */
  lastTurn?: { durationMs: number; costUsd?: number; outputTokens?: number };
  /** How full the context window is, when Claude Code reported it. */
  context?: { percent: number; tokens: number; max: number };
  /** What Claude is doing besides writing: condensing the conversation, or waiting to retry the API. */
  activity?: { kind: 'compacting' } | { kind: 'retrying'; attempt: number; max: number; delayMs: number };
  /** Commands and agents running in the background; each can be stopped. */
  tasks?: BackgroundTask[];
  /** Messages sent to run after the current turn, oldest first. */
  queued?: string[];
  /** Claude Code's guess at what you will ask next, after a turn. */
  suggestion?: string;
};

export type BackgroundTask = { id: string; description: string; type: string };

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
};

/** One of the account's usage limits, as Claude Code last reported it. */
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
export type GitStatus = { repo: false } | { repo: true; branch?: string; ahead?: number; behind?: number; files: GitFile[] };
export type TreeEntry = { name: string; path: string; dir: boolean; size?: number };
export type FileContent = { path: string; size: number; text?: string; binary?: boolean; truncated?: boolean; image?: string };
export type McpServer = { name: string; status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'; error?: string; tools: number; scope?: string };
export type RewindResult = { canRewind: boolean; error?: string; files?: string[]; insertions?: number; deletions?: number };
export type Agent = { name: string; description: string };

export type ServerEvent =
  | { type: 'session'; session: SessionSummary }
  | { type: 'sessions_changed' }
  | { type: 'message'; sessionId: string; message: ChatMessage }
  | { type: 'run'; state: RunState }
  /** A session's status changed; sent to every client, for session lists. */
  | { type: 'status'; sessionId: string; status: SessionStatus }
  | { type: 'reload'; sessionId: string };

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
};
