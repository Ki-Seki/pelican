// @vitest-environment jsdom
// A workflow agent opened in its card: what it was asked, what it returned, and its steps, kept up
// to date while it works. Made-up data in the shapes the server sends.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage, RunState, Workflow, WorkflowAgentPage } from '../src/shared/protocol';
import type { SessionView } from '../src/web/lib/store';

let wide = true;
Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
Object.assign(window, { matchMedia: (query: string) => ({ matches: wide && query === '(min-width: 640px)', media: query, addEventListener() {}, removeEventListener() {} }) });

const { api } = await import('../src/web/lib/api');
const { setRun } = await import('../src/web/lib/store');
const { MessageList } = await import('../src/web/components/MessageList');

const SESSION = 'dddddddd-0000-4000-8000-000000000001';
const META = "export const meta = {\n  name: 'demo-review',\n  description: 'Review the demo app',\n  phases: [{ title: 'Review' }, { title: 'Verify' }],\n}\n";
const at = Date.now() - 10 * 60_000;
const call: ChatMessage = { uuid: 'a-w', role: 'assistant', blocks: [{ type: 'tool_use', id: 'toolu_w', name: 'Workflow', input: { script: META } }], timestamp: at };
const launched: ChatMessage = {
  uuid: 'r-w', role: 'user', timestamp: at + 1000,
  blocks: [{ type: 'tool_result', tool_use_id: 'toolu_w', content: 'Workflow launched in background. Task ID: w1\nRun ID: wf_7c2e4a10-9b3', workflow: { runId: 'wf_7c2e4a10-9b3', taskId: 'w1', name: 'demo-review', summary: 'Review the demo app' } }],
};

type Agent = Workflow['agents'][number];
const agent = (index: number, state: Agent['state'], extra: Partial<Agent> = {}): Agent => ({
  index, label: `review:${index}`, phaseTitle: 'Review', state, agentId: `a${index}`, model: 'claude-opus-5-5', ...extra,
});
const flow = (extra: Partial<Workflow>): Workflow => ({
  runId: 'wf_7c2e4a10-9b3', taskId: 'w1', name: 'demo-review', description: 'Review the demo app', status: 'running', startedAt: Date.now() - 120_000,
  phases: [{ title: 'Review' }, { title: 'Verify' }], agents: [], source: 'journal', ...extra,
});
const step = (n: number, answered = true): ChatMessage[] => [
  { uuid: `s${n}`, role: 'assistant', blocks: [{ type: 'tool_use', id: `t${n}`, name: 'Read', input: { file_path: `/work/shop/file${n}.ts` } }] },
  ...(answered ? [{ uuid: `s${n}r`, role: 'user' as const, blocks: [{ type: 'tool_result' as const, tool_use_id: `t${n}`, content: 'ok' }] }] : []),
];
const stepsOf = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => step(from + i)).flat();

/** An agent's transcript as the server pages it: the newest, before a message, or from one on. */
function serve(all: () => ChatMessage[], extra: Partial<WorkflowAgentPage> = {}) {
  return vi.spyOn(api, 'workflowAgent').mockImplementation(async (_s, _c, _a, before, after) => {
    const messages = all();
    if (after !== undefined) return { messages: messages.slice(after, after + 60), total: messages.length, offset: Math.min(after, messages.length), ...extra };
    const end = before ?? messages.length;
    const offset = Math.max(0, end - 60);
    return { messages: messages.slice(offset, end), total: messages.length, offset, ...extra };
  });
}

function show(messages: ChatMessage[], mode: 'normal' | 'verbose' = 'verbose') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view: SessionView = { messages, offset: 0, total: messages.length, loaded: true, loadingOlder: false };
  return render(<QueryClientProvider client={client}><MessageList sessionId={SESSION} view={view} mode={mode} /></QueryClientProvider>);
}
const card = () => screen.getByRole('region', { name: 'Workflow demo-review' });
const runWith = (workflow: Workflow): RunState => ({ sessionId: SESSION, cwd: '/work/shop', busy: false, settings: {}, permissions: [], partial: [], workflows: { toolu_w: workflow } });
const shown = (n: number) => screen.queryByText(`file${n}.ts`) !== null;

beforeEach(() => {
  wide = true;
});
afterEach(() => {
  cleanup();
  setRun(SESSION, undefined);
  vi.restoreAllMocks();
});

describe('an agent at work, opened', () => {
  it('keeps every step once earlier ones are shown and it goes on: asked only for what is new', async () => {
    // 100 steps (200 messages); the newest page holds 70-99.
    let all = stepsOf(0, 99);
    const pages = serve(() => all);
    setRun(SESSION, runWith(flow({ source: 'live', agents: [agent(1, 'progress', { startedAt: Date.now() - 50_000, lastProgressAt: Date.now(), toolCalls: 100 })] })));
    show([call, launched]);
    fireEvent.click(await screen.findByText('review:1'));
    await screen.findByText('file99.ts');
    // Verbose: every step loaded shows; the CLI's count is of them all.
    expect(card().textContent).toContain('Activity · last 30 of 100 tool calls');
    fireEvent.click(screen.getByRole('button', { name: 'Show earlier' }));
    await screen.findByText('file40.ts');
    // It takes two more steps; the newest 60 would now start at step 72.
    all = [...all, ...step(100), ...step(101)];
    await screen.findByText('file101.ts', undefined, { timeout: 5000 });
    expect([40, 69, 70, 71, 99, 100].map((n) => [n, shown(n)])).toEqual([40, 69, 70, 71, 99, 100].map((n) => [n, true]));
    // Asked from the last message it held on, not the newest 60 again.
    expect(pages.mock.calls.some((c) => c[4] === 199)).toBe(true);
  }, 10_000);

  it('starts again from the newest when its transcript changed under it', async () => {
    let all = stepsOf(1, 3);
    serve(() => all);
    setRun(SESSION, runWith(flow({ source: 'live', agents: [agent(1, 'progress', { startedAt: Date.now() - 50_000, lastProgressAt: Date.now() })] })));
    show([call, launched]);
    fireEvent.click(await screen.findByText('review:1'));
    await screen.findByText('file3.ts');
    // Begun again (another attempt in the same file): what it held is not its any more.
    all = [...stepsOf(7, 8)];
    await screen.findByText('file8.ts', undefined, { timeout: 5000 });
    expect(shown(3)).toBe(false);
  }, 10_000);

  it('shows the steps it took in its last seconds once it ends', async () => {
    let state: Workflow = flow({ agents: [agent(1, 'progress', { startedAt: Date.now() - 60_000, lastProgressAt: Date.now() })] });
    vi.spyOn(api, 'workflow').mockImplementation(async () => state);
    let all = [...step(1), ...step(2, false)];
    const pages = serve(() => all);
    show([call, launched]);
    fireEvent.click(await screen.findByText('review:1'));
    await screen.findByText('file2.ts');
    const asked = pages.mock.calls.length;
    // Within a second it reads file 2, then file 3, and ends; the card hears so at its next ask.
    all = [...step(1), ...step(2), ...step(3)];
    state = flow({ agents: [agent(1, 'done', { startedAt: Date.now() - 60_000, durationMs: 61_000, resultPreview: 'All clear.' })] });
    await waitFor(() => expect(card().textContent).toContain('All clear.'), { timeout: 5000 });
    await screen.findByText('file3.ts');
    expect(pages.mock.calls.length).toBeGreaterThan(asked);
  }, 15_000);

  it('asks for no steps while it is queued, with no id yet, and shows the prompt it waits with', async () => {
    const queued = { ...agent(2, 'start', { queuedAt: Date.now() - 5000, promptPreview: 'Review the client side of the checkout.' }), agentId: undefined } as Agent;
    vi.spyOn(api, 'workflow').mockResolvedValue(flow({ agents: [agent(1, 'progress', { startedAt: Date.now() - 60_000 }), queued] }));
    const pages = vi.spyOn(api, 'workflowAgent').mockRejectedValue(new Error('Not found'));
    show([call, launched]);
    fireEvent.click(await screen.findByText('review:2'));
    expect(card().textContent).toContain('Waiting for an agent slot.');
    fireEvent.click(within(card()).getByRole('button', { name: 'Prompt' }));
    expect(card().textContent).toContain('Review the client side of the checkout.');
    await new Promise((resolve) => setTimeout(resolve, 3500));
    expect(pages).not.toHaveBeenCalled();
  }, 10_000);
});

describe('an agent done before its result reached the run’s journal, opened', () => {
  it('asks again each second for what it returned, instead of saying it returned nothing', async () => {
    let page: Partial<WorkflowAgentPage> = { resultComing: true };
    vi.spyOn(api, 'workflow').mockResolvedValue(flow({ agents: [agent(1, 'done', { durationMs: 9000 })] }));
    const pages = vi.spyOn(api, 'workflowAgent').mockImplementation(async () => ({ messages: step(1), total: 2, offset: 0, ...page }));
    show([call, launched]);
    fireEvent.click(await screen.findByText('review:1'));
    await waitFor(() => expect(pages).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(card().textContent).not.toContain('(empty)');
    // Claude Code writes the journal's result line: the next ask has it.
    page = { result: 'No findings.' };
    await waitFor(() => expect(card().textContent).toContain('No findings.'), { timeout: 3000 });
    const asked = pages.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    // Once there, it is not asked for again.
    expect(pages.mock.calls.length).toBe(asked);
    expect(card().textContent).not.toContain('(empty)');
  }, 10_000);
});

describe('an agent that finished, opened', () => {
  it('says what it returned first, then the last of its steps, the rest a tap away, as the CLI’s agent card does', async () => {
    vi.spyOn(api, 'workflow').mockResolvedValue(flow({ status: 'completed', source: 'record', durationMs: 361_000, agents: [agent(1, 'done', { toolCalls: 12, durationMs: 60_000 })] }));
    serve(() => stepsOf(1, 12), { result: '{"findings":[]}', prompt: 'Review the server.' });
    show([call, launched], 'normal');
    fireEvent.click(within(card()).getAllByRole('button')[0]!);
    fireEvent.click(await screen.findByRole('button', { name: 'Done: Review, 1 of 1 done' }));
    fireEvent.click(await screen.findByText('review:1'));
    await screen.findByText('file12.ts');
    expect([10, 11, 12].every(shown)).toBe(true);
    expect(shown(9)).toBe(false);
    expect(card().textContent).toContain('Activity · last 3 of 12 tool calls');
    const text = card().textContent!;
    expect(text.indexOf('Outcome')).toBeLessThan(text.indexOf('Activity'));
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect([1, 6, 12].every(shown)).toBe(true);
    expect(card().textContent).toContain('Activity · 12 tool calls');
  });

  it('with no steps at all says so as the CLI does, not that they are still to come', async () => {
    vi.spyOn(api, 'workflow').mockResolvedValue(flow({ status: 'completed', source: 'record', agents: [agent(1, 'done', { durationMs: 1000 }), agent(2, 'progress', { startedAt: Date.now() })] }));
    serve(() => [{ uuid: 'p', role: 'user', blocks: [{ type: 'text', text: 'Say hello.' }] }]);
    show([call, launched]);
    fireEvent.click(await screen.findByText('review:1'));
    expect(await screen.findByText('No tool calls.')).toBeTruthy();
    expect(screen.queryByText('No tool calls yet.')).toBeNull();
  });

  it('in Verbose shows all its steps', async () => {
    vi.spyOn(api, 'workflow').mockResolvedValue(flow({ status: 'completed', source: 'record', agents: [agent(1, 'done', { toolCalls: 8 })] }));
    serve(() => stepsOf(1, 8));
    show([call, launched], 'verbose');
    fireEvent.click(await screen.findByText('review:1'));
    await screen.findByText('file8.ts');
    expect([1, 4, 8].every(shown)).toBe(true);
  });
});

describe('an agent’s row', () => {
  it('names the model it ran on, the one Claude Code fell back to', async () => {
    vi.spyOn(api, 'workflow').mockResolvedValue(flow({ status: 'completed', source: 'record', agents: [agent(1, 'done', { model: 'claude-opus-5-5', fallbackModel: 'claude-opus-4-8', durationMs: 1000 })] }));
    show([call, launched]);
    const row = await screen.findByRole('button', { name: /^Completed: review:1, / });
    expect(row.textContent).toContain('Opus 4.8');
    expect(row.textContent).not.toContain('Opus 5.5');
  });

  it('on a phone gives the label the row’s width, its figures under it, and opened, the whole label', async () => {
    wide = false;
    const label = 'review:workspace-files-view-and-its-routes';
    vi.spyOn(api, 'workflow').mockResolvedValue(flow({ status: 'completed', source: 'record', agents: [agent(1, 'done', { label, tokens: 120_800, durationMs: 181_000 })] }));
    serve(() => []);
    show([call, launched]);
    const name = await screen.findByText(label);
    expect(name.className).toContain('truncate');
    // The figures are in the label's column, not beside it.
    expect(name.parentElement!.textContent).toContain('120.8k tok · 3m 1s');
    fireEvent.click(name);
    expect(screen.getByText(label).className).not.toContain('truncate');
    expect(screen.getByText(label).className).toContain('break-words');
  });
});

describe('an Agent call’s steps', () => {
  const agentCall: ChatMessage = { uuid: 'a-ag', role: 'assistant', blocks: [{ type: 'tool_use', id: 'toolu_ag', name: 'Agent', input: { description: 'Look around', prompt: 'Look around the shop.' } }], timestamp: at };
  const agentDone: ChatMessage = { uuid: 'r-ag', role: 'user', timestamp: at + 1000, blocks: [{ type: 'tool_result', tool_use_id: 'toolu_ag', content: 'All clear.\nagentId: ag1' }] };

  // Each page draws every step loaded so far, so this keeps to few: pages of 20 messages (10
  // steps) here, where the server's are 60; and, drawn on a busy computer, more time than most.
  it('come a page at a time, the newest first, saying when earlier ones are left to show', async () => {
    // 25 steps (50 messages).
    const all = stepsOf(0, 24);
    const pages = vi.spyOn(api, 'subagent').mockImplementation(async (_s, _a, before) => {
      const end = before ?? all.length;
      const offset = Math.max(0, end - 20);
      return { messages: all.slice(offset, end), total: all.length, offset };
    });
    // Verbose: the call is open, with its instructions, its steps and its answer.
    show([agentCall, agentDone]);
    fireEvent.click(await screen.findByText('Steps it took'));
    await screen.findByText('Last 10 steps');
    expect(pages).toHaveBeenCalledWith(SESSION, 'ag1');
    expect(shown(24) && shown(15) && !shown(14)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Show earlier' }));
    await screen.findByText('Last 20 steps');
    expect(pages).toHaveBeenLastCalledWith(SESSION, 'ag1', 30);
    expect(shown(5) && !shown(4)).toBe(true);
    // All of it shown: no word of more.
    fireEvent.click(screen.getByRole('button', { name: 'Show earlier' }));
    await screen.findByText('25 steps');
    expect(pages).toHaveBeenLastCalledWith(SESSION, 'ag1', 10);
    expect(screen.queryByRole('button', { name: 'Show earlier' })).toBeNull();
    expect(shown(0)).toBe(true);
  }, 15_000);
});
