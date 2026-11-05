import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { firstTurnSession, readLastTurn } from '../src/server/transcripts';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'pelican-transcripts-'));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const row = (value: Record<string, unknown>) => JSON.stringify(value);
const write = async (name: string, rows: string[]) => {
  const file = path.join(dir, name);
  await writeFile(file, `${rows.join('\n')}\n`);
  return file;
};

describe('readLastTurn', () => {
  it('takes the time and folder of the last turn and the text of the latest reply', async () => {
    const file = await write('a.jsonl', [
      row({ type: 'user', timestamp: '2026-11-05T01:00:00.000Z', cwd: '/w/app', gitBranch: 'main', message: { role: 'user', content: 'Fix it' } }),
      row({ type: 'assistant', timestamp: '2026-11-05T01:00:05.000Z', cwd: '/w/app', gitBranch: 'main', message: { content: [{ type: 'text', text: 'Fixed: the cache key was wrong.' }] } }),
      row({ type: 'assistant', timestamp: '2026-11-05T01:00:06.000Z', cwd: '/w/app', gitBranch: 'fix', message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] } }),
      // Rows Claude Desktop appends to idle sessions: not activity.
      row({ type: 'custom-title', customTitle: 'Cache bug' }),
      row({ type: 'queue-operation', timestamp: '2026-11-05T09:00:00.000Z', operation: 'enqueue' }),
    ]);
    const turn = await readLastTurn(file);
    expect(turn).toEqual({ time: Date.parse('2026-11-05T01:00:06.000Z'), cwd: '/w/app', gitBranch: 'fix', preview: 'Fixed: the cache key was wrong.' });
  });

  it('has no preview while the turn has said nothing yet', async () => {
    const file = await write('b.jsonl', [
      row({ type: 'assistant', timestamp: '2026-11-05T01:00:00.000Z', message: { content: [{ type: 'text', text: 'Earlier reply' }] } }),
      row({ type: 'user', timestamp: '2026-11-05T02:00:00.000Z', message: { role: 'user', content: 'Next task' } }),
    ]);
    const turn = await readLastTurn(file);
    expect(turn?.time).toBe(Date.parse('2026-11-05T02:00:00.000Z'));
    expect(turn?.preview).toBeUndefined();
  });

  it('skips subagent rows and a half-written last line', async () => {
    const file = await write('c.jsonl', [
      row({ type: 'assistant', timestamp: '2026-11-05T01:00:00.000Z', message: { content: [{ type: 'text', text: 'Main reply' }] } }),
      row({ type: 'assistant', isSidechain: true, timestamp: '2026-11-05T01:05:00.000Z', message: { content: [{ type: 'text', text: 'Subagent' }] } }),
      '{"type":"assistant","timestamp":"2026-11-05T01:06:00.000Z","message":{"content":[{"type":"text","text":"half',
    ]);
    const turn = await readLastTurn(file);
    expect(turn?.preview).toBe('Main reply');
    expect(turn?.time).toBe(Date.parse('2026-11-05T01:00:00.000Z'));
  });

  it('says why the turn stopped when its reply is Claude Code’s note of an API error', async () => {
    const file = await write('e.jsonl', [
      row({ type: 'user', timestamp: '2026-10-30T01:00:00.000Z', message: { role: 'user', content: 'Deploy the site' } }),
      row({
        type: 'assistant', timestamp: '2026-10-30T01:00:01.000Z', isApiErrorMessage: true, error: 'authentication_failed',
        message: { model: '<synthetic>', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] },
      }),
    ]);
    expect(await readLastTurn(file)).toEqual({ time: Date.parse('2026-10-30T01:00:01.000Z'), stopped: 'not signed in' });
  });

  it('notes a summary Claude Code wrote at the end, which the SDK titles the session with, unless a last prompt is there', async () => {
    const turn = [
      row({ type: 'user', timestamp: '2026-11-05T01:00:00.000Z', message: { role: 'user', content: 'Fix it' } }),
      row({ type: 'assistant', timestamp: '2026-11-05T01:00:05.000Z', message: { content: [{ type: 'text', text: 'Fixed.' }] } }),
    ];
    const summary = row({ type: 'summary', summary: 'Fixing the cache key', leafUuid: 'x' });
    expect((await readLastTurn(await write('f.jsonl', [...turn, summary])))?.summarized).toBe(true);
    expect((await readLastTurn(await write('g.jsonl', [...turn, summary, row({ type: 'last-prompt', lastPrompt: 'Fix it' })])))?.summarized).toBeUndefined();
    expect((await readLastTurn(await write('h.jsonl', turn)))?.summarized).toBeUndefined();
  });

  it('returns nothing for a missing file', async () => {
    expect(await readLastTurn(path.join(dir, 'missing.jsonl'))).toBeUndefined();
  });
});

describe('firstTurnSession', () => {
  it('names the session a transcript was copied from (a side chat), or its own', async () => {
    const side = await write('side.jsonl', [
      row({ type: 'custom-title', customTitle: 'Side chat', sessionId: 'side' }),
      row({ type: 'user', sessionId: 'parent', message: { role: 'user', content: 'from the parent' }, timestamp: '2026-11-02T09:00:00Z' }),
      row({ type: 'assistant', sessionId: 'parent', message: { role: 'assistant', content: [] }, timestamp: '2026-11-02T09:00:01Z' }),
      row({ type: 'user', sessionId: 'side', message: { role: 'user', content: 'a side question' }, timestamp: '2026-11-02T09:30:00Z' }),
    ]);
    expect(await firstTurnSession(side)).toBe('parent');
    const own = await write('own.jsonl', [row({ type: 'user', sessionId: 'own', message: { role: 'user', content: 'hi' }, timestamp: '2026-11-02T09:00:00Z' })]);
    expect(await firstTurnSession(own)).toBe('own');
    expect(await firstTurnSession(path.join(dir, 'missing.jsonl'))).toBeUndefined();
  });
});
