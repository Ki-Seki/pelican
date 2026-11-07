// @vitest-environment jsdom
// An Agent call whose agent Claude left working in the background, as its card shows it: never
// Claude Code's words to Claude for its launch, how it stands and what it is doing, its steps read
// again while it works, Stop, and once Claude Code says it ended, what it returned, in the card.
// Made-up data in the shapes Claude Code writes.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage, MessagesPage, RunState } from '../src/shared/protocol';
import type { SessionView } from '../src/web/lib/store';

Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
Object.assign(window, { matchMedia: (query: string) => ({ matches: query === '(min-width: 640px)', media: query, addEventListener() {}, removeEventListener() {} }) });
Element.prototype.scrollIntoView ??= function scrollIntoView() {};

const { api } = await import('../src/web/lib/api');
const { setRun } = await import('../src/web/lib/store');
const { MessageList } = await import('../src/web/components/MessageList');

const SESSION = 'dddddddd-0000-4000-8000-0000000000a9';
const at = Date.now() - 10 * 60_000;
const AGENT = 'a1b2c3d4e5f6a7b8c';

const LAUNCH_TEXT = [
  'Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)',
  `agentId: ${AGENT} (internal ID - do not mention to user. Use SendMessage with to: '${AGENT}', summary: '<5-10 word recap>' to continue this agent.)`,
  'The agent is working in the background. You will be notified automatically when it completes.',
  'Do not duplicate this agent\'s work — avoid working with the same files or topics it is using.',
  `output_file: /tmp/claude-501/x/tasks/${AGENT}.output`,
  'Do NOT Read or tail this file via the shell tool.',
].join('\n');

const call: ChatMessage = {
  uuid: 'a-bg', role: 'assistant', timestamp: at,
  blocks: [{ type: 'tool_use', id: 'toolu_bg', name: 'Agent', input: { description: 'Look for flaky tests', subagent_type: 'general-purpose', prompt: 'Find the tests that fail now and then, and why.', run_in_background: true } }],
};
const launched = (recorded = true): ChatMessage => ({
  uuid: 'r-bg', role: 'user', timestamp: at + 1000,
  blocks: [{ type: 'tool_result', tool_use_id: 'toolu_bg', content: LAUNCH_TEXT, ...(recorded ? { agent: { mode: 'background' as const, agentId: AGENT } } : {}) }],
});
const said = (uuid: string, text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ uuid, role: 'user', timestamp: at + 60_000, blocks: [{ type: 'text', text }], ...extra });
const reply = (uuid: string, text: string): ChatMessage => ({ uuid, role: 'assistant', timestamp: at + 70_000, blocks: [{ type: 'text', text }] });

/** Claude Code's notice of the agent's end, as it writes it into the conversation. */
const notice = (status: string, summary: string, extra = '') => [
  '<task-notification>',
  `<task-id>${AGENT}</task-id>`,
  '<tool-use-id>toolu_bg</tool-use-id>',
  `<output-file>/tmp/claude-501/x/tasks/${AGENT}.output</output-file>`,
  `<status>${status}</status>`,
  `<summary>${summary}</summary>`,
  '<note>A task-notification fires each time this agent stops with no live background children of its own.</note>',
  extra,
  '</task-notification>',
].filter(Boolean).join('\n');
const USAGE = '<usage><subagent_tokens>40200</subagent_tokens><tool_uses>12</tool_uses><duration_ms>100000</duration_ms></usage>';

const step = (n: number, answered = true): ChatMessage[] => [
  { uuid: `s${n}`, role: 'assistant', blocks: [{ type: 'tool_use', id: `t${n}`, name: 'Read', input: { file_path: `/work/shop/file${n}.ts` } }] },
  ...(answered ? [{ uuid: `s${n}r`, role: 'user' as const, blocks: [{ type: 'tool_result' as const, tool_use_id: `t${n}`, content: 'ok' }] }] : []),
];
const stepsOf = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => step(from + i)).flat();
const shown = (n: number) => screen.queryByText(`file${n}.ts`) !== null;

/** Its transcript as the server pages it: the newest, before a message, or from one on. */
function serve(all: () => ChatMessage[]) {
  return vi.spyOn(api, 'subagent').mockImplementation(async (_s, _a, before, after): Promise<MessagesPage> => {
    const messages = all();
    if (after !== undefined) return { messages: messages.slice(after, after + 60), total: messages.length, offset: Math.min(after, messages.length) };
    const end = before ?? messages.length;
    const offset = Math.max(0, end - 60);
    return { messages: messages.slice(offset, end), total: messages.length, offset };
  });
}

/** This Pelican's Claude running the session, with the agent at work in it. */
const working = (extra: Partial<RunState> = {}): RunState => ({
  sessionId: SESSION, cwd: '/work/shop', busy: false, settings: {}, permissions: [], partial: [],
  tasks: [{ id: AGENT, description: 'Look for flaky tests', type: 'general-purpose', summary: 'Reading the checkout tests', toolUseId: 'toolu_bg' }],
  progress: { toolu_bg: { summary: 'Reading the checkout tests', lastTool: 'Read', toolUses: 3, durationMs: 65_000 } },
  ...extra,
});
const idle = (): RunState => ({ sessionId: SESSION, cwd: '/work/shop', busy: false, settings: {}, permissions: [], partial: [] });

let client: QueryClient;
function show(messages: ChatMessage[], mode: 'normal' | 'verbose' = 'verbose') {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view: SessionView = { messages, offset: 0, total: messages.length, loaded: true, loadingOlder: false };
  return render(<QueryClientProvider client={client}><MessageList sessionId={SESSION} view={view} mode={mode} /></QueryClientProvider>);
}
/** The same conversation, gone on. */
function goOn(rendered: ReturnType<typeof show>, messages: ChatMessage[], mode: 'normal' | 'verbose' = 'verbose') {
  const view: SessionView = { messages, offset: 0, total: messages.length, loaded: true, loadingOlder: false };
  rendered.rerender(<QueryClientProvider client={client}><MessageList sessionId={SESSION} view={view} mode={mode} /></QueryClientProvider>);
}
/** The agent's step: its row, the line under it and, opened, the card. */
const card = () => screen.getByRole('button', { name: /^Agent · general-purpose/ }).closest('[data-step]') as HTMLElement;
const MODEL_ONLY = /Async agent launched|internal metadata|agentId|output_file|SendMessage|Do NOT Read/;

afterEach(() => {
  cleanup();
  setRun(SESSION, undefined);
  vi.restoreAllMocks();
});

describe('a background agent’s card', () => {
  it('never shows Claude Code’s words to Claude for its launch, recorded or not: it says it started in the background', async () => {
    serve(() => []);
    for (const recorded of [true, false]) {
      show([call, launched(recorded)]);
      await screen.findByText('Started in background');
      expect(card().textContent).toContain('Instructions');
      expect(card().textContent).not.toMatch(MODEL_ONLY);
      expect(document.body.textContent).not.toMatch(MODEL_ONLY);
      cleanup();
    }
  });

  it('while it works here: running in background, with its steps, its time and what it is doing, and its steps open', async () => {
    const pages = serve(() => stepsOf(1, 3));
    setRun(SESSION, working());
    show([call, launched()]);
    expect(await within(card()).findByText('Running in background · 3 steps · 1m 5s · Reading the checkout tests')).toBeTruthy();
    expect(card().querySelector('.animate-spin')).not.toBeNull();
    // Opened, it shows its steps without asking.
    await screen.findByText('file3.ts');
    expect(pages).toHaveBeenCalledWith(SESSION, AGENT);
    expect(card().textContent).toContain('3 steps');
    expect(card().textContent).not.toMatch(MODEL_ONLY);
  });

  it('reads its steps again while it works, asking only for what is new, and stops once it ended', async () => {
    let all = stepsOf(1, 2);
    const pages = serve(() => all);
    setRun(SESSION, working());
    const rendered = show([call, launched()]);
    await screen.findByText('file2.ts');
    all = [...stepsOf(1, 3), ...step(4, false)];
    await screen.findByText('file4.ts', undefined, { timeout: 6000 });
    // From the last message it held on, not the newest page again.
    expect(pages.mock.calls.some((c) => c[3] === 3)).toBe(true);
    // It ends: what it did in its last seconds, once, and then nothing more.
    all = stepsOf(1, 5);
    setRun(SESSION, idle());
    goOn(rendered, [call, launched(), said('n', notice('completed', 'Agent "Look for flaky tests" finished', `<result>Two flaky tests.</result>\n${USAGE}`))]);
    await screen.findByText('file5.ts', undefined, { timeout: 6000 });
    const asked = pages.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 4000));
    expect(pages.mock.calls.length).toBe(asked);
  }, 25_000);

  it('once Claude Code said it ended, shows how and what it returned in the card, and the line about its end leads there', async () => {
    serve(() => stepsOf(1, 12));
    show([call, launched(), said('n', notice('completed', 'Agent "Look for flaky tests" finished', `<result>Two tests are **flaky**: both wait for a timer.</result>\n${USAGE}`)), reply('c', 'Both flaky tests wait for a timer.')], 'normal');
    // The line names the agent, how it ended and its time; what it returned is the card's.
    const line = screen.getByRole('button', { name: /^Agent Look for flaky tests finished · 1m 40s$/ });
    expect(line.textContent).not.toContain('flaky**');
    expect(within(card()).getByText('Finished in background · 12 steps · 40.2k tokens · 1m 40s')).toBeTruthy();
    expect(card().textContent).not.toContain('both wait for a timer');
    // Normal view: the card is closed; the line opens it.
    fireEvent.click(line);
    await waitFor(() => expect(card().textContent).toContain('Two tests are flaky: both wait for a timer.'));
    expect(within(card()).getByText('flaky').tagName).toBe('STRONG');
    expect(card().querySelector('.animate-spin')).toBeNull();
    expect(document.body.textContent).not.toMatch(MODEL_ONLY);
  });

  it('shows the report its agent handed back where Claude Code’s notice only points to it', async () => {
    serve(() => []);
    const pointer = `<result>This agent's report was delivered to you as a message from "${AGENT}" (its SubagentHandback call). Read it there; it is not repeated here.\n</result>`;
    const handback = said('h', `<agent-message from="${AGENT}">\n[Subagent hand-back] The report follows:\n  No flaky tests left.\n</agent-message>`, { meta: true, handback: { from: AGENT, report: 'No flaky tests left.' } });
    show([call, launched(), handback, said('n', notice('completed', 'Agent "Look for flaky tests" finished', `${pointer}\n${USAGE}`))]);
    await within(card()).findByText('No flaky tests left.');
    expect(document.body.textContent).not.toMatch(/SubagentHandback|delivered to you|hand-back/);
  });

  it('one that failed says so, in red, with why, in its card and on the line', async () => {
    serve(() => []);
    show([call, launched(), said('n', notice('failed', 'Agent "Look for flaky tests" failed: API Error: Can’t reach the API server'))]);
    const words = within(card()).getByText('Failed in background');
    expect(words.className).toContain('text-danger');
    expect(within(card()).getByText('API Error: Can’t reach the API server')).toBeTruthy();
    expect(within(card()).getByText('failed').className).toContain('text-danger');
    expect(screen.getByRole('button', { name: /^Agent Look for flaky tests failed$/ })).toBeTruthy();
  });

  it('one stopped says so: stopped in background, and the line says who stopped it', async () => {
    serve(() => []);
    show([call, launched(), said('n', notice('killed', 'Agent "Look for flaky tests" was stopped by user'))]);
    expect(within(card()).getByText('Stopped in background')).toBeTruthy();
    expect(within(card()).getByText('stopped')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Agent Look for flaky tests was stopped by user$/ })).toBeTruthy();
  });

  it('has Stop while it works here, which stops its task as the task list does', async () => {
    serve(() => stepsOf(1, 2));
    const stop = vi.spyOn(api, 'stopTask').mockResolvedValue({ ok: true });
    setRun(SESSION, working());
    show([call, launched()]);
    fireEvent.click(await within(card()).findByRole('button', { name: 'Stop this agent' }));
    expect(stop).toHaveBeenCalledWith(SESSION, AGENT);
    expect(within(card()).getByRole('button', { name: 'Stop this agent' }).textContent).toBe('Stopping…');
    // Not where this Pelican's Claude does not run it.
    cleanup();
    setRun(SESSION, idle());
    show([call, launched()]);
    await screen.findByText('Started in background');
    expect(within(card()).queryByRole('button', { name: 'Stop this agent' })).toBeNull();
  });

  it('is a step of its own, never folded away among the steps around it', async () => {
    serve(() => []);
    const reads: ChatMessage[] = stepsOf(1, 7).map((m, i) => ({ ...m, timestamp: at - 60_000 + i }));
    const later: ChatMessage[] = stepsOf(8, 9).map((m, i) => ({ ...m, uuid: `${m.uuid}-later`, timestamp: at + 2000 + i }));
    show([...reads, call, launched(), ...later], 'normal');
    // The seven reads before it fold; the agent stays in view.
    expect(screen.getByText('7 steps')).toBeTruthy();
    expect(shown(1)).toBe(false);
    expect(within(card()).getByText('Started in background')).toBeTruthy();
  });
});

describe('a foreground agent’s card', () => {
  it('is as before: its answer without Claude Code’s trailer, its steps a tap away, nothing said of the background', async () => {
    const pages = serve(() => stepsOf(1, 2));
    const call: ChatMessage = { uuid: 'a-fg', role: 'assistant', timestamp: at, blocks: [{ type: 'tool_use', id: 'toolu_fg', name: 'Agent', input: { description: 'Look around', subagent_type: 'general-purpose', prompt: 'Look around the shop.' } }] };
    const done: ChatMessage = { uuid: 'r-fg', role: 'user', timestamp: at + 1000, blocks: [{ type: 'tool_result', tool_use_id: 'toolu_fg', content: `All **clear**.\nagentId: ag1 (use SendMessage with to: 'ag1', summary: '<5-10 word recap>' to continue this agent)\n<usage>subagent_tokens: 900\ntool_uses: 2\nduration_ms: 9000</usage>` }] };
    show([call, done]);
    const step = screen.getByRole('button', { name: /^Agent · general-purpose/ }).closest('[data-step]') as HTMLElement;
    expect(within(step).getByText('clear').tagName).toBe('STRONG');
    expect(step.textContent).not.toMatch(/agentId|subagent_tokens|in background/);
    expect(pages).not.toHaveBeenCalled();
    fireEvent.click(within(step).getByText('Steps it took'));
    await within(step).findByText('file2.ts');
    expect(pages).toHaveBeenCalledWith(SESSION, 'ag1');
  });
});
