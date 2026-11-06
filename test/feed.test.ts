import { appendFile, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ServerEvent } from '../src/shared/protocol';
import { config } from '../src/server/config';
import { feedCount, feedFor, subscribe } from '../src/server/feed';
import { refreshTranscriptIndex } from '../src/server/transcripts';

let dir: string;
let projects: string;
const saved = config.claudeHome;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'pelican-feed-'));
  config.claudeHome = dir;
  projects = path.join(dir, 'projects', '-w-app');
  await mkdir(projects, { recursive: true });
});
afterAll(async () => {
  config.claudeHome = saved;
  await rm(dir, { recursive: true, force: true });
});

let clock = Date.parse('2026-11-05T00:00:00.000Z');
const say = (uuid: string, parent: string | null, type: 'user' | 'assistant', text: string) =>
  `${JSON.stringify({
    uuid, parentUuid: parent, type, timestamp: new Date((clock += 1000)).toISOString(),
    message: type === 'user' ? { role: 'user', content: text } : { role: 'assistant', content: [{ type: 'text', text }] },
  })}\n`;

async function transcript(id: string, rows: string): Promise<string> {
  const file = path.join(projects, `${id}.jsonl`);
  await writeFile(file, rows);
  await refreshTranscriptIndex();
  return file;
}

/** Waits for `test` to hold: up to 10 seconds, which a busy computer can need. */
async function until(test: () => boolean, ms = 10_000): Promise<void> {
  for (const start = Date.now(); !test(); ) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const delivered = (events: ServerEvent[]) =>
  events.flatMap((e) => (e.type === 'message' ? [e.message.uuid] : e.type === 'reload' ? ['reload'] : []));

describe('a session’s feed', () => {
  it('delivers each row added to the transcript once, and a vanished row as a reload', async () => {
    const id = '0f0f0f0f-0000-4000-8000-000000000001';
    const file = await transcript(id, say('u1', null, 'user', 'first'));
    const events: ServerEvent[] = [];
    const unsubscribe = subscribe(id, (event) => events.push(event));
    try {
      await feedFor(id).check();
      await appendFile(file, say('a1', 'u1', 'assistant', 'reply'));
      await until(() => delivered(events).includes('a1'));
      // What the run publishes and the transcript then holds goes out once.
      await feedFor(id).publish({ uuid: 'u2', role: 'user', blocks: [{ type: 'text', text: 'next' }] });
      await appendFile(file, say('u2', 'a1', 'user', 'next'));
      await until(() => feedFor(id).watching && delivered(events).includes('u2'));
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(delivered(events)).toEqual(['a1', 'u2']);
      // Rewound: a row the client has is gone from the file.
      await writeFile(file, say('u1', null, 'user', 'first'));
      await until(() => delivered(events).includes('reload'));
    } finally {
      unsubscribe();
    }
  }, 20_000);

  it('keeps going when the transcript cannot be read, and reads it once it can', async () => {
    if (process.getuid?.() === 0) return; // root reads anything
    const id = '0f0f0f0f-0000-4000-8000-000000000002';
    const file = await transcript(id, say('u1', null, 'user', 'locked'));
    await chmod(file, 0o000);
    const events: ServerEvent[] = [];
    const unsubscribe = subscribe(id, (event) => events.push(event));
    try {
      // At least one poll runs into the unreadable file; an unhandled rejection would fail this run.
      await new Promise((resolve) => setTimeout(resolve, 1300));
      // A run still publishes into it.
      await feedFor(id).publish({ uuid: 'p1', role: 'user', blocks: [{ type: 'text', text: 'sent' }] });
      expect(delivered(events)).toEqual(['p1']);
      // Readable again: clients, which could not load it either, read it whole.
      await chmod(file, 0o644);
      await until(() => delivered(events).includes('reload'));
      await appendFile(file, say('a1', 'u1', 'assistant', 'readable again'));
      await until(() => delivered(events).includes('a1'));
    } finally {
      unsubscribe();
      await chmod(file, 0o644);
    }
  }, 20_000);

  it('is let go once nobody watches and nothing waits for a late subscriber', async () => {
    const id = '0f0f0f0f-0000-4000-8000-000000000003';
    await transcript(id, say('u1', null, 'user', 'hello'));
    const before = feedCount();
    subscribe(id, () => undefined)();
    expect(feedCount()).toBe(before);
    // Published with nobody watching (a new session's first prompt): kept for a page that subscribes late.
    await feedFor(id).publish({ uuid: 'p9', role: 'user', blocks: [{ type: 'text', text: 'first' }] });
    const late: ServerEvent[] = [];
    const unsubscribe = subscribe(id, (event) => late.push(event));
    await until(() => delivered(late).length > 0);
    unsubscribe();
    expect(delivered(late)).toEqual(['p9']);
    expect(feedCount()).toBe(before + 1);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 3 * 60_000);
      expect(feedFor(id).idle).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives a late subscriber only what the transcript does not hold yet, before what happens meanwhile', async () => {
    const id = '0f0f0f0f-0000-4000-8000-000000000004';
    const file = await transcript(id, say('u1', null, 'user', 'Take a screenshot'));
    // A step the run published with its picture as data, and the transcript then wrote.
    const picture = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo'.repeat(1000) } };
    await feedFor(id).publish({ uuid: 'r1', role: 'user', blocks: [{ type: 'tool_result', tool_use_id: 't1', content: [picture as never] }] });
    await appendFile(file, `${JSON.stringify({
      uuid: 'r1', parentUuid: 'u1', type: 'user', timestamp: new Date((clock += 1000)).toISOString(),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [picture] }] },
    })}\n`);
    // One the transcript has not got yet.
    await feedFor(id).publish({ uuid: 'a1', role: 'assistant', blocks: [{ type: 'text', text: 'Here it is.' }] });
    const late: ServerEvent[] = [];
    const unsubscribe = subscribe(id, (event) => late.push(event));
    try {
      feedFor(id).broadcast({ type: 'reload', sessionId: id });
      await until(() => late.length >= 2);
      await new Promise((resolve) => setTimeout(resolve, 50));
      // The page reads the picture from the transcript, by address: it is not sent again as data.
      expect(delivered(late)).toEqual(['a1', 'reload']);
    } finally {
      unsubscribe();
    }
  });
});
