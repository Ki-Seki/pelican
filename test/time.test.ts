import { describe, expect, it } from 'vitest';

import { relativeTime, timeAgo } from '../src/web/lib/format';

describe('how long ago, in words', () => {
  const now = new Date(2026, 10, 5, 12, 0).getTime();
  const minute = 60_000;

  it('says what the list shows in short, as a sentence would', () => {
    expect(timeAgo(now - 20_000, now)).toBe('just now');
    expect(timeAgo(now - minute, now)).toBe('1 minute ago');
    expect(timeAgo(now - 3 * minute, now)).toBe('3 minutes ago');
    expect(relativeTime(now - 3 * minute, now)).toBe('3m');
    expect(timeAgo(now - 2 * 60 * minute, now)).toBe('2 hours ago');
    expect(timeAgo(now - 24 * 60 * minute, now)).toBe('1 day ago');
    expect(timeAgo(now - 6 * 24 * 60 * minute, now)).toBe('6 days ago');
  });

  it('names the date after a week, with the year when it is another', () => {
    expect(timeAgo(new Date(2026, 2, 4).getTime(), now)).toBe('March 4');
    expect(timeAgo(new Date(2025, 11, 31).getTime(), now)).toBe('December 31, 2025');
  });

  it('never says a time in the future', () => {
    expect(timeAgo(now + 5 * minute, now)).toBe('just now');
  });
});
