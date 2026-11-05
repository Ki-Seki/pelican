// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'pelican:settings';

/** prefs.ts reads storage when it loads: a fresh copy for each case. */
async function prefs(stored?: unknown) {
  localStorage.clear();
  if (stored !== undefined) localStorage.setItem(KEY, JSON.stringify(stored));
  vi.resetModules();
  return import('../src/web/lib/prefs');
}

describe('the effort a new session starts with', () => {
  beforeEach(() => localStorage.clear());

  it('is High until one is picked in Settings', async () => {
    const { newSessionDefaults, START_EFFORT } = await prefs();
    expect(START_EFFORT).toBe('high');
    expect(newSessionDefaults().effort).toBe('high');
    // Settings saved by an older Pelican, before effort was a pick of its own.
    expect((await prefs({ model: 'opus', fast: false })).newSessionDefaults().effort).toBe('high');
  });

  it('is the one picked, and Default picked stays Default', async () => {
    expect((await prefs({ model: 'opus', effort: 'low' })).newSessionDefaults().effort).toBe('low');
    const { newSessionDefaults, saveDefaults, loadDefaults } = await prefs();
    saveDefaults({ model: 'opus' });
    expect(JSON.parse(localStorage.getItem(KEY)!)).toMatchObject({ model: 'opus', effort: null });
    expect(newSessionDefaults().effort).toBeUndefined();
    expect(loadDefaults().effort).toBeUndefined();
  });

  it('is not given to an existing session that ran without one', async () => {
    const { loadDefaults } = await prefs();
    expect(loadDefaults().effort).toBeUndefined();
  });
});
