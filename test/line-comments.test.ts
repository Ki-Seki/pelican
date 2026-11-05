import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LineComment } from '../src/web/lib/review';

// What this browser keeps, in memory, as localStorage would.
const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
});

const SESSION = '33333333-2222-4333-8444-555555555555';
const comment = (id: string, note = 'Name it count'): LineComment => ({ id, path: 'src/a.ts', kind: 'add', line: 4, code: 'const x = 1;', note });

/** The comments module as a page loads it, with what this browser kept. */
async function load() {
  vi.resetModules();
  return import('../src/web/lib/review');
}

describe('line comments kept in this browser', () => {
  beforeEach(() => store.clear());

  it('are kept by the chat they were written in, and come back after a reload', async () => {
    const first = await load();
    first.setComments(SESSION, [comment('c1')]);
    first.setComments('new:/code/app', [comment('c2')]);
    const again = await load();
    expect(again.commentsOf(SESSION)).toEqual([comment('c1')]);
    expect(again.commentsOf('new:/code/app')).toEqual([comment('c2')]);
    expect(again.commentsOf('/code/app')).toEqual([]);
  });

  it('drop the store of earlier builds, kept by folder: nothing says which session each comment was written in', async () => {
    store.set('pelican:comments', JSON.stringify({ '/code/app': [comment('old')] }));
    const review = await load();
    expect(review.commentsOf('/code/app')).toEqual([]);
    expect(store.has('pelican:comments')).toBe(false);
  });

  it('leave out what is not a comment, and survive a broken store', async () => {
    store.set('pelican:comments', JSON.stringify({ chats: { [SESSION]: [comment('c1'), { id: 'c2', note: 3 }, null], other: 'nonsense' } }));
    expect((await load()).commentsOf(SESSION)).toEqual([comment('c1')]);
    store.set('pelican:comments', '{not json');
    const review = await load();
    expect(review.commentsOf(SESSION)).toEqual([]);
    review.setComments(SESSION, [comment('c3')]);
    expect((await load()).commentsOf(SESSION)).toEqual([comment('c3')]);
  });

  it('keep the fifty chats written in last', async () => {
    const review = await load();
    for (let i = 0; i < 60; i += 1) review.setComments(`chat-${i}`, [comment(`c${i}`)]);
    const again = await load();
    expect(again.commentsOf('chat-9')).toEqual([]);
    expect(again.commentsOf('chat-10')).toEqual([comment('c10')]);
    expect(again.commentsOf('chat-59')).toEqual([comment('c59')]);
  });
});

describe('line comments in a message', () => {
  it('go before the words, a blank line between, as Claude Desktop sends them', async () => {
    const { withComments } = await load();
    const said = 'src/a.ts:4\n> + const x = 1;\nName it count';
    expect(withComments('  Looks good otherwise \n', [comment('c1')])).toBe(`${said}\n\nLooks good otherwise`);
    expect(withComments('', [comment('c1')])).toBe(said);
    expect(withComments('No comments', [])).toBe('No comments');
  });
});
