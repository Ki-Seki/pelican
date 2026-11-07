// A page's connection to a terminal (src/web/lib/terminal-socket.ts), against a socket that does
// what it is told: what it passes on, what it acknowledges, and when it connects again.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TERMINAL_CLOSE, TERMINAL_LIMITS } from '../src/shared/terminal';
import { type Connection, TerminalConnection } from '../src/web/lib/terminal-socket';

class FakeSocket {
  static made: FakeSocket[] = [];
  readyState = 0;
  binaryType = 'blob';
  sent: Array<string | Uint8Array> = [];
  onopen?: () => void;
  onmessage?: (event: { data: unknown }) => void;
  onclose?: (event: { code: number }) => void;
  constructor(readonly url: string) {
    FakeSocket.made.push(this);
  }
  send(data: string | Uint8Array) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  text(message: object) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  binary(bytes: number) {
    this.onmessage?.({ data: new Uint8Array(bytes).buffer });
  }
  end(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  get acks() {
    return this.sent.filter((d): d is string => typeof d === 'string').map((d) => JSON.parse(d) as { type: string; bytes?: number }).filter((m) => m.type === 'ack');
  }
}

const ready = { type: 'ready', id: 't1', cols: 80, rows: 24, snapshot: 'PROMPT$ ', program: 'bash' };

function connect(size = { cols: 80, rows: 24 }) {
  const states: Connection[] = [];
  const written: Array<() => void> = [];
  const events = {
    ready: vi.fn(),
    output: vi.fn((_data: Uint8Array, done: () => void) => written.push(done)),
    size: vi.fn(),
    program: vi.fn(),
    exit: vi.fn(),
    clear: vi.fn(),
    state: (state: Connection) => states.push(state),
  };
  const connection = new TerminalConnection({
    url: (cols, rows) => `ws://pelican/api/terminal?id=t1&cols=${cols}&rows=${rows}`,
    size: () => size,
    events,
    WebSocket: FakeSocket as unknown as typeof WebSocket,
  });
  connection.start();
  return { connection, events, states, written, socket: () => FakeSocket.made.at(-1)! };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.made = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe('a terminal’s connection', () => {
  it('draws the screen it is sent first, then passes the output on and acknowledges it once it is on the screen, in steps', () => {
    const { connection, events, states, written, socket } = connect({ cols: 100, rows: 30 });
    expect(socket().url).toBe('ws://pelican/api/terminal?id=t1&cols=100&rows=30');
    expect(socket().binaryType).toBe('arraybuffer');
    socket().open();
    socket().text(ready);
    expect(events.ready).toHaveBeenCalledWith(ready);
    expect(states.at(-1)).toEqual({ kind: 'open' });
    socket().binary(10_000);
    socket().binary(10_000);
    // Not acknowledged until written to the screen, then in one step past TERMINAL_LIMITS.ackBytes.
    expect(socket().acks).toEqual([]);
    for (const done of written) done();
    expect(socket().acks).toEqual([{ type: 'ack', bytes: 20_000 }]);
    socket().text({ type: 'program', program: 'vim' });
    socket().text({ type: 'size', cols: 120, rows: 40 });
    socket().text({ type: 'exit', code: 0, signal: null });
    socket().text({ type: 'tick' });
    expect(events.program).toHaveBeenCalledWith('vim');
    expect(events.size).toHaveBeenCalledWith(120, 40);
    expect(events.exit).toHaveBeenCalledWith({ code: 0, signal: null });
    connection.resize(90, 20);
    expect(socket().sent.at(-1)).toBe(JSON.stringify({ type: 'resize', cols: 90, rows: 20 }));
  });

  it('asks the computer to clear the terminal for every page, and clears when told; asked with no connection, once there is one', () => {
    const { connection, events, socket } = connect();
    socket().open();
    socket().text(ready);
    connection.clear();
    expect(socket().sent.at(-1)).toBe(JSON.stringify({ type: 'clear' }));
    socket().text({ type: 'clear' });
    expect(events.clear).toHaveBeenCalledTimes(1);
    socket().end(1006);
    connection.clear();
    vi.advanceTimersByTime(1000);
    socket().open();
    expect(socket().sent.some((d) => d === JSON.stringify({ type: 'clear' }))).toBe(false);
    // Once the screen has come, drawn as it was: then cleared, there and everywhere.
    socket().text(ready);
    expect(socket().sent.filter((d) => d === JSON.stringify({ type: 'clear' }))).toHaveLength(1);
  });

  it('says the colors the page draws in on each connection, and again when they change', () => {
    const colors = { foreground: '#171717', background: '#fafafa', cursor: '#171717', ansi: Array.from({ length: 16 }, () => '#000000') };
    const connection = new TerminalConnection({
      url: () => 'ws://pelican/api/terminal?id=t1&cols=80&rows=24',
      size: () => ({ cols: 80, rows: 24 }),
      colors: () => colors,
      events: { ready: vi.fn(), output: vi.fn(), size: vi.fn(), program: vi.fn(), exit: vi.fn(), clear: vi.fn(), state: vi.fn() },
      WebSocket: FakeSocket as unknown as typeof WebSocket,
    });
    connection.start();
    FakeSocket.made.at(-1)!.open();
    expect(FakeSocket.made.at(-1)!.sent).toEqual([JSON.stringify({ type: 'colors', colors })]);
    const dark = { ...colors, background: '#0a0a0a' };
    connection.colors(dark);
    expect(FakeSocket.made.at(-1)!.sent.at(-1)).toBe(JSON.stringify({ type: 'colors', colors: dark }));
    // Again after a dropped connection.
    FakeSocket.made.at(-1)!.end(1006);
    vi.advanceTimersByTime(500);
    FakeSocket.made.at(-1)!.open();
    expect(FakeSocket.made.at(-1)!.sent).toEqual([JSON.stringify({ type: 'colors', colors })]);
    connection.stop();
  });

  it('sends keys as binary frames, a long paste in frames the server takes', () => {
    const { connection, socket } = connect();
    connection.input('ls\r');
    expect(socket().sent).toEqual([]);
    socket().open();
    connection.input('ls\r');
    expect(new TextDecoder().decode(socket().sent[0] as Uint8Array)).toBe('ls\r');
    connection.input('x'.repeat(TERMINAL_LIMITS.frame * 2 + 5));
    expect(socket().sent.slice(1).map((frame) => (frame as Uint8Array).length)).toEqual([TERMINAL_LIMITS.frame, TERMINAL_LIMITS.frame, 5]);
  });

  it('comes back after a dropped connection, waiting longer each time, and at once when let go for being behind', () => {
    const { states, socket } = connect();
    socket().open();
    socket().text(ready);
    socket().end(1006);
    expect(states.at(-1)).toEqual({ kind: 'connecting', again: true });
    expect(FakeSocket.made).toHaveLength(1);
    vi.advanceTimersByTime(500);
    expect(FakeSocket.made).toHaveLength(2);
    socket().end(1006);
    vi.advanceTimersByTime(500);
    expect(FakeSocket.made).toHaveLength(2);
    vi.advanceTimersByTime(500);
    expect(FakeSocket.made).toHaveLength(3);
    // Pelican stopping looks the same: the page comes back.
    socket().end(1001);
    vi.advanceTimersByTime(2000);
    expect(FakeSocket.made).toHaveLength(4);
    socket().open();
    socket().text(ready);
    socket().end(TERMINAL_CLOSE.behind);
    vi.advanceTimersByTime(0);
    expect(FakeSocket.made).toHaveLength(5);
  });

  it('says when it was let go for being signed out, and tries again as after a drop', () => {
    const signedOut = vi.fn();
    const connection = new TerminalConnection({
      url: () => 'ws://pelican/api/terminal?id=t1&cols=80&rows=24',
      size: () => ({ cols: 80, rows: 24 }),
      events: { ready: vi.fn(), output: vi.fn(), size: vi.fn(), program: vi.fn(), exit: vi.fn(), clear: vi.fn(), state: vi.fn(), signedOut },
      WebSocket: FakeSocket as unknown as typeof WebSocket,
    });
    connection.start();
    FakeSocket.made.at(-1)!.open();
    FakeSocket.made.at(-1)!.text(ready);
    FakeSocket.made.at(-1)!.end(TERMINAL_CLOSE.signedOut);
    expect(signedOut).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(500);
    expect(FakeSocket.made).toHaveLength(2);
    connection.stop();
  });

  it('stops for good when the terminal is gone, closed, refused or on too many pages', () => {
    for (const [code, kind] of [[TERMINAL_CLOSE.gone, 'gone'], [TERMINAL_CLOSE.closed, 'closed'], [TERMINAL_CLOSE.refused, 'refused'], [TERMINAL_CLOSE.tooManyViewers, 'crowded']] as const) {
      FakeSocket.made = [];
      const { states, socket } = connect();
      socket().open();
      socket().end(code);
      expect(states.at(-1)).toEqual({ kind });
      vi.advanceTimersByTime(60_000);
      expect(FakeSocket.made).toHaveLength(1);
    }
  });

  it('connects afresh on coming back to a socket gone quiet, and leaves one that still talks', () => {
    const { connection, socket } = connect();
    socket().open();
    socket().text(ready);
    connection.comeBack();
    expect(FakeSocket.made).toHaveLength(1);
    vi.advanceTimersByTime(31_000);
    connection.comeBack();
    expect(FakeSocket.made).toHaveLength(2);
    // Quiet past a minute while open: dead, whatever it says.
    socket().open();
    vi.advanceTimersByTime(70_000);
    expect(FakeSocket.made).toHaveLength(3);
  });

  it('lets go when stopped, the shell running on, and connects no more', () => {
    const { connection, socket } = connect();
    socket().open();
    connection.stop();
    expect(socket().readyState).toBe(3);
    socket().end(1006);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.made).toHaveLength(1);
  });
});
