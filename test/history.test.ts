import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readHistory } from '../src/server/history';

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
