import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { config } from '../src/server/config';
import { findUpload, keepDays, saveUpload, sweepUploads } from '../src/server/files';

// Each test with folders of its own: in any order, one finds no other's uploads or settings.
let dir: string;
const saved = { stateDir: config.stateDir, claudeHome: config.claudeHome };
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'pelican-uploads-'));
  config.stateDir = path.join(dir, 'state');
  config.claudeHome = path.join(dir, 'claude');
  await mkdir(config.claudeHome, { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
afterAll(() => {
  Object.assign(config, saved);
});

const DAY = 24 * 3600_000;

describe('uploads', () => {
  it('go once they are older than Claude Code keeps sessions', async () => {
    const old = await saveUpload(new File(['old'], 'old.png', { type: 'image/png' }));
    const recent = await saveUpload(new File(['new'], 'new.png', { type: 'image/png' }));
    const then = new Date(Date.now() - 31 * DAY);
    await utimes(path.dirname(old.path), then, then);
    expect(await keepDays()).toBe(30);
    expect(await sweepUploads((await keepDays()) * DAY)).toBe(1);
    expect(await readdir(path.join(config.stateDir, 'uploads'))).toEqual([recent.id]);
  });

  it('are kept as long as Claude Code’s cleanupPeriodDays says, and at least a day', async () => {
    await writeFile(path.join(config.claudeHome, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 90 }));
    expect(await keepDays()).toBe(90);
    await writeFile(path.join(config.claudeHome, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 0 }));
    expect(await keepDays()).toBe(1);
    await writeFile(path.join(config.claudeHome, 'settings.json'), 'not json');
    expect(await keepDays()).toBe(30);
  });

  it('are typed by their extension, and one named for what every object has is a plain file', async () => {
    const png = await saveUpload(new File(['x'], 'shot.png', { type: 'image/png' }));
    expect((await findUpload(png.id))?.mime).toBe('image/png');
    for (const name of ['notes.constructor', 'notes.__proto__']) {
      const odd = await saveUpload(new File(['x'], name, { type: '' }));
      expect((await findUpload(odd.id))?.mime).toBe('application/octet-stream');
    }
  });
});
