// @vitest-environment jsdom
// One terminal's screen on a page (src/web/components/TerminalScreen.tsx), with xterm.js and the
// connection stood in for: the size it tells the shell as its tab shows again or its box changes.
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** The size the box fits, as xterm's fit addon proposes it. */
let fits = { cols: 80, rows: 24 };
/** The stand-in terminal, and what was asked of it. */
let shown: { cols: number; rows: number; resized: Array<[number, number]> } | undefined;
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
    write(_data: unknown, done?: () => void) {
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
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('../src/shared/terminal-guards', () => ({ guardOutput: () => undefined }));
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
afterEach(cleanup);

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
