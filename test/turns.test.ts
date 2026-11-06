import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '../src/shared/protocol';
import { buildItems, filesChangedUnder } from '../src/web/lib/turns';

const user = (uuid: string, text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ uuid, role: 'user', blocks: [{ type: 'text', text }], ...extra });
const assistant = (uuid: string, blocks: ChatMessage['blocks']): ChatMessage => ({ uuid, role: 'assistant', blocks });

describe('buildItems', () => {
  it('joins one turn’s rows and attaches tool results to their calls', () => {
    const items = buildItems([
      user('u1', 'List the files'),
      assistant('a1', [{ type: 'text', text: 'Looking.' }]),
      assistant('a2', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }]),
      { uuid: 'r1', role: 'user', blocks: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.txt' }] },
      assistant('a3', [{ type: 'text', text: 'One file.' }]),
    ]);
    expect(items.map((i) => i.kind)).toEqual(['user', 'assistant']);
    const turn = items[1]!;
    if (turn.kind !== 'assistant') throw new Error('expected a turn');
    expect(turn.parts.map((p) => p.kind)).toEqual(['text', 'tool', 'text']);
    const tool = turn.parts[1]!;
    expect(tool.kind === 'tool' && tool.call.result?.content).toBe('a.txt');
  });

  it('shows slash commands, their output and interruptions for what they are, and hides injected text', () => {
    const items = buildItems([
      user('c1', '<command-name>/compact</command-name><command-args></command-args>'),
      user('o1', '<local-command-stdout>Compacted</local-command-stdout>'),
      user('m1', 'Skill instructions', { meta: true }),
      user('i1', '[Request interrupted by user]'),
      user('s1', '<system-reminder>hidden</system-reminder>'),
    ]);
    expect(items).toMatchObject([
      { kind: 'user', command: { name: '/compact', args: '' } },
      { kind: 'notice', tone: 'output', text: 'Compacted' },
      { kind: 'notice', tone: 'interrupt' },
    ]);
  });

  it('marks a compaction', () => {
    const items = buildItems([user('k1', 'Summary of the earlier conversation', { compactSummary: true })]);
    expect(items).toMatchObject([{ kind: 'compact', summary: 'Summary of the earlier conversation' }]);
  });
});

describe('buildItems: ! commands', () => {
  it('shows a bash-mode message as a command with its output', () => {
    const items = buildItems([user('b1', '<bash-input>ls &amp; pwd</bash-input><bash-stdout>a.txt\n&lt;dir&gt;</bash-stdout><bash-stderr></bash-stderr>')]);
    expect(items).toMatchObject([{ kind: 'shell', command: 'ls & pwd', stdout: 'a.txt\n<dir>', stderr: '' }]);
  });

  it('shows an output too long for the conversation as the start Claude got and where all of it is, not Claude Code’s wrapper', () => {
    const file = '/home/me/.claude/projects/-work/5e25f65d-1b8b-4490-a3d3-43540da07ef3/tool-results/b1b2gp6fw.txt';
    // As Claude Code's bash mode writes it, the CLI's or Pelican's: the start is not escaped.
    const saved = `<bash-stdout><persisted-output>\nOutput too large (97.7KB). Full output saved to: ${file}\n\nPreview (first 2KB):\n<x> &amp; y\n...\n</persisted-output></bash-stdout><bash-stderr></bash-stderr>`;
    const items = buildItems([user('b1', '<bash-input>cat big.log</bash-input>'), user('b2', saved)]);
    expect(items).toMatchObject([{ kind: 'shell', command: 'cat big.log', stdout: `<x> &amp; y\n...\nOutput too large (97.7KB). Full output saved to: ${file}`, stderr: '' }]);
  });
});

describe('toChatMessage', () => {
  it('marks what Claude Code adds itself as meta, from the transcript and from the live stream', async () => {
    const { toChatMessage } = await import('../src/server/normalize');
    const note = '[Image: original 2400x1260, displayed at 2000x1050.]';
    expect(toChatMessage({ type: 'user', uuid: 'a', isMeta: true, message: { role: 'user', content: note } })?.meta).toBe(true);
    expect(toChatMessage({ type: 'user', uuid: 'b', isSynthetic: true, message: { role: 'user', content: note } })?.meta).toBe(true);
    expect(toChatMessage({ type: 'user', uuid: 'c', message: { role: 'user', content: 'typed' } })?.meta).toBeUndefined();
  });
});

describe('toChatMessage: refusals', () => {
  it('marks the result of a call Claude Code records as refused, whatever its words', async () => {
    const { toChatMessage } = await import('../src/server/normalize');
    const row = (toolDenialKind?: string) => toChatMessage({
      type: 'user', uuid: 'r', ...(toolDenialKind ? { toolDenialKind } : {}),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'Put it in .env.local instead.', is_error: true }] },
    });
    expect(row('user-rejected')?.blocks[0]).toMatchObject({ type: 'tool_result', denied: true });
    expect(row('permission-rule')?.blocks[0]).toMatchObject({ denied: true });
    // Stopped is not refused, and a plain error is neither.
    expect(row('interrupted')?.blocks[0]).not.toHaveProperty('denied');
    expect(row()?.blocks[0]).not.toHaveProperty('denied');
  });
});

describe('where a turn’s "files changed" goes', () => {
  const turn = (uuid: string, n: number) => ({ uuid, n, text: '', files: [{ path: 'theme.css', added: 1, removed: 1 }], checkpoint: false });
  const picture: ChatMessage['blocks'][number] = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } };

  it('under Claude’s answer to a ! command when the command’s turn changed files, as /diff cuts turns', () => {
    const items = buildItems([
      user('p1', 'Fix the failing tests'),
      assistant('a1', [{ type: 'text', text: 'Run them and I will look.' }]),
      user('c1', '<bash-input>npm test</bash-input>'),
      user('o1', '<bash-stdout>FAIL theme.test.ts</bash-stdout><bash-stderr></bash-stderr>'),
      assistant('a2', [{ type: 'text', text: 'Fixed.' }]),
      user('p2', 'Thanks'),
      assistant('a3', [{ type: 'text', text: 'You are welcome.' }]),
    ]);
    // The ! command's turn is known by the row holding the command, the card's own key.
    const under = filesChangedUnder(items, [turn('c1', 3)]);
    expect([...under].map(([answer, t]) => [answer, t.uuid])).toEqual([['a2', 'c1']]);
  });

  it('under the last answer of the turn a picture sent without words belongs to, and after a task’s note under its answer', () => {
    const items = buildItems([
      user('p1', 'Make the toggle bigger'),
      assistant('a1', [{ type: 'text', text: 'Done.' }]),
      { uuid: 'i1', role: 'user', blocks: [picture] },
      assistant('a2', [{ type: 'text', text: 'And now it matches.' }]),
      user('n1', '<task-notification>\n<summary>Background command "npm run build" completed (exit code 0)</summary>\n</task-notification>'),
      assistant('a3', [{ type: 'text', text: 'The build is fixed.' }]),
    ]);
    const under = filesChangedUnder(items, [turn('p1', 1), turn('n1', 2)]);
    expect([...under].map(([answer, t]) => [answer, t.uuid])).toEqual([['a2', 'p1'], ['a3', 'n1']]);
  });

  it('under the answer to a message sent with only a file, which /diff counts as a turn of its own', () => {
    const items = buildItems([
      user('p1', 'Fix it'),
      assistant('a1', [{ type: 'text', text: 'Done.' }]),
      // As Pelican writes a message of files alone: the block that tells Claude where they are.
      user('f1', 'Attached files:\n- /tmp/w/uploads/0b7e2c1a-1111-4111-8111-111111111111/spec.pdf (spec.pdf)'),
      assistant('a2', [{ type: 'text', text: 'Read it, and changed the theme.' }]),
    ]);
    const under = filesChangedUnder(items, [turn('p1', 1), turn('f1', 2)]);
    expect([...under].map(([answer, t]) => [answer, t.uuid])).toEqual([['a1', 'p1'], ['a2', 'f1']]);
  });
});

describe('buildItems: workflows', () => {
  const notice = (id: string, status: string, extra = '') => `<task-notification>\n<task-id>w1</task-id>\n<tool-use-id>${id}</tool-use-id>\n<output-file>/tmp/w1.output</output-file>\n<status>${status}</status>\n<summary>Dynamic workflow "Review &amp; fix" ${status}</summary>${extra}\n</task-notification>`;
  const workflow = (id: string, runId: string): ChatMessage[] => [
    assistant(`a-${id}`, [{ type: 'tool_use', id, name: 'Workflow', input: { script: "export const meta = { name: 'demo-review', description: 'Review', phases: [] }" } }]),
    { uuid: `r-${id}`, role: 'user', blocks: [{ type: 'tool_result', tool_use_id: id, content: 'Workflow launched in background.', workflow: { runId, taskId: 'w1' } }] },
  ];

  it('joins a workflow’s end to its call, and leaves a line that names it where Claude Code said it', () => {
    const items = buildItems([
      user('u1', 'Review it'),
      ...workflow('toolu_w', 'wf_7c2e4a10-9b3'),
      user('n1', notice('toolu_w', 'completed', '<result>[1]</result><usage><duration_ms>361250</duration_ms></usage>')),
      assistant('a2', [{ type: 'text', text: 'It found one thing.' }]),
    ]);
    expect(items.map((i) => i.kind)).toEqual(['user', 'assistant', 'notice', 'assistant']);
    const call = items[1]!.kind === 'assistant' && items[1]!.parts[0]!.kind === 'tool' ? items[1]!.parts[0]!.call : undefined;
    expect(call?.ended).toMatchObject({ status: 'completed', result: '[1]', summary: 'Dynamic workflow "Review & fix" completed' });
    // The line leads to the card; the result is in the card, not again here.
    expect(items[2]).toMatchObject({ kind: 'notice', tone: 'task', workflow: { toolUseId: 'toolu_w', name: 'demo-review', status: 'completed', durationMs: 361_250 } });
    expect((items[2] as { detail?: string }).detail).toBeUndefined();
  });

  it('keeps the end of a call not on the page, and of any other task, as a notice with what it returned', () => {
    const items = buildItems([user('n1', notice('toolu_elsewhere', 'completed', '<result>done</result>'))]);
    expect(items).toMatchObject([{ kind: 'notice', tone: 'task', text: 'Dynamic workflow "Review & fix" completed', detail: 'done' }]);
    expect((items[0] as { workflow?: unknown }).workflow).toBeUndefined();
  });

  it('takes the word of the Claude Code that ran a workflow over one that found it without its end', () => {
    const orphan = '<task-notification>\n<task-id>w1</task-id>\n<tool-use-id>toolu_w</tool-use-id>\n<status>stopped</status>\n<summary>Background workflow didn\'t finish</summary>\n<note>No completion record.</note>\n</task-notification>';
    const items = buildItems([...workflow('toolu_w', 'wf_7c2e4a10-9b3'), user('n1', notice('toolu_w', 'completed')), user('n2', orphan)]);
    const call = items[0]!.kind === 'assistant' && items[0]!.parts[0]!.kind === 'tool' ? items[0]!.parts[0]!.call : undefined;
    expect(call?.ended?.status).toBe('completed');
  });

  it('marks a call whose run a later call resumed, with that call', () => {
    const items = buildItems([...workflow('toolu_a', 'wf_7c2e4a10-9b3'), ...workflow('toolu_b', 'wf_7c2e4a10-9b3'), ...workflow('toolu_c', 'wf_0d0d0d0d-111')]);
    const calls = items.flatMap((i) => (i.kind === 'assistant' ? i.parts : [])).flatMap((p) => (p.kind === 'tool' ? [p.call] : []));
    expect(calls.map((c) => c.resumedBy)).toEqual(['toolu_b', undefined, undefined]);
  });
});

describe('toChatMessage: a Workflow call’s launch', () => {
  it('keeps the run Claude Code recorded next to the result, from a transcript or from the stream', async () => {
    const { toChatMessage } = await import('../src/server/normalize');
    const output = {
      status: 'async_launched', taskId: 'w4k9qz2mx', taskType: 'local_workflow', workflowName: 'demo-review', runId: 'wf_7c2e4a10-9b3', summary: 'Review the demo app',
      transcriptDir: '/h/.claude/projects/p/s/subagents/workflows/wf_7c2e4a10-9b3', scriptPath: '/h/.claude/projects/p/s/workflows/scripts/demo-review-wf_7c2e4a10-9b3.js',
    };
    const content = [{ type: 'tool_result', tool_use_id: 'toolu_w', content: 'Workflow launched in background.' }];
    const expected = { runId: 'wf_7c2e4a10-9b3', taskId: 'w4k9qz2mx', name: 'demo-review', summary: 'Review the demo app', scriptFile: 'demo-review-wf_7c2e4a10-9b3.js' };
    for (const key of ['toolUseResult', 'tool_use_result']) {
      const message = toChatMessage({ type: 'user', uuid: 'r', [key]: output, message: { role: 'user', content } });
      expect(message?.blocks[0]).toMatchObject({ type: 'tool_result', workflow: expected });
    }
    // Another tool's result keeps nothing of the kind, and a run id of another shape is no run id.
    const agent = toChatMessage({ type: 'user', uuid: 'r', toolUseResult: { status: 'async_launched', agentId: 'a1' }, message: { role: 'user', content } });
    expect(agent?.blocks[0]).not.toHaveProperty('workflow');
    const odd = toChatMessage({ type: 'user', uuid: 'r', toolUseResult: { ...output, runId: '../../etc' }, message: { role: 'user', content } });
    expect(odd?.blocks[0]).toMatchObject({ workflow: { taskId: 'w4k9qz2mx' } });
    expect((odd?.blocks[0] as { workflow?: { runId?: string } }).workflow?.runId).toBeUndefined();
  });
});

describe('toChatMessage: a ! command’s output row', () => {
  it('keeps the Claude Code that wrote it, which says how to read it, and on no other row', async () => {
    const { toChatMessage } = await import('../src/server/normalize');
    const row = (text: string) => ({ type: 'user', uuid: 'r', version: '2.1.318', message: { role: 'user', content: text } });
    expect(toChatMessage(row('<bash-stdout></bash-stdout><bash-stderr>FAIL</bash-stderr>'))).toMatchObject({ version: '2.1.318' });
    expect(toChatMessage(row('<bash-input>npm test</bash-input>'))).not.toHaveProperty('version');
    expect(toChatMessage(row('Fix the tests'))).not.toHaveProperty('version');
    expect(toChatMessage({ ...row('<bash-stdout></bash-stdout>'), version: 'x'.repeat(33) })).not.toHaveProperty('version');
  });
});
