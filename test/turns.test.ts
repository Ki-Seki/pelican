import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '../src/shared/protocol';
import { buildItems } from '../src/web/lib/turns';

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
