import type { IncomingMessage } from 'node:http';

import { serve } from '@hono/node-server';
import { WebSocketServer, type WebSocket } from 'ws';

import type { ClientEvent, ServerEvent } from '../shared/protocol.js';
import { app } from './app.js';
import { loadAuth, passwordSet, signedIn } from './auth.js';
import { config } from './config.js';
import { connect, subscribe } from './feed.js';
import { initPush } from './push.js';
import { closeAll, runState } from './runner.js';
import { hostAllowed, originAllowed } from './security.js';

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

    const wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req: IncomingMessage, socket, head) => {
      const pathname = new URL(req.url ?? '/', 'http://x').pathname;
      const forwarded = req.headers['x-forwarded-host'];
      const ok = pathname.endsWith('/api/ws')
        && (passwordSet() || hostAllowed(req.headers.host))
        && originAllowed(req.headers.origin, req.headers.host, Array.isArray(forwarded) ? forwarded[0] : forwarded)
        && signedIn(req.headers.cookie);
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
  });
  return { url };
}
