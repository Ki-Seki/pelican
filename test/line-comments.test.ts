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
  return { ...(await import('../src/web/lib/review')), ...(await import('../src/web/lib/drafts')) };
}

describe('line comments kept in this browser', () => {
  beforeEach(() => store.clear());

  it('wait with the rest of what goes with the chat’s next message, and come back after a reload', async () => {
    const first = await load();
    first.setComments(SESSION, [comment('c1')]);
    first.setComments('new:/code/app', [comment('c2')]);
    const again = await load();
    expect(again.commentsOf(SESSION)).toEqual([comment('c1')]);
    expect(again.waitingOf(SESSION)).toMatchObject([{ id: 'c1', kind: 'comment', path: 'src/a.ts', lines: [4, 4], side: 'add', note: 'Name it count' }]);
    expect(again.commentsOf('new:/code/app')).toEqual([comment('c2')]);
    expect(again.commentsOf('/code/app')).toEqual([]);
  });

  it('change and go where they are among what waits, a quote beside them left as it was', async () => {
    const review = await load();
    const passage = review.waitingOf(SESSION);
    expect(passage).toEqual([]);
    review.setComments(SESSION, [comment('c1')]);
    review.addWaiting(SESSION, { id: 'q1', kind: 'quote', text: 'a passage', from: { what: 'reply' } });
    review.setComments(SESSION, [comment('c1', 'Name it total'), comment('c2')]);
    expect(review.waitingOf(SESSION).map((item) => `${item.id}:${item.note ?? ''}`)).toEqual(['c1:Name it total', 'q1:', 'c2:Name it count']);
    review.setComments(SESSION, []);
    expect(review.waitingOf(SESSION).map((item) => item.id)).toEqual(['q1']);
  });

  it('come from the store earlier builds kept them in, once, and leave out what is not a comment', async () => {
    store.set('pelican:comments', JSON.stringify({ chats: { [SESSION]: [comment('c1'), { id: 'c2', note: 3 }, null], other: 'nonsense' } }));
    expect((await load()).commentsOf(SESSION)).toEqual([comment('c1')]);
    expect(store.has('pelican:comments')).toBe(false);
    store.set('pelican:comments', '{not json');
    const review = await load();
    expect(review.commentsOf(SESSION)).toEqual([comment('c1')]);
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
  it('go before the words, three line breaks between, as Claude Desktop sends them', async () => {
    const { withComments } = await load();
    const said = 'In `src/a.ts` at line 4:\n```ts\nconst x = 1;\n```\nName it count';
    expect(withComments('  Looks good otherwise \n', [comment('c1')])).toBe(`${said}\n\n\nLooks good otherwise`);
    expect(withComments('', [comment('c1')])).toBe(said);
    expect(withComments('No comments', [])).toBe('No comments');
  });
});
