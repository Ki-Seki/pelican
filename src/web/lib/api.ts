import type {
  Account,
  Agent,
  Attachment,
  ChatMessage,
  Command,
  FileContent,
  GitStatus,
  McpServer,
  MessagesPage,
  ModelOption,
  PermissionDecision,
  RecordedSettings,
  RewindResult,
  RunSettings,
  RunState,
  SendMode,
  ServerInfo,
  SessionSummary,
  ShellResult,
  TreeEntry,
  UsageLimit,
} from '../../shared/protocol';
import type { Todo } from '../../shared/tasks';
import { STATIC_DEMO, staticRequest } from './static-demo';

/**
 * The app does not know the path it is served under (`/` on its own, or a
 * prefix a reverse proxy mounts it at), so every URL is resolved against the
 * folder of the current page.
 */
export const appBase = new URL('./', location.href);

export const apiUrl = (path: string) => new URL(`api/${path}`, appBase).toString();

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly signIn = false) {
    super(message);
  }
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (STATIC_DEMO) {
    try {
      return (await staticRequest(appBase, path, init)) as T;
    } catch (error) {
      throw new ApiError((error as Error).message, 403);
    }
  }
  const response = await fetch(apiUrl(path), {
    ...init,
    headers: { ...MARK, ...(typeof init?.body === 'string' ? { 'Content-Type': 'application/json' } : {}) },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; signIn?: boolean };
    if (body.signIn) onSignedOut();
    throw new ApiError(body.error ?? `${response.status} ${response.statusText}`, response.status, Boolean(body.signIn));
  }
  return (await response.json()) as T;
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
  info: () => request<ServerInfo>('info'),
  sessions: () => request<{ sessions: SessionSummary[] }>('sessions').then((r) => r.sessions),
  session: (id: string) =>
    request<{ session: SessionSummary | null; run: RunState | null; tasks: Todo[]; settings: RecordedSettings }>(`sessions/${encodeURIComponent(id)}`),
  messages: (id: string, before?: number, limit = 120) =>
    request<MessagesPage>(
      `sessions/${encodeURIComponent(id)}/messages?limit=${limit}${before === undefined ? '' : `&before=${before}`}`,
    ),
  send: (id: string, body: { text: string; attachments: string[]; settings: RunSettings; uuid: string; mode?: SendMode }) =>
    send<{ sessionId: string }>('POST', `sessions/${encodeURIComponent(id)}/messages`, body),
  create: (body: { cwd?: string; scratch?: boolean; text: string; attachments: string[]; settings: RunSettings; uuid: string }) =>
    send<{ sessionId: string }>('POST', 'sessions', body),
  interrupt: (id: string) => send<{ ok: boolean }>('POST', `sessions/${encodeURIComponent(id)}/interrupt`),
  decide: (id: string, requestId: string, decision: PermissionDecision) =>
    send<{ ok: boolean }>('POST', `sessions/${encodeURIComponent(id)}/permissions/${encodeURIComponent(requestId)}`, decision),
  setMode: (id: string, permissionMode: RunSettings['permissionMode']) =>
    send<{ ok: boolean }>('POST', `sessions/${encodeURIComponent(id)}/mode`, { permissionMode }),
  rename: (id: string, title: string) => send<{ ok: boolean }>('PATCH', `sessions/${encodeURIComponent(id)}`, { title }),
  /**
   * Edit the prompt `before` and send it again: the last prompt in place (`inPlace`), an earlier
   * one on a branch made just before it (a new session for the first prompt). `uuid` is made once
   * per edit, so a retry gets the same result.
   */
  edit: (id: string, body: { before: string; text: string; settings: RunSettings; uuid: string; keepImages: number[] }) =>
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
  shell: (id: string, command: string) => send<ShellResult>('POST', `sessions/${encodeURIComponent(id)}/shell`, { command }),
  rewind: (id: string, uuid: string, dryRun: boolean) => send<RewindResult>('POST', `sessions/${encodeURIComponent(id)}/rewind`, { uuid, dryRun }),
  mcp: (id: string) => request<{ servers: McpServer[]; live: boolean }>(`sessions/${encodeURIComponent(id)}/mcp`),
  setMcp: (id: string, name: string, change: { enabled?: boolean; reconnect?: boolean }) =>
    send<{ servers: McpServer[] }>('POST', `sessions/${encodeURIComponent(id)}/mcp/${encodeURIComponent(name)}`, change),
  stopTask: (id: string, task: string) => send<{ ok: boolean }>('POST', `sessions/${encodeURIComponent(id)}/tasks/${encodeURIComponent(task)}/stop`),
  subagent: (id: string, agent: string) =>
    request<{ messages: ChatMessage[] }>(`sessions/${encodeURIComponent(id)}/agents/${encodeURIComponent(agent)}`).then((r) => r.messages),
  usage: () => request<{ limits: UsageLimit[] }>('usage').then((r) => r.limits),
  sent: (id: string, path: string) => request<FileContent>(`sessions/${encodeURIComponent(id)}/sent?path=${encodeURIComponent(path)}`),
  git: (cwd: string) => request<GitStatus>(`git?cwd=${encodeURIComponent(cwd)}`),
  gitDiff: (cwd: string, path: string) => request<{ diff: string }>(`git/diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`).then((r) => r.diff),
  tree: (cwd: string, path: string) => request<{ entries: TreeEntry[] }>(`tree?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`).then((r) => r.entries),
  file: (cwd: string, path: string) => request<FileContent>(`file?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`),
  files: (cwd: string, q: string) =>
    request<{ files: string[] }>(`files?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(q)}`).then((r) => r.files),
  projects: () => request<{ projects: Project[] }>('projects').then((r) => r.projects),
  dirs: (path?: string) => request<DirListing>(`dirs${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  upload: async (file: File): Promise<Attachment> => {
    if (STATIC_DEMO) throw new ApiError('This demo runs in your browser: nothing is uploaded.', 403);
    if (file.size > MAX_UPLOAD) throw new ApiError(`${file.name} is larger than 25 MB`, 413);
    const form = new FormData();
    form.append('file', file);
    const response = await fetch(apiUrl('uploads'), { method: 'POST', body: form, headers: MARK });
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
