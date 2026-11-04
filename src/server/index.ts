import { readFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { WebSocketServer, type WebSocket } from 'ws';

import pkg from '../../package.json' with { type: 'json' };
import type {
  Attachment,
  ClientEvent,
  PermissionDecision,
  RunSettings,
  ServerEvent,
  ServerInfo,
} from '../shared/protocol.js';
import { config } from './config.js';
import { connect, subscribe } from './feed.js';
import { findUpload, listDirs, readUpload, saveUpload } from './files.js';
import { listModels } from './models.js';
import { addSubscription, initPush, pushKey, removeSubscription } from './push.js';
import { closeAll, getRun, runState, runStatus, sendMessage } from './runner.js';
import { listSummaries, loadPage, renameSessionTitle, sessionSummary } from './sessions.js';

/**
 * Requests that change something must come from this app's own page (or an
 * origin allowed in the config). Behind AI Server the front proxy checks the
 * origin as well; this keeps a stray page on another site from driving Claude.
 */
function originAllowed(origin: string | undefined, ...hosts: Array<string | undefined>): boolean {
  if (!origin) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (config.allowedOrigins.includes(url.origin)) return true;
  return hosts.flatMap((h) => (h ? h.split(',').map((s) => s.trim()) : [])).includes(url.host);
}

const app = new Hono();

app.use('/api/*', async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD'
    && !originAllowed(c.req.header('origin'), c.req.header('host'), c.req.header('x-forwarded-host'))) {
    return c.json({ error: 'Request from another site' }, 403);
  }
  await next();
});

app.onError((error, c) => {
  console.warn('[pelican]', c.req.method, c.req.path, error.message);
  return c.json({ error: error.message }, 500);
});

app.get('/api/info', (c) => {
  const info: ServerInfo = { machine: config.machine, home: config.home, version: pkg.version };
  const key = pushKey();
  if (key) info.pushKey = key;
  return c.json(info);
});

app.get('/api/sessions', async (c) => c.json({ sessions: await listSummaries(runStatus) }));

app.get('/api/sessions/:id', async (c) => {
  const id = c.req.param('id');
  const session = await sessionSummary(id, runStatus);
  const run = runState(id);
  if (!session && !run) return c.json({ error: 'No such session' }, 404);
  return c.json({ session: session ?? null, run: run ?? null });
});

app.get('/api/sessions/:id/messages', async (c) => {
  const before = c.req.query('before');
  const limit = Math.min(Number(c.req.query('limit') ?? 120) || 120, 500);
  return c.json(await loadPage(c.req.param('id'), before === undefined ? undefined : Number(before), limit));
});

type SendBody = { text?: string; attachments?: string[]; settings?: RunSettings; uuid?: string; cwd?: string };

async function attachmentsFrom(ids: string[] | undefined): Promise<Attachment[]> {
  const found = await Promise.all((ids ?? []).map((id) => findUpload(id)));
  return found.filter((a): a is Attachment => Boolean(a));
}

app.post('/api/sessions', async (c) => {
  const body = await c.req.json<SendBody>();
  const sessionId = await sendMessage({ cwd: body.cwd }, {
    text: body.text ?? '',
    attachments: await attachmentsFrom(body.attachments),
    settings: body.settings ?? {},
    ...(body.uuid ? { uuid: body.uuid } : {}),
  });
  return c.json({ sessionId });
});

app.post('/api/sessions/:id/messages', async (c) => {
  const body = await c.req.json<SendBody>();
  const sessionId = await sendMessage({ sessionId: c.req.param('id') }, {
    text: body.text ?? '',
    attachments: await attachmentsFrom(body.attachments),
    settings: body.settings ?? {},
    ...(body.uuid ? { uuid: body.uuid } : {}),
  });
  return c.json({ sessionId });
});

app.post('/api/sessions/:id/interrupt', async (c) => {
  await getRun(c.req.param('id'))?.interrupt();
  return c.json({ ok: true });
});

app.post('/api/sessions/:id/permissions/:requestId', async (c) => {
  const decision = await c.req.json<PermissionDecision>();
  const ok = getRun(c.req.param('id'))?.decide(c.req.param('requestId'), decision) ?? false;
  return ok ? c.json({ ok }) : c.json({ error: 'That request is no longer pending' }, 409);
});

app.post('/api/sessions/:id/mode', async (c) => {
  const { permissionMode } = await c.req.json<{ permissionMode: RunSettings['permissionMode'] }>();
  await getRun(c.req.param('id'))?.setPermissionMode(permissionMode);
  return c.json({ ok: true });
});

app.patch('/api/sessions/:id', async (c) => {
  const { title } = await c.req.json<{ title?: string }>();
  if (!title?.trim()) return c.json({ error: 'Title is empty' }, 400);
  await renameSessionTitle(c.req.param('id'), title.trim());
  return c.json({ ok: true });
});

app.get('/api/models', async (c) => c.json({ models: await listModels() }));

app.get('/api/projects', async (c) => {
  const seen = new Map<string, { path: string; name: string; lastActivity: number; sessions: number }>();
  for (const s of await listSummaries(runStatus)) {
    if (!s.cwd) continue;
    const entry = seen.get(s.cwd);
    if (entry) entry.sessions += 1;
    else seen.set(s.cwd, { path: s.cwd, name: s.project, lastActivity: s.lastActivity, sessions: 1 });
  }
  return c.json({ projects: [...seen.values()] });
});

app.get('/api/dirs', async (c) => {
  try {
    return c.json(await listDirs(c.req.query('path'), c.req.query('hidden') === '1'));
  } catch (error) {
    return c.json({ error: (error as Error).message }, 400);
  }
});

app.post('/api/uploads', async (c) => {
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) return c.json({ error: 'No file' }, 400);
  return c.json({ attachment: await saveUpload(file) });
});

app.get('/api/uploads/:id', async (c) => {
  const found = await readUpload(c.req.param('id'));
  if (!found) return c.notFound();
  return c.body(new Uint8Array(found.data), 200, {
    'Content-Type': found.attachment.mime,
    'Cache-Control': 'private, max-age=86400',
  });
});

app.get('/api/push/key', (c) => c.json({ key: pushKey() ?? null }));

app.post('/api/push/subscribe', async (c) => {
  const body = await c.req.json<{ subscription: { endpoint: string; keys: { p256dh: string; auth: string } }; openUrl?: string }>();
  await addSubscription({ ...body.subscription, ...(body.openUrl ? { openUrl: body.openUrl } : {}) });
  return c.json({ ok: true });
});

app.post('/api/push/unsubscribe', async (c) => {
  const { endpoint } = await c.req.json<{ endpoint: string }>();
  await removeSubscription(endpoint);
  return c.json({ ok: true });
});

app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.json': 'application/json', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

app.get('/*', async (c) => {
  if (!config.webDir) return c.text('The web app is not built. Run `npm run build`, or use `npm run dev`.', 503);
  const root = config.webDir;
  const requested = path.normalize(decodeURIComponent(new URL(c.req.url).pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = path.join(root, requested);
  if (!file.startsWith(root) || requested === '/' || !path.extname(file)) file = path.join(root, 'index.html');
  try {
    const data = await readFile(file);
    const ext = path.extname(file);
    const hashed = file.includes(`${path.sep}assets${path.sep}`);
    return c.body(new Uint8Array(data), 200, {
      'Content-Type': TYPES[ext] ?? 'application/octet-stream',
      'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
  } catch {
    return c.notFound();
  }
});

await initPush();

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`[pelican] ${config.machine}: http://${info.address}:${info.port}${config.webDir ? '' : ' (API only)'}`);
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req: IncomingMessage, socket, head) => {
  const pathname = new URL(req.url ?? '/', 'http://x').pathname;
  const forwarded = req.headers['x-forwarded-host'];
  if (!pathname.endsWith('/api/ws')
    || !originAllowed(req.headers.origin, req.headers.host, Array.isArray(forwarded) ? forwarded[0] : forwarded)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws: WebSocket) => {
  const send = (event: ServerEvent) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
  };
  const disconnect = connect(send);
  const subscriptions = new Map<string, () => void>();
  // Proxies (Cloudflare closes idle sockets after 100 s) see traffic every 25 s.
  const ping = setInterval(() => ws.ping(), 25_000);

  ws.on('message', (data) => {
    let event: ClientEvent;
    try {
      event = JSON.parse(String(data)) as ClientEvent;
    } catch {
      return;
    }
    if (event.type === 'subscribe' && !subscriptions.has(event.sessionId)) {
      subscriptions.set(event.sessionId, subscribe(event.sessionId, send));
      const state = runState(event.sessionId);
      if (state) send({ type: 'run', state });
    } else if (event.type === 'unsubscribe') {
      subscriptions.get(event.sessionId)?.();
      subscriptions.delete(event.sessionId);
    }
  });

  ws.on('close', () => {
    clearInterval(ping);
    disconnect();
    for (const unsubscribe of subscriptions.values()) unsubscribe();
  });
});

const shutdown = () => {
  closeAll();
  server.close();
  setTimeout(() => process.exit(0), 500).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
