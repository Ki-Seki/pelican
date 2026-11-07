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
// A step's menu opens in a dialog, which jsdom does not show.
HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
  this.removeAttribute('open');
};

const { api } = await import('../src/web/lib/api');
const { setRun } = await import('../src/web/lib/store');
const { MessageList } = await import('../src/web/components/MessageList');
const { RunInTerminal } = await import('../src/web/lib/terminals');

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

function show(messages: ChatMessage[], mode: 'normal' | 'thinking' | 'verbose' = 'normal', runInTerminal?: (command: string) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (list: ChatMessage[]) => {
    const view: SessionView = { messages: list, offset: 0, total: list.length, loaded: true, loadingOlder: false };
    return <QueryClientProvider client={client}><RunInTerminal.Provider value={runInTerminal}><MessageList sessionId={SESSION} view={view} mode={mode} /></RunInTerminal.Provider></QueryClientProvider>;
  };
  const shown = render(tree(messages));
  /** The same page, its conversation grown. */
  return { ...shown, again: (list: ChatMessage[]) => shown.rerender(tree(list)) };
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
    // An agent the stop cut short is stopped, not failed; so is its phase.
    expect(within(phases()!).getByRole('button', { name: /^Stopped: review:2, / })).toBeTruthy();
    expect(within(phases()!).getByRole('button', { name: 'Stopped: Review, 1 of 2 done' })).toBeTruthy();
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
    expect(within(phases()!).getByRole('button', { name: /^Stopped: review:1, / })).toBeTruthy();
  });

  it('that did not compile says so, and asks the server for nothing', () => {
    show([call(), { uuid: 'r', role: 'user', blocks: [{ type: 'tool_result', tool_use_id: 'toolu_w', content: 'Workflow script has a syntax error and was not launched:\nUnexpected token (3:4)', is_error: true }] }], 'verbose');
    expect(card().textContent).toContain('Not launched');
    expect(card().textContent).toContain('Unexpected token (3:4)');
    expect(api.workflow).not.toHaveBeenCalled();
    // Its plan is still there to read.
    expect(card().textContent).toContain('Review — one agent per area');
  });

  it('not answered yet in another app (waiting there for approval, say) claims nothing; one sent to the cloud says where', () => {
    show([call()], 'verbose');
    expect(card().textContent).not.toMatch(/Not launched|Running|Stopped/);
    expect(card().textContent).toContain('Review — one agent per area');
    cleanup();
    show([call(), { uuid: 'r', role: 'user', blocks: [{ type: 'tool_result', tool_use_id: 'toolu_w', content: 'Session: https://claude.ai/code/s1', workflow: { taskId: 'r1', name: 'demo-review', sessionUrl: 'https://claude.ai/code/s1' } }] }], 'verbose');
    expect(card().textContent).toContain('Running in a cloud session');
    expect(screen.getByRole('link', { name: 'Open the cloud session' }).getAttribute('href')).toBe('https://claude.ai/code/s1');
    expect(api.workflow).not.toHaveBeenCalled();
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
    fireEvent.click(screen.getByRole('button', { name: 'Show earlier' }));
    await waitFor(() => expect(screen.getByText('file1.ts')).toBeTruthy());
    expect(pages).toHaveBeenCalledWith(SESSION, 'toolu_w', 'a1', 2);
  });

  it('offers no Run in terminal on a command one of its agents ran', async () => {
    vi.spyOn(api, 'workflowAgent').mockResolvedValue(page([
      { uuid: 'b1', role: 'assistant', blocks: [{ type: 'tool_use', id: 'tb1', name: 'Bash', input: { command: 'ls -la && touch WORKFLOW_STEP_RAN', description: 'List the files' } }] },
      { uuid: 'b1r', role: 'user', blocks: [{ type: 'tool_result', tool_use_id: 'tb1', content: 'README.md' }] },
    ], 0, { prompt: 'Review the server.' }));
    wide = true;
    show([call(), launched()], 'verbose', vi.fn());
    await waitFor(() => expect(phases()).not.toBeNull());
    fireEvent.click(within(phases()!).getByText('review:1'));
    fireEvent.click(await screen.findByRole('button', { name: /^More for Run List the files/ }));
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem').map((item) => item.textContent);
    expect(items).toContain('Copy command');
    expect(items).not.toContain('Run in terminal');
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

describe('a run this Pelican ran, once it lets the run go', () => {
  it('never goes back to what the card read before its live report came', async () => {
    // The page loaded its messages before its run state: the card asked the server once.
    const early: Workflow = { ...live({ totalTokens: 50_000 }), agents: [agent(1, 'Review', 'progress', { startedAt: Date.now() - 60_000 }), agent(2, 'Review', 'start', { queuedAt: Date.now() - 60_000 })] };
    const answers = vi.spyOn(api, 'workflow').mockResolvedValueOnce(early);
    const { again } = show([call(), launched()], 'verbose');
    await waitFor(() => expect(card().textContent).toContain('50k tokens'));
    // Then its run state came, and it ran to its end here.
    const ended = live({ status: 'completed', durationMs: 361_250, totalTokens: 412_300, agents: [agent(1, 'Review', 'done'), agent(2, 'Review', 'done')] });
    act(() => setRun(SESSION, runWith(ended)));
    again([call(), launched(), said('n1', noticeOf('completed', USAGE))]);
    await waitFor(() => expect(card().textContent).toContain('412.3k tokens'));
    // Two minutes on, Pelican lets its live copy go; the card asks the server again, still on its way.
    answers.mockImplementation(() => new Promise(() => undefined));
    act(() => setRun(SESSION, { ...runWith(ended), workflows: {} }));
    expect(card().textContent).toContain('412.3k tokens');
    expect(card().textContent).toContain('2 of 2 done');
  });
});

describe('a running workflow on a computer', () => {
  it('keeps open the phase at work, and the agent the reader opened in it, when that phase is done', async () => {
    wide = true;
    vi.spyOn(api, 'workflowAgent').mockResolvedValue({ messages: [], total: 0, offset: 0, prompt: 'Review the server.' });
    setRun(SESSION, runWith(live({ agents: [agent(1, 'Review', 'progress', { startedAt: Date.now() - 60_000, lastProgressAt: Date.now() })] })));
    show([call(), launched()], 'normal');
    fireEvent.click(header());
    fireEvent.click(within(phases()!).getByText('review:1'));
    await waitFor(() => expect(screen.getByText('Prompt')).toBeTruthy());
    // The agent finishes, and with it the phase; the run goes on to Verify, which opens too.
    act(() => setRun(SESSION, runWith(live({ agents: [agent(1, 'Review', 'done', { durationMs: 61_000 }), agent(2, 'Verify', 'progress', { startedAt: Date.now() })] }))));
    expect(screen.getByText('Prompt')).toBeTruthy();
    expect(within(phases()!).getByText('verify:2')).toBeTruthy();
  });

  it('says to a screen reader what its grid shows: agents that failed or stalled', () => {
    setRun(SESSION, runWith(live({ agents: [agent(1, 'Review', 'error', { error: 'API Error: 529' }), agent(2, 'Review', 'progress', { startedAt: Date.now() - 300_000, lastProgressAt: Date.now() - 120_000 })] })));
    show([call(), launched()], 'normal');
    expect(header().getAttribute('aria-label')).toMatch(/0\/2 agents, 30k tokens, 1 failed, 1 stalled$/);
  });
});

describe('a paused run', () => {
  it('is not running, as the CLI tells it: its time stops, its agents stopped, and it can still be stopped', () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      setRun(SESSION, runWith(live({ status: 'paused', durationMs: 600_000, agents: [agent(1, 'Review', 'done', { durationMs: 1000 }), agent(2, 'Review', 'progress', { startedAt: Date.now() - 500_000, lastProgressAt: Date.now() - 400_000 })] })));
      show([call(), launched()], 'verbose');
      const before = card().textContent;
      expect(before).toContain('Paused');
      expect(before).toContain('10m 0s');
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(card().textContent).toBe(before);
      expect(within(phases()!).getByRole('button', { name: /^Stopped: review:2, / })).toBeTruthy();
      expect(card().textContent).toContain('Not run: Verify, Report');
      expect(screen.queryByRole('img', { name: /agents done/ })).toBeNull();
      expect(screen.getByRole('button', { name: 'Stop this workflow' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a run that ended before any agent started', () => {
  it('says so in Desktop’s words, with the plan it had', async () => {
    vi.spyOn(api, 'workflow').mockResolvedValue({ ...RECORD, status: 'failed', durationMs: 400, agents: [], totalTokens: 0, error: 'TypeError: phases is not iterable', result: undefined });
    show([call(), launched()], 'verbose');
    await waitFor(() => expect(card().textContent).toContain('Failed before any agents started'));
    expect(card().textContent).toContain('TypeError: phases is not iterable');
    expect(card().textContent).toContain('Review — one agent per area');
  });
});

describe('a run’s result', () => {
  it('shows as code, also when it was cut short, never as Markdown', async () => {
    const { resultMarkdown } = await import('../src/web/lib/workflows');
    // What the server sends of a long one: laid out, cut where a line ends, with what was left out.
    const value = [{ findings: Array.from({ length: 240 }, (_, i) => ({ title: `Finding ${i}: \`a_${i}.ts\` skips the *owner* check when __proto__ is set` })) }];
    const full = JSON.stringify(value, null, 2);
    const cut = `${full.slice(0, full.lastIndexOf('\n', 16 * 1024))}\n... (truncated 3000 chars)`;
    for (const text of [cut, `${full.slice(0, 16 * 1024)}\n…`, '[{"verdicts":[{"finding":"x"', JSON.stringify(value)]) expect(resultMarkdown(text).startsWith('```json\n')).toBe(true);
    // An agent's own words stay words, also in brackets; a string Claude Code wrote as JSON is its text.
    expect(resultMarkdown('[harness: subagent output matched an instruction-shaped pattern] All clear.')).toBe('[harness: subagent output matched an instruction-shaped pattern] All clear.');
    expect(resultMarkdown('**All clear.**')).toBe('**All clear.**');
    expect(resultMarkdown('"All clear."')).toBe('All clear.');
  });
});

describe('a Workflow card, read', () => {
  it('folds a long description to two lines, and shows its name and description whole once opened', () => {
    const long = 'Review every route of the server and every page of the client, then have a skeptic check each finding, then fix what holds up, with a test for each fix';
    show([call('toolu_w', { script: META.replace('Review the demo app, then check each finding', long) }), launched()], 'normal');
    const description = within(card()).getByText(long);
    // line-clamp sets how it is shown itself: a class that shows it as a block would undo the clamp.
    expect(description.className.split(' ')).toContain('line-clamp-2');
    expect(description.className.split(' ')).not.toContain('block');
    fireEvent.click(header());
    expect(within(card()).getByText(long).className).not.toContain('line-clamp');
    expect(within(card()).getByText('demo-review').className).not.toContain('truncate');
  });

  it('takes the focus when the line about its end leads to it', async () => {
    show([call(), launched(), said('n1', noticeOf('completed', USAGE))]);
    const line = screen.getByRole('button', { name: /Workflow demo-review completed/ });
    line.focus();
    fireEvent.click(line);
    await waitFor(() => expect(document.activeElement).toBe(header()));
  });

  it('whose meta holds an escape no string could hold still shows, as a call Claude Code did not launch', async () => {
    const { describeTool } = await import('../src/web/lib/tools');
    const script = "export const meta = {\n  name: 'tidy',\n  description: 'Tidy \\u{-1} up',\n  phases: [{ title: 'Tidy' }],\n}\nreturn 1\n";
    expect(() => describeTool('Workflow', { script })).not.toThrow();
    show([call('toolu_bad', { script }), { uuid: 'r', role: 'user', blocks: [{ type: 'tool_result', tool_use_id: 'toolu_bad', is_error: true, content: 'Workflow script has a syntax error and was not launched:\nInvalid Unicode escape sequence' }] }], 'verbose');
    const refused = screen.getByRole('region', { name: 'Workflow tidy' });
    expect(refused.textContent).toContain('Not launched');
    expect(refused.textContent).toContain('Invalid Unicode escape sequence');
  });
});

describe('a run whose every field is hostile', () => {
  const X = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>';
  const LINK = '[open](javascript:window.__pwned=1) ![p](https://tracker.example/p.png) <a href="javascript:window.__pwned=1">a</a>';
  const SCRIPT = `export const meta = {\n  name: 'n',\n  description: 'desc ${X}',\n  phases: [{ title: 'P ${X}', detail: 'D ${X}' }],\n}\n// \`\`\`\n</code></pre>${X}\nreturn 1\n`;

  it('shows every field as text: no element, handler or script link of its own', async () => {
    wide = true;
    vi.spyOn(api, 'workflow').mockResolvedValue({
      runId: 'wf_7c2e4a10-9b3', taskId: 'w1', name: `name ${X}`, description: `desc ${X}`, status: 'failed', durationMs: 1000, source: 'record',
      error: `error ${X}`, result: `result ${X} ${LINK}`, script: SCRIPT, phases: [{ title: `P ${X}`, detail: `D ${X}` }],
      agents: [
        { index: 1, label: `label ${X}`, phaseTitle: `P ${X}`, state: 'done', agentId: 'a1', model: `m ${X}`, agentType: `t ${X}`, resultPreview: `rp ${X} ${LINK}`, promptPreview: `pp ${X}` },
        { index: 2, label: `label2 ${X}`, phaseTitle: `P ${X}`, state: 'error', agentId: 'a2', error: `agent error ${X}` },
      ],
    });
    vi.spyOn(api, 'workflowAgent').mockResolvedValue({
      messages: [
        { uuid: 's1', role: 'assistant', blocks: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: `echo ${X}`, description: `d ${X}` } }] },
        { uuid: 's2', role: 'user', blocks: [{ type: 'tool_result', tool_use_id: 't1', content: `${X} ${LINK}` }] },
      ],
      total: 2, offset: 0, prompt: `prompt ${X}`, result: `result ${X} ${LINK}`,
    });
    show([
      call('toolu_w', { scriptPath: '/x/workflows/scripts/n-wf_7c2e4a10-9b3.js' }),
      { uuid: 'r', role: 'user', timestamp: at + 1000, blocks: [{ type: 'tool_result', tool_use_id: 'toolu_w', content: 'Workflow launched in background.', workflow: { runId: 'wf_7c2e4a10-9b3', taskId: 'w1', name: `n ${X}`, summary: `s ${X}`, sessionUrl: 'javascript:alert(1)' } }] },
      said('n', '<task-notification>\n<task-id>w1</task-id>\n<tool-use-id>toolu_w</tool-use-id>\n<output-file>/o</output-file>\n<status>failed</status>\n<summary>Dynamic workflow "x" failed: &lt;img src=x onerror=alert(1)&gt;</summary>\n<result>&lt;script&gt;alert(1)&lt;/script&gt;</result>\n</task-notification>'),
    ], 'verbose');
    await waitFor(() => expect(phases()).not.toBeNull());
    for (const row of within(phases()!).getAllByRole('button', { name: /label/ })) fireEvent.click(row);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Prompt' })).toHaveLength(2));
    for (const button of screen.getAllByRole('button', { name: 'Prompt' })) fireEvent.click(button);
    expect(document.body.textContent).toContain('prompt <img');
    // The script, then the result: one at a time.
    fireEvent.click(screen.getByRole('button', { name: 'Script' }));
    expect(document.body.textContent).toContain('</code></pre><img');
    const scriptOpen = document.body.innerHTML;
    fireEvent.click(screen.getByRole('button', { name: 'Result' }));
    expect(document.body.textContent).toContain('<script>window.__pwned=1</script>');
    expect(scriptOpen).not.toMatch(/<(img|script)[\s>]/);
    expect(document.querySelectorAll('script, iframe, object, embed')).toHaveLength(0);
    expect([...document.querySelectorAll('img')].map((i) => i.getAttribute('src'))).toEqual([]);
    expect([...document.querySelectorAll('*')].flatMap((e) => [...e.attributes].filter((a) => /^on/i.test(a.name)).map((a) => a.name))).toEqual([]);
    expect([...document.querySelectorAll('[href]')].map((a) => a.getAttribute('href')).filter((h) => /^\s*javascript:/i.test(h ?? ''))).toEqual([]);
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
  });
});
