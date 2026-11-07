import type { StartDefaults } from '../src/shared/defaults';

/** What Claude Code 2.1.318 starts a new session with where no settings file says anything. */
export const BUILT_IN: StartDefaults = {
  model: { value: 'default', source: 'built-in' },
  effort: { byModel: {} },
  fast: { value: false, source: 'built-in', perSession: false },
  ultracode: { value: false, source: 'built-in', workflows: true },
  permissionMode: { value: 'auto', source: 'built-in' },
  file: { path: '/home/me/.claude/settings.json', state: 'missing' },
};
