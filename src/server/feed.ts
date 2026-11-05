import { stat } from 'node:fs/promises';

import type { ChatMessage, ServerEvent } from '../shared/protocol.js';
import { loadMessages } from './sessions.js';
import { transcriptPath } from './transcripts.js';

export type Listener = (event: ServerEvent) => void;

const POLL_MS = 1000;
/**
 * How long a published message waits for a client that subscribes late (a new session's first
 * prompt, sent before the page could subscribe). Later ones come from the transcript.
 */
const RECENT_MS = 2 * 60_000;

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
  /** Recently published messages, replayed to a client that subscribes late (a new session's first prompt). */
  private recent: Array<{ message: ChatMessage; at: number }> = [];
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
      // Clients could not load it either while it failed: they read it whole now.
      if (this.unprimed) this.broadcast({ type: 'reload', sessionId: this.sessionId });
      this.unprimed = false;
    })().catch((error: unknown) => {
      // Tried again at the next poll: the file may be readable by then (a write finished, its owner changed).
      this.primed = undefined;
      this.unprimed = true;
      throw error;
    });
    return this.primed;
  }

  private unprimed = false;

  /** Said once until reading works again, not once a second. */
  private failing = false;

  private failed(error: unknown): void {
    if (this.failing) return;
    this.failing = true;
    console.warn(`[pelican] cannot read the transcript of ${this.sessionId.slice(0, 8)}: ${(error as Error).message ?? error}`);
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

  /** Publishes still on their way (priming reads the transcript first). */
  publishing = 0;

  async publish(message: ChatMessage): Promise<void> {
    this.publishing += 1;
    try {
      // A transcript that cannot be read must not stop the run publishing: the message goes out anyway.
      await this.prime().catch((error: unknown) => this.failed(error));
      if (this.delivered.has(message.uuid)) return;
      this.delivered.add(message.uuid);
      this.recent.push({ message, at: Date.now() });
      if (this.recent.length > 40) this.recent.shift();
      this.broadcast({ type: 'message', sessionId: this.sessionId, message });
    } finally {
      this.publishing -= 1;
    }
  }

  /** Whether it still holds messages for a late subscriber; older ones are let go. */
  hasRecent(now = Date.now()): boolean {
    this.recent = this.recent.filter((r) => now - r.at < RECENT_MS);
    return this.recent.length > 0;
  }

  /**
   * What a late subscriber missed: messages published that the transcript does not hold yet. The
   * rest its page reads from the transcript, pictures by address, not as megabytes of data again.
   */
  async unwritten(): Promise<ChatMessage[]> {
    if (!this.hasRecent()) return [];
    const recent = this.recent.map((r) => r.message);
    // Unreadable, it is no help to the page either: everything goes, as published.
    const messages = await loadMessages(this.sessionId).catch(() => []);
    const written = new Set(messages.flatMap((m) => (m.sourceUuid ? [m.uuid, m.sourceUuid] : [m.uuid])));
    return recent.filter((message) => !written.has(message.uuid));
  }

  /** Nobody watches, nothing is on its way, nothing waits for a late subscriber: it can go. */
  get idle(): boolean {
    return this.listeners.size === 0 && this.publishing === 0 && !this.hasRecent();
  }

  watch(): void {
    if (this.timer) return;
    void this.prime().catch((error: unknown) => this.failed(error));
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

  /** Delivers what the transcript gained since the last look; never fails (a poll nobody awaits). */
  async check(): Promise<boolean> {
    if (this.checking) return false;
    this.checking = true;
    try {
      return await this.read();
    } catch (error) {
      this.failed(error);
      return false;
    } finally {
      this.checking = false;
    }
  }

  private async read(): Promise<boolean> {
    await this.prime();
    const file = await transcriptPath(this.sessionId);
    if (!file) return false;
    const info = await stat(file).catch(() => undefined);
    if (!info || (info.size === this.size && info.mtimeMs === this.mtimeMs)) return false;
    const messages = await loadMessages(this.sessionId);
    // Only once it was read: a file that could not be is tried again at the next poll.
    this.size = info.size;
    this.mtimeMs = info.mtimeMs;
    this.failing = false;
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
  // A late subscriber gets what it missed first; what happens meanwhile waits, to come after it.
  let waiting: ServerEvent[] | undefined = feed.hasRecent() ? [] : undefined;
  const subscriber: Listener = (event) => (waiting ? waiting.push(event) : listener(event));
  feed.listeners.add(subscriber);
  if (waiting) {
    void feed.unwritten().catch((): ChatMessage[] => []).then((missed) => {
      const meanwhile = waiting ?? [];
      waiting = undefined;
      if (!feed.listeners.has(subscriber)) return;
      try {
        for (const message of missed) listener({ type: 'message', sessionId, message });
        for (const event of meanwhile) listener(event);
      } catch {
        // A closed socket; its unsubscribe follows.
      }
    });
  }
  feed.watch();
  return () => {
    feed.listeners.delete(subscriber);
    if (feed.listeners.size > 0) return;
    feed.unwatch();
    // Forgotten once idle, so feeds do not pile up for every session ever opened or run. A run
    // that publishes again gets a new one, which reads the transcript first like any other.
    if (feed.idle && feeds.get(sessionId) === feed) feeds.delete(sessionId);
  };
}

/** Feeds of runs that published with nobody watching go too, once their messages are old. */
function sweep(): void {
  for (const [sessionId, feed] of feeds) if (feed.idle) feeds.delete(sessionId);
}

setInterval(sweep, 60_000).unref();

/** How many feeds are kept, for tests. */
export const feedCount = () => feeds.size;
