import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

import { serve } from '@hono/node-server';
import { WebSocketServer, type WebSocket } from 'ws';

import type { ClientEvent, RunState, ServerEvent } from '../shared/protocol.js';
import { app } from './app.js';
import { loadAuth, signedIn } from './auth.js';
import { config } from './config.js';
import { connect, subscribe } from './feed.js';
import { keepDays, sweepUploads } from './files.js';
import { initPush } from './push.js';
import { closeAll, runState } from './runner.js';
import { hostAllowed, originAllowed } from './security.js';
import { RunChannel } from './stream.js';
import { watchWaiting } from './waiting.js';

const SESSION_ID = /^[\w-]{1,100}$/;
/** A browser follows a handful of sessions at once; more from one socket is not a browser. */
const MAX_SUBSCRIPTIONS = 64;
/** Proxies close idle sockets (Cloudflare after 100 s); a ping this often keeps them open and finds dead ones. */
const HEARTBEAT_MS = 25_000;
/**
 * Unsent bytes past which a socket gets no more run updates until it catches up (a phone on a slow
 * link): each update replaces the last, so only the newest is sent once the backlog is gone.
 */
const MAX_BUFFERED = 256 * 1024;
const DAY_MS = 24 * 3600_000;

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

  // Client events are a few hundred bytes; nothing bigger is read. What goes out is mostly JSON,
  // compressed: Tailscale Serve and SSH tunnels pass it on as it is.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: { threshold: 1024 } });

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
    const channels = new Map<string, RunChannel>();
    /** Sessions whose run updates were held back while the socket was full. */
    const behind = new Set<string>();
    let catchingUp: NodeJS.Timeout | undefined;

    const sendRun = (sessionId: string, state: RunState | null) => {
      const channel = channels.get(sessionId);
      if (!channel || ws.readyState !== ws.OPEN) return;
      if (ws.bufferedAmount > MAX_BUFFERED) {
        channel.reset();
        behind.add(sessionId);
        catchingUp ??= setInterval(() => {
          if (ws.readyState !== ws.OPEN || ws.bufferedAmount > MAX_BUFFERED / 2) return;
          clearInterval(catchingUp);
          catchingUp = undefined;
          for (const id of [...behind]) {
            behind.delete(id);
            sendRun(id, runState(id) ?? null);
          }
        }, 250);
        return;
      }
      const event = channel.next(state);
      if (event) send(event);
    };

    // A socket that does not answer a ping is gone (a phone that changed networks, a closed lid):
    // it is dropped with its subscriptions, instead of being polled for until TCP gives up. A ping
    // waits behind what was sent before it, though: a phone on a slow link still reading pictures
    // is kept while its backlog goes down. That shows only once a whole message has gone out, and
    // one large message can take longer than a heartbeat, so a backlog gets a second heartbeat.
    // Pages cannot see pings, so a tick tells them the socket still works.
    let answered = true;
    /** What was still to send at the last heartbeat, and heartbeats since that last went down. */
    let backlog = 0;
    let stalled = 0;
    ws.on('pong', () => {
      answered = true;
    });
    const heartbeat = setInterval(() => {
      const left = ws.bufferedAmount;
      if (answered) {
        answered = false;
        backlog = left;
        stalled = 0;
        ws.ping();
        send({ type: 'tick' });
        return;
      }
      stalled = left < backlog ? 0 : stalled + 1;
      backlog = left;
      if (stalled > (left > 0 ? 1 : 0)) ws.terminate();
    }, HEARTBEAT_MS);
    // A frame too large or malformed closes this socket; unheard, the error would stop the server.
    ws.on('error', () => ws.terminate());

    ws.on('message', (data) => {
      const event = clientEvent(String(data));
      if (!event) return;
      const id = event.sessionId;
      if (event.type === 'subscribe') {
        if (!subscriptions.has(id)) {
          if (subscriptions.size >= MAX_SUBSCRIPTIONS) return;
          channels.set(id, new RunChannel(id));
          subscriptions.set(id, subscribe(id, (update) => (update.type === 'run' ? sendRun(id, update.state) : send(update))));
        }
        // Every subscribe is answered with the run as it is now, or with none, also a repeated
        // one: a page that comes back after a while asks again and is set right, whatever it missed.
        channels.get(id)!.reset();
        sendRun(id, runState(id) ?? null);
      } else {
        subscriptions.get(id)?.();
        subscriptions.delete(id);
        channels.delete(id);
        behind.delete(id);
      }
    });

    ws.on('close', () => {
      clearInterval(heartbeat);
      clearInterval(catchingUp);
      disconnect();
      for (const unsubscribe of subscriptions.values()) unsubscribe();
    });
  });

  const stopWatching = watchWaiting();

  // Every attachment is saved for Claude to read; they go when Claude Code lets go of sessions.
  const sweep = () => void keepDays().then((days) => sweepUploads(days * DAY_MS)).catch(() => undefined);
  sweep();
  const sweeping = setInterval(sweep, DAY_MS);
  sweeping.unref();

  const shutdown = () => {
    closeAll();
    server.close();
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const close = async () => {
    stopWatching();
    clearInterval(sweeping);
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    for (const client of wss.clients) client.terminate();
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { url, close };
}
