import type {
  Account,
  Agent,
  Attachment,
  ChatMessage,
  Command,
  FileContent,
  GitStatus,
  LiveShell,
  McpServer,
  MessagesPage,
  ModelOption,
  PlanUsage,
  PermissionDecision,
  PermissionMode,
  RecordedSettings,
  RewindResult,
  RunSettings,
  RunState,
  SendMode,
  ServerInfo,
  SessionSummary,
  TaskOutput,
  TreeEntry,
  UsageLimit,
} from '../../shared/protocol';
import { useSyncExternalStore } from 'react';

import type { Todo } from '../../shared/tasks';
import { DemoRefusal, STATIC_DEMO, staticRequest } from './static-demo';

/**
 * The app does not know the path it is served under (`/` on its own, or a
 * prefix a reverse proxy mounts it at), so every URL is resolved against the
 * folder of the current page.
 */
export const appBase = new URL('./', location.href);

export const apiUrl = (path: string) => new URL(`api/${path}`, appBase).toString();

/** status 0: the server could not be reached at all. `demo`: the demo's note in place of an action. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly signIn = false,
    /** Claude Code would start in a folder nobody trusted: what the folder brings, to ask about. */
    readonly trust?: { brings: string[] },
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

async function fromServer(path: string, init?: RequestInit): Promise<unknown> {
  if (STATIC_DEMO) return staticRequest(appBase, path, init);
  const response = await reach(apiUrl(path), {
    ...init,
    headers: { ...MARK, ...(typeof init?.body === 'string' ? { 'Content-Type': 'application/json' } : {}) },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; signIn?: boolean; needsTrust?: boolean; brings?: unknown };
    if (body.signIn) onSignedOut();
    const trust = body.needsTrust ? { brings: Array.isArray(body.brings) ? body.brings.filter((b): b is string => typeof b === 'string') : [] } : undefined;
    throw new ApiError(body.error ?? `${response.status} ${response.statusText}`, response.status, Boolean(body.signIn), trust);
  }
  return response.json();
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
   * Edit the prompt `before` and send it again: the last prompt in place (`inPlace`), an earlier
   * one on a branch made just before it (a new session for the first prompt). `uuid` is made once
   * per edit, so a retry gets the same result. `startMode`: the mode Settings picked for new
   * sessions, for a branch of a session in Bypass, which never starts in it.
   */
  edit: (id: string, body: { before: string; text: string; settings: RunSettings; uuid: string; keepImages: number[]; startMode?: PermissionMode }) =>
    send<{ sessionId: string; inPlace: boolean }>('POST', `sessions/${encodeURIComponent(id)}/edit`, body),
  /** A copy of the session; with `before`, the copy stops just before that message (null: it was the first). */
  fork: (id: string, options: { before?: string; title?: string } = {}) =>
    send<{ sessionId: string | null }>('POST', `sessions/${encodeURIComponent(id)}/fork`, options).then((r) => r.sessionId),
  remove: (id: string) => send<{ ok: boolean }>('DELETE', `sessions/${encodeURIComponent(id)}`),
  /** Put the session away from the list (true) or bring it back (false); nothing else changes. */
  archive: (id: string, archived: boolean) => send<{ ok: boolean }>('POST', `sessions/${encodeURIComponent(id)}/archive`, { archived }),
  exportUrl: (id: string) => apiUrl(`sessions/${encodeURIComponent(id)}/export`),
  models: () => request<{ models: ModelOption[]; signedIn: boolean | null; account?: Account }>('models'),
  completions: (cwd: string) => request<{ commands: Command[]; agents: Agent[] }>(`commands?cwd=${encodeURIComponent(cwd)}`),
  /** Starts a `!` command; its output comes over the socket (lib/shells). `trust`: the answer for a folder nobody trusted. */
  shell: (id: string, command: string, trust?: TrustChoice) =>
    send<{ shell: LiveShell }>('POST', `sessions/${encodeURIComponent(id)}/shell`, { command, ...(trust ? { trust } : {}) }),
  stopShell: (id: string, shell: string) => send<{ ok: boolean }>('POST', `sessions/${encodeURIComponent(id)}/shell/${encodeURIComponent(shell)}/stop`),
  rewind: (id: string, uuid: string, dryRun: boolean) => send<RewindResult>('POST', `sessions/${encodeURIComponent(id)}/rewind`, { uuid, dryRun }),
  mcp: (id: string) => request<{ servers: McpServer[]; live: boolean }>(`sessions/${encodeURIComponent(id)}/mcp`),
  setMcp: (id: string, name: string, change: { enabled?: boolean; reconnect?: boolean }) =>
    send<{ servers: McpServer[] }>('POST', `sessions/${encodeURIComponent(id)}/mcp/${encodeURIComponent(name)}`, change),
  stopTask: (id: string, task: string) => send<{ ok: boolean }>('POST', `sessions/${encodeURIComponent(id)}/tasks/${encodeURIComponent(task)}/stop`),
  /** The end of what a background command printed. */
  taskOutput: (id: string, task: string) => request<TaskOutput>(`sessions/${encodeURIComponent(id)}/tasks/${encodeURIComponent(task)}/output`),
  /** Takes back a prompt waiting for the turn to end. */
  unqueue: (id: string, uuid: string) => send<{ ok: boolean }>('DELETE', `sessions/${encodeURIComponent(id)}/queued/${encodeURIComponent(uuid)}`),
  /** The mode a new session starts in, from Claude Code's settings (no folder: a scratch session). */
  defaults: (cwd?: string) => request<{ permissionMode: PermissionMode | null }>(`defaults${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`),
  subagent: (id: string, agent: string) =>
    request<{ messages: ChatMessage[] }>(`sessions/${encodeURIComponent(id)}/agents/${encodeURIComponent(agent)}`).then((r) => r.messages),
  usage: () => request<{ limits: UsageLimit[] }>('usage').then((r) => r.limits),
  /** The plan's usage as Claude Code's /usage shows it, or null where plan limits do not apply. */
  planUsage: () => request<{ plan: PlanUsage | null }>('usage/plan').then((r) => r.plan),
  sent: (id: string, path: string) => request<FileContent>(`sessions/${encodeURIComponent(id)}/sent?path=${encodeURIComponent(path)}`),
  git: (cwd: string) => request<GitStatus>(`git?cwd=${encodeURIComponent(cwd)}`),
  gitDiff: (cwd: string, path: string) => request<{ diff: string }>(`git/diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`).then((r) => r.diff),
  tree: (cwd: string, path: string) => request<{ entries: TreeEntry[] }>(`tree?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`).then((r) => r.entries),
  file: (cwd: string, path: string) => request<FileContent>(`file?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`),
  files: (cwd: string, q: string) =>
    request<{ files: string[] }>(`files?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(q)}`).then((r) => r.files),
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
  pushKey: () => request<{ key: string | null }>('push/key').then((r) => r.key),
  subscribePush: (subscription: PushSubscriptionJSON, openUrl: string) =>
    send<{ ok: boolean }>('POST', 'push/subscribe', { subscription, openUrl }),
  unsubscribePush: (endpoint: string) => send<{ ok: boolean }>('POST', 'push/unsubscribe', { endpoint }),
};

export type { ChatMessage };
