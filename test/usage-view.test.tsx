// @vitest-environment jsdom
// West of UTC, so a time's local day and its UTC day can differ.
process.env.TZ = 'America/Los_Angeles';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { UsageSummary } from '../src/shared/usage';

const summary: UsageSummary = {
  range: 'all', from: '2026-09-30', to: '2026-11-05',
  tokens: { input: 10, output: 10, cacheRead: 10, cacheWrite: 10 },
  series: { unit: 'day', points: [] },
  models: [], projects: [], apps: [], sessions: [],
  // A session whose transcript is gone, as Claude Code's own stats remember it: it started on
  // October 1 in UTC, which is still September 30 in California.
  activity: { sessions: 7, activeDays: 4, days: 37, currentStreak: 2, longestStreak: 2, longest: { id: 'old', ms: 9_000_000, at: Date.parse('2026-10-01T02:00:00Z') } },
  limits: [], compacted: [],
  progress: { files: 2, read: 2, ready: true },
};

vi.mock('../src/web/lib/api', async (original) => {
  const actual = await original<typeof import('../src/web/lib/api')>();
  return { ...actual, api: { ...actual.api, models: async () => ({ models: [], signedIn: true }), usageStats: async () => summary } };
});

beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});

const { UsageSheet } = await import('../src/web/components/Usage');
afterEach(() => cleanup());

const page = () => render(<QueryClientProvider client={new QueryClient()}><UsageSheet open onClose={() => {}} /></QueryClientProvider>);

describe('the usage page', () => {
  it('dates the longest session by its UTC day, as every other day on the page', async () => {
    expect(new Date().getTimezoneOffset()).toBeGreaterThan(0);
    page();
    const tile = (await screen.findByText('Longest session')).parentElement!;
    expect(tile.textContent).toContain('on Oct 1');
  });
});

describe('the usage page’s note on counting', () => {
  it('says that Claude Code’s /stats counts each content block, so its totals are higher', async () => {
    page();
    expect(await screen.findByText(/each reply counted once\. Claude Code’s \/stats counts each content block of a reply, so its totals are higher\./)).toBeTruthy();
  });
});
