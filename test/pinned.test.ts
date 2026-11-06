import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const id = (n: number) => `9a9a9a9a-0000-4000-8000-${String(n).padStart(12, '0')}`;
const folders: string[] = [];

/** A state folder of its own, and the pins as a fresh start of Pelican reads them from it. */
async function start(stateDir?: string) {
  const dir = stateDir ?? await mkdtemp(path.join(os.tmpdir(), 'pelican-pins-'));
  if (!stateDir) folders.push(dir);
  vi.resetModules();
  const { config } = await import('../src/server/config');
  config.stateDir = dir;
  return { dir, file: path.join(dir, 'pinned.json'), ...await import('../src/server/pinned') };
}

const read = async (file: string) => JSON.parse(await readFile(file, 'utf8')) as { ids: string[] };

afterEach(() => vi.restoreAllMocks());
afterAll(() => Promise.all(folders.map((dir) => rm(dir, { recursive: true, force: true }))));

describe('the pins', () => {
  it('are none at first, and are kept in pinned.json in the state folder, readable only by you', async () => {
    const { dir, file, pinnedIds, setPinned } = await start();
    expect([...await pinnedIds()]).toEqual([]);
    await setPinned(id(1), true);
    await setPinned(id(2), true);
    await setPinned(id(1), false);
    expect(await read(file)).toEqual({ ids: [id(2)] });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    // The next start reads them back.
    const again = await start(dir);
    expect([...await again.pinnedIds()]).toEqual([id(2)]);
  });

  it('are written one at a time, each write with all of them, and leave nothing else behind', async () => {
    const { dir, file, setPinned } = await start();
    const ids = Array.from({ length: 12 }, (_, n) => id(n));
    await Promise.all(ids.map((pinned) => setPinned(pinned, true)));
    expect((await read(file)).ids.sort()).toEqual([...ids].sort());
    expect(await readdir(dir)).toEqual(['pinned.json']);
  });

  it('set aside a file they cannot read, rather than throw it away, and start with none', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pelican-pins-'));
    folders.push(dir);
    await writeFile(path.join(dir, 'pinned.json'), '{"ids": [');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { file, pinnedIds, setPinned } = await start(dir);
    expect([...await pinnedIds()]).toEqual([]);
    const aside = (await readdir(dir)).find((name) => name.startsWith('pinned.json.bad-'));
    expect(aside && await readFile(path.join(dir, aside), 'utf8')).toBe('{"ids": [');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('pinned.json could not be read; it was set aside and no session is pinned'));
    await setPinned(id(3), true);
    expect(await read(file)).toEqual({ ids: [id(3)] });
  });

  it('keep only ids that are text', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pelican-pins-'));
    folders.push(dir);
    await writeFile(path.join(dir, 'pinned.json'), JSON.stringify({ ids: [id(4), 7, null, { id: id(5) }] }));
    const { pinnedIds } = await start(dir);
    expect([...await pinnedIds()]).toEqual([id(4)]);
  });

  it('stay as they were when a write fails, with no half-written file left', async () => {
    const { dir, file, pinnedIds, setPinned } = await start();
    await setPinned(id(6), true);
    // Where the file goes, a folder: the write cannot land.
    await rm(file);
    await mkdir(file);
    await expect(setPinned(id(7), true)).rejects.toThrow();
    expect([...await pinnedIds()]).toEqual([id(6)]);
    expect(await readdir(dir)).toEqual(['pinned.json']);
  });
});
