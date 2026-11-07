import type {
  Account,
  Agent,
  Attachment,
  ChatMessage,
  Command,
  CommandAt,
  FileContent,
  GitStatus,
  LiveShell,
  McpServer,
  MessagesPage,
  ModelOption,
  PlanUsage,
  PermissionDecision,
  RecordedSettings,
  RewindCheck,
  RewindDone,
  RewindRestore,
  RunSettings,
  RunState,
  SavedOutputPage,
  SendMode,
  ServerInfo,
  SessionChanges,
  SessionSummary,
  TaskOutput,
  TreeEntry,
  UsageLimit,
  Workflow,
  WorkflowAgentPage,
} from '../../shared/protocol';
import { useSyncExternalStore } from 'react';

import type { DefaultChange, StartDefaults } from '../../shared/defaults';
import type { Todo } from '../../shared/tasks';
import type { NewTerminal, TerminalInfo, TerminalList, TerminalRunning } from '../../shared/terminal';
import type { SessionUsage, UsageRange, UsageSummary } from '../../shared/usage';
import { DemoRefusal, requestKey, STATIC_DEMO, staticRequest } from './static-demo';

/**
 * The app does not know the path it is served under (`/` on its own, or a
 * prefix a reverse proxy mounts it at), so every URL is resolved against the
 * folder of the current page.
 */
export const appBase = new URL('./', location.href);

export const apiUrl = (path: string) => new URL(`api/${path}`, appBase).toString();

/** Whether a file Claude sent can be had: still there, gone from where it was sent, or past what Pelican serves. */
export type SentState = 'there' | 'gone' | 'large';

/** status 0: the server could not be reached at all. `demo`: the demo's note in place of an action. */
/** What a folder nobody trusted brings, to ask about before Claude Code (or a terminal) starts in it: its items, the commands in them, and the files it shows part of. */
export type TrustQuestion = { brings: string[]; commands?: CommandAt[][]; more?: string[] };

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly signIn = false,
    /** Claude Code would start in a folder nobody trusted: what the folder brings, to ask about, the commands in it, and the files it shows part of. */
    readonly trust?: TrustQuestion,
    /** The demo saying what it does not do, not something going wrong. */
    readonly demo = false,
  ) {
    super(message);
  }
}

/** Starting in a folder nobody trusted: trust it, or run with the user's own settings only. */
export type TrustChoice = 'trusted' | 'user-only';

/** Whether an error is the demo saying what it does not do, rather than something going wrong. */
export const isDemoNote = (error: unknown): boolean => error instanceof ApiError && error.demo;

/** Whether an error only says the computer could not be reached (said once, by the offline line). */
export const isUnreachable = (error: unknown): boolean => error instanceof ApiError && error.status === 0;

/** The computer's name, from the server's info, for saying which one cannot be reached. */
let machineName: string | undefined;

/**
 * Whether the last request reached the server. A socket can drop while requests still work (a
 * proxy without WebSockets), and the other way round; the offline line tells the two apart.
 */
let reachable = true;
const reachListeners = new Set<() => void>();
function setReachable(value: boolean): void {
  if (reachable === value) return;
  reachable = value;
  for (const listener of reachListeners) listener();
}

/** Calls `listener` each time requests start or stop reaching the server. */
export function onReachable(listener: (reachable: boolean) => void): () => void {
  const call = () => listener(reachable);
  reachListeners.add(call);
  return () => reachListeners.delete(call);
}

export function useReachable(): boolean {
  return useSyncExternalStore(
    (listener) => {
      reachListeners.add(listener);
      return () => reachListeners.delete(listener);
    },
    () => reachable,
  );
}

/** fetch, with a dropped connection said in words ("Can’t reach laptop") instead of the browser's. */
async function reach(url: string, init: RequestInit): Promise<Response> {
  if (STATIC_DEMO) return fetch(url, init);
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    setReachable(false);
    throw new ApiError(`Can’t reach ${machineName || 'your computer'}`, 0);
  }
  // A proxy in front (an SSH tunnel, a reverse proxy) that cannot reach Pelican answers 502, 503 or
  // 504 with a page of its own; Pelican never answers so with JSON-less words. It is the computer out
  // of reach, said by the offline line as a dropped connection is, not "502 Bad Gateway".
  if ([502, 503, 504].includes(response.status) && !response.headers.get('content-type')?.includes('application/json')) {
    void response.body?.cancel().catch(() => undefined);
    setReachable(false);
    throw new ApiError(`Can’t reach ${machineName || 'your computer'}`, 0);
  }
  setReachable(true);
  return response;
}

/**
 * Answers given in the page instead of by the server: the demo's (lib/demo). `answer` takes every
 * request that would change something; `read` may answer a read itself; `adjust` sees each answer.
 */
export type LocalAnswers = {
  answer: (path: string, init: RequestInit) => Promise<unknown>;
  read: (path: string) => Promise<unknown> | undefined;
  adjust: (path: string, data: unknown) => unknown;
};
let local: LocalAnswers | undefined;
export function answerLocally(answers: LocalAnswers | undefined): void {
  local = answers;
}

/** Called when the server says the session cookie is missing or expired. */
let onSignedOut: () => void = () => {};
export function whenSignedOut(handler: () => void): void {
  onSignedOut = handler;
}

/** Every request says it comes from Pelican's page; the server refuses requests without it. */
const MARK = { 'X-Pelican': '1' };

/** The largest file the server takes (MAX_UPLOAD_BYTES). */
const MAX_UPLOAD = 25 * 1024 * 1024;

export type AuthMode = 'none' | 'password' | 'token';
export type AuthState = { required: boolean; mode: AuthMode; signedIn: boolean };

/**
 * What a folder brings, as the server says it: its items, the commands in each where it says where
 * they are, and the files of which it shows part.
 */
function trustIn(brings: unknown, commands: unknown, more: unknown): { brings: string[]; commands?: CommandAt[][]; more: string[] } {
  const items = Array.isArray(brings) ? brings.filter((b): b is string => typeof b === 'string') : [];
  const files = Array.isArray(more) ? more.filter((m): m is string => typeof m === 'string') : [];
  const at = (item: string, command: unknown) => Array.isArray(command) && command.length === 3 && Number.isInteger(command[0]) && Number.isInteger(command[1])
    && 0 <= command[0] && command[0] <= command[1] && command[1] <= item.length && (command[2] === 'shell' || command[2] === 'argv' || command[2] === 'powershell');
  const each = Array.isArray(brings) && items.length === brings.length && Array.isArray(commands) && commands.length === items.length
    && commands.every((list, i) => Array.isArray(list) && list.every((command) => at(items[i]!, command)));
  return each ? { brings: items, commands: commands as CommandAt[][], more: files } : { brings: items, more: files };
}

async function fromServer(path: string, init?: RequestInit): Promise<unknown> {
  if (STATIC_DEMO) return staticRequest(appBase, path, init);
  const response = await reach(apiUrl(path), {
    ...init,
    headers: { ...MARK, ...(typeof init?.body === 'string' ? { 'Content-Type': 'application/json' } : {}) },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; signIn?: boolean; needsTrust?: boolean; brings?: unknown; commands?: unknown; more?: unknown };
    if (body.signIn) onSignedOut();
    const trust = body.needsTrust ? trustIn(body.brings, body.commands, body.more) : undefined;
    throw new ApiError(body.error ?? `${response.status} ${response.statusText}`, response.status, Boolean(body.signIn), trust);
  }
  return response.json();
}

/**
 * Asks whether this browser is still signed in, as a socket closed for its sign-in
 * (SIGNED_OUT_CLOSE) has it wonder; when it is not, the app shows the sign-in.
 */
export function checkSignedIn(): void {
  if (STATIC_DEMO) return;
  void reach(apiUrl('auth'), { headers: { ...MARK } })
    .then((response) => (response.ok ? response.json() as Promise<AuthState> : undefined))
    .then((state) => {
      if (state?.required && !state.signedIn) onSignedOut();
    })
    .catch(() => undefined);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  try {
    if (local && init?.method && init.method !== 'GET') return (await local.answer(path, init)) as T;
    const data = (local && local.read(path)) || fromServer(path, init);
    return (local ? local.adjust(path, await data) : await data) as T;
  } catch (error) {
    if (error instanceof DemoRefusal) throw new ApiError(error.message, 403, false, undefined, true);
    throw error;
  }
}

const send = <T>(method: string, path: string, body?: unknown) =>
  request<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });

export type Project = { path: string; name: string; lastActivity: number; sessions: number };
export type DirListing = { path: string; parent?: string; dirs: Array<{ name: string; path: string }> };

export const api = {
  auth: () => request<AuthState>('auth'),
  login: (proof: { password: string } | { token: string }) => send<{ ok: boolean }>('POST', 'auth/login', proof),
  logout: () => send<{ ok: boolean }>('POST', 'auth/logout'),
  /** A one-time code that signs a phone in, good for two minutes (null when nobody signs in). */
  accessCode: () => send<{ code: string | null }>('POST', 'access/code').then((r) => r.code),
  /** The address a phone uses to reach this Pelican, when the server knows one (PELICAN_PUBLIC_URL, tailscale serve). */
  phoneAddress: () => request<{ url: string | null }>('access/phone').then((r) => r.url),
  info: () => request<ServerInfo>('info').then((info) => {
    machineName = info.machine;
    return info;
  }),
  /** Asks the server for nothing much, to learn whether it can be reached. */
  probe: () => request<ServerInfo>('info').then(() => true, () => false),
  sessions: () => request<{ sessions: SessionSummary[] }>('sessions').then((r) => r.sessions),
  session: (id: string) =>
    request<{ session: SessionSummary | null; run: RunState | null; tasks: Todo[]; settings: RecordedSettings }>(`sessions/${encodeURIComponent(id)}`),
  messages: (id: string, before?: number, limit = 120) =>
    request<MessagesPage>(
      `sessions/${encodeURIComponent(id)}/messages?limit=${limit}${before === undefined ? '' : `&before=${before}`}`,
    ),
  send: (id: string, body: { text: string; attachments: string[]; settings: RunSettings; uuid: string; mode?: SendMode; trust?: TrustChoice }) =>
    send<{ sessionId: string }>('POST', `sessions/${encodeURIComponent(id)}/messages`, body),
  create: (body: { cwd?: string; scratch?: boolean; text: string; attachments: string[]; settings: RunSettings; uuid: string; trust?: TrustChoice }) =>
    send<{ sessionId: string }>('POST', 'sessions', body),
  interrupt: (id: string) => send<{ ok: boolean }>('POST', `sessions/${encodeURIComponent(id)}/interrupt`),
  decide: (id: string, requestId: string, decision: PermissionDecision) =>
    send<{ ok: boolean }>('POST', `sessions/${encodeURIComponent(id)}/permissions/${encodeURIComponent(requestId)}`, decision),
  /** The composer's settings, applied to the session's running Claude at once. */
  applySettings: (id: string, settings: RunSettings) => send<{ ok: boolean }>('POST', `sessions/${encodeURIComponent(id)}/settings`, { settings }),
  setMode: (id: string, permissionMode: RunSettings['permissionMode']) =>
    send<{ ok: boolean }>('POST', `sessions/${encodeURIComponent(id)}/mode`, { permissionMode }),
  rename: (id: string, title: string) => send<{ ok: boolean }>('PATCH', `sessions/${encodeURIComponent(id)}`, { title }),
  /**
   * A side question about the session, as Claude Desktop asks one: a side chat is made from the
   * session so far, only reading, and the question goes there. Later ones go to it with `send`.
   */
  side: (id: string, body: { question: string; settings: RunSettings; uuid: string }) =>
    send<{ sessionId: string }>('POST', `sessions/${encodeURIComponent(id)}/side`, body),
  /** A copy of the session as its conversation reads (Fork); with `upTo`, it ends at that message (Fork from here, on a reply). */
  fork: (id: string, options: { upTo?: string; title?: string } = {}) =>
    send<{ sessionId: string | null }>('POST', `sessions/${encodeURIComponent(id)}/fork`, options).then((r) => r.sessionId),
  /**
   * Fork from here, on a prompt: a copy that ends just before it, and the prompt's words and files
   * for the new session's box. Before the first prompt there is nothing to copy: no session.
   */
  forkBefore: (id: string, before: string) =>
    send<{ sessionId: string | null; prompt: { text: string; attachments: Attachment[] } }>('POST', `sessions/${encodeURIComponent(id)}/fork`, { before }),
  remove: (id: string) => send<{ ok: boolean }>('DELETE', `sessions/${encodeURIComponent(id)}`),
  /** Put the session away from the list (true), unpinned, or bring it back (false); nothing else changes. */
  archive: (id: string, archived: boolean) => send<{ ok: boolean }>('POST', `sessions/${encodeURIComponent(id)}/archive`, { archived }),
  /** Keep the session at the top of the list (true) or let it go back (false); a pin brings an archived session back. */
  pin: (id: string, pinned: boolean) => send<{ ok: boolean }>('POST', `sessions/${encodeURIComponent(id)}/pin`, { pinned }),
  /** The session as Markdown, to save; on the site, the file its build saved from the demo. */
  exportUrl: (id: string) => (STATIC_DEMO
    ? new URL(`data/${requestKey(`sessions/${encodeURIComponent(id)}/export`)}.md`, appBase).toString()
    : apiUrl(`sessions/${encodeURIComponent(id)}/export`)),
  models: () => request<{ models: ModelOption[]; signedIn: boolean | null; account?: Account }>('models'),
  completions: (cwd: string) => request<{ commands: Command[]; agents: Agent[] }>(`commands?cwd=${encodeURIComponent(cwd)}`),
  /** Starts a `!` command; its output comes over the socket (lib/shells). `trust`: the answer for a folder nobody trusted. */
  shell: (id: string, command: string, trust?: TrustChoice) =>
    send<{ shell: LiveShell }>('POST', `sessions/${encodeURIComponent(id)}/shell`, { command, ...(trust ? { trust } : {}) }),
  stopShell: (id: string, shell: string) => send<{ ok: boolean }>('POST', `sessions/${encodeURIComponent(id)}/shell/${encodeURIComponent(shell)}/stop`),
  /** What Rewind to here can put back for the prompt `uuid`, by Claude Code's own check: its dialog's choices. */
  rewindCheck: (id: string, uuid: string) => send<RewindCheck>('POST', `sessions/${encodeURIComponent(id)}/rewind`, { uuid, dryRun: true }),
  /** Rewind to here: back to before the prompt `uuid`, the code, the conversation or both. */
  rewind: (id: string, uuid: string, restore: RewindRestore) => send<RewindDone>('POST', `sessions/${encodeURIComponent(id)}/rewind`, { uuid, restore }),
  /** Undo rewind: the messages come back, until the next message; the files stay as they are. */
  undoRewind: (id: string) => send<{ ok: boolean }>('POST', `sessions/${encodeURIComponent(id)}/rewind/undo`, {}),
  mcp: (id: string) => request<{ servers: McpServer[]; live: boolean }>(`sessions/${encodeURIComponent(id)}/mcp`),
  setMcp: (id: string, name: string, change: { enabled?: boolean; reconnect?: boolean }) =>
    send<{ servers: McpServer[] }>('POST', `sessions/${encodeURIComponent(id)}/mcp/${encodeURIComponent(name)}`, change),
  stopTask: (id: string, task: string) => send<{ ok: boolean }>('POST', `sessions/${encodeURIComponent(id)}/tasks/${encodeURIComponent(task)}/stop`),
  /** A page of an output Claude Code saved in place of one too long for the conversation (a long `!` command's), by its file's name. */
  savedOutput: (id: string, name: string, from = 0) =>
    request<SavedOutputPage>(`sessions/${encodeURIComponent(id)}/tool-results/${encodeURIComponent(name)}?from=${from}`),
  /** The end of what a background command printed. */
  taskOutput: (id: string, task: string) => request<TaskOutput>(`sessions/${encodeURIComponent(id)}/tasks/${encodeURIComponent(task)}/output`),
  /** Takes back a prompt waiting for the turn to end. */
  unqueue: (id: string, uuid: string) => send<{ ok: boolean }>('DELETE', `sessions/${encodeURIComponent(id)}/queued/${encodeURIComponent(uuid)}`),
  /** What a new session in `cwd` starts with, from Claude Code's settings, and whence (no folder: a scratch session, and Settings). */
  defaults: (cwd?: string) => request<StartDefaults>(`defaults${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`),
  /** Saves one change in Claude Code's user settings, as its /model, /effort, /fast or /config would; answers with the defaults for `cwd` now. */
  saveDefault: (change: DefaultChange, cwd?: string) => send<StartDefaults>('POST', 'defaults', { ...change, ...(cwd ? { cwd } : {}) }),
  /** The last messages of an Agent call's subagent's transcript, or those before message `before`. */
  subagent: (id: string, agent: string, before?: number) =>
    request<MessagesPage>(`sessions/${encodeURIComponent(id)}/agents/${encodeURIComponent(agent)}${before !== undefined ? `?before=${before}` : ''}`),
  /** A Workflow call's run, from the run's own files (or this Pelican's Claude, while it runs it). */
  workflow: (id: string, call: string) =>
    request<{ workflow: Workflow }>(`sessions/${encodeURIComponent(id)}/workflows/${encodeURIComponent(call)}`).then((r) => r.workflow),
  /**
   * The last messages of one workflow agent's transcript, or those before message `before`, or
   * those from message `after` on (what is new, for a page that has the rest).
   */
  workflowAgent: (id: string, call: string, agent: string, before?: number, after?: number) =>
    request<WorkflowAgentPage>(`sessions/${encodeURIComponent(id)}/workflows/${encodeURIComponent(call)}/agents/${encodeURIComponent(agent)}${
      before !== undefined ? `?before=${before}` : after !== undefined ? `?after=${after}` : ''}`),
  usage: () => request<{ limits: UsageLimit[] }>('usage').then((r) => r.limits),
  /** The plan's usage as Claude Code's /usage shows it, or null where plan limits do not apply. */
  planUsage: () => request<{ plan: PlanUsage | null }>('usage/plan').then((r) => r.plan),
  /** Usage and activity of every session on the computer, for a period: what is read so far, and how far reading got. */
  usageStats: (range: UsageRange) => request<{ summary: UsageSummary }>(`usage/stats?range=${range}`).then((r) => r.summary),
  /** One session's usage, for its menu (null: no transcript yet). */
  sessionUsage: (id: string) => request<{ usage: SessionUsage | null }>(`sessions/${encodeURIComponent(id)}/usage`).then((r) => r.usage),
  /** A file Claude sent in the session, to show: its text, or a picture as data. */
  sent: (id: string, path: string) => request<FileContent>(`sessions/${encodeURIComponent(id)}/sent?path=${encodeURIComponent(path)}`),
  /** The address of a file Claude sent in the session: a picture or a PDF as itself, or (`download`) to save. */
  sentUrl: (id: string, path: string, download = false) =>
    apiUrl(`sessions/${encodeURIComponent(id)}/sent/raw?path=${encodeURIComponent(path)}${download ? '&download=1' : ''}`),
  /**
   * Whether files Claude sent (one call's, at most 50) are still there to have, asked once for their
   * cards, before any tap: `gone` once one is not where Claude Code delivered it, `large` past what
   * Pelican serves. A file Claude did not send in the session is not in the answer. The site's demo
   * has every file it shows.
   */
  sentStates: async (id: string, paths: string[]): Promise<Map<string, SentState>> => {
    if (STATIC_DEMO) return new Map(paths.map((path) => [path, 'there']));
    const answer = await request<Record<SentState, string[]>>(`sessions/${encodeURIComponent(id)}/sent/state?${paths.map((path) => `p=${encodeURIComponent(path)}`).join('&')}`);
    return new Map((['there', 'gone', 'large'] as const).flatMap((state) => (answer[state] ?? []).map((path) => [path, state] as const)));
  },
  /** The folder's changes since the last commit, or (`base`) since its branch split from the default branch. */
  git: (cwd: string, scope?: 'base') => request<GitStatus>(`git?cwd=${encodeURIComponent(cwd)}${scope ? `&scope=${scope}` : ''}`),
  /** One file's diff; `from`, a renamed file's old path, so it shows what changed rather than a new file. */
  gitDiff: (cwd: string, path: string, scope?: 'base', from?: string) =>
    request<{ diff: string }>(`git/diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}${scope ? `&scope=${scope}` : ''}${from ? `&from=${encodeURIComponent(from)}` : ''}`).then((r) => r.diff),
  tree: (cwd: string, path: string) => request<{ entries: TreeEntry[] }>(`tree?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`).then((r) => r.entries),
  file: (cwd: string, path: string) => request<FileContent>(`file?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`),
  files: (cwd: string, q: string) =>
    request<{ files: string[] }>(`files?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(q)}`).then((r) => r.files),
  /** The lines of the folder's files that hold `q` (Claude Code's ripgrep, else a scan). */
  search: (cwd: string, q: string) =>
    request<{ engine: 'rg' | 'scan'; files: Array<{ path: string; lines: Array<{ n: number; text: string }> }>; truncated: boolean }>(`search?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(q)}`),
  /** Which of these paths (at most 50) are files in the folder. */
  exists: (cwd: string, paths: string[]) =>
    request<{ paths: string[] }>(`exists?cwd=${encodeURIComponent(cwd)}${paths.map((p) => `&p=${encodeURIComponent(p)}`).join('')}`).then((r) => r.paths),
  /** What each turn of a session changed (T1, T2…), from Claude Code's records of its edits. */
  changes: (id: string) => request<SessionChanges>(`sessions/${encodeURIComponent(id)}/changes`),
  /** One turn's diff of one file. */
  turnDiff: (id: string, turn: string, path: string) =>
    request<{ diff: string }>(`sessions/${encodeURIComponent(id)}/changes?turn=${encodeURIComponent(turn)}&path=${encodeURIComponent(path)}`).then((r) => r.diff),
  projects: () => request<{ projects: Project[] }>('projects').then((r) => r.projects),
  dirs: (path?: string) => request<DirListing>(`dirs${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  /** Makes a folder inside `parent` and says where it is. */
  makeDir: (parent: string, name: string) => send<{ path: string }>('POST', 'dirs', { parent, name }).then((r) => r.path),
  upload: async (file: File): Promise<Attachment> => {
    if (local || STATIC_DEMO) return request<Attachment>('uploads', { method: 'POST' });
    if (file.size > MAX_UPLOAD) throw new ApiError(`${file.name} is larger than 25 MB`, 413);
    const form = new FormData();
    form.append('file', file);
    const response = await reach(apiUrl('uploads'), { method: 'POST', body: form, headers: MARK });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(body.error ?? response.statusText, response.status);
    }
    return ((await response.json()) as { attachment: Attachment }).attachment;
  },
  /** Every terminal, and whether this Pelican runs any (the first ask loads the PTY). */
  terminals: () => request<TerminalList>('terminals'),
  /** A new terminal: the user's shell in a folder, at this size, with a command to run there or none. */
  openTerminal: (body: NewTerminal) => send<{ terminal: TerminalInfo }>('POST', 'terminals', body).then((r) => r.terminal),
  /** A terminal, and whether a program runs in it now, a job in the background too. */
  terminal: (id: string) => request<TerminalRunning>(`terminals/${encodeURIComponent(id)}`),
  /** Ends a terminal: its shell is hung up, as closing a window does. */
  closeTerminal: (id: string) => send<{ ok: boolean }>('DELETE', `terminals/${encodeURIComponent(id)}`),
  /** The address of a terminal's socket, at a size (relative to the page, as api/ws). */
  terminalSocket: (id: string, cols: number, rows: number) => {
    const url = new URL(`api/terminal?id=${encodeURIComponent(id)}&cols=${cols}&rows=${rows}`, appBase);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  },
  pushKey: () => request<{ key: string | null }>('push/key').then((r) => r.key),
  subscribePush: (subscription: PushSubscriptionJSON, openUrl: string) =>
    send<{ ok: boolean }>('POST', 'push/subscribe', { subscription, openUrl }),
  unsubscribePush: (endpoint: string) => send<{ ok: boolean }>('POST', 'push/unsubscribe', { endpoint }),
};

export type { ChatMessage };
