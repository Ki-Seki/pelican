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
