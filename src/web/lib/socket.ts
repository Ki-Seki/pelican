import type { ClientEvent, ServerEvent } from '../../shared/protocol';
import { appBase } from './api';

type Listener = (event: ServerEvent) => void;

/**
 * One WebSocket for the whole app. It reconnects with backoff, right away
 * when the page becomes visible again (phones drop sockets of background
 * tabs), and re-subscribes to the sessions in view.
 */
class Socket {
  private ws?: WebSocket;
  private retry = 0;
  private timer?: number;
  private readonly sessions = new Set<string>();
  private readonly listeners = new Set<Listener>();
  private readonly connectionListeners = new Set<(connected: boolean) => void>();
  connected = false;

  start(): void {
    this.connect();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !this.connected) this.connect();
    });
    window.addEventListener('online', () => {
      if (!this.connected) this.connect();
    });
  }

  private connect(): void {
    clearTimeout(this.timer);
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    const url = new URL('api/ws', appBase);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setConnected(true);
      for (const sessionId of this.sessions) this.write({ type: 'subscribe', sessionId });
    };
    ws.onmessage = (message) => {
      let event: ServerEvent;
      try {
        event = JSON.parse(String(message.data)) as ServerEvent;
      } catch {
        return;
      }
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

  subscribe(sessionId: string): void {
    if (this.sessions.has(sessionId)) return;
    this.sessions.add(sessionId);
    this.write({ type: 'subscribe', sessionId });
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
}

export const socket = new Socket();
