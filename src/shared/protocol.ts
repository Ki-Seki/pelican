// Types shared by the server and the web app: REST payloads and WebSocket events.

import type { PermissionMode } from './modes';
import type { TerminalAvailability } from './terminal';

export type { PermissionMode } from './modes';

/** idle: nothing running · running: this app is running a turn · waiting: a turn waits for an
 *  approval or an answer (in another app when `runningIn` says so) · live: another client
 *  (Desktop, the terminal) is working on it, or wrote to it just now. */
export type SessionStatus = 'idle' | 'running' | 'waiting' | 'live';

/**
 * Where a command is in an item of what a folder brings (its trust sheet): from, to, and whether a
 * shell runs it, it is a program and its arguments, joined by spaces, or PowerShell runs it.
 */
export type CommandAt = [from: number, to: number, runs: 'shell' | 'argv' | 'powershell'];

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
  /**
   * A side chat's first question, in its words, as Pelican names the side chat; and the message
   * its own conversation starts at, after the copy of its session's. Neither before it asked one.
   */
  sideQuestion?: string;
  sideStart?: string;
  /** Put away from the list in Pelican; the transcript is untouched. */
  archived?: boolean;
  /**
   * Kept at the top of the list in Pelican: its own pins, apart from Claude Desktop's. Never
   * together with `archived`.
   */
  pinned?: boolean;
  /** Open (idle) in another app too, which does not see what is sent here until it reopens the session. */
  openIn?: string;
  /** The other app working on it right now, or waiting there for an answer: "the terminal", "Claude Desktop". */
  runningIn?: string;
  /** Start of Claude's latest reply. */
  preview?: string;
  /**
   * The latest turn ended on an error Claude Code noted in place of a reply, in a few words ("not
   * signed in"): the list shows that, not the error's text as Claude's reply.
   */
  stopped?: string;
  /**
   * Background tasks and subagents still running in a session this app runs, and the checks it
   * scheduled, which Claude stays running for. Between turns, the session is still at work.
   */
  tasks?: number;
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
  /** What a Workflow call launched, as Claude Code records it next to the result. */
  workflow?: WorkflowLaunch;
  /** What a SendUserFile call delivered, as Claude Code records it next to the result. */
  delivered?: Delivery;
  /** An Agent call that did not wait for its agent: how Claude Code records it began it, next to the result. */
  agent?: AgentLaunch;
};

/**
 * How an Agent call that does not wait for its agent began it: in the background on this computer
 * (`agentId`: its transcript, and its task while it runs), in a cloud session (`sessionUrl`), or
 * as a teammate (`name`). Claude Code's result for it is for the model alone.
 */
export type AgentLaunch = { mode: 'background' | 'cloud' | 'teammate'; agentId?: string; sessionUrl?: string; name?: string };

/** A subagent's final report, which Claude Code hands back to its session as a message of its own: which agent, and its words. */
export type Handback = { from: string; report: string };

/**
 * A file Claude sent you, as Claude Code recorded it delivered: its absolute path on the computer,
 * as Claude Code checked it, its size then, whether Claude Code took it for a picture, and its type.
 */
export type DeliveredFile = { path: string; size?: number; image?: boolean; type?: string };

/**
 * What one SendUserFile call delivered: the files, how Claude meant them shown (`render`: in
 * place; `attach`: as a file to save; unset: by their type), its caption, and how many files
 * Claude Code did not deliver (`missed`).
 */
export type Delivery = { files: DeliveredFile[]; display?: 'render' | 'attach'; caption?: string; missed?: number };

/** The run a Workflow call started: its run id (the folder its agents write to) and its task. */
export type WorkflowLaunch = {
  runId?: string;
  taskId?: string;
  /** meta.name and meta.description of the script. */
  name?: string;
  summary?: string;
  /** Launched in a cloud session instead (remote_launched): its address. */
  sessionUrl?: string;
  /** The copy of the script Claude Code kept for this run: its file name in the session's scripts folder. */
  scriptFile?: string;
};

/**
 * One agent of a workflow, as Claude Code reports it (a `workflow_agent` item of its progress).
 * `start`: queued (`queuedAt` without `startedAt`) or just started; `progress`: running.
 */
export type WorkflowAgent = {
  index: number;
  label: string;
  state: 'start' | 'progress' | 'done' | 'error';
  phaseIndex?: number;
  phaseTitle?: string;
  agentId?: string;
  agentType?: string;
  isolation?: 'worktree' | 'remote';
  model?: string;
  /** The model it ran on instead, when Claude Code fell back to another. */
  fallbackModel?: string;
  /** Its context at its latest response (input, cache and output), as Claude Code counts it. */
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
  error?: string;
  queuedAt?: number;
  startedAt?: number;
  lastProgressAt?: number;
  attempt?: number;
  lastAttemptReason?: 'stalled' | 'throttled' | 'user-retry';
  skipped?: boolean;
  blocked?: boolean;
  /** Its result came back from the run's journal (a resumed run) instead of running again. */
  cached?: boolean;
  lastToolName?: string;
  lastToolSummary?: string;
  resultPreview?: string;
  promptPreview?: string;
};

/** A phase of a workflow: from the script's `meta.phases` (with its detail), or one the run opened. */
export type WorkflowPhase = { title: string; detail?: string };

/**
 * Claude Code's statuses for a workflow run, and `stopped`: it ended with the Claude Code that ran
 * it, which left no word of its own about it.
 */
export type WorkflowStatus = 'running' | 'paused' | 'completed' | 'failed' | 'killed' | 'stopped';

/** A workflow run as a page shows it, from the SDK's events, Claude Code's record of it, or its journal. */
export type Workflow = {
  runId?: string;
  taskId?: string;
  name?: string;
  description?: string;
  status: WorkflowStatus;
  startedAt?: number;
  durationMs?: number;
  totalTokens?: number;
  totalToolCalls?: number;
  phases: WorkflowPhase[];
  agents: WorkflowAgent[];
  error?: string;
  /** What the script returned, as text (JSON for a value), cut to a size a page can take. */
  result?: string;
  /** The script, when the call itself does not hold it (a run of a script file). */
  script?: string;
  /** live: this Pelican runs it (Stop works); record: Claude Code's record of the ended run; journal: the run's folder. */
  source: 'live' | 'record' | 'journal';
};

/**
 * One page of a workflow agent's own transcript, with its prompt and what it returned.
 * `resultComing`: done by its run's word, its result not in the run's journal yet, where Claude
 * Code writes it just after; asked for again, it is there.
 */
export type WorkflowAgentPage = MessagesPage & { prompt?: string; result?: string; resultComing?: true };
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
  /**
   * The Claude Code that wrote a `!` command's output row. The row's shape changed in 2.1.80: since
   * then a command that went well always has something under stdout, so an empty one means it failed.
   */
  version?: string;
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
  /** Claude Code's code for that failure, when it gave one (`authentication_failed`, `overloaded`…). */
  error?: string;
  /** A subagent's report Claude Code handed back (meta: its card shows it, as the agent's result). */
  handback?: Handback;
};

export type MessagesPage = {
  messages: ChatMessage[];
  /** Messages in the whole conversation; `offset` is the index of the first returned one. */
  total: number;
  offset: number;
  /** On the newest page: the conversation was rewound here and ends before that prompt, until the next message. */
  rewound?: Rewound;
};

/**
 * Where a session's conversation was rewound (Rewind to here), until the next message: the prompt
 * it went back to before (out of the conversation, with all after it), and when. Undo rewind
 * brings them back until then.
 */
export type Rewound = { prompt: string; at: number };

/**
 * What Rewind to here puts back, Claude Desktop's three choices (the CLI's Restore code and
 * conversation, Restore conversation, Restore code): Code and conversation, Conversation only,
 * Code only.
 */
export type RewindRestore = 'both' | 'conversation' | 'code';

/** What Rewind to here can put back, asked before it does (its dialog's choices). */
export type RewindCheck = {
  /** The files putting the code back would change, by Claude Code's own check: none when none changed after the message. */
  files: string[];
  insertions: number;
  deletions: number;
  /**
   * Why the conversation cannot go back to before the message here, when it cannot (then only the
   * code can): the session is open in another app, it is the conversation's first message, or the
   * conversation was compacted after it.
   */
  conversationStays?: string;
};

/** What Rewind to here did. */
export type RewindDone = {
  /** The files that went back, and the lines that changed. */
  files?: string[];
  insertions?: number;
  deletions?: number;
  /** Files Claude Code left as they were: links, or files whose copy it could not read back safely. */
  skipped?: number;
  /** The conversation went back to before the message: its words and its files, for the message box. */
  prompt?: { text: string; attachments: Attachment[] };
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

/** A slash command Claude Code offers; `builtin`: Claude Code's own, not the user's, a project's, a plugin's or a server's. */
export type Command = { name: string; description: string; argumentHint: string; builtin?: boolean };

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
  /** Workflows Claude runs here, as Claude Code reports them, by the id of the Workflow call that started each. */
  workflows?: Record<string, Workflow>;
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

/**
 * `output`: a command or watcher whose output can be read while it runs; `summary`: what an agent
 * says it is doing, or how far a workflow's agents got; `toolUseId`: the call that started it, whose
 * card follows it; `type`: an agent's kind, or Claude Code's task type (`local_bash`, `local_workflow`).
 */
export type BackgroundTask = { id: string; description: string; type: string; output?: boolean; summary?: string; toolUseId?: string };

export type TaskOutput = { output: string; truncated: boolean };

/**
 * What a session last ran with, as its transcript records it: the model Claude Code asked for,
 * the effort, whether output was fast, whether ultracode was on, and the permission mode.
 */
export type RecordedSettings = { model?: string; effort?: string; fast?: boolean; ultracode?: boolean; permissionMode?: PermissionMode };

/** While Claude works, a new message joins the turn at Claude's next step (steer) or waits for the turn to end (queue). */
export type SendMode = 'steer' | 'queue';

/**
 * A page of an output Claude Code saved in a session's tool-results folder in place of one too
 * long for the conversation: `text` from `from` bytes in, `size` the file's in bytes, `next`
 * where the next page starts, while there is more.
 */
export type SavedOutputPage = { text: string; from: number; size: number; next?: number };

/**
 * A `!` command still running, as its output comes. Its record in the conversation has the same
 * id (the message holding the command), and replaces it once written.
 */
export type LiveShell = {
  id: string;
  command: string;
  startedAt: number;
  /** stdout and stderr together, as they came, up to a limit (`truncated` past it; it runs on). */
  output: string;
  truncated?: boolean;
  /** Stop was asked for; the command is ending. */
  stopping?: boolean;
  /** Done: its exit code (null: it did not finish on its own), and whether it waits for Claude's turn to end to go into the conversation. */
  done?: { code: number | null; waiting?: boolean };
  /** It could not be added to the conversation. */
  error?: string;
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

/** A file changed in a folder, as git says; `committed`: changed by commits alone, nothing of it waits to be committed. */
export type GitFile = { path: string; status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted'; added?: number; removed?: number; from?: string; committed?: true };

/** A file one turn changed, from Claude Code's record of its edits: relative to the session's folder when inside it, with each edit's lines added up, as /diff counts them. */
export type TurnFile = { path: string; added: number; removed: number; created?: boolean; /** Where its first change is, in the file as its first edit left it. */ line?: number };

/**
 * One prompt that led Claude to edit files, as Claude Code's /diff offers it: `n` its place among
 * the conversation's prompts, so a prompt that changed nothing leaves a gap (T1, T3…). `uuid` is
 * the prompt's own; `checkpoint`: Claude Code kept the files as they were before it, so Rewind
 * to here can put them back.
 */
export type TurnChanges = { uuid: string; n: number; text: string; at?: number; files: TurnFile[]; checkpoint: boolean };

/** What each turn changed; `lines`, for each edit's tool call, the line its change starts at. */
export type SessionChanges = { turns: TurnChanges[]; lines: Record<string, number> };
/**
 * A folder's changes, as git says. `upstream`: the branch it pushes to, when set; `base`: the
 * default branch All changes is compared with, by Claude Code's /diff ("vs main"), when there is
 * one; `split`: the branch has commits beyond where it split from `base`, so All changes holds
 * them as well as what is not committed; `remote`: the repository has a remote to push to;
 * `github`: origin is that repository on GitHub (`owner/name`). With all of the changes, also
 * `uncommitted`: how many files are not committed yet.
 */
export type GitStatus = { repo: false; untrusted?: boolean } | {
  repo: true; branch?: string; upstream?: string; base?: string; split?: boolean; remote?: boolean; github?: string; ahead?: number; behind?: number; uncommitted?: number; files: GitFile[];
};
/**
 * A pull request Claude named in Desktop's `<pr-created>` tag, as GitHub says it is now, read with
 * gh: its card's live status. `live: false` where gh cannot read it (not installed, not signed in).
 */
export type PrStatus = { live: false } | {
  live: true; number: number; title: string; state: 'open' | 'closed' | 'merged'; draft: boolean; head?: string; base?: string; checks?: 'passing' | 'failing' | 'running';
};
export type TreeEntry = { name: string; path: string; dir: boolean; size?: number };
export type FileContent = { path: string; size: number; text?: string; binary?: boolean; truncated?: boolean; image?: string };
export type McpServer = { name: string; status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'; error?: string; tools: number; scope?: string };
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
  /** A session's status, or how much background work it has (`tasks`), changed; sent to every client, for session lists. */
  | { type: 'status'; sessionId: string; status: SessionStatus; tasks?: number }
  | { type: 'reload'; sessionId: string }
  /** The conversation was rewound (Rewind to here), or no longer is (Undo rewind, the next message): what pages show of it now. */
  | { type: 'rewound'; sessionId: string; rewound: Rewound | null }
  /** The session's `!` commands still running, all of them: when one starts, stops or ends, and in answer to a subscribe. */
  | { type: 'shells'; sessionId: string; shells: LiveShell[] }
  /**
   * What a running `!` command printed since: `text` goes at `from` of its output. A page whose
   * copy does not end there subscribes again and gets the whole list.
   */
  | { type: 'shell_output'; sessionId: string; id: string; from: number; text: string }
  /** Every 25 s: pages cannot see pings, and a socket that has gone quiet is a dead one. */
  | { type: 'tick' };

export type ClientEvent =
  | { type: 'subscribe'; sessionId: string }
  | { type: 'unsubscribe'; sessionId: string };

/**
 * The close code of a socket (api/ws, or a terminal's) whose browser is no longer signed in: a
 * new token or password, or a cookie that expired. The server checks every second, with the
 * sign-in the socket opened with; the page asks whether it is still signed in, and shows the
 * sign-in when it is not.
 */
export const SIGNED_OUT_CLOSE = 4401;

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
  /** Whether this server runs terminals, and why not; GET /api/terminals says for sure. */
  terminal?: TerminalAvailability;
};
