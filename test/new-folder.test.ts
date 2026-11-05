import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FolderError, makeDir } from '../src/server/files';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'pelican-newfolder-'));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const fails = (promise: Promise<unknown>, status: number) => expect(promise).rejects.toSatisfy((e) => e instanceof FolderError && e.status === status);

describe('a new folder for a session', () => {
  it('is made inside the folder being browsed, and its path comes back', async () => {
    const made = await makeDir(dir, '  my project  ');
    expect(made).toBe(path.join(await import('node:fs/promises').then((f) => f.realpath(dir)), 'my project'));
    expect((await stat(made)).isDirectory()).toBe(true);
  });

  it('is never an existing folder or file', async () => {
    await makeDir(dir, 'twice');
    await fails(makeDir(dir, 'twice'), 409);
    await writeFile(path.join(dir, 'a-file'), 'x');
    await fails(makeDir(dir, 'a-file'), 409);
  });

  it('takes a plain name only: no slashes, no way up, no control characters', async () => {
    for (const name of ['', '   ', '.', '..', 'a/b', '../escape', 'a\\b', 'bad\u0000name', 'tab\tname', 'x'.repeat(256)]) await fails(makeDir(dir, name), 400);
  });

  it('says so when the place is gone', async () => {
    await fails(makeDir(path.join(dir, 'nowhere'), 'x'), 404);
  });
});
