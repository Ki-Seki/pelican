// A page showing a terminal, as the web app's would: it writes the screen it is sent and the
// output after it into a terminal of its own (xterm's headless one, with the widths and guards
// TerminalScreen has), and acknowledges what it wrote.
import type net from 'node:net';

import unicode11Addon from '@xterm/addon-unicode11';
import xtermHeadless, { type Terminal } from '@xterm/headless';
import WebSocket from 'ws';

import { type TerminalColors, TERMINAL_LIMITS, terminalServerMessage, type TerminalServerMessage } from '../src/shared/terminal';
import { guardOutput } from '../src/shared/terminal-guards';
import { loadWidths } from '../src/shared/terminal-widths';

const { Terminal: HeadlessTerminal } = xtermHeadless;
const { Unicode11Addon } = unicode11Addon;

export const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Until `check` holds, for at most `ms` of a clock of its own: a test may stop the wall clock (Date.now). */
export async function until(check: () => boolean, ms = 10_000, what = 'the page'): Promise<void> {
  for (const start = performance.now(); !check();) {
    if (performance.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await pause(10);
  }
}

export type PageOptions = {
  cols?: number;
  rows?: number;
  /** Acknowledges what it wrote (a page does); off, a page that reads but never says so. */
  ack?: boolean;
  headers?: Record<string, string>;
  /** The colors it says it draws in, as the web app's page does once connected. */
  colors?: TerminalColors;
};

export class Page {
  readonly ws: WebSocket;
  readonly screen: Terminal;
  readonly messages: TerminalServerMessage[] = [];
  /** All output, as text, from the screen it was sent on. */
  output = '';
  /** Bytes of output received, and acknowledged. */
  received = 0;
  acked = 0;
  closed?: { code: number; reason: string };
  opened = false;
  private unacked = 0;
  ack: boolean;

  constructor(port: number, id: string, options: PageOptions = {}) {
    const cols = options.cols ?? 80;
    const rows = options.rows ?? 24;
    this.ack = options.ack ?? true;
    this.screen = new HeadlessTerminal({ cols, rows, scrollback: TERMINAL_LIMITS.scrollback, allowProposedApi: true, logLevel: 'off' });
    loadWidths(this.screen, Unicode11Addon);
    guardOutput(this.screen);
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminal?id=${encodeURIComponent(id)}&cols=${cols}&rows=${rows}`, {
      headers: options.headers ?? {},
    });
    this.ws.on('open', () => {
      this.opened = true;
      if (options.colors) this.send({ type: 'colors', colors: options.colors });
    });
    this.ws.on('error', () => undefined);
    this.ws.on('close', (code, reason) => {
      this.closed = { code, reason: String(reason) };
    });
    this.ws.on('message', (data, binary) => {
      if (!binary) {
        const message = terminalServerMessage(String(data));
        if (!message) throw new Error(`Not a message: ${String(data).slice(0, 200)}`);
        this.messages.push(message);
        if (message.type === 'ready') {
          this.screen.resize(message.cols, message.rows);
          this.screen.write(message.snapshot);
        } else if (message.type === 'size') {
          this.screen.resize(message.cols, message.rows);
        } else if (message.type === 'clear') {
          // Clear terminal, as TerminalScreen does: once the output before it is on the screen.
          this.screen.write('', () => this.screen.clear());
        }
        return;
      }
      const bytes = data as Buffer;
      this.received += bytes.length;
      this.output += bytes.toString('utf8');
      this.screen.write(new Uint8Array(bytes), () => {
        this.unacked += bytes.length;
        if (this.ack && this.unacked >= TERMINAL_LIMITS.ackBytes) this.sendAck();
      });
    });
  }

  /** Says what it has drawn, all of it. */
  sendAck(): void {
    if (this.unacked === 0 || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'ack', bytes: this.unacked }));
    this.acked += this.unacked;
    this.unacked = 0;
  }

  get ready(): Extract<TerminalServerMessage, { type: 'ready' }> | undefined {
    return this.messages.find((m): m is Extract<TerminalServerMessage, { type: 'ready' }> => m.type === 'ready');
  }

  async opening(): Promise<void> {
    await until(() => this.opened || this.closed !== undefined, 5000, 'the socket to open');
  }

  async readied(): Promise<Extract<TerminalServerMessage, { type: 'ready' }>> {
    await until(() => this.ready !== undefined || this.closed !== undefined, 10_000, 'ready');
    if (!this.ready) throw new Error(`closed before ready: ${JSON.stringify(this.closed)}`);
    return this.ready;
  }

  /** Waits for output matching `pattern`, from what came after `from` characters. */
  async sees(pattern: RegExp, ms = 10_000, from = 0): Promise<RegExpExecArray> {
    let found: RegExpExecArray | null = null;
    await until(() => Boolean((found = pattern.exec(this.output.slice(from)))), ms, String(pattern));
    return found!;
  }

  type(text: string): void {
    this.ws.send(Buffer.from(text, 'utf8'), { binary: true });
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  /** The screen's lines as text, as the page shows them (its active buffer). */
  lines(): string[] {
    const buffer = this.screen.buffer.active;
    const out: string[] = [];
    for (let y = 0; y < buffer.length; y += 1) out.push(buffer.getLine(y)?.translateToString(true) ?? '');
    return out;
  }

  /** Stops reading from its socket, as a phone asleep with the socket open does. */
  stall(): void {
    (this.ws as unknown as { _socket: net.Socket })._socket.pause();
  }

  resume(): void {
    (this.ws as unknown as { _socket: net.Socket })._socket.resume();
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    const closed = new Promise((resolve) => this.ws.once('close', resolve));
    this.ws.terminate();
    await closed;
  }
}
