// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage, RunState, Workflow, WorkflowAgentPage } from '../src/shared/protocol';
import type { SessionView } from '../src/web/lib/store';

// The width decides what opens by itself: a computer opens the phase at work, a phone does not.
let wide = false;
Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
Object.assign(window, { matchMedia: (query: string) => ({ matches: wide && query === '(min-width: 640px)', media: query, addEventListener() {}, removeEventListener() {} }) });

const { api } = await import('../src/web/lib/api');
const { setRun } = await import('../src/web/lib/store');
const { MessageList } = await import('../src/web/components/MessageList');

const SESSION = 'cccccccc-0000-4000-8000-000000000001';
const META = "export const meta = {\n  name: 'demo-review',\n  description: 'Review the demo app, then check each finding',\n  phases: [\n    { title: 'Review', detail: 'one agent per area' },\n    { title: 'Verify' },\n    { title: 'Report' },\n  ],\n}\nreturn await agent('Review it')\n";
const at = Date.now() - 30 * 60_000;

const call = (id = 'toolu_w', input: Record<string, unknown> = { script: META }): ChatMessage => ({ uuid: `a-${id}`, role: 'assistant', blocks: [{ type: 'tool_use', id, name: 'Workflow', input }], timestamp: at });
const launched = (id = 'toolu_w', runId = 'wf_7c2e4a10-9b3', taskId = 'w1'): ChatMessage => ({
  uuid: `r-${id}`, role: 'user', timestamp: at + 1000,
  blocks: [{ type: 'tool_result', tool_use_id: id, content: `Workflow launched in background. Task ID: ${taskId}\nRun ID: ${runId}`, workflow: { runId, taskId, name: 'demo-review', summary: 'Review the demo app, then check each finding' } }],
});
const noticeOf = (status: string, extra = '', id = 'toolu_w') => `<task-notification>\n<task-id>w1</task-id>\n<tool-use-id>${id}</tool-use-id>\n<output-file>/tmp/x/w1.output</output-file>\n<status>${status}</status>\n<summary>Dynamic workflow "Review the demo app" ${status}</summary>${extra}\n</task-notification>`;
const said = (uuid: string, text: string): ChatMessage => ({ uuid, role: 'user', blocks: [{ type: 'text', text }], timestamp: at + 2000 });
const USAGE = '<usage><agent_count>4</agent_count><agents_done>4</agents_done><subagent_tokens>412300</subagent_tokens><tool_uses>87</tool_uses><duration_ms>361250</duration_ms></usage>';

const agent = (index: number, phase: string, state: Workflow['agents'][number]['state'], extra: Partial<Workflow['agents'][number]> = {}) => ({
  index, label: `${phase.toLowerCase()}:${index}`, phaseTitle: phase, state, agentId: `a${index}`, model: 'claude-opus-5-5', tokens: 10_000 * index, toolCalls: index, ...extra,
});

const RECORD: Workflow = {
  runId: 'wf_7c2e4a10-9b3', taskId: 'w1', name: 'demo-review', description: 'Review the demo app, then check each finding', status: 'completed',
  durationMs: 361_250, totalTokens: 412_300, totalToolCalls: 87, source: 'record', result: '[{"verdicts":[]}]',
  phases: [{ title: 'Review', detail: 'one agent per area' }, { title: 'Verify' }, { title: 'Report' }],
  agents: [agent(1, 'Review', 'done', { durationMs: 180_000 }), agent(2, 'Review', 'done', { durationMs: 95_000 }), agent(3, 'Verify', 'done'), agent(4, 'Verify', 'done')],
};

const live = (extra: Partial<Workflow> = {}): Workflow => ({
  runId: 'wf_7c2e4a10-9b3', taskId: 'w1', name: 'demo-review', description: 'Review the demo app, then check each finding', status: 'running', startedAt: Date.now() - 161_000,
  phases: [{ title: 'Review', detail: 'one agent per area' }, { title: 'Verify' }, { title: 'Report' }],
  agents: [agent(1, 'Review', 'done', { durationMs: 61_000 }), agent(2, 'Review', 'progress', { startedAt: Date.now() - 100_000, lastProgressAt: Date.now() - 2000, lastToolName: 'Edit', lastToolSummary: 'src/a.ts' })],
  source: 'live', ...extra,
});

const runWith = (workflow: Workflow): RunState => ({
  sessionId: SESSION, cwd: '/work/shop', busy: false, settings: {}, permissions: [], partial: [],
  tasks: [{ id: 'w1', description: 'demo-review', type: 'local_workflow', summary: '1/2 agents' }], workflows: { toolu_w: workflow },
});

function show(messages: ChatMessage[], mode: 'normal' | 'thinking' | 'verbose' = 'normal') {
  const view: SessionView = { messages, offset: 0, total: messages.length, loaded: true, loadingOlder: false };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MessageList sessionId={SESSION} view={view} mode={mode} /></QueryClientProvider>);
}

const card = () => screen.getByRole('region', { name: 'Workflow demo-review' });
const phases = () => screen.queryByRole('list', { name: 'Phases' });
const header = () => within(card()).getAllByRole('button')[0]!;

beforeEach(() => {
  wide = false;
  vi.spyOn(api, 'workflow').mockResolvedValue(RECORD);
});
afterEach(() => {
  cleanup();
  setRun(SESSION, undefined);
  vi.restoreAllMocks();
});

describe('a Workflow call', () => {
  it('shows as a workflow, with its name, description and how it ended, never as its script', async () => {
    show([call(), launched(), said('n1', noticeOf('completed', USAGE))]);
    expect(card().textContent).toContain('Workflow');
    expect(card().textContent).toContain('Review the demo app, then check each finding');
    await waitFor(() => expect(card().textContent).toContain('Completed in 6m 1s'));
    expect(card().textContent).toContain('4 agents');
    expect(card().textContent).toContain('412.3k tokens');
    // Said in words, part by part.
    expect(header().getAttribute('aria-label')).toBe('Workflow demo-review. Review the demo app, then check each finding. Completed in 6m 1s, 4 agents, 412.3k tokens');
    expect(document.body.textContent).not.toContain('export const meta');
    // Normal folds it, as other steps: no phases until it is opened.
    expect(phases()).toBeNull();
    fireEvent.click(header());
    expect(within(phases()!).getAllByText(/2 of 2 done/, { selector: 'span' })).toHaveLength(2);
    expect(api.workflow).toHaveBeenCalledWith(SESSION, 'toolu_w');
  });

  it('opens in Verbose, every phase with its agents', async () => {
    show([call(), launched()], 'verbose');
    await waitFor(() => expect(phases()).not.toBeNull());
    expect(within(phases()!).getByText('review:1')).toBeTruthy();
    expect(within(phases()!).getByText('verify:4')).toBeTruthy();
    // A phase no agent ran in, once the run ended, says so in one line.
    expect(card().textContent).toContain('Not run: Report');
  });

  it('while it runs here: live, the phase at work open on a computer, one line a phase on a phone', async () => {
    setRun(SESSION, runWith(live()));
    show([call(), launched()], 'normal');
    expect(card().textContent).toMatch(/Running.*2m 4\ds.*1\/2 agents.*30k tokens/);
    expect(screen.getByRole('img', { name: '1 of 2 agents done, 1 running, 0 stalled, 0 failed' })).toBeTruthy();
    fireEvent.click(header());
    // On a phone each phase is a line until it is tapped.
    expect(within(phases()!).getByText(/1 of 2 done/, { selector: 'span' })).toBeTruthy();
    expect(within(phases()!).queryByText('review:2')).toBeNull();
    expect(card().textContent).toContain('Up next: Verify, Report');
    expect(api.workflow).not.toHaveBeenCalled();
    cleanup();

    wide = true;
    show([call(), launched()], 'normal');
    fireEvent.click(header());
    expect(within(phases()!).getByText('review:2')).toBeTruthy();
    expect(within(phases()!).getByText('Edit · src/a.ts')).toBeTruthy();
  });

  it('stops through the task’s Stop, where this Pelican runs it', async () => {
    const stop = vi.spyOn(api, 'stopTask').mockResolvedValue({ ok: true });
    setRun(SESSION, runWith(live()));
    show([call(), launched()], 'verbose');
    fireEvent.click(screen.getByRole('button', { name: 'Stop this workflow' }));
    expect(stop).toHaveBeenCalledWith(SESSION, 'w1');
    await waitFor(() => expect(card().textContent).toContain('Stopping…'));
    act(() => setRun(SESSION, runWith(live({ status: 'killed', durationMs: 170_000, agents: [agent(1, 'Review', 'done'), agent(2, 'Review', 'error', { error: 'Stopped because the workflow was stopped' })] }))));
    await waitFor(() => expect(card().textContent).toContain('Stopped'));
    expect(screen.queryByRole('button', { name: 'Stop this workflow' })).toBeNull();
    // An agent the stop cut short is stopped, not failed.
    expect(within(phases()!).getByText('Stopped:')).toBeTruthy();
  });

  it('says it failed, and why', async () => {
    vi.spyOn(api, 'workflow').mockResolvedValue({ ...RECORD, status: 'failed', source: 'journal', agents: [], error: undefined, result: undefined });
    show([call(), launched(), said('n1', noticeOf('failed').replace('failed</summary>', 'failed: TypeError: x &lt;y&gt;</summary>'))], 'verbose');
    await waitFor(() => expect(card().textContent).toContain('Failed'));
    expect(card().textContent).toContain('TypeError: x <y>');
  });

  it('says it stopped when the Claude Code that ran it ended without its end', async () => {
    vi.spyOn(api, 'workflow').mockResolvedValue({ ...RECORD, status: 'stopped', source: 'journal', agents: [agent(1, 'Review', 'progress')] });
    show([call(), launched()], 'verbose');
    await waitFor(() => expect(card().textContent).toContain('Stopped'));
    expect(within(phases()!).getByText('Stopped:')).toBeTruthy();
  });

  it('that did not compile says so, and asks the server for nothing', () => {
    show([call(), { uuid: 'r', role: 'user', blocks: [{ type: 'tool_result', tool_use_id: 'toolu_w', content: 'Workflow script has a syntax error and was not launched:\nUnexpected token (3:4)', is_error: true }] }], 'verbose');
    expect(card().textContent).toContain('Not launched');
    expect(card().textContent).toContain('Unexpected token (3:4)');
    expect(api.workflow).not.toHaveBeenCalled();
    // Its plan is still there to read.
    expect(card().textContent).toContain('Review — one agent per area');
  });

  it('is named by its end in the conversation, a line that leads to the card instead of a copy of it', async () => {
    show([call(), launched(), said('n1', noticeOf('completed', `<result>[{"verdicts":[]}]</result>${USAGE}`))]);
    const line = screen.getByRole('button', { name: /Workflow demo-review completed · 6m 1s/ });
    expect(screen.queryAllByText(/verdicts/)).toHaveLength(0);
    expect(phases()).toBeNull();
    fireEvent.click(line);
    await waitFor(() => expect(phases()).not.toBeNull());
  });

  it('whose run a later call resumed points there', async () => {
    show([call('toolu_a'), launched('toolu_a', 'wf_7c2e4a10-9b3', 'w0'), call('toolu_w'), launched('toolu_w', 'wf_7c2e4a10-9b3', 'w1')], 'verbose');
    const first = screen.getAllByRole('region', { name: 'Workflow demo-review' })[0]!;
    expect(within(first).getByRole('button', { name: 'Resumed in a later call' })).toBeTruthy();
  });
});

describe('a workflow agent', () => {
  const page = (messages: ChatMessage[], offset: number, extra: Partial<WorkflowAgentPage> = {}): WorkflowAgentPage => ({ messages, total: offset + messages.length, offset, ...extra });
  const step = (n: number): ChatMessage[] => [
    { uuid: `s${n}`, role: 'assistant', blocks: [{ type: 'tool_use', id: `t${n}`, name: 'Read', input: { file_path: `/work/shop/file${n}.ts` } }] },
    { uuid: `s${n}r`, role: 'user', blocks: [{ type: 'tool_result', tool_use_id: `t${n}`, content: 'ok' }] },
  ];

  it('opens into its steps, newest first loaded, with what it was asked and what it returned', async () => {
    const pages = vi.spyOn(api, 'workflowAgent').mockImplementation(async (_s, _c, _a, before) => (before === undefined
      ? page([...step(2), ...step(3)], 2, { prompt: 'Review the server.', result: '{"findings":[]}' })
      : page(step(1), 0)));
    wide = true;
    show([call(), launched()], 'verbose');
    await waitFor(() => expect(phases()).not.toBeNull());
    fireEvent.click(within(phases()!).getByText('review:1'));
    await waitFor(() => expect(screen.getByText('file3.ts')).toBeTruthy());
    expect(screen.getByText('file2.ts')).toBeTruthy();
    expect(screen.queryByText('file1.ts')).toBeNull();
    expect(pages).toHaveBeenCalledWith(SESSION, 'toolu_w', 'a1');
    expect(screen.getByText('Prompt')).toBeTruthy();
    expect(screen.getByText('Outcome')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show earlier steps' }));
    await waitFor(() => expect(screen.getByText('file1.ts')).toBeTruthy());
    expect(pages).toHaveBeenCalledWith(SESSION, 'toolu_w', 'a1', 2);
  });
});

describe('a workflow asking to run', () => {
  it('shows its phases and what running it costs, the script a tap away, as Claude Code asks', async () => {
    const { PermissionCard } = await import('../src/web/components/PermissionCard');
    render(<PermissionCard sessionId={SESSION} request={{ id: 'p1', sessionId: SESSION, toolName: 'Workflow', input: { script: META }, createdAt: Date.now() }} />);
    expect(screen.getByText('Claude wants to run a dynamic workflow')).toBeTruthy();
    expect(document.body.textContent).toContain('This dynamic workflow will spin up multiple subagents across the following phases:');
    expect(document.body.textContent).toContain('Review — one agent per area');
    expect(document.body.textContent).toContain('can use a lot of tokens quickly');
    expect(document.body.textContent).not.toContain('export const meta');
    fireEvent.click(screen.getByRole('button', { name: 'View raw script' }));
    expect(document.body.textContent).toContain('export const meta');
  });
});
