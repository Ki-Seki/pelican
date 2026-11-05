import { describe, expect, it } from 'vitest';

import type { PartialBlock, RunState } from '../src/shared/protocol';
import { PARTIAL_INPUT_MAX, RunChannel } from '../src/server/stream';

const run = (partial: PartialBlock[], extra: Partial<RunState> = {}): RunState => ({
  sessionId: 's1', cwd: '/w', busy: true, settings: {}, permissions: [], partial, ...extra,
});

describe('a client’s copy of a run', () => {
  it('gets the whole state first, then only the text added, and nothing when nothing changed', () => {
    const channel = new RunChannel('s1');
    expect(channel.next(run([{ type: 'text', text: 'Hel' }]))).toEqual({ type: 'run', sessionId: 's1', state: run([{ type: 'text', text: 'Hel' }]) });
    expect(channel.next(run([{ type: 'text', text: 'Hello, wor' }]))).toEqual({
      type: 'partial', sessionId: 's1', appends: [{ index: 0, from: 3, text: 'lo, wor' }],
    });
    expect(channel.next(run([{ type: 'text', text: 'Hello, wor' }]))).toBeUndefined();
    expect(channel.next(run([{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'Hello, world' }]))).toMatchObject({ type: 'run' });
    expect(channel.next(run([{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Hello, world!' }]))).toEqual({
      type: 'partial', sessionId: 's1', appends: [{ index: 0, from: 2, text: 'm' }, { index: 1, from: 12, text: '!' }],
    });
  });

  it('gets the whole state when anything but the streamed text changes, or the text is not a continuation', () => {
    const channel = new RunChannel('s1');
    channel.next(run([{ type: 'text', text: 'abc' }]));
    expect(channel.next(run([{ type: 'text', text: 'abcd' }], { busy: false }))).toMatchObject({ type: 'run', state: { busy: false } });
    expect(channel.next(run([{ type: 'text', text: 'xbcde' }], { busy: false }))).toMatchObject({ type: 'run' });
    expect(channel.next(run([], { busy: false }))).toMatchObject({ type: 'run', state: { partial: [] } });
  });

  it('starts over after a reset, and says when no run is left', () => {
    const channel = new RunChannel('s1');
    channel.next(run([{ type: 'text', text: 'abc' }]));
    channel.reset();
    expect(channel.next(run([{ type: 'text', text: 'abcd' }]))).toMatchObject({ type: 'run' });
    expect(channel.next(null)).toEqual({ type: 'run', sessionId: 's1', state: null });
    expect(channel.next(run([{ type: 'text', text: 'abcd' }]))).toMatchObject({ type: 'run' });
  });

  it('sends what a block gained when the run added it to the same block, as the run does', () => {
    const channel = new RunChannel('s1');
    const text: PartialBlock = { type: 'text', text: 'Hel' };
    const thinking: PartialBlock = { type: 'thinking', thinking: 'hm' };
    expect(channel.next(run([thinking, text]))).toMatchObject({ type: 'run', state: { partial: [{ thinking: 'hm' }, { text: 'Hel' }] } });
    text.text += 'lo';
    thinking.thinking += 'm';
    expect(channel.next(run([thinking, text]))).toEqual({
      type: 'partial', sessionId: 's1', appends: [{ index: 0, from: 2, text: 'm' }, { index: 1, from: 3, text: 'lo' }],
    });
    text.text += ', world';
    expect(channel.next(run([thinking, text]))).toEqual({ type: 'partial', sessionId: 's1', appends: [{ index: 1, from: 5, text: ', world' }] });
    expect(channel.next(run([thinking, text]))).toBeUndefined();
  });

  it('streams a tool call’s input only as far as the page names the call from it', () => {
    const channel = new RunChannel('s1');
    const head = '{"file_path":"/w/big.txt","content":"';
    const first = channel.next(run([{ type: 'tool_use', name: 'Write', inputJson: head }]));
    expect(first).toMatchObject({ type: 'run', state: { partial: [{ inputJson: head }] } });
    const long = `${head}${'x'.repeat(50_000)}`;
    const grown = channel.next(run([{ type: 'tool_use', name: 'Write', inputJson: long }]));
    expect(grown).toEqual({ type: 'partial', sessionId: 's1', appends: [{ index: 0, from: head.length, text: long.slice(head.length, PARTIAL_INPUT_MAX) }] });
    expect(channel.next(run([{ type: 'tool_use', name: 'Write', inputJson: `${long}yyyy` }]))).toBeUndefined();
  });
});
