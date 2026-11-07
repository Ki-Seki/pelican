import type { WebSocket } from 'ws';

/** Proxies close idle sockets (Cloudflare after 100 s); a ping this often keeps them open and finds dead ones. */
export const HEARTBEAT_MS = 25_000;

/**
 * Pings a socket every HEARTBEAT_MS, and drops it once it stops answering (a phone that changed
 * networks, a closed lid), instead of keeping it until TCP gives up. A ping waits behind what was
 * sent before it, though: a phone on a slow link still reading pictures is kept while its backlog
 * goes down. That shows only once a whole message has gone out, and one large message can take
 * longer than a heartbeat, so a backlog gets a second heartbeat. Pages cannot see pings, so `tick`
 * tells them, with each one, that the socket still works. Returns what stops it.
 */
export function heartbeat(ws: WebSocket, tick: () => void): () => void {
  let answered = true;
  /** What was still to send at the last heartbeat, and heartbeats since that last went down. */
  let backlog = 0;
  let stalled = 0;
  const pong = () => {
    answered = true;
  };
  ws.on('pong', pong);
  const timer = setInterval(() => {
    const left = ws.bufferedAmount;
    if (answered) {
      answered = false;
      backlog = left;
      stalled = 0;
      ws.ping();
      tick();
      return;
    }
    stalled = left < backlog ? 0 : stalled + 1;
    backlog = left;
    if (stalled > (left > 0 ? 1 : 0)) ws.terminate();
  }, HEARTBEAT_MS);
  return () => {
    clearInterval(timer);
    ws.off('pong', pong);
  };
}
