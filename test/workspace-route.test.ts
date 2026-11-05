// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { folderOf, goTo, goUp, leave, stepOf, withStep } from '../src/web/lib/workspace-route';

/** The browser answers back and forward later, as a task of its own: wait for it. */
const settled = () => new Promise<void>((resolve) => {
  window.addEventListener('popstate', () => resolve(), { once: true });
});

afterEach(() => history.replaceState(null, '', '/'));

describe('the steps of Changes and files in the address', () => {
  it('reads and writes the tab, the path, the line and what Changes shows, keeping the rest', () => {
    expect(stepOf('?s=abc')).toBeUndefined();
    expect(stepOf('?s=abc&w=files&p=src%2Fa.ts&l=7')).toEqual({ tab: 'files', path: 'src/a.ts', line: 7 });
    expect(stepOf('?w=changes&t=base&l=0')).toEqual({ tab: 'changes', scope: 'base' });
    expect(stepOf('?w=terminal')).toBeUndefined();
    expect(withStep('?s=abc', { tab: 'changes', path: 'a b.ts', scope: 'u1' })).toBe('?s=abc&w=changes&p=a+b.ts&t=u1');
    expect(withStep('?new&cwd=%2Fx&w=files', undefined)).toBe('?new&cwd=%2Fx');
    expect(folderOf('src/settings/Settings.tsx')).toBe('src/settings/');
    expect(folderOf('src/settings/')).toBe('src/');
    expect(folderOf('README.md')).toBe('');
  });

  it('walks back step by step, and leaves for the conversation in one go', async () => {
    history.replaceState(null, '', '/?s=abc');
    goTo({ tab: 'changes' }, true);
    goTo({ tab: 'changes', path: 'a.ts' }, true);
    expect(location.search).toBe('?s=abc&w=changes&p=a.ts');
    // Up to the list it came from: a step back, not one more entry.
    const back = settled();
    goUp({ tab: 'changes' });
    await back;
    expect(location.search).toBe('?s=abc&w=changes');
    const left = settled();
    leave();
    await left;
    expect(location.search).toBe('?s=abc');
  });

  it('goes up in place when the step was not reached from there (a file opened from the chat)', async () => {
    history.replaceState(null, '', '/?s=abc');
    goTo({ tab: 'files', path: 'src/a.ts', line: 3 }, true);
    goUp({ tab: 'files', path: 'src/' });
    expect(location.search).toBe('?s=abc&w=files&p=src%2F');
    const left = settled();
    leave();
    await left;
    expect(location.search).toBe('?s=abc');
  });

  it('leaves in place when none of the history is its own (a reloaded address)', () => {
    history.replaceState(null, '', '/?s=abc&w=files');
    leave();
    expect(location.search).toBe('?s=abc');
  });
});
