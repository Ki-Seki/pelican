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
const { clearDraft, forgetDrafts, loadDraft, saveDraft } = await import('../src/web/lib/drafts');

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
