import type { ClientEvent, ServerEvent } from '../../shared/protocol';
import { appBase } from './api';
import { STATIC_DEMO } from './static-demo';

type Listener = (event: ServerEvent) => void;

/** The server sends something at least every 25 s; a socket quiet for longer than this is dead, whatever it says. */
const QUIET_MS = 60_000;
/** Back on screen after this long without a word: start afresh rather than trust a socket that slept. */
const QUIET_ON_RETURN_MS = 30_000;

/**
 * One WebSocket for the whole app. It reconnects with backoff, right away
 * when the page becomes visible again (phones drop sockets of background
 * tabs), and re-subscribes to the sessions in view. Browsers often keep a
 * socket open after the network under it went away, so one that has gone
 * quiet is replaced too.
 */
class Socket {
  private ws?: WebSocket;
  private retry = 0;
  private timer?: number;
  private lastHeard = 0;
  private readonly sessions = new Set<string>();
  private readonly listeners = new Set<Listener>();
  private readonly connectionListeners = new Set<(connected: boolean) => void>();
  private readonly resyncListeners = new Set<() => void>();
  connected = false;

  start(): void {
    // The demo on the project site has no server: nothing to connect to, nothing to wait for.
    if (STATIC_DEMO) {
      this.connected = true;
      return;
    }
    this.connect();
    const comeBack = () => {
      if (!this.connected || Date.now() - this.lastHeard > QUIET_ON_RETURN_MS) this.reconnect();
      else this.resync();
    };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') comeBack();
    });
    window.addEventListener('online', comeBack);
    window.setInterval(() => {
      if (this.connected && Date.now() - this.lastHeard > QUIET_MS) this.reconnect();
    }, 10_000);
  }

  /** Connects again now, e.g. after signing in, instead of waiting out the backoff. */
  reconnect(): void {
    this.retry = 0;
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      const old = this.ws;
      this.ws = undefined;
      old.close();
    }
    this.setConnected(false);
    this.connect();
  }

  private connect(): void {
    clearTimeout(this.timer);
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    const url = new URL('api/ws', appBase);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.retry = 0;
      this.lastHeard = Date.now();
      this.setConnected(true);
      this.resync();
    };
    ws.onmessage = (message) => {
      if (this.ws !== ws) return;
      this.lastHeard = Date.now();
      let event: ServerEvent;
      try {
        event = JSON.parse(String(message.data)) as ServerEvent;
      } catch {
        return;
      }
      if (event.type === 'tick') return;
      for (const listener of this.listeners) listener(event);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.setConnected(false);
      const delay = Math.min(1000 * 2 ** this.retry, 15_000);
      this.retry += 1;
      this.timer = window.setTimeout(() => this.connect(), delay);
    };
  }

  private setConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    for (const listener of this.connectionListeners) listener(connected);
  }

  private write(event: ClientEvent): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(event));
  }

  /**
   * Asks again for every session in view: the server answers each with its run as it is now (or
   * none), and the page catches up on messages it may have missed.
   */
  private resync(): void {
    for (const sessionId of this.sessions) this.write({ type: 'subscribe', sessionId });
    for (const listener of this.resyncListeners) listener();
  }

  subscribe(sessionId: string): void {
    if (this.sessions.has(sessionId)) return;
    this.sessions.add(sessionId);
    this.write({ type: 'subscribe', sessionId });
  }

  /** Asks for a session's run again, whole: the page's copy no longer matches what streams in. */
  refresh(sessionId: string): void {
    if (this.sessions.has(sessionId)) this.write({ type: 'subscribe', sessionId });
  }

  unsubscribe(sessionId: string): void {
    if (!this.sessions.delete(sessionId)) return;
    this.write({ type: 'unsubscribe', sessionId });
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onConnection(listener: (connected: boolean) => void): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  /** After connecting, and on coming back to the page: time to catch up. */
  onResync(listener: () => void): () => void {
    this.resyncListeners.add(listener);
    return () => this.resyncListeners.delete(listener);
  }
}

export const socket = new Socket();
