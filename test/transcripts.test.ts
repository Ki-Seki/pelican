import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readLastTurn } from '../src/server/transcripts';

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

  it('returns nothing for a missing file', async () => {
    expect(await readLastTurn(path.join(dir, 'missing.jsonl'))).toBeUndefined();
  });
});
