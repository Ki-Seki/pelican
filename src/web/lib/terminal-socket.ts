import {
  TERMINAL_CLOSE, TERMINAL_LIMITS, terminalServerMessage, type TerminalExit, type TerminalServerMessage,
} from '../../shared/terminal';

/**
 * A page's connection to one terminal (`api/terminal`, a socket of its own; the protocol is in
 * src/shared/terminal.ts). It says when the screen is ready and passes on what the shell prints,
 * acknowledging it once it is on the screen, so the shell waits for a page that is behind instead
 * of piling output up. A connection that drops, as a phone's does when it sleeps, comes back by
 * itself, at once when the page shows again, and the screen is drawn afresh from the server's copy.
 */

/** Where a connection stands, for the tab to say. */
export type Connection =
  /** Connecting, the first time or again after a drop; `again` once it had been open. */
  | { kind: 'connecting'; again: boolean }
  | { kind: 'open' }
  /** No such terminal: Pelican stopped since (terminals end with it), or another page closed it first. */
  | { kind: 'gone' }
  /** Closed: here, on another page, or after a long time unused. */
  | { kind: 'closed' }
  /** Terminals are off here (the demo, --no-terminal). */
  | { kind: 'refused' }
  /** Open on as many pages as a terminal can be. */
  | { kind: 'crowded' };

export type ConnectionEvents = {
  /** The screen as it is: draw it at this size before the output that follows. */
  ready: (screen: Extract<TerminalServerMessage, { type: 'ready' }>) => void;
  /** What the shell printed; call `written` once it is on the screen. */
  output: (data: Uint8Array, written: () => void) => void;
  size: (cols: number, rows: number) => void;
  program: (program: string) => void;
  exit: (exit: TerminalExit) => void;
  state: (state: Connection) => void;
};

export type ConnectionOptions = {
  /** The socket's address for this size. */
  url: (cols: number, rows: number) => string;
  /** The size the page draws the shell at now. */
  size: () => { cols: number; rows: number };
  events: ConnectionEvents;
  /** For tests. */
  WebSocket?: typeof WebSocket;
  now?: () => number;
};

/** The server says something at least every 25 s (a tick): quiet for longer than this, the socket is dead. */
const QUIET_MS = 60_000;
/** Back on screen after this long without a word: connect afresh rather than trust a socket that slept. */
const QUIET_ON_RETURN_MS = 30_000;
const encoder = new TextEncoder();

export class TerminalConnection {
  private ws?: WebSocket;
  private retry = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private watch?: ReturnType<typeof setInterval>;
  private heard = 0;
  /** Output on the screen since the last acknowledgement, in bytes. */
  private unacked = 0;
  private opened = false;
  private stopped = false;
  private readonly now: () => number;

  constructor(private readonly options: ConnectionOptions) {
    this.now = options.now ?? Date.now;
  }

  start(): void {
    this.connect();
    this.watch = setInterval(() => {
      if (this.ws?.readyState === 1 && this.now() - this.heard > QUIET_MS) this.again();
    }, 10_000);
  }

  /** Lets go of the terminal here: the shell runs on. */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.watch);
    const ws = this.ws;
    this.ws = undefined;
    ws?.close();
  }

  /** The page shows again, or the network came back: connect now if the socket is gone or went quiet. */
  comeBack(): void {
    if (this.stopped) return;
    const open = this.ws?.readyState === 1;
    if (!open && this.ws?.readyState === 0) return;
    if (!open || this.now() - this.heard > QUIET_ON_RETURN_MS) this.again();
  }

  /** Keys and pastes, in frames the server takes; dropped while there is no connection. */
  input(data: string | Uint8Array<ArrayBuffer>): void {
    const ws = this.ws;
    if (ws?.readyState !== 1) return;
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    for (let at = 0; at < bytes.length; at += TERMINAL_LIMITS.frame) ws.send(bytes.subarray(at, at + TERMINAL_LIMITS.frame));
  }

  /** This page's size, for the shell; a connection made later says it too. */
  resize(cols: number, rows: number): void {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  }

  private connect(): void {
    clearTimeout(this.timer);
    if (this.stopped) return;
    const { cols, rows } = this.options.size();
    const Socket = this.options.WebSocket ?? WebSocket;
    const ws = new Socket(this.options.url(cols, rows));
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.unacked = 0;
    this.options.events.state({ kind: 'connecting', again: this.opened });
    ws.onopen = () => {
      if (this.ws === ws) this.heard = this.now();
    };
    ws.onmessage = (message: MessageEvent) => {
      if (this.ws !== ws) return;
      this.heard = this.now();
      if (typeof message.data !== 'string') {
        const data = new Uint8Array(message.data as ArrayBuffer);
        this.options.events.output(data, () => this.written(ws, data.length));
        return;
      }
      const event = terminalServerMessage(message.data);
      if (!event) return;
      if (event.type === 'ready') {
        this.retry = 0;
        this.opened = true;
        this.options.events.ready(event);
        this.options.events.state({ kind: 'open' });
      } else if (event.type === 'size') {
        this.options.events.size(event.cols, event.rows);
      } else if (event.type === 'program') {
        this.options.events.program(event.program);
      } else if (event.type === 'exit') {
        this.options.events.exit({ code: event.code, signal: event.signal });
      }
    };
    ws.onclose = (event: CloseEvent) => {
      if (this.ws !== ws || this.stopped) return;
      this.ws = undefined;
      const ends: Partial<Record<number, Connection>> = {
        [TERMINAL_CLOSE.gone]: { kind: 'gone' },
        [TERMINAL_CLOSE.badRequest]: { kind: 'gone' },
        [TERMINAL_CLOSE.closed]: { kind: 'closed' },
        [TERMINAL_CLOSE.refused]: { kind: 'refused' },
        [TERMINAL_CLOSE.tooManyViewers]: { kind: 'crowded' },
      };
      const end = ends[event.code];
      if (end) {
        this.stopped = true;
        clearInterval(this.watch);
        this.options.events.state(end);
        return;
      }
      // Behind: let go for being slow, it gets the screen as it is now at once. Otherwise the link
      // dropped: again after a moment, a longer one each time.
      const delay = event.code === TERMINAL_CLOSE.behind ? 0 : Math.min(500 * 2 ** this.retry, 15_000);
      this.retry += 1;
      this.options.events.state({ kind: 'connecting', again: this.opened });
      this.timer = setTimeout(() => this.connect(), delay);
    };
  }

  /** Connects again now, dropping the socket there is. */
  private again(): void {
    const old = this.ws;
    this.ws = undefined;
    old?.close();
    this.retry = 0;
    this.connect();
  }

  /** Output is on the screen: acknowledged in steps, on the socket it came by. */
  private written(ws: WebSocket, bytes: number): void {
    if (this.ws !== ws || ws.readyState !== 1) return;
    this.unacked += bytes;
    if (this.unacked < TERMINAL_LIMITS.ackBytes) return;
    ws.send(JSON.stringify({ type: 'ack', bytes: this.unacked }));
    this.unacked = 0;
  }
}
