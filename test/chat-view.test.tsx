// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage, RunState } from '../src/shared/protocol';
import type { SessionView } from '../src/web/lib/store';
import type { ToolCall } from '../src/web/lib/turns';

/** Size changes, delivered when the test says: jsdom lays nothing out. */
class FakeResizeObserver {
  static all = new Set<FakeResizeObserver>();
  constructor(readonly callback: () => void) {
    FakeResizeObserver.all.add(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {
    FakeResizeObserver.all.delete(this);
  }
}
Object.assign(globalThis, { ResizeObserver: FakeResizeObserver });

let media: Record<string, boolean> = {};
Object.assign(window, { matchMedia: (query: string) => ({ matches: Boolean(media[query]), media: query, addEventListener() {}, removeEventListener() {} }) });

const { MessageList } = await import('../src/web/components/MessageList');
const { ToolCallView } = await import('../src/web/components/ToolCall');
const { Markdown } = await import('../src/web/components/Markdown');

afterEach(() => {
  cleanup();
  media = {};
});

const at = Date.now() - 60_000;
const messages: ChatMessage[] = [
  { uuid: 'u1', role: 'user', blocks: [{ type: 'text', text: 'Add a dark theme' }], timestamp: at },
  { uuid: 'a1', role: 'assistant', blocks: [{ type: 'text', text: 'Looking at the colors first.' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/p/theme.css' } }], timestamp: at + 1000 },
  { uuid: 'r1', role: 'user', blocks: [{ type: 'tool_result', tool_use_id: 't1', content: ':root {}' }], timestamp: at + 2000 },
  { uuid: 'a2', role: 'assistant', blocks: [{ type: 'text', text: 'Now the toggle itself.' }], timestamp: at + 3000 },
];
const view = (extra: Partial<SessionView> = {}): SessionView => ({ messages, offset: 0, total: messages.length, loaded: true, loadingOlder: false, ...extra });

/** The list's scroller, made to report a size, with the content `height` tall and a 400px window. */
function scroller(container: HTMLElement) {
  const el = container.querySelector('.overflow-y-auto') as HTMLDivElement;
  const box = { height: 1000, top: 0 };
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => box.height });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 400 });
  Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => box.top, set: (v: number) => { box.top = Math.max(0, Math.min(v, box.height - 400)); } });
  const resized = (height: number) => act(() => {
    box.height = height;
    for (const observer of FakeResizeObserver.all) observer.callback();
  });
  return { el, box, resized };
}

describe('following the end of the conversation', () => {
  beforeEach(() => FakeResizeObserver.all.clear());

  it('keeps the end in view when something below grows after it is drawn', () => {
    const { container } = render(<MessageList sessionId="s" view={view()} mode="normal" />);
    const { box, resized } = scroller(container);
    resized(1000);
    expect(box.top).toBe(600);
    // A picture loads, an approval card takes room: still at the end.
    resized(1400);
    expect(box.top).toBe(1000);
    expect(screen.queryByLabelText('Jump to latest')).toBeNull();
  });

  it('goes on following after a tap that opens nothing', () => {
    const { container } = render(<MessageList sessionId="s" view={view()} mode="normal" />);
    const { box, resized } = scroller(container);
    resized(1000);
    fireEvent.click(screen.getByText('Now the toggle itself.'));
    resized(1500);
    expect(box.top).toBe(1100);
  });

  it('does not move text being selected, and follows again once it is let go', () => {
    const { container } = render(<MessageList sessionId="s" view={view()} mode="normal" />);
    const { box, resized } = scroller(container);
    resized(1000);
    const text = screen.getByText('Now the toggle itself.');
    const selection = vi.spyOn(window, 'getSelection').mockReturnValue({ isCollapsed: false, anchorNode: text.firstChild, toString: () => 'toggle' } as unknown as Selection);
    resized(1400);
    expect(box.top).toBe(600);
    expect(screen.getByLabelText('Jump to latest')).toBeTruthy();
    selection.mockRestore();
    resized(1500);
    expect(box.top).toBe(1100);
  });

  it('stops following when the reader opens a step, and offers the way back', () => {
    const { container } = render(<MessageList sessionId="s" view={view()} mode="normal" />);
    const { el, box, resized } = scroller(container);
    resized(1000);
    fireEvent.click(screen.getByRole('button', { name: /theme\.css/ }));
    resized(1600);
    expect(box.top).toBe(600);
    const jump = screen.getByLabelText('Jump to latest');
    el.scrollTo = vi.fn();
    fireEvent.click(jump);
    expect(el.scrollTo).toHaveBeenCalledWith({ top: 1600, behavior: 'smooth' });
  });

  it('stops following when the reader scrolls up, and shows the jump button as more arrives', () => {
    const { container } = render(<MessageList sessionId="s" view={view()} mode="normal" />);
    const { el, box, resized } = scroller(container);
    resized(1000);
    box.top = 400;
    fireEvent.scroll(el);
    resized(1300);
    expect(box.top).toBe(400);
    expect(screen.getByLabelText('Jump to latest')).toBeTruthy();
  });

  it('jumps without scrolling smoothly when motion is reduced', () => {
    media['(prefers-reduced-motion: reduce)'] = true;
    const { container } = render(<MessageList sessionId="s" view={view()} mode="normal" />);
    const { el, box, resized } = scroller(container);
    resized(1000);
    box.top = 0;
    fireEvent.scroll(el);
    el.scrollTo = vi.fn();
    fireEvent.click(screen.getByLabelText('Jump to latest'));
    expect(el.scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: 'auto' });
  });
});

describe('code in a reply', () => {
  it('has its copy button in a bar of its own, not over the code', () => {
    const html = renderToStaticMarkup(<Markdown text={'```python\nprint("hi")\n```'} />);
    const pre = html.slice(html.indexOf('<pre'), html.indexOf('</pre>'));
    expect(pre).not.toContain('aria-label="Copy"');
    expect(html.indexOf('aria-label="Copy"')).toBeLessThan(html.indexOf('<pre'));
    expect(html).toContain('python');
  });

  it('names a picture’s button', () => {
    const html = renderToStaticMarkup(<Markdown text={'![the chart](api/uploads/a)\n\n![](api/uploads/b)'} />);
    expect(html).toContain('aria-label="the chart"');
    expect(html).toContain('aria-label="Open image"');
  });
});
