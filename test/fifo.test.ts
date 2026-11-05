import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readHistory } from '../src/server/history';
import { readLastTurn } from '../src/server/transcripts';
import { readProjectFile } from '../src/server/workspace';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'pelican-fifo-'));
  execFileSync('mkfifo', [path.join(dir, 'pipe')]);
  execFileSync('mkfifo', [path.join(dir, 'pipe.jsonl')]);
  await writeFile(path.join(dir, 'notes.txt'), 'hello\n');
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe.skipIf(process.platform === 'win32')('a named pipe where a file should be', () => {
  it('is refused at once, and never holds up the server’s other file reads', async () => {
    // More than Node's four file threads: any that waited for a writer would stall the rest.
    const reads = Array.from({ length: 6 }, () => readProjectFile(dir, 'pipe').then(() => 'read', (error: Error) => error.message));
    expect(await Promise.all(reads)).toEqual(Array(6).fill('Not a regular file'));
    expect(await readProjectFile(dir, 'notes.txt')).toMatchObject({ text: 'hello\n' });
  });

  it('is no transcript either', async () => {
    const file = path.join(dir, 'pipe.jsonl');
    expect(await readHistory(file)).toEqual([]);
    expect(await readLastTurn(file)).toBeUndefined();
  });
});
