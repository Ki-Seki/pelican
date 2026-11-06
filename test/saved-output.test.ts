import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SavedOutputPage } from '../src/shared/protocol';
import { app } from '../src/server/app';
import { accessToken, loadAuth } from '../src/server/auth';
import { config } from '../src/server/config';
import { SAVED_PAGE_BYTES } from '../src/server/shell';
import { refreshTranscriptIndex } from '../src/server/transcripts';

const SESSION = '7a7a7a7a-1111-4222-8333-555555555555';
const OTHER = '7a7a7a7a-1111-4222-8333-666666666666';
/** A branch of SESSION (Claude Code's forkSession: its rows copied, each saying from where), and a third session. */
const FORK = '7a7a7a7a-1111-4222-8333-777777777777';
const THIRD = '7a7a7a7a-1111-4222-8333-888888888888';
const saved = { ...config };
let dir: string;
let folder: string;
// One byte, then two-byte characters: a page of 256 KB would end inside one.
const OUTPUT = `x${'é'.repeat(200_000)}`;
const LINES = Array.from({ length: 40_000 }, (_, i) => `line ${i + 1}\n`).join('');

beforeAll(async () => {
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pelican-saved-')));
  config.configDir = path.join(dir, 'config');
  config.stateDir = path.join(dir, 'state');
  config.auth = 'auto';
  await loadAuth();
  // Two sessions, as Claude Code keeps them, one with a long ! command's output saved beside it.
  const projects = path.join(config.claudeHome, 'projects', '-work');
  await mkdir(projects, { recursive: true });
  for (const id of [SESSION, OTHER]) {
    await writeFile(path.join(projects, `${id}.jsonl`), `${JSON.stringify({ type: 'user', uuid: `p-${id}`, sessionId: id, message: { role: 'user', content: 'hi' } })}\n`);
  }
  folder = path.join(projects, SESSION, 'tool-results');
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'b1b2gp6fw.txt'), OUTPUT);
  await writeFile(path.join(folder, 'blines000.txt'), LINES);
  await writeFile(path.join(folder, 'bown00000.txt'), 'saved for SESSION\n');
  await writeFile(path.join(dir, 'secret.txt'), 'not for the phone\n');
  await symlink(path.join(dir, 'secret.txt'), path.join(folder, 'blinked00.txt'));
  // A file with a second name, made in the folder: not one Claude Code wrote there.
  await link(path.join(dir, 'secret.txt'), path.join(folder, 'bhardlnk0.txt'));
  await mkdir(path.join(projects, OTHER), { recursive: true });
  // Another session's folder made a link to this one's.
  await symlink(folder, path.join(projects, OTHER, 'tool-results'));
  // The branch: its records of SESSION's long output, one copied from SESSION and one copied from
  // THIRD (a branch of a branch), which both name SESSION's file; and one of its own naming it.
  const record = (uuid: string, name: string, extra: Record<string, unknown>) => JSON.stringify({
    type: 'user', uuid, sessionId: FORK, ...extra,
    message: { role: 'user', content: `<bash-stdout><persisted-output>\nOutput too large (390.6KB). Full output saved to: ${path.join(folder, name)}\n\nPreview (first 2KB):\nx\n...\n</persisted-output></bash-stdout><bash-stderr></bash-stderr>` },
  });
  await writeFile(path.join(projects, `${FORK}.jsonl`), [
    record('f1', 'b1b2gp6fw.txt', { forkedFrom: { sessionId: SESSION, messageUuid: 'f1' } }),
    record('f2', 'blines000.txt', { parentUuid: 'f1', forkedFrom: { sessionId: THIRD, messageUuid: 'f2' } }),
    record('f3', 'bhardlnk0.txt', { parentUuid: 'f2', forkedFrom: { sessionId: SESSION, messageUuid: 'f3' } }),
    record('f4', 'bown00000.txt', { parentUuid: 'f3' }),
  ].join('\n') + '\n');
  await refreshTranscriptIndex();
});
afterAll(async () => {
  Object.assign(config, saved);
  await rm(dir, { recursive: true, force: true });
});

const ask = (url: string, auth = true) => app.request(url, { headers: { host: 'localhost:7860', 'x-pelican': '1', ...(auth ? { authorization: `Bearer ${accessToken()}` } : {}) } });
const page = async (name: string, from?: number) => {
  const response = await ask(`/api/sessions/${SESSION}/tool-results/${encodeURIComponent(name)}${from === undefined ? '' : `?from=${from}`}`);
  return { status: response.status, body: (await response.json()) as SavedOutputPage };
};

describe('a long ! command’s saved output, for Show all', () => {
  it('is read by its name from the session’s own tool-results folder, a page at a time, in whole characters', async () => {
    const first = await page('b1b2gp6fw.txt');
    expect(first.status).toBe(200);
    // The page ends before the character it would cut in two, which starts the next.
    expect(first.body).toEqual({ text: `x${'é'.repeat((SAVED_PAGE_BYTES - 1) / 2)}`, from: 0, size: Buffer.byteLength(OUTPUT), next: SAVED_PAGE_BYTES - 1 });
    const second = await page('b1b2gp6fw.txt', first.body.next);
    expect(second.body.next).toBeUndefined();
    expect(first.body.text + second.body.text).toBe(OUTPUT);
    // Asked for from inside a character, it starts at the next whole one.
    expect((await page('b1b2gp6fw.txt', 2)).body).toMatchObject({ from: 3, text: 'é'.repeat(Math.floor((SAVED_PAGE_BYTES - 1) / 2)) });
    // Lines are kept whole where a page can end with one.
    const lines = await page('blines000.txt');
    expect(lines.body.next).toBeDefined();
    expect(lines.body.text.endsWith('\n')).toBe(true);
    expect(lines.body.text + (await page('blines000.txt', lines.body.next)).body.text).toBe(LINES);
  });

  it('is nothing else: no path, no other kind of name, no link, not another session’s, and only for you', async () => {
    for (const name of ['../secret.txt', '..', 'b1b2gp6fw', 'b1b2gp6fw.txt.bak', '.hidden.txt', 'blinked00.txt', 'bhardlnk0.txt', 'missing0.txt']) {
      expect((await page(name)).status, name).toBe(404);
    }
    expect((await ask(`/api/sessions/${SESSION}/tool-results/..%2F..%2F${SESSION}.jsonl`)).status).toBe(404);
    // The other session's folder leads to this one's through a link.
    expect((await ask(`/api/sessions/${OTHER}/tool-results/b1b2gp6fw.txt`)).status).toBe(404);
    expect((await ask('/api/sessions/not-a-session/tool-results/b1b2gp6fw.txt')).status).toBe(404);
    expect((await page('b1b2gp6fw.txt', -1)).status).toBe(404);
    expect((await ask(`/api/sessions/${SESSION}/tool-results/b1b2gp6fw.txt`, false)).status).toBe(401);
  });
});

describe('a branch’s copy of a long ! command’s record, for Show all', () => {
  const branch = (name: string) => ask(`/api/sessions/${FORK}/tool-results/${encodeURIComponent(name)}`);

  it('reads the saved output in the folder of the session it was copied from, when that is the one its path names', async () => {
    const response = await branch('b1b2gp6fw.txt');
    expect(response.status).toBe(200);
    expect(((await response.json()) as SavedOutputPage).text).toBe(`x${'é'.repeat((SAVED_PAGE_BYTES - 1) / 2)}`);
  });

  it('is gone when the row came from another session than the path names, or is the branch’s own, and never a file with another name', async () => {
    // Copied from THIRD, a branch of a branch, though the path names SESSION's folder.
    expect((await branch('blines000.txt')).status).toBe(404);
    // Not a copy: the branch's own row naming another session's file.
    expect((await branch('bown00000.txt')).status).toBe(404);
    expect((await branch('bhardlnk0.txt')).status).toBe(404);
    // A session with no such record reads only its own folder.
    expect((await ask(`/api/sessions/${OTHER}/tool-results/blines000.txt`)).status).toBe(404);
  });
});
