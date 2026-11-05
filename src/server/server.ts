import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

import { serve } from '@hono/node-server';
import { WebSocketServer, type WebSocket } from 'ws';

import type { ClientEvent, ServerEvent } from '../shared/protocol.js';
import { app } from './app.js';
import { loadAuth, signedIn } from './auth.js';
import { config } from './config.js';
import { connect, subscribe } from './feed.js';
import { initPush } from './push.js';
import { closeAll, runState } from './runner.js';
import { hostAllowed, originAllowed } from './security.js';

const SESSION_ID = /^[\w-]{1,100}$/;
/** A browser follows a handful of sessions at once; more from one socket is not a browser. */
const MAX_SUBSCRIPTIONS = 64;

/** A client event, or undefined for anything else. */
function clientEvent(text: string): ClientEvent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const { type, sessionId } = value as Record<string, unknown>;
  if ((type !== 'subscribe' && type !== 'unsubscribe') || typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return undefined;
  return { type, sessionId };
}

let guarded = false;

/**
 * Work nobody waits for (a poll, a notification) must not take the server down when it fails:
 * Node would exit, and every turn Claude is running with it. It is said in the log instead.
 * A thrown exception stays fatal: state may be broken then.
 */
function guardRejections(): void {
  if (guarded) return;
  guarded = true;
  process.on('unhandledRejection', (error) => {
    console.warn('[pelican] unexpected error:', error instanceof Error ? (error.stack ?? error.message) : error);
  });
}

/** The path of a request target, without parsing it: a malformed target must not throw. */
const pathOf = (url: string | undefined) => (url ?? '/').split('?')[0] ?? '/';

/**
 * Starts the HTTP server and the WebSocket that streams sessions. Resolves once it listens.
 * Port 0 takes any free port; `url` says which.
 */
export async function startServer(): Promise<{ url: string; close: () => Promise<void> }> {
  guardRejections();
  await loadAuth();
  await initPush();

  // Client events are a few hundred bytes; nothing bigger is read.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  const { url, server } = await new Promise<{ url: string; server: ReturnType<typeof serve> }>((resolve, reject) => {
    const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info: AddressInfo) => {
      const host = info.family === 'IPv6' ? `[${info.address}]` : info.address;
      resolve({ url: `http://${host}:${info.port}/`, server });
    });
    server.on('error', reject);
  });

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    // A connection that breaks before the handshake ends here, not in an unheard 'error'.
    socket.on('error', () => socket.destroy());
    try {
      const forwarded = req.headers['x-forwarded-host'];
      // The same checks as every request: a known Host, a page of Pelican's own, a signed-in browser.
      const ok = pathOf(req.url).endsWith('/api/ws')
        && hostAllowed(req.headers.host)
        && originAllowed(req.headers.origin, req.headers.host, Array.isArray(forwarded) ? forwarded[0] : forwarded)
        && signedIn(req.headers.cookie, req.headers.authorization);
      if (!ok) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } catch {
      socket.destroy();
    }
  });

  wss.on('connection', (ws: WebSocket) => {
    const send = (event: ServerEvent) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
    };
    const disconnect = connect(send);
    const subscriptions = new Map<string, () => void>();
    // Proxies close idle sockets (Cloudflare after 100 s); a ping every 25 s keeps it open.
    const ping = setInterval(() => ws.ping(), 25_000);
    // A frame too large or malformed closes this socket; unheard, the error would stop the server.
    ws.on('error', () => ws.terminate());

    ws.on('message', (data) => {
      const event = clientEvent(String(data));
      if (!event) return;
      if (event.type === 'subscribe' && !subscriptions.has(event.sessionId)) {
        if (subscriptions.size >= MAX_SUBSCRIPTIONS) return;
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

  const close = async () => {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    for (const client of wss.clients) client.terminate();
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { url, close };
}
