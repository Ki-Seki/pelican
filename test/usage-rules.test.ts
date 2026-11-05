import { describe, expect, it } from 'vitest';

import { appOf, cacheShare, COST_LABEL, costShown, costWords, limitKind, modelName } from '../src/shared/usage';

describe('the cost estimate', () => {
  it('is shown only for an API key or a cloud provider, never on a Claude plan or while unknown', () => {
    expect(costShown({ signedIn: true })).toBe(true);
    for (const plan of ['pro', 'max', 'team', 'enterprise']) expect(costShown({ signedIn: true, plan })).toBe(false);
    expect(costShown({ signedIn: false })).toBe(false);
    expect(costShown({ signedIn: null })).toBe(false);
    expect(costShown({})).toBe(false);
  });

  it('always says it is an estimate at API prices, and which sessions it leaves out', () => {
    expect(COST_LABEL).toBe('estimated at API prices');
    expect(costWords(3.1)).toBe('$3.10, estimated at API prices');
    expect(costWords(1234.4)).toBe('$1,234, estimated at API prices');
    expect(costWords(0.004, 1)).toBe('$0.00, estimated at API prices; 1 session has no estimate');
    expect(costWords(12, 3)).toBe('$12.00, estimated at API prices; 3 sessions have no estimate');
  });
});

describe('the words for what Claude Code records', () => {
  it('tells the usage limits apart as Claude Code does', () => {
    expect(limitKind('You’ve hit your 5-hour limit · resets 3pm')).toBe('session');
    expect(limitKind("You've hit your session limit · resets 8pm")).toBe('session');
    expect(limitKind("You've hit your weekly limit · resets Nov 9")).toBe('weekly');
    expect(limitKind("You've hit your Opus limit · resets Mon 9am")).toBe('model');
    expect(limitKind("You've hit your limit · resets 3pm (Europe/London)")).toBe('session');
    expect(limitKind("You've hit your limit · resets Nov 9, 9am")).toBe('weekly');
    expect(limitKind("You've hit your monthly spend limit.")).toBeUndefined();
    expect(limitKind("You've hit your fast limit · resets in 3m")).toBeUndefined();
    expect(limitKind('API Error: 529 overloaded')).toBeUndefined();
  });

  it('names models as people say them', () => {
    expect(modelName('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelName('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5');
    expect(modelName('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe('Sonnet 4.5');
    expect(modelName('claude-sonnet-4-5@20250929')).toBe('Sonnet 4.5');
    expect(modelName('claude-3-5-haiku-20241022')).toBe('Haiku 3.5');
    expect(modelName('claude-opus-4-6[1m]')).toBe('Opus 4.6');
    expect(modelName('unknown')).toBe('unknown');
  });

  it('names the app that wrote a row by Claude Code’s entrypoint, and Pelican by its own record', () => {
    expect(appOf('cli', false)).toBe('Terminal');
    expect(appOf('claude-desktop', false)).toBe('Claude Desktop');
    expect(appOf('claude-vscode', false)).toBe('VS Code');
    expect(appOf('sdk-ts', true)).toBe('Pelican');
    expect(appOf('sdk-ts', false)).toBe('Agent SDK');
    expect(appOf('sdk-cli', true)).toBe('Agent SDK');
    expect(appOf('something-else', false)).toBe('Other');
    expect(appOf(undefined, false)).toBe('Other');
  });

  it('counts cache reuse as Claude Code’s prompt cache line does', () => {
    expect(cacheShare({ input: 10, output: 500, cacheRead: 900, cacheWrite: 90 })).toBeCloseTo(0.9);
    expect(cacheShare({ input: 0, output: 5, cacheRead: 0, cacheWrite: 0 })).toBeUndefined();
  });
});
