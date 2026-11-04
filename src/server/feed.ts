import { stat } from 'node:fs/promises';

import type { ChatMessage, ServerEvent } from '../shared/protocol.js';
import { loadMessages } from './sessions.js';
import { transcriptPath } from './transcripts.js';

export type Listener = (event: ServerEvent) => void;

const POLL_MS = 1000;

/**
 * Delivers one session's messages to the clients viewing it.
 *
 * Messages come from two places: the stream of a turn this app runs, and the
 * transcript file, which other clients (Desktop, the terminal) also write.
 * Both carry the same ids, so each message is delivered once. The file is
 * polled while anyone is watching; a stat per second is cheap and works the
 * same on macOS and Linux, unlike file watchers across atomic rewrites.
 */
class Feed {
  readonly listeners = new Set<Listener>();
  private delivered = new Set<string>();
  /** Ids last read from the file; one that disappears means the conversation was rewound. */
  private fromFile = new Set<string>();
  private primed?: Promise<void>;
  private size = -1;
  private mtimeMs = -1;
  private timer?: NodeJS.Timeout;
  private checking = false;

  constructor(readonly sessionId: string) {}

  private async prime(): Promise<void> {
    this.primed ??= (async () => {
      const file = await transcriptPath(this.sessionId);
      if (file) {
        const info = await stat(file).catch(() => undefined);
        if (info) {
          this.size = info.size;
          this.mtimeMs = info.mtimeMs;
        }
      }
      for (const message of await loadMessages(this.sessionId)) {
        this.delivered.add(message.uuid);
        this.fromFile.add(message.uuid);
      }
    })();
    return this.primed;
  }

  broadcast(event: ServerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A closed socket; its unsubscribe follows.
      }
    }
  }

  async publish(message: ChatMessage): Promise<void> {
    await this.prime();
    if (this.delivered.has(message.uuid)) return;
    this.delivered.add(message.uuid);
    this.broadcast({ type: 'message', sessionId: this.sessionId, message });
  }

  watch(): void {
    if (this.timer) return;
    void this.prime();
    this.timer = setInterval(() => {
      void this.check().then((changed) => {
        if (changed) sessionsChanged();
      });
    }, POLL_MS);
  }

  unwatch(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  get watching(): boolean {
    return Boolean(this.timer);
  }

  async check(): Promise<boolean> {
    if (this.checking) return false;
    this.checking = true;
    try {
      await this.prime();
      const file = await transcriptPath(this.sessionId);
      if (!file) return false;
      const info = await stat(file).catch(() => undefined);
      if (!info || (info.size === this.size && info.mtimeMs === this.mtimeMs)) return false;
      this.size = info.size;
      this.mtimeMs = info.mtimeMs;
      const messages = await loadMessages(this.sessionId);
      const present = new Set(messages.map((m) => m.uuid));
      for (const uuid of this.fromFile) {
        if (!present.has(uuid)) {
          this.fromFile = present;
          this.delivered = new Set(present);
          this.broadcast({ type: 'reload', sessionId: this.sessionId });
          return true;
        }
      }
      this.fromFile = present;
      for (const message of messages) {
        if (this.delivered.has(message.uuid)) continue;
        this.delivered.add(message.uuid);
        this.broadcast({ type: 'message', sessionId: this.sessionId, message });
      }
      return true;
    } finally {
      this.checking = false;
    }
  }
}

const feeds = new Map<string, Feed>();
const everyone = new Set<Listener>();
let changedTimer: NodeJS.Timeout | undefined;

export function feedFor(sessionId: string): Feed {
  let feed = feeds.get(sessionId);
  if (!feed) {
    feed = new Feed(sessionId);
    feeds.set(sessionId, feed);
  }
  return feed;
}

/** Tells every connected client the session list changed, at most every 2 s. */
export function sessionsChanged(): void {
  if (changedTimer) return;
  changedTimer = setTimeout(() => {
    changedTimer = undefined;
    for (const listener of everyone) {
      try {
        listener({ type: 'sessions_changed' });
      } catch {
        // Closed socket.
      }
    }
  }, 2000);
}

export function broadcastAll(event: ServerEvent): void {
  for (const listener of everyone) {
    try {
      listener(event);
    } catch {
      // Closed socket.
    }
  }
}

export function connect(listener: Listener): () => void {
  everyone.add(listener);
  return () => everyone.delete(listener);
}

export function subscribe(sessionId: string, listener: Listener): () => void {
  const feed = feedFor(sessionId);
  feed.listeners.add(listener);
  feed.watch();
  return () => {
    feed.listeners.delete(listener);
    if (feed.listeners.size === 0) feed.unwatch();
  };
}

export async function checkFeed(sessionId: string): Promise<void> {
  if (await feedFor(sessionId).check()) sessionsChanged();
}
