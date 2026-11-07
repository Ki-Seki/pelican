// An Agent call that Claude did not wait for, as the conversation joins its end and its report to
// it. Made-up content in Claude Code's shapes.
import { describe, expect, it } from 'vitest';

import type { ChatMessage, ToolResultBlock } from '../src/shared/protocol';
import { agentOf, buildItems, runsInBackground, type ToolCall } from '../src/web/lib/turns';

const AGENT = 'a1b2c3d4e5f6a7b8c';
const LAUNCH = `Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\nagentId: ${AGENT} (internal ID - do not mention to user.)\noutput_file: /tmp/x/${AGENT}.output`;
const user = (uuid: string, text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ uuid, role: 'user', blocks: [{ type: 'text', text }], ...extra });
const assistant = (uuid: string, blocks: ChatMessage['blocks']): ChatMessage => ({ uuid, role: 'assistant', blocks });
const agentCall = (id: string, background = true): ChatMessage => assistant(`a-${id}`, [{ type: 'tool_use', id, name: 'Agent', input: { description: 'Look for flaky tests', prompt: 'Find them.', ...(background ? { run_in_background: true } : {}) } }]);
const result = (id: string, content: string, extra: Partial<ToolResultBlock> = {}): ChatMessage => ({ uuid: `r-${id}`, role: 'user', blocks: [{ type: 'tool_result', tool_use_id: id, content, ...extra }] });
const notice = (status: string, summary: string, { toolUseId = 'toolu_bg', extra = '' } = {}) =>
  `<task-notification>\n<task-id>${AGENT}</task-id>\n${toolUseId ? `<tool-use-id>${toolUseId}</tool-use-id>\n` : ''}<output-file>/tmp/x/${AGENT}.output</output-file>\n<status>${status}</status>\n<summary>${summary}</summary>\n<note>It may notify again.</note>${extra}\n</task-notification>`;
const callsOf = (items: ReturnType<typeof buildItems>): ToolCall[] => items.flatMap((i) => (i.kind === 'assistant' ? i.parts : [])).flatMap((p) => (p.kind === 'tool' ? [p.call] : []));

describe('agentOf', () => {
  it('tells an agent left working in the background, from what Claude Code recorded or, without that, its words to Claude', () => {
    const recorded: ToolCall = { id: 't', name: 'Agent', input: {}, result: { type: 'tool_result', tool_use_id: 't', content: LAUNCH, agent: { mode: 'background', agentId: AGENT } } };
    expect(agentOf(recorded)).toEqual({ background: true, mode: 'background', agentId: AGENT });
    expect(agentOf({ ...recorded, result: { type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: LAUNCH }] } })).toEqual({ background: true, mode: 'background', agentId: AGENT });
    const cloud: ToolCall = { id: 't', name: 'Task', input: {}, result: { type: 'tool_result', tool_use_id: 't', content: 'Cloud agent launched. (This tool result is internal metadata.)\ntaskId: r1\nsession_url: https://claude.ai/code/session_1' } };
    expect(agentOf(cloud)).toMatchObject({ background: true, mode: 'cloud', sessionUrl: 'https://claude.ai/code/session_1' });
    // One Claude waited for: its id from the trailer after its report, the last one.
    const done: ToolCall = { id: 't', name: 'Agent', input: {}, result: { type: 'tool_result', tool_use_id: 't', content: 'agentId: not-this\nFound it.\nagentId: ag1 (use SendMessage)\n<usage>tool_uses: 1</usage>' } };
    expect(agentOf(done)).toEqual({ background: false, agentId: 'ag1' });
    // A launch that failed is none, and other tools are not agents.
    expect(agentOf({ ...recorded, result: { type: 'tool_result', tool_use_id: 't', content: LAUNCH, is_error: true } }).background).toBe(false);
    expect(agentOf({ id: 't', name: 'Bash', input: {}, result: { type: 'tool_result', tool_use_id: 't', content: LAUNCH } }).background).toBe(false);
  });

  it('counts a call asked to run in the background as one from the start, before its result', () => {
    expect(runsInBackground({ id: 't', name: 'Agent', input: { run_in_background: true } })).toBe(true);
    expect(runsInBackground({ id: 't', name: 'Agent', input: {} })).toBe(false);
    expect(runsInBackground({ id: 't', name: 'Bash', input: { run_in_background: true } })).toBe(false);
  });
});

describe('buildItems: an agent in the background', () => {
  it('joins Claude Code’s notice of its end to its call, and leaves a line in its words that leads there, without what it returned', () => {
    const items = buildItems([
      user('u1', 'Look for flaky tests'),
      agentCall('toolu_bg'),
      result('toolu_bg', LAUNCH, { agent: { mode: 'background', agentId: AGENT } }),
      user('n1', notice('completed', 'Agent "Look for flaky tests" finished', { extra: '\n<result>Two flaky tests.</result>\n<usage><subagent_tokens>900</subagent_tokens><tool_uses>12</tool_uses><duration_ms>100000</duration_ms></usage>' })),
      assistant('a2', [{ type: 'text', text: 'Two of them.' }]),
    ]);
    expect(items.map((i) => i.kind)).toEqual(['user', 'assistant', 'notice', 'assistant']);
    expect(callsOf(items)[0]?.ended).toMatchObject({ status: 'completed', result: 'Two flaky tests.', usage: { toolUses: 12, durationMs: 100_000, tokens: 900 } });
    expect(items[2]).toMatchObject({ kind: 'notice', tone: 'task', agent: { toolUseId: 'toolu_bg', description: 'Look for flaky tests', status: 'completed', words: 'finished', durationMs: 100_000 } });
    expect((items[2] as { detail?: string }).detail).toBeUndefined();
  });

  it('says how it ended in Claude Code’s words: failed, its reason apart; stopped, and by whom', () => {
    const failed = buildItems([agentCall('toolu_bg'), result('toolu_bg', LAUNCH), user('n1', notice('failed', 'Agent "Look for flaky tests" failed: API Error: overloaded'))]);
    expect(failed[1]).toMatchObject({ agent: { status: 'failed', words: 'failed' } });
    expect(callsOf(failed)[0]?.ended).toMatchObject({ status: 'failed', error: 'API Error: overloaded' });
    const stopped = buildItems([agentCall('toolu_bg'), result('toolu_bg', LAUNCH), user('n1', notice('killed', 'Agent "Look for flaky tests" was stopped by user'))]);
    expect(stopped[1]).toMatchObject({ agent: { status: 'killed', words: 'was stopped by user' } });
  });

  it('finds the call by its agent where the notice names no call, and takes the newest word', () => {
    const items = buildItems([
      agentCall('toolu_bg'),
      result('toolu_bg', LAUNCH),
      user('n1', notice('completed', 'Agent "Look for flaky tests" is waiting on its own background work', { toolUseId: '' })),
      user('n2', notice('completed', 'Agent "Look for flaky tests" finished', { toolUseId: '' })),
    ]);
    expect(items.filter((i) => i.kind === 'notice').map((i) => (i.kind === 'notice' ? i.agent?.words : undefined))).toEqual(['is waiting on its own background work', 'finished']);
    expect(callsOf(items)[0]?.ended?.summary).toBe('Agent "Look for flaky tests" finished');
  });

  it('gives the call the report its agent handed back, which Claude Code’s notice only points to, and shows that message nowhere else', () => {
    const items = buildItems([
      agentCall('toolu_bg'),
      result('toolu_bg', LAUNCH),
      user('h1', '<agent-message from="x">[Subagent hand-back] …</agent-message>', { meta: true, handback: { from: AGENT, report: 'No flaky tests left.' } }),
      user('n1', notice('completed', 'Agent "Look for flaky tests" finished', { extra: `\n<result>This agent's report was delivered to you as a message from "${AGENT}" (its SubagentHandback call). Read it there; it is not repeated here.</result>` })),
    ]);
    expect(callsOf(items)[0]?.report).toBe('No flaky tests left.');
    expect(items.map((i) => i.kind)).toEqual(['assistant', 'notice']);
    // So does one Claude waited for, whose result only points to its report.
    const waited = buildItems([
      agentCall('toolu_fg', false),
      user('h1', 'framed', { meta: true, handback: { from: 'ag1', report: 'All clear.' } }),
      result('toolu_fg', 'This agent\'s report was delivered to you as a message from "ag1" (its SubagentHandback call).\nagentId: ag1 (use SendMessage)'),
    ]);
    expect(callsOf(waited)[0]?.report).toBe('All clear.');
  });

  it('keeps the notice of a call not on the page, or of another kind of task, as before', () => {
    const items = buildItems([user('n1', notice('completed', 'Agent "Elsewhere" finished', { toolUseId: 'toolu_other', extra: '\n<result>done</result>' }))]);
    expect(items).toMatchObject([{ kind: 'notice', tone: 'task', text: 'Agent "Elsewhere" finished', detail: 'done' }]);
    expect((items[0] as { agent?: unknown }).agent).toBeUndefined();
  });
});
