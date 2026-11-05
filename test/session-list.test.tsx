// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { SessionSummary } from '../src/shared/protocol';

const now = Date.now();
const session = (id: string, title: string, extra: Partial<SessionSummary> = {}): SessionSummary =>
  ({ id, title, cwd: '/code/app', project: 'app', lastActivity: now - 60_000, status: 'idle', ...extra });

const sessions: SessionSummary[] = [
  session('s1', 'Watch the dev server', { tasks: 2, preview: 'Started npm run dev and an agent.' }),
  session('s2', 'Check the export queue', { lastActivity: now - 120_000 }),
  session('s3', 'Check the export queue', { lastActivity: now - 180_000, tasks: 1 }),
  session('s4', 'Deploy the site', { stopped: 'not signed in', lastActivity: now - 240_000 }),
  session('s5', 'Fix the login test', { status: 'running', lastActivity: now - 300_000 }),
];

vi.mock('../src/web/lib/api', async (original) => {
  const actual = await original<typeof import('../src/web/lib/api')>();
  return { ...actual, api: { ...actual.api, sessions: async () => sessions } };
});

beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  Object.assign(globalThis, {
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
  });
});

const { SessionList } = await import('../src/web/components/SessionList');

afterEach(cleanup);

const list = () => render(
  <QueryClientProvider client={new QueryClient()}>
    <SessionList machine="studio" onOpen={() => {}} onNew={() => {}} onSettings={() => {}} connected />
  </QueryClientProvider>,
);

describe('the session list', () => {
  it('keeps a session with background tasks among the active ones, saying how many, unfolded', async () => {
    list();
    const active = (await screen.findByText('Active')).closest('section')!;
    const rows = within(active).getAllByRole('link');
    expect(rows.map((row) => row.getAttribute('aria-label')?.split(', ').slice(0, 2).join(', '))).toEqual([
      'Watch the dev server, 2 tasks',
      'Check the export queue, 1 task',
      'Fix the login test, Working',
    ]);
    expect(within(active).getByText('2 tasks')).toBeTruthy();
    // The same title in the same folder folds, but not into one still at work.
    expect(screen.queryByText(/earlier/)).toBeNull();
  });

  it('says quietly why a turn stopped instead of a reply', async () => {
    list();
    const stopped = await screen.findByText('Stopped: not signed in');
    expect(stopped.className).toContain('text-faint');
    expect(screen.getByText('Started npm run dev and an agent.').className).toContain('text-muted');
  });
});
