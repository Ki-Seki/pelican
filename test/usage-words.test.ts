import { describe, expect, it } from 'vitest';

import type { UsageSummary } from '../src/shared/usage';
import { compactNumber, highlights, hourBand, span } from '../src/web/lib/usage';

const clock = (hour: number) => new Date(2000, 0, 1, hour).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const summary = (patch: Partial<UsageSummary>): UsageSummary => ({
  range: '7d', from: '2026-10-30', to: '2026-11-05',
  tokens: { input: 300, output: 20_000, cacheRead: 2_400_000, cacheWrite: 300_000 },
  series: { unit: 'day', points: [] },
  models: [], projects: [], apps: [], sessions: [],
  activity: { sessions: 3, activeDays: 2, days: 7, currentStreak: 1, longestStreak: 2 },
  limits: [], compacted: [],
  progress: { files: 3, read: 3, ready: true },
  ...patch,
});

describe('the usage page’s words', () => {
  it('writes counts in full below 10,000 and short above', () => {
    expect([0, 1284, 9999, 12_900, 129_400, 999_960, 4_200_000, 1_300_000_000].map(compactNumber))
      .toEqual(['0', '1,284', '9,999', '12.9K', '129K', '1M', '4.2M', '1.3B']);
    expect([40_000, 12 * 60_000, 185 * 60_000, 52 * 3_600_000].map(span)).toEqual(['40s', '12m', '3h 5m', '2d 4h']);
  });

  it('says where most of it went, and how much came from the cache', () => {
    const lines = highlights(summary({
      projects: [{ cwd: '/w/web', name: 'acme-web', tokens: 2_000_000, sessions: 2 }, { cwd: '/w/data', name: 'data', tokens: 720_300, sessions: 1 }],
      sessions: [
        { id: 'a', title: 'Upgrade the test runner', project: 'acme-web', app: 'VS Code', tokens: 1_300_000, at: 0 },
        { id: 'b', title: 'Small fix', project: 'data', app: 'Terminal', tokens: 100_000, at: 0 },
      ],
    }));
    expect(lines).toEqual([
      '74% of the tokens went to acme-web.',
      'One session, “Upgrade the test runner”, took 48%.',
      '89% of the input was read from the cache.',
    ]);
  });

  it('says when the 5-hour limit tends to be reached, the weekly one, waits and compactions', () => {
    const at = (h: number) => Date.UTC(2026, 10, 3, h);
    const lines = highlights(summary({
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      limits: [{ kind: 'session', at: at(14) }, { kind: 'session', at: at(15) }, { kind: 'session', at: at(23) }, { kind: 'weekly', at: at(16) }],
      waits: { ms: 4 * 60_000 + 20_000, count: 3, longest: 130_000 },
      compacted: [{ id: 'a', title: 'Upgrade the test runner', times: 3 }],
    }), (ms) => new Date(ms).getUTCHours());
    expect(lines[0]).toBe(`The 5-hour limit was reached 3 times, mostly between ${clock(14)} and ${clock(18)}.`);
    expect(lines[1]).toMatch(/^The weekly limit was reached once, on /);
    expect(lines[2]).toBe('In Pelican, Claude waited 4m for your answers, 2m at most.');
    expect(lines[3]).toBe('“Upgrade the test runner” was compacted 3 times. A new session for each new task keeps the context small.');
  });

  it('finds the four hours most of the times fall in, if they do', () => {
    expect(hourBand([14, 15, 16, 2])).toEqual([14, 18]);
    expect(hourBand([23, 0, 1])).toEqual([23, 3]);
    expect(hourBand([1, 7, 13, 19])).toBeUndefined();
  });
});
