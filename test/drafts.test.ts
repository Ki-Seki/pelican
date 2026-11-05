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
const { clearDraft, forgetDrafts, loadDraft, moveDraft, saveDraft } = await import('../src/web/lib/drafts');

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

  it('survive a broken store', () => {
    store.set('pelican:drafts', '{not json');
    expect(loadDraft('s1')).toBeUndefined();
    saveDraft('s1', 'still saved');
    expect(loadDraft('s1')?.text).toBe('still saved');
  });
});
