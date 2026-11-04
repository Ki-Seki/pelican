import type {
  Attachment,
  ChatMessage,
  MessagesPage,
  ModelOption,
  PermissionDecision,
  RunSettings,
  RunState,
  ServerInfo,
  SessionSummary,
} from '../../shared/protocol';

/**
 * The app does not know the path it is mounted under (`/_m/<machine>/pelican/`
 * behind AI Server, `/` on its own), so every URL is resolved against the
 * folder of the current page.
 */
export const appBase = new URL('./', location.href);

export const apiUrl = (path: string) => new URL(`api/${path}`, appBase).toString();

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...init,
    headers: init?.body && typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : undefined,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(body.error ?? `${response.status} ${response.statusText}`, response.status);
  }
  return (await response.json()) as T;
}

const send = <T>(method: string, path: string, body?: unknown) =>
  request<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });

export type Project = { path: string; name: string; lastActivity: number; sessions: number };
export type DirListing = { path: string; parent?: string; dirs: Array<{ name: string; path: string }> };

export const api = {
  info: () => request<ServerInfo>('info'),
  sessions: () => request<{ sessions: SessionSummary[] }>('sessions').then((r) => r.sessions),
  session: (id: string) =>
    request<{ session: SessionSummary | null; run: RunState | null }>(`sessions/${encodeURIComponent(id)}`),
  messages: (id: string, before?: number, limit = 120) =>
    request<MessagesPage>(
      `sessions/${encodeURIComponent(id)}/messages?limit=${limit}${before === undefined ? '' : `&before=${before}`}`,
    ),
  send: (id: string, body: { text: string; attachments: string[]; settings: RunSettings; uuid: string }) =>
    send<{ sessionId: string }>('POST', `sessions/${encodeURIComponent(id)}/messages`, body),
  create: (body: { cwd: string; text: string; attachments: string[]; settings: RunSettings; uuid: string }) =>
    send<{ sessionId: string }>('POST', 'sessions', body),
  interrupt: (id: string) => send<{ ok: boolean }>('POST', `sessions/${encodeURIComponent(id)}/interrupt`),
  decide: (id: string, requestId: string, decision: PermissionDecision) =>
    send<{ ok: boolean }>('POST', `sessions/${encodeURIComponent(id)}/permissions/${encodeURIComponent(requestId)}`, decision),
  setMode: (id: string, permissionMode: RunSettings['permissionMode']) =>
    send<{ ok: boolean }>('POST', `sessions/${encodeURIComponent(id)}/mode`, { permissionMode }),
  rename: (id: string, title: string) => send<{ ok: boolean }>('PATCH', `sessions/${encodeURIComponent(id)}`, { title }),
  models: () => request<{ models: ModelOption[] }>('models').then((r) => r.models),
  projects: () => request<{ projects: Project[] }>('projects').then((r) => r.projects),
  dirs: (path?: string) => request<DirListing>(`dirs${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  upload: async (file: File): Promise<Attachment> => {
    const form = new FormData();
    form.append('file', file);
    const response = await fetch(apiUrl('uploads'), { method: 'POST', body: form });
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
