import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { describeAlways, sessionModeOf } from '../src/server/approvals';

const HOME = '/Users/me';
const rules = (destination: string, ...list: Array<{ toolName: string; ruleContent?: string }>) =>
  ({ type: 'addRules', rules: list, behavior: 'allow', destination }) as PermissionUpdate;

describe('what "always" saves, in words', () => {
  it('names the command, the site, the folder and where the rule is kept', () => {
    expect(describeAlways([rules('localSettings', { toolName: 'Bash', ruleContent: 'npm test:*' })], HOME)).toBe('Always allow npm test * in this project');
    expect(describeAlways([rules('localSettings', { toolName: 'Bash', ruleContent: 'npm test *' }, { toolName: 'Bash', ruleContent: 'npm run build *' })], HOME))
      .toBe('Always allow npm test * and npm run build * in this project');
    expect(describeAlways([rules('userSettings', { toolName: 'WebFetch', ruleContent: 'domain:docs.example.com' })], HOME)).toBe('Always allow fetching docs.example.com in every project');
    expect(describeAlways([rules('session', { toolName: 'Read', ruleContent: '//Users/me/data/**' })], HOME)).toBe('Allow reading ~/data for this session');
    expect(describeAlways([rules('localSettings', { toolName: 'mcp__github__create_issue' })], HOME)).toBe('Always allow github · create_issue in this project');
    expect(describeAlways([rules('localSettings', { toolName: 'WebSearch' })], HOME)).toBe('Always allow WebSearch in this project');
  });

  it('says that a file edit switches the session to accepting edits, and any folder it opens', () => {
    expect(describeAlways([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }], HOME)).toBe('Allow all edits this session');
    expect(describeAlways([
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
      { type: 'addDirectories', directories: ['/Users/me/other'], destination: 'session' },
    ], HOME)).toBe('Allow all edits this session; allow access to ~/other for this session');
    expect(describeAlways([{ type: 'setMode', mode: 'plan', destination: 'session' }], HOME)).toBe('Switch to Plan for this session');
  });

  it('offers nothing it cannot say plainly', () => {
    expect(describeAlways(undefined, HOME)).toBeUndefined();
    expect(describeAlways([], HOME)).toBeUndefined();
    expect(describeAlways([{ type: 'removeRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'localSettings' }], HOME)).toBeUndefined();
    expect(describeAlways([{ ...rules('localSettings', { toolName: 'Bash', ruleContent: 'x' }), behavior: 'deny' } as PermissionUpdate], HOME)).toBeUndefined();
    expect(describeAlways([rules('localSettings', { toolName: 'Bash', ruleContent: 'y'.repeat(300) })], HOME)).toBeUndefined();
  });

  it('knows the mode a choice switches the session to', () => {
    expect(sessionModeOf([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }])).toBe('acceptEdits');
    expect(sessionModeOf([rules('localSettings', { toolName: 'Bash' })])).toBeUndefined();
    expect(sessionModeOf([{ type: 'setMode', mode: 'plan', destination: 'userSettings' }])).toBeUndefined();
  });
});
