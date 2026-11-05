// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { loadDefaults, saveDefaults } from '../src/web/lib/prefs';

afterEach(() => localStorage.clear());

describe('what new sessions start with', () => {
  it('has no mode until one is picked in Settings, and keeps a picked one per browser', () => {
    expect(loadDefaults()).toEqual({ model: 'default', fast: false, ultracode: false });
    saveDefaults({ model: 'opus', effort: 'high', permissionMode: 'plan' });
    expect(loadDefaults()).toEqual({ model: 'opus', effort: 'high', fast: false, ultracode: false, permissionMode: 'plan' });
  });

  it('never keeps Bypass, nor a mode Settings does not offer', () => {
    saveDefaults({ model: 'opus', permissionMode: 'bypassPermissions' });
    expect(loadDefaults().permissionMode).toBeUndefined();
    localStorage.setItem('pelican:settings', JSON.stringify({ permissionMode: 'dontAsk' }));
    expect(loadDefaults().permissionMode).toBeUndefined();
  });
});
