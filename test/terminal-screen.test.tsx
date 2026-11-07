// @vitest-environment jsdom
// One terminal's screen on a page (src/web/components/TerminalScreen.tsx), with xterm.js and the
// connection stood in for: the size it tells the shell as its tab shows again or its box changes,
// and where a link in the output goes, said before it opens.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** The size the box fits, as xterm's fit addon proposes it. */
let fits = { cols: 80, rows: 24 };
/** The stand-in terminal, and what was asked of it. */
let shown: { cols: number; rows: number; resized: Array<[number, number]>; written: unknown[] } | undefined;
/** Terminals whose output not yet taken in was let go. */
const dropped: unknown[] = [];
/** The connection's options (its events), and the sizes it told the shell. */
let connection: { events: Record<string, (...args: any[]) => void> } | undefined;
const told: unknown[][] = [];
/** The box's ResizeObserver, to call as the browser would. */
let observed: (() => void) | undefined;

vi.mock('@xterm/xterm', () => {
  const listen = () => ({ dispose() {} });
  class Terminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;
    modes = { applicationCursorKeysMode: false, bracketedPasteMode: false };
    buffer = { active: { type: 'normal', viewportY: 0, baseY: 0, cursorX: 0, cursorY: 0, length: 0, getLine: () => undefined }, onBufferChange: listen };
    parser = { registerCsiHandler: listen, registerDcsHandler: listen, registerOscHandler: listen };
    textarea = document.createElement('textarea');
    resized: Array<[number, number]> = [];
    written: unknown[] = [];
    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      shown = this;
    }
    loadAddon() {}
    open() {}
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
      this.resized.push([cols, rows]);
    }
    write(data: unknown, done?: () => void) {
      this.written.push(data);
      done?.();
    }
    onData = listen;
    onBinary = listen;
    onSelectionChange = listen;
    onWriteParsed = listen;
    onScroll = listen;
    onResize = listen;
    attachCustomKeyEventHandler() {}
    attachCustomWheelEventHandler() {}
    hasSelection = () => false;
    getSelection = () => '';
    clearSelection() {}
    focus() {}
    refresh() {}
    dispose() {}
  }
  return { Terminal };
});
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { proposeDimensions = () => ({ ...fits }); } }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }));
/** What the web links addon was made with: its handler, and its hover and leave. */
let webLinks: unknown[] = [];
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {
    constructor(...args: unknown[]) {
      webLinks = args;
    }
  },
}));
vi.mock('../src/shared/terminal-guards', async (original) => ({
  ...(await original<typeof import('../src/shared/terminal-guards')>()),
  guardOutput: () => undefined,
  dropPendingOutput: (t: unknown) => {
    dropped.push(t);
  },
}));
vi.mock('../src/shared/terminal-widths', () => ({ loadWidths: () => undefined }));
vi.mock('../src/web/lib/terminal-cursor', () => ({ showCursor: () => undefined }));
vi.mock('../src/web/lib/terminal-input', async (original) => ({
  ...(await original<typeof import('../src/web/lib/terminal-input')>()),
  boundReadOut: () => undefined,
  insertedText: () => () => undefined,
  cleanPastes: () => () => undefined,
}));
vi.mock('../src/web/lib/terminal-socket', () => ({
  TerminalConnection: class {
    constructor(options: { events: Record<string, (...args: any[]) => void> }) {
      connection = options;
    }
    start() {}
    stop() {}
    comeBack() {}
    get open() {
      return true;
    }
    input = () => true;
    resize(...args: unknown[]) {
      told.push(args);
    }
    clear() {}
    colors() {}
  },
}));

beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  window.requestAnimationFrame = ((done: FrameRequestCallback) => setTimeout(() => done(0), 0)) as unknown as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as unknown as typeof window.cancelAnimationFrame;
  globalThis.ResizeObserver = class {
    constructor(callback: () => void) {
      observed = callback;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const { TerminalScreen } = await import('../src/web/components/TerminalScreen');

/** The box's size on screen: what the screen measures to tell a resize from showing again. */
let box = { width: 800, height: 480 };
beforeEach(() => {
  fits = { cols: 80, rows: 24 };
  box = { width: 800, height: 480 };
  told.length = 0;
  connection = undefined;
  shown = undefined;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => box.width });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => box.height });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const frame = () => act(() => new Promise((resolve) => setTimeout(resolve, 5)));
const props = { id: 't1', touch: false, label: 'Terminal', onProgram() {}, onExit() {}, onConnection() {}, onMode() {}, onMenu() {}, onQuote() {} };

describe('the size a page tells the shell', () => {
  it('is not taken from another page as the Terminal tab shows again, only asked for, and taken as the box is resized', async () => {
    const view = render(<TerminalScreen {...props} hidden={false} />);
    await frame();
    // Another page has the shell at its size: this one draws it so.
    act(() => connection!.events.ready!({ type: 'ready', id: 't1', cols: 120, rows: 40, snapshot: '', program: 'zsh' }));
    expect(shown).toMatchObject({ cols: 120, rows: 40 });
    told.length = 0;
    // Files, then Terminal again: the box is hidden, then as it was.
    view.rerender(<TerminalScreen {...props} hidden />);
    box = { width: 0, height: 0 };
    observed!();
    await frame();
    view.rerender(<TerminalScreen {...props} hidden={false} />);
    box = { width: 800, height: 480 };
    observed!();
    await frame();
    // Asked for, as the server takes it only where this page is alone; the screen stays as drawn.
    expect(told.length).toBeGreaterThan(0);
    for (const said of told) expect(said).toEqual([80, 24, true]);
    expect(shown).toMatchObject({ cols: 120, rows: 40 });
    // The server took it (this page is alone) and says it back: drawn at it, and then its own again.
    act(() => connection!.events.size!(80, 24));
    expect(shown).toMatchObject({ cols: 80, rows: 24 });
    told.length = 0;
    // The window resized here: that takes the shell's size, as typing does.
    act(() => connection!.events.size!(120, 40));
    box = { width: 1000, height: 600 };
    fits = { cols: 100, rows: 30 };
    observed!();
    await frame();
    expect(told).toEqual([[100, 30]]);
    expect(shown).toMatchObject({ cols: 100, rows: 30 });
  });
});

describe('output on a page', () => {
  it('is drawn in pieces of bounded work, acknowledged once all of it is, and let go with the screen', async () => {
    const view = render(<TerminalScreen {...props} hidden={false} />);
    act(() => connection!.events.ready!({ type: 'ready', id: 't1', cols: 500, rows: 300, snapshot: '', program: 'zsh' }));
    shown!.written.length = 0;
    // A frame of scrolls of the whole screen at 500 by 300, as a page gets it: 64 KB of UTF-8.
    const frame = new TextEncoder().encode('\u001b[300S'.repeat(64 * 1024 / 7));
    const written = vi.fn();
    act(() => connection!.events.output!(frame, written));
    const pieces = shown!.written as Uint8Array[];
    const { outputPieces, wideMost } = await import('../src/shared/terminal-guards');
    expect(pieces.length).toBeGreaterThan(frame.length / 512);
    for (const piece of pieces) expect(outputPieces(piece, 500, 300).reduce((sum, p) => sum + p.wide, 0)).toBeLessThanOrEqual(wideMost(500, 300));
    expect(Buffer.concat(pieces)).toEqual(Buffer.from(frame));
    expect(written).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(dropped).toContain(shown);
  });
});

type LinkHandler = { activate: (event: MouseEvent, uri: string) => void; hover: (event: MouseEvent, uri: string) => void; leave: (event: MouseEvent, uri: string) => void };
const linkHandler = () => (shown as unknown as { options: { linkHandler: LinkHandler } }).options.linkHandler;
const click = (keys: Partial<MouseEventInit> = {}) => new MouseEvent('click', keys);

describe('a link in the output', () => {
  it('says where it goes as it is pointed at, before a click with ⌘ or Ctrl opens it, whatever its text reads', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<TerminalScreen {...props} hidden={false} />);
    // A program's link (OSC 8) whose text reads as another address, and a host spelled to look like one.
    act(() => linkHandler().hover(click(), 'https://github.com.evil.example/login?next=%2F#top'));
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('https://github.com.evil.example/login?next=%2F#top');
    act(() => linkHandler().leave(click(), 'https://github.com.evil.example/login'));
    expect(screen.queryByRole('status')).toBeNull();
    act(() => linkHandler().hover(click(), 'https://\u0430pple.example/'));
    expect(screen.getByRole('status').textContent).toContain('https://xn--pple-43d.example/');
    // A plain address the text holds is said the same way, by the addon's hover.
    const [, options] = webLinks as [unknown, { hover: LinkHandler['hover']; leave: LinkHandler['leave'] }];
    act(() => options.leave(click(), ''));
    act(() => options.hover(click(), 'https://example.com/docs'));
    expect(screen.getByRole('status').textContent).toContain('https://example.com/docs');
    // A click alone selects; with the key held, it opens where it was said to go, with no way back.
    act(() => linkHandler().activate(click(), 'https://example.com/docs'));
    expect(open).not.toHaveBeenCalled();
    act(() => linkHandler().activate(click({ metaKey: true, ctrlKey: true }), 'https://example.com/docs'));
    expect(open).toHaveBeenCalledWith('https://example.com/docs', '_blank', 'noopener,noreferrer');
    // Nothing but http and https.
    act(() => linkHandler().hover(click(), 'javascript:alert(1)'));
    act(() => linkHandler().activate(click({ metaKey: true, ctrlKey: true }), 'javascript:alert(1)'));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('asks on a touch screen first, saying where it goes, and opens once Open is tapped', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<TerminalScreen {...props} touch hidden={false} />);
    act(() => linkHandler().activate(click(), 'https://github.com.evil.example/login'));
    expect(open).not.toHaveBeenCalled();
    const asking = screen.getByRole('dialog', { name: 'Open this link?' });
    expect(asking.textContent).toContain('https://github.com.evil.example/login');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(open).not.toHaveBeenCalled();
    act(() => linkHandler().activate(click(), 'https://example.com/docs'));
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(open).toHaveBeenCalledWith('https://example.com/docs', '_blank', 'noopener,noreferrer');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
