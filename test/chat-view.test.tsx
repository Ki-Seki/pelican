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

describe('a prompt', () => {
  it('is text you can select, with its actions shown on a tap on a touch screen', () => {
    media['(hover: none)'] = true;
    render(<MessageList sessionId="s" view={view()} mode="normal" onRewind={() => {}} />);
    const prompt = screen.getByText('Add a dark theme');
    expect(prompt.closest('button')).toBeNull();
    // The prompt's Copy comes first; the reply has its own.
    const row = screen.getAllByRole('button', { name: 'Copy' })[0]!.parentElement!;
    expect(row.className).toContain('sr-only');
    // The end of selecting some of it is not a tap.
    const selection = vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => 'dark' } as Selection);
    fireEvent.click(prompt);
    expect(row.className).toContain('sr-only');
    selection.mockRestore();
    fireEvent.click(prompt);
    expect(row.className).not.toContain('sr-only');
    expect(screen.getByRole('button', { name: 'Rewind' })).toBeTruthy();
  });

  it('keeps its actions to a pointer’s hover or focus on a computer: a click does nothing', () => {
    render(<MessageList sessionId="s" view={view()} mode="normal" />);
    const row = screen.getAllByRole('button', { name: 'Copy' })[0]!.parentElement!;
    fireEvent.click(screen.getByText('Add a dark theme'));
    expect(row.className).toContain('group-focus-within/user:opacity-100');
  });

  it('has a heading for each turn, for moving through the conversation by headings', () => {
    render(<MessageList sessionId="s" view={view()} mode="normal" />);
    expect(screen.getAllByRole('heading', { level: 5 }).map((h) => h.textContent)).toEqual(['You said:']);
    expect(screen.getAllByRole('heading', { level: 6 }).map((h) => h.textContent)).toEqual(['Claude said:']);
  });
});

describe('the working line', () => {
  const run = (extra: Partial<RunState>): RunState => ({ sessionId: 's', cwd: '/p', busy: true, settings: {}, permissions: [], partial: [], ...extra });

  it('counts from when the turn began, or from when Claude asked', () => {
    render(<MessageList sessionId="s" view={view({ run: run({ startedAt: Date.now() - 125_000 }) })} mode="normal" />);
    expect(screen.getByText('2m 05s')).toBeTruthy();
    cleanup();
    const request = { id: 'p', sessionId: 's', toolName: 'Bash', input: {}, canRemember: false, createdAt: Date.now() - 20_000 };
    render(<MessageList sessionId="s" view={view({ run: run({ startedAt: Date.now() - 125_000, permissions: [request] }) })} mode="normal" />);
    expect(screen.getByText('Waiting for you')).toBeTruthy();
    expect(screen.getByText('20s')).toBeTruthy();
  });

  it('falls back to the prompt that started the turn', () => {
    const messagesNow: ChatMessage[] = [{ uuid: 'u', role: 'user', blocks: [{ type: 'text', text: 'Go' }], timestamp: Date.now() - 7000 }];
    render(<MessageList sessionId="s" view={view({ messages: messagesNow, run: run({}) })} mode="normal" />);
    expect(screen.getByText('7s')).toBeTruthy();
  });
});

const tool = (name: string, input: Record<string, unknown>, content?: string, isError = false, extra: Partial<ToolCall> = {}): ToolCall => ({
  id: 't', name, input, ...(content !== undefined ? { result: { type: 'tool_result', tool_use_id: 't', content, ...(isError ? { is_error: true } : {}) } } : {}), ...extra,
});
const REJECT = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file).";

describe('what you decided stays visible', () => {
  it('a refused command says so, with your note, not as a failure', () => {
    render(<ToolCallView call={tool('Bash', { command: 'docker volume rm pg', description: 'Remove the volume' }, `${REJECT} To tell you how to proceed, the user said:\nNever remove volumes.`, true)} running={false} />);
    expect(screen.getByText('denied')).toBeTruthy();
    expect(screen.queryByText('failed')).toBeNull();
    expect(screen.getByText('Never remove volumes.')).toBeTruthy();
  });

  it('a refused edit counts no changed lines; a failed one says failed', () => {
    const edit = { file_path: '/p/a.ts', old_string: 'a', new_string: 'b\nc' };
    const { container } = render(<ToolCallView call={tool('Edit', edit, `${REJECT} STOP what you are doing.`, true)} running={false} />);
    expect(container.textContent).not.toMatch(/\+2/);
    cleanup();
    const failed = render(<ToolCallView call={tool('Edit', edit, '<tool_use_error>String to replace not found in file.</tool_use_error>', true)} running={false} />);
    expect(screen.getByText('failed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /a\.ts/ }));
    expect(failed.container.textContent).toContain('String to replace not found in file.');
    expect(failed.container.textContent).not.toContain('<tool_use_error>');
  });

  it('your answers show under Claude’s questions', () => {
    const questions = [{ question: 'Which database?', options: [] }, { question: 'Which environments?', options: [] }];
    render(<ToolCallView call={tool('AskUserQuestion', { questions }, 'Your questions have been answered: "Which database?"="Postgres", "Which environments?"="dev, staging" notes: not production yet. You can now continue with these answers in mind.')} running={false} />);
    expect(screen.getByText('Postgres')).toBeTruthy();
    expect(screen.getByText('dev, staging')).toBeTruthy();
    expect(screen.getByText('not production yet')).toBeTruthy();
    cleanup();
    render(<ToolCallView call={tool('AskUserQuestion', { questions }, 'The user chose not to answer.', true)} running={false} />);
    expect(screen.getByText('Not answered')).toBeTruthy();
  });

  it('a plan says whether you approved it or sent it back, and what you said', () => {
    const plan = { plan: '## Plan\n\n1. Drop the old tables.' };
    render(<ToolCallView call={tool('ExitPlanMode', plan, `${REJECT} To tell you how to proceed, the user said:\nKeep the old tables for a week.`, true)} running={false} />);
    expect(screen.getByText('Plan · Sent back')).toBeTruthy();
    expect(screen.getByText('Keep the old tables for a week.')).toBeTruthy();
    cleanup();
    render(<ToolCallView call={tool('ExitPlanMode', plan, 'User has approved your plan. You can now start coding.')} running={false} />);
    expect(screen.getByText('Plan · Approved')).toBeTruthy();
  });
});

describe('task lists', () => {
  const todos = { todos: [{ content: 'Read', status: 'completed' }, { content: 'Write', status: 'in_progress', activeForm: 'Writing' }] };

  it('show as a card when new, and as a line that opens to the list when they only move along', () => {
    render(<ToolCallView call={tool('TodoWrite', todos, 'ok')} running={false} />);
    expect(screen.getByText('Tasks · 1/2')).toBeTruthy();
    cleanup();
    render(<ToolCallView call={tool('TodoWrite', todos, 'ok', false, { sameTasks: true })} running={false} />);
    expect(screen.queryByText('Tasks · 1/2')).toBeNull();
    expect(screen.getByText('1/2 · Writing')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Update tasks/ }));
    expect(screen.getByText('Tasks · 1/2')).toBeTruthy();
  });
});

describe('tool output', () => {
  it('shows without escape codes', () => {
    const { container } = render(<ToolCallView call={tool('Bash', { command: 'npm test' }, '\u001b[32m✓\u001b[39m passed\rdone')} running={false} defaultOpen />);
    expect(container.querySelectorAll('pre')[1]!.textContent).toBe('done');
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
