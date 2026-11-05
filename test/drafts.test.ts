import { beforeEach, describe, expect, it } from 'vitest';

import type { Attachment } from '../src/shared/protocol';

// What this browser keeps, in memory, as localStorage would.
const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
});
const { clearDraft, forgetDrafts, loadDraft, messageWithQuotes, moveDraft, saveDraft } = await import('../src/web/lib/drafts');

const file: Attachment = { id: 'u1', name: 'shot.png', mime: 'image/png', size: 10, path: '/tmp/u1' };

describe('drafts', () => {
  beforeEach(() => store.clear());

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

  it('go along with a new session moved to another folder, files and all', () => {
    saveDraft('new:/code/acme', 'Refactor the export job', [file]);
    saveDraft('new:/code/site', 'An older start there');
    moveDraft('new:/code/acme', 'new:/code/site');
    expect(loadDraft('new:/code/acme')).toBeUndefined();
    expect(loadDraft('new:/code/site')).toMatchObject({ text: 'Refactor the export job', attachments: [file] });
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

  it('keep the quotes waiting above the box, until the message they went into was sent', () => {
    saveDraft('s1', 'And not a context?', [], ['> Why CSS variables?']);
    expect(loadDraft('s1')).toMatchObject({ text: 'And not a context?', quotes: ['> Why CSS variables?'] });
    // Quotes alone are a draft too.
    saveDraft('s2', '', [], ['a.ts:3\n> x']);
    expect(loadDraft('s2')?.quotes).toEqual(['a.ts:3\n> x']);
    clearDraft('s1', 'another message');
    expect(loadDraft('s1')?.quotes).toEqual(['> Why CSS variables?']);
    clearDraft('s1', '> Why CSS variables?\n\nAnd not a context?');
    expect(loadDraft('s1')).toBeUndefined();
  });

  it('keep the quotes when a ! command goes instead: they wait for a message', () => {
    saveDraft('s1', '!npm test', [], ['> the failing line']);
    clearDraft('s1', '!npm test');
    expect(loadDraft('s1')).toMatchObject({ text: '', quotes: ['> the failing line'] });
  });

  it('keep what waits to be put back, files and all, once the message beside it was sent, and take it to another folder', () => {
    saveDraft('s1', 'Then fix what fails', [], [], [{ text: '!npm test' }]);
    expect(loadDraft('s1')).toMatchObject({ text: 'Then fix what fails', held: [{ text: '!npm test' }] });
    clearDraft('s1', 'Then fix what fails');
    expect(loadDraft('s1')).toMatchObject({ text: '', held: [{ text: '!npm test' }] });
    saveDraft('new:/code/acme', '', [], [], [{ text: 'What does this show?', attachments: [file] }]);
    moveDraft('new:/code/acme', 'new:/code/site');
    expect(loadDraft('new:/code/site')?.held).toEqual([{ text: 'What does this show?', attachments: [file] }]);
    expect(loadDraft('new:/code/acme')).toBeUndefined();
    // A text alone, as kept before its files waited with it; what holds neither words nor files goes.
    store.set('pelican:drafts', JSON.stringify({ s1: { text: '', held: ['!kept', 3, null, ' ', { text: ' ' }, { text: '', attachments: [file, { id: 3 }] }], at: 1 } }));
    expect(loadDraft('s1')?.held).toEqual([{ text: '!kept' }, { text: '', attachments: [file] }]);
  });

  it('take their quotes along to another folder, and drop what is not a quote', () => {
    saveDraft('new:/code/acme', 'about this', [], ['> a line']);
    moveDraft('new:/code/acme', 'new:/code/site');
    expect(loadDraft('new:/code/site')?.quotes).toEqual(['> a line']);
    store.set('pelican:drafts', JSON.stringify({ s1: { text: 'x', quotes: ['> kept', 3, null, ' '], at: 1 } }));
    expect(loadDraft('s1')?.quotes).toEqual(['> kept']);
  });

  it('all go when this browser signs out', () => {
    saveDraft('s1', 'a prompt');
    saveDraft('s2', 'another');
    forgetDrafts();
    expect(loadDraft('s1')).toBeUndefined();
    expect(loadDraft('s2')).toBeUndefined();
  });

  it('take the line comments waiting with them when this browser signs out, also where those have not loaded', async () => {
    store.set('pelican:comments', JSON.stringify({ chats: { s1: [{ id: 'c1', path: 'a.ts', kind: 'add', line: 1, code: 'x', note: 'y' }] } }));
    forgetDrafts();
    expect(store.has('pelican:comments')).toBe(false);
    // Loaded, its copy in memory goes too.
    const { commentsOf, setComments } = await import('../src/web/lib/review');
    setComments('s2', [{ id: 'c2', path: 'a.ts', kind: 'add', line: 1, code: 'x', note: 'y' }]);
    forgetDrafts();
    expect(commentsOf('s2')).toEqual([]);
    expect(store.has('pelican:comments')).toBe(false);
  });

  it('make the message that goes out of their quotes and words, which a send compares them with', () => {
    expect(messageWithQuotes(['> a quote  ', 'a.ts:3\n> x'], '  my words ')).toBe('> a quote\n\na.ts:3\n> x\n\nmy words');
    saveDraft('s1', 'my words', [], ['> a quote']);
    clearDraft('s1', messageWithQuotes(['> a quote'], 'my words'));
    expect(loadDraft('s1')).toBeUndefined();
  });

  it('survive a broken store', () => {
    store.set('pelican:drafts', '{not json');
    expect(loadDraft('s1')).toBeUndefined();
    saveDraft('s1', 'still saved');
    expect(loadDraft('s1')?.text).toBe('still saved');
  });
});
