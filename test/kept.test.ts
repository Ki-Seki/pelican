import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

const id = (n: number) => `7b7b7b7b-0000-4000-8000-${String(n).padStart(12, '0')}`;
const folders: string[] = [];

/** Pelican's pins and archive as a fresh start reads them, from a state folder of their own. */
async function start() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pelican-kept-'));
  folders.push(dir);
  vi.resetModules();
  const { config } = await import('../src/server/config');
  config.stateDir = dir;
  const kept = await import('../src/server/kept');
  const now = async () => {
    const { archived, pinned } = await kept.kept();
    return (n: number) => ({ archived: archived.has(id(n)), pinned: pinned.has(id(n)) });
  };
  return { dir, ...kept, now };
}

afterAll(() => Promise.all(folders.map((dir) => rm(dir, { recursive: true, force: true }))));

describe('a session’s pin and archive', () => {
  it('are never both: archiving unpins, and a pin brings an archived session back', async () => {
    const { keep, now } = await start();
    await keep(id(1), { pinned: true });
    await keep(id(1), { archived: true });
    expect((await now())(1)).toEqual({ archived: true, pinned: false });
    await keep(id(1), { pinned: true });
    expect((await now())(1)).toEqual({ archived: false, pinned: true });
    // Taking one back leaves the other as it is.
    await keep(id(1), { archived: false });
    expect((await now())(1)).toEqual({ archived: false, pinned: true });
    await keep(id(1), { pinned: false });
    expect((await now())(1)).toEqual({ archived: false, pinned: false });
  });

  it('change one at a time, so two at once still leave one or the other', async () => {
    const { keep, now } = await start();
    await Promise.all([keep(id(2), { archived: true }), keep(id(2), { pinned: true }), keep(id(3), { pinned: true }), keep(id(3), { archived: true })]);
    const marks = await now();
    expect([marks(2), marks(3)]).toEqual([{ archived: false, pinned: true }, { archived: true, pinned: false }]);
  });

  it('stay as they were when the second write fails', async () => {
    const { dir, keep, now } = await start();
    await keep(id(4), { pinned: true });
    // Where the pins go, a folder: unpinning cannot land, so the archive is taken back.
    await rm(path.join(dir, 'pinned.json'));
    await mkdir(path.join(dir, 'pinned.json'));
    await expect(keep(id(4), { archived: true })).rejects.toThrow();
    expect((await now())(4)).toEqual({ archived: false, pinned: true });
  });

  it('go with a session that is deleted', async () => {
    const { forget, keep, now } = await start();
    await keep(id(5), { pinned: true });
    await keep(id(6), { archived: true });
    await forget(id(5));
    await forget(id(6));
    const marks = await now();
    expect([marks(5), marks(6)]).toEqual([{ archived: false, pinned: false }, { archived: false, pinned: false }]);
  });
});
