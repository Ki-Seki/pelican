import type { IncomingMessage } from 'node:http';

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

/** Starts the HTTP server and the WebSocket that streams sessions. Resolves once it listens. */
export async function startServer(): Promise<{ url: string }> {
  await loadAuth();
  await initPush();

  const url = await new Promise<string>((resolve, reject) => {
    const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
      const host = info.family === 'IPv6' ? `[${info.address}]` : info.address;
      resolve(`http://${host}:${info.port}/`);
    });
    server.on('error', reject);

    // Client events are a few hundred bytes; nothing bigger is read.
    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

    server.on('upgrade', (req: IncomingMessage, socket, head) => {
      const pathname = new URL(req.url ?? '/', 'http://x').pathname;
      const forwarded = req.headers['x-forwarded-host'];
      // The same checks as every request: a known Host, a page of Pelican's own, a signed-in browser.
      const ok = pathname.endsWith('/api/ws')
        && hostAllowed(req.headers.host)
        && originAllowed(req.headers.origin, req.headers.host, Array.isArray(forwarded) ? forwarded[0] : forwarded)
        && signedIn(req.headers.cookie, req.headers.authorization);
      if (!ok) {
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
  });
  return { url };
}
