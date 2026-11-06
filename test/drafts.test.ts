import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Attachment } from '../src/shared/protocol';
import type { WaitingItem } from '../src/web/lib/quote';

// What this browser keeps, in memory, as localStorage would.
const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
});
const { addWaiting, clearDraft, forgetDrafts, loadDraft, moveDraft, putBackWaiting, saveDraft, setWaiting, takeWaiting, updateWaiting, waitingOf } = await import('../src/web/lib/drafts');

const file: Attachment = { id: 'u1', name: 'shot.png', mime: 'image/png', size: 10, path: '/tmp/u1' };
const quote = (id: string, text: string, note?: string): WaitingItem => ({ id, kind: 'quote', text, from: { what: 'reply', key: 'a1', span: [3, 9] }, ...(note ? { note } : {}) });

/** The drafts module as a page loads it, with what this browser kept. */
async function reload() {
  vi.resetModules();
  return import('../src/web/lib/drafts');
}

describe('drafts', () => {
  beforeEach(() => {
    store.clear();
    for (const chat of ['s1', 's2', 'new:/code/acme', 'new:/code/site']) setWaiting(chat, []);
  });

  it('are kept per chat, with the files already uploaded', () => {
    saveDraft('s1', 'Also add a section on the migration steps, with', [file]);
    saveDraft('new:/code/acme', 'Start with');
    expect(loadDraft('s1')).toMatchObject({ text: 'Also add a section on the migration steps, with', attachments: [file] });
    expect(loadDraft('new:/code/acme')?.text).toBe('Start with');
    expect(loadDraft('s2')).toBeUndefined();
  });

  it('go when the box is emptied by hand', () => {
    saveDraft('s1', 'hello');
    saveDraft('s1', '   ');
    expect(loadDraft('s1')).toBeUndefined();
  });

  it('go once the message they hold was sent, not when another was started meanwhile', () => {
    saveDraft('s1', 'first message');
    clearDraft('s1', 'something else');
    expect(loadDraft('s1')?.text).toBe('first message');
    clearDraft('s1', 'first message  ');
    expect(loadDraft('s1')).toBeUndefined();
  });

  it('go along with a new session moved to another folder, files and what waits and all', () => {
    saveDraft('new:/code/acme', 'Refactor the export job', [file]);
    addWaiting('new:/code/acme', quote('q1', 'the export job', 'Why so slow?'));
    saveDraft('new:/code/site', 'An older start there');
    moveDraft('new:/code/acme', 'new:/code/site');
    expect(loadDraft('new:/code/acme')).toBeUndefined();
    expect(waitingOf('new:/code/acme')).toEqual([]);
    expect(loadDraft('new:/code/site')).toMatchObject({ text: 'Refactor the export job', attachments: [file], items: [quote('q1', 'the export job', 'Why so slow?')] });
    expect(waitingOf('new:/code/site')).toEqual([quote('q1', 'the export job', 'Why so slow?')]);
    // Nothing typed: what the other folder had stays.
    moveDraft('new:/code/acme', 'new:/code/site');
    expect(loadDraft('new:/code/site')?.text).toBe('Refactor the export job');
  });

  it('keep the newest fifty', () => {
    for (let i = 0; i < 60; i += 1) {
      store.set('pelican:drafts', JSON.stringify({ ...JSON.parse(store.get('pelican:drafts') ?? '{}'), [`s${i}`]: { text: `draft ${i}`, at: i } }));
    }
    saveDraft('latest', 'newest');
    const kept = Object.keys(JSON.parse(store.get('pelican:drafts')!) as object);
    expect(kept).toHaveLength(50);
    expect(kept).toContain('latest');
    expect(kept).not.toContain('s0');
  });

  it('keep what waits for the next message, notes and all, across a reload and after its words were sent', async () => {
    saveDraft('s1', 'And not a context?');
    addWaiting('s1', quote('q1', 'Why CSS variables?', 'Say why'));
    updateWaiting('s1', 'q1', { note: 'Say why, briefly' });
    const again = await reload();
    expect(again.loadDraft('s1')).toMatchObject({ text: 'And not a context?', items: [quote('q1', 'Why CSS variables?', 'Say why, briefly')] });
    expect(again.waitingOf('s1')).toEqual([quote('q1', 'Why CSS variables?', 'Say why, briefly')]);
    // What waits alone is a draft too, and the words of a sent message go without it.
    again.clearDraft('s1', 'And not a context?');
    expect(again.loadDraft('s1')).toMatchObject({ text: '', items: [quote('q1', 'Why CSS variables?', 'Say why, briefly')] });
    again.setWaiting('s1', []);
    expect(again.loadDraft('s1')).toBeUndefined();
    // A quote of a terminal keeps its tab and what its header calls it.
    const terminal = { id: 't1', kind: 'quote' as const, text: '14 passed', from: { what: 'terminal' as const }, tab: '2', label: 'zsh' };
    again.addWaiting('s2', terminal);
    expect((await reload()).waitingOf('s2')).toEqual([terminal]);
  });

  it('give what waits to one message at a time, and take it back, before anything added meanwhile, when it does not go', () => {
    addWaiting('s1', quote('q1', 'first passage'));
    addWaiting('s1', quote('q2', 'second passage', 'a note'));
    const taken = takeWaiting('s1');
    expect(taken.map((item) => item.id)).toEqual(['q1', 'q2']);
    expect(takeWaiting('s1')).toEqual([]);
    addWaiting('s1', quote('q3', 'added while it was on its way'));
    putBackWaiting('s1', taken);
    expect(waitingOf('s1').map((item) => item.id)).toEqual(['q1', 'q2', 'q3']);
  });

  it('hold up to 99 quotes with a note, as Claude Desktop’s message does', () => {
    for (let i = 0; i < 99; i += 1) expect(addWaiting('s1', quote(`q${i}`, `passage ${i}`, 'note'))).toBe(true);
    expect(addWaiting('s1', quote('q99', 'one more', 'note'))).toBe(false);
    // Without a note it is an excerpt, which has no such limit.
    expect(addWaiting('s1', quote('q100', 'one more'))).toBe(true);
    expect(waitingOf('s1')).toHaveLength(100);
  });

  it('keep what waits when a ! command goes instead: it waits for a message', () => {
    saveDraft('s1', '!npm test');
    addWaiting('s1', quote('q1', 'the failing line'));
    clearDraft('s1', '!npm test');
    expect(loadDraft('s1')).toMatchObject({ text: '', items: [quote('q1', 'the failing line')] });
  });

  it('keep what waits to be put back, files and all, once the message beside it was sent, and take it to another folder', () => {
    saveDraft('s1', 'Then fix what fails', [], [{ text: '!npm test' }]);
    expect(loadDraft('s1')).toMatchObject({ text: 'Then fix what fails', held: [{ text: '!npm test' }] });
    clearDraft('s1', 'Then fix what fails');
    expect(loadDraft('s1')).toMatchObject({ text: '', held: [{ text: '!npm test' }] });
    saveDraft('new:/code/acme', '/compact', [], [{ text: 'What does this show?', attachments: [file], aside: true }]);
    moveDraft('new:/code/acme', 'new:/code/site');
    // Set aside by Put back, it says so after a reload too.
    expect(loadDraft('new:/code/site')?.held).toEqual([{ text: 'What does this show?', attachments: [file], aside: true }]);
    expect(loadDraft('new:/code/acme')).toBeUndefined();
    // A text alone, as kept before waiting messages kept their files; what holds neither words nor files goes.
    store.set('pelican:drafts', JSON.stringify({ s1: { text: '', held: ['!kept', 3, null, ' ', { text: ' ' }, { text: '', attachments: [file, { id: 3 }], aside: 'yes' }], at: 1 } }));
    expect(loadDraft('s1')?.held).toEqual([{ text: '!kept' }, { text: '', attachments: [file] }]);
  });

  it('leave out what is not a waiting item', () => {
    store.set('pelican:drafts', JSON.stringify({ s1: { text: 'x', items: [quote('q1', 'kept'), { id: 'q2', kind: 'quote' }, { id: 'c1', kind: 'comment', text: 'x', path: 'a.ts', note: '' }, null, 'nonsense'], at: 1 } }));
    expect(loadDraft('s1')?.items).toEqual([quote('q1', 'kept')]);
  });

  it('all go when this browser signs out, what waits with them too', () => {
    saveDraft('s1', 'a prompt');
    saveDraft('s2', 'another');
    addWaiting('s2', quote('q1', 'a passage'));
    forgetDrafts();
    expect(loadDraft('s1')).toBeUndefined();
    expect(loadDraft('s2')).toBeUndefined();
    expect(waitingOf('s2')).toEqual([]);
  });

  it('survive a broken store', () => {
    store.set('pelican:drafts', '{not json');
    expect(loadDraft('s1')).toBeUndefined();
    saveDraft('s1', 'still saved');
    expect(loadDraft('s1')?.text).toBe('still saved');
  });
});

describe('what earlier builds kept, moved in once', () => {
  beforeEach(() => store.clear());

  it('quotes kept as text become items: a file’s lines with where they are, secrets masked as one taken now would be', async () => {
    const token = ['gh', 'p_', 'x'.repeat(36)].join('');
    store.set('pelican:drafts', JSON.stringify({ s1: { text: 'about these', quotes: ['src/app.ts:7-8\n>   const a = 1;\n>   const b = 2;', `> the key is ${token}`, 3, ' '], at: 1 } }));
    const drafts = await reload();
    expect(drafts.waitingOf('s1')).toMatchObject([
      { kind: 'quote', text: '  const a = 1;\n  const b = 2;', path: 'src/app.ts', lines: [7, 8], from: { what: 'file' } },
      { kind: 'quote', text: `the key is ${token.slice(0, 8)}${'\u2022'.repeat(token.length - 8)}`, from: { what: 'earlier' } },
    ]);
    expect(drafts.loadDraft('s1')?.text).toBe('about these');
    // Once: the draft keeps items now, with the same ids after another reload.
    const stored = JSON.parse(store.get('pelican:drafts')!) as Record<string, Record<string, unknown>>;
    expect(stored.s1!.quotes).toBeUndefined();
    const ids = drafts.waitingOf('s1').map((item) => item.id);
    expect((await reload()).waitingOf('s1').map((item) => item.id)).toEqual(ids);
  });

  it('line comments kept apart join what waits in their chat, and their store goes', async () => {
    const comment = { id: 'c1', path: 'src/a.ts', kind: 'add', line: 4, code: 'const x = 1;', note: 'Name it count' };
    store.set('pelican:comments', JSON.stringify({ chats: { s1: [comment, { id: 'c2', note: 3 }, null], other: 'nonsense' } }));
    store.set('pelican:drafts', JSON.stringify({ s1: { text: 'Looks good', items: [quote('q1', 'a passage')], at: 1 } }));
    const drafts = await reload();
    expect(drafts.waitingOf('s1')).toEqual([
      quote('q1', 'a passage'),
      { id: 'c1', kind: 'comment', text: 'const x = 1;', note: 'Name it count', path: 'src/a.ts', lines: [4, 4], side: 'add', from: { what: 'diff' } },
    ]);
    expect(store.has('pelican:comments')).toBe(false);
    expect(drafts.loadDraft('s1')?.text).toBe('Looks good');
  });

  it('comments kept by folder, before they were kept by session, are dropped: nothing says whose they were', async () => {
    store.set('pelican:comments', JSON.stringify({ '/code/app': [{ id: 'old', path: 'a.ts', kind: 'add', line: 1, code: 'x', note: 'y' }] }));
    const drafts = await reload();
    expect(drafts.waitingOf('/code/app')).toEqual([]);
    expect(store.has('pelican:comments')).toBe(false);
  });

  it('signing out takes the older store too, also where nothing has read it', () => {
    store.set('pelican:comments', JSON.stringify({ chats: { s1: [{ id: 'c1', path: 'a.ts', kind: 'add', line: 1, code: 'x', note: 'y' }] } }));
    forgetDrafts();
    expect(store.has('pelican:comments')).toBe(false);
  });
});
