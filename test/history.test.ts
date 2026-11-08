import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { conversationUpTo, readHistory } from '../src/server/history';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'pelican-history-'));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

let clock = Date.parse('2026-11-05T00:00:00.000Z');
const say = (uuid: string, parent: string | null, type: 'user' | 'assistant', text: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    uuid, parentUuid: parent, type, timestamp: new Date((clock += 1000)).toISOString(),
    message: type === 'user' ? { role: 'user', content: text } : { role: 'assistant', content: [{ type: 'text', text }] },
    ...extra,
  });
const boundary = (uuid: string, logicalParent: string, preservedTail?: string) =>
  JSON.stringify({
    uuid, parentUuid: null, logicalParentUuid: logicalParent, type: 'system', subtype: 'compact_boundary',
    ...(preservedTail ? { compactMetadata: { preservedSegment: { headUuid: preservedTail, anchorUuid: 'x', tailUuid: preservedTail } } } : {}),
  });
const texts = (messages: Awaited<ReturnType<typeof readHistory>>) =>
  messages.map((m) => m.blocks.map((b) => (b.type === 'text' ? b.text : '')).join(''));

describe('readHistory', () => {
  it('reads what is appended, and a last line once it is whole', async () => {
    const file = path.join(dir, 'grow.jsonl');
    await writeFile(file, `${say('u1', null, 'user', 'first')}\n${JSON.stringify({ type: 'custom-title', customTitle: 'T' })}\n`);
    expect(texts(await readHistory(file))).toEqual(['first']);
    const next = say('a1', 'u1', 'assistant', 'reply');
    await appendFile(file, next.slice(0, 20));
    expect(texts(await readHistory(file))).toEqual(['first']);
    await appendFile(file, `${next.slice(20)}\n${say('u2', 'a1', 'user', 'second')}`);
    expect(texts(await readHistory(file))).toEqual(['first', 'reply', 'second']);
    await appendFile(file, `\n${say('a2', 'u2', 'assistant', 'again')}\n`);
    expect(texts(await readHistory(file))).toEqual(['first', 'reply', 'second', 'again']);
  });

  it('carries on through compactions, also when a boundary points at a row that was never written', async () => {
    const file = path.join(dir, 'compact.jsonl');
    await writeFile(file, [
      say('u1', null, 'user', 'before'),
      say('a1', 'u1', 'assistant', 'old reply'),
      boundary('b1', 'a1'),
      say('s1', 'b1', 'user', 'summary one', { isCompactSummary: true, isMeta: true }),
      say('u2', 's1', 'user', 'middle'),
      say('a2', 'u2', 'assistant', 'kept'),
      boundary('b2', 'never-written', 'a2'),
      say('s2', 'b2', 'user', 'summary two', { isCompactSummary: true }),
      say('u3', 's2', 'user', 'after'),
    ].join('\n') + '\n');
    const messages = await readHistory(file);
    expect(texts(messages)).toEqual(['before', 'old reply', 'summary one', 'middle', 'kept', 'summary two', 'after']);
    expect(messages.filter((m) => m.compactSummary).map((m) => m.uuid)).toEqual(['s1', 's2']);
  });

  it('follows the newest branch after a rewind', async () => {
    const file = path.join(dir, 'branch.jsonl');
    await writeFile(file, [
      say('u1', null, 'user', 'start'),
      say('a1', 'u1', 'assistant', 'one'),
      say('u2', 'a1', 'user', 'first try'),
      say('a2', 'u2', 'assistant', 'abandoned'),
      say('u3', 'a1', 'user', 'second try'),
    ].join('\n') + '\n');
    expect(texts(await readHistory(file))).toEqual(['start', 'one', 'second try']);
    await appendFile(file, `${say('a3', 'u3', 'assistant', 'kept')}\n`);
    expect(texts(await readHistory(file))).toEqual(['start', 'one', 'second try', 'kept']);
  });

  it('skips subagent rows and starts over when the file is replaced', async () => {
    const file = path.join(dir, 'replace.jsonl');
    await writeFile(file, [say('u1', null, 'user', 'main'), say('x1', 'u1', 'assistant', 'side', { isSidechain: true })].join('\n') + '\n');
    expect(texts(await readHistory(file))).toEqual(['main']);
    await rm(file);
    await writeFile(file, `${say('n1', null, 'user', 'new')}\n`);
    expect(texts(await readHistory(file))).toEqual(['new']);
  });

  it('returns nothing for a missing file', async () => {
    expect(await readHistory(path.join(dir, 'missing.jsonl'))).toEqual([]);
  });
});

describe('conversationUpTo', () => {
  it('reads the conversation up to a rewind’s cut, where Claude Code resumes, across compactions; as it reads now without one, or with one it does not hold', async () => {
    const file = path.join(dir, 'upto.jsonl');
    await writeFile(file, [
      say('u1', null, 'user', 'before'),
      say('a1', 'u1', 'assistant', 'old reply'),
      boundary('b1', 'a1'),
      say('s1', 'b1', 'user', 'summary', { isCompactSummary: true, isMeta: true }),
      say('u2', 's1', 'user', 'kept'),
      say('a2', 'u2', 'assistant', 'answer'),
      say('u3', 'a2', 'user', 'rewound away'),
      say('a3', 'u3', 'assistant', 'gone too'),
    ].join('\n') + '\n');
    expect(texts(await conversationUpTo(file, 'a2'))).toEqual(['before', 'old reply', 'summary', 'kept', 'answer']);
    const whole = ['before', 'old reply', 'summary', 'kept', 'answer', 'rewound away', 'gone too'];
    expect(texts(await conversationUpTo(file))).toEqual(whole);
    expect(texts(await conversationUpTo(file, 'never-written'))).toEqual(whole);
  });
});

describe('readHistory: messages sent mid-turn', () => {
  it('shows a queued command where Claude read it, under the sender’s id', async () => {
    const file = path.join(dir, 'steer.jsonl');
    await writeFile(file, [
      say('u1', null, 'user', 'run it'),
      say('a1', 'u1', 'assistant', 'running'),
      JSON.stringify({
        uuid: 'q1', parentUuid: 'a1', type: 'attachment', timestamp: new Date((clock += 1000)).toISOString(),
        attachment: { type: 'queued_command', prompt: [{ type: 'text', text: 'also say hi' }], source_uuid: 'client-1', commandMode: 'prompt' },
      }),
      say('a2', 'q1', 'assistant', 'done, hi'),
    ].join('\n') + '\n');
    const messages = await readHistory(file);
    expect(texts(messages)).toEqual(['run it', 'running', 'also say hi', 'done, hi']);
    expect(messages[2]).toMatchObject({ uuid: 'q1', role: 'user', steered: true, sourceUuid: 'client-1' });
  });
});

describe('readHistory: notes Claude Code adds to the conversation', () => {
  it('keeps hook feedback, warnings and notices where they were said, under the id the run published them with', async () => {
    const file = path.join(dir, 'notes.jsonl');
    const at = () => new Date((clock += 1000)).toISOString();
    await writeFile(file, [
      say('u1', null, 'user', 'Delete the build folder'),
      JSON.stringify({
        uuid: 'a1', parentUuid: 'u1', type: 'assistant', timestamp: at(),
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'rm -rf build' } }] },
      }),
      // A hook's message, as Claude Code records it, and its own notices.
      JSON.stringify({
        uuid: 'h1', parentUuid: 'a1', type: 'attachment', timestamp: at(),
        attachment: { type: 'hook_system_message', content: 'rm -rf is blocked here\nuse the clean script', hookName: 'PreToolUse:Bash', toolUseID: 't1', hookEvent: 'PreToolUse' },
      }),
      JSON.stringify({ uuid: 'n1', parentUuid: 'h1', type: 'system', subtype: 'informational', level: 'warning', content: 'The hook took 9 s', isMeta: false, timestamp: at() }),
      // The terminal shows 'info' lines only in its transcript view; the run does not publish them either.
      JSON.stringify({ uuid: 'n2', parentUuid: 'n1', type: 'system', subtype: 'informational', level: 'info', content: 'Running hooks', isMeta: false, timestamp: at() }),
      JSON.stringify({
        uuid: 'r1', parentUuid: 'n2', type: 'user', timestamp: at(),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Blocked by hook', is_error: true }] },
      }),
      say('a2', 'r1', 'assistant', 'I used npm run clean instead.'),
    ].join('\n') + '\n');
    const messages = await readHistory(file);
    expect(messages.map((m) => [m.uuid, m.role])).toEqual([['u1', 'user'], ['a1', 'assistant'], ['h1', 'system'], ['n1', 'system'], ['r1', 'user'], ['a2', 'assistant']]);
    // In Claude Code's words, as the run shows them while the turn runs.
    expect(messages[2]!.blocks).toEqual([{ type: 'text', text: 'PreToolUse:Bash says: rm -rf is blocked here\nPreToolUse:Bash says: use the clean script' }]);
    expect(messages[3]!.blocks).toEqual([{ type: 'text', text: 'The hook took 9 s' }]);
    expect(messages[3]!.timestamp).toBeTypeOf('number');
  });
});

describe('readRecordedSettings', () => {
  it('keeps what the session last ran with: model, effort, speed, ultracode, permission mode', async () => {
    const { readRecordedSettings } = await import('../src/server/history');
    const file = path.join(dir, 'settings.jsonl');
    const asst = (uuid: string, parent: string, extra: Record<string, unknown>, speed: string) => JSON.stringify({
      uuid, parentUuid: parent, type: 'assistant', timestamp: new Date((clock += 1000)).toISOString(),
      message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'ok' }], usage: { speed } }, ...extra,
    });
    await writeFile(file, [
      JSON.stringify({ uuid: 'u1', parentUuid: null, type: 'user', permissionMode: 'plan', timestamp: new Date((clock += 1000)).toISOString(), message: { role: 'user', content: 'go' } }),
      asst('a1', 'u1', { requestedModel: 'claude-sonnet-5', effort: 'high' }, 'standard'),
      JSON.stringify({ uuid: 'x1', parentUuid: 'a1', type: 'attachment', attachment: { type: 'ultra_effort_enter' } }),
      JSON.stringify({ uuid: 'u2', parentUuid: 'x1', type: 'user', permissionMode: 'bypassPermissions', timestamp: new Date((clock += 1000)).toISOString(), message: { role: 'user', content: 'more' } }),
      asst('a2', 'u2', { requestedModel: 'claude-opus-5-5', effort: 'max' }, 'fast'),
    ].join('\n') + '\n');
    expect(await readRecordedSettings(file)).toEqual({ model: 'claude-opus-5-5', effort: 'max', fast: true, ultracode: true, permissionMode: 'bypassPermissions' });
  });
});

describe('readHistory: the parsed transcripts it keeps', () => {
  it('keeps two long sessions in use at once, reading only what each gains, though together they pass the budget', async () => {
    // Two sessions of about 35M characters kept each (a message keeps at most 60,000), more together
    // than the 64 Mi kept for sessions not in use.
    const long = async (name: string) => {
      const file = path.join(dir, name);
      const text = 'x'.repeat(59_000);
      const rows: string[] = [];
      for (let i = 0; i < 600; i += 1) rows.push(say(`${name}-${i}`, i === 0 ? null : `${name}-${i - 1}`, i % 2 ? 'assistant' : 'user', text));
      await writeFile(file, `${rows.join('\n')}\n`);
      return file;
    };
    const a = await long('a.jsonl');
    const b = await long('b.jsonl');
    const firstOfA = (await readHistory(a))[0];
    const firstOfB = (await readHistory(b))[0];
    // Each grows while the other is read, as two pages following two working sessions see them.
    for (let i = 0; i < 2; i += 1) {
      await appendFile(a, `${say(`a-more-${i}`, i === 0 ? 'a.jsonl-599' : `a-more-${i - 1}`, 'user', 'more')}\n`);
      const nowA = await readHistory(a);
      await appendFile(b, `${say(`b-more-${i}`, i === 0 ? 'b.jsonl-599' : `b-more-${i - 1}`, 'user', 'more')}\n`);
      const nowB = await readHistory(b);
      // Read on from where it was, not parsed again from the start.
      expect(nowA[0]).toBe(firstOfA);
      expect(nowB[0]).toBe(firstOfB);
      expect(texts(nowA).at(-1)).toBe('more');
    }
    // Once nobody has looked at one for a minute, it is let go past the budget, as before.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 2 * 60_000);
      await readHistory(b);
      expect((await readHistory(a))[0]).not.toBe(firstOfA);
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);
});
