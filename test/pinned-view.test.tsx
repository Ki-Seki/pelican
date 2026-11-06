// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionSummary } from '../src/shared/protocol';

const MIN = 60_000;
const HOUR = 60 * MIN;
const now = Date.now();
const session = (id: string, title: string, extra: Partial<SessionSummary> = {}): SessionSummary =>
  ({ id, title, cwd: '/code/app', project: 'app', lastActivity: now - MIN, status: 'idle', ...extra });
const docs = { cwd: '/code/docs', project: 'docs' };

/** The sessions as the server has them. */
let server: SessionSummary[] = [];
const initial = (): SessionSummary[] => [
  session('a1', 'Add a dark theme', { status: 'running', lastActivity: now - MIN }),
  session('p2', 'Fix the login test', { status: 'waiting', pinned: true, lastActivity: now - 5 * MIN }),
  session('p4', 'Watch the dev server', { tasks: 2, pinned: true, lastActivity: now - 20 * MIN }),
  session('t1', 'Tidy the docs', { ...docs, lastActivity: now - 30 * MIN }),
  session('p3', 'Check the queue', { pinned: true, lastActivity: now - 2 * HOUR }),
  session('q2', 'Check the queue', { lastActivity: now - 3 * HOUR }),
  session('q3', 'Check the queue', { lastActivity: now - 4 * HOUR }),
  session('p1', 'Release notes', { ...docs, pinned: true, lastActivity: now - 26 * HOUR }),
  session('o1', 'Old idea', { archived: true, lastActivity: now - 5 * 24 * HOUR }),
];
vi.mock('../src/web/lib/api', async (original) => {
  const actual = await original<typeof import('../src/web/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      // Newest first, as the server lists them.
      sessions: async () => [...server].sort((a, b) => b.lastActivity - a.lastActivity),
    },
  };
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
const { setPrefs } = await import('../src/web/lib/prefs');

beforeEach(() => {
  server = initial();
  setPrefs({ listGroup: 'time', listDensity: 'detailed' });
});
afterEach(cleanup);

const list = () => render(
  <QueryClientProvider client={new QueryClient()}>
    <SessionList machine="studio" onOpen={() => {}} onNew={() => {}} onSettings={() => {}} connected />
  </QueryClientProvider>,
);

/** Each group of the list, by its heading, with the titles of its rows. */
const groups = () => [...document.querySelectorAll('section')].map((section) => ({
  heading: section.querySelector('h2, button[aria-expanded]')?.textContent?.replace(/\d+$/, '') ?? '',
  rows: [...section.querySelectorAll('a')].map((row) => row.getAttribute('aria-label') ?? ''),
}));
const titles = (heading: string) => groups().find((g) => g.heading === heading)?.rows.map((row) => row.split(', ')[0]);
const pinnedSection = () => [...document.querySelectorAll('section')].find((s) => s.querySelector('h2, button[aria-expanded]')?.textContent?.startsWith('Pinned'))!;

describe('pinned sessions in the list', () => {
  it('lead it, above Active, each keeping its status and its earlier runs, and say so to a screen reader', async () => {
    list();
    await screen.findByText('Pinned');
    expect(groups().map((g) => g.heading)).toEqual(['Pinned', 'Active', 'Today']);
    expect(titles('Pinned')).toEqual(['Fix the login test', 'Watch the dev server', 'Check the queue', 'Release notes']);
    expect(titles('Active')).toEqual(['Add a dark theme']);
    const pinned = within(pinnedSection());
    expect(pinned.getByText('Needs you')).toBeTruthy();
    expect(pinned.getByText('2 tasks')).toBeTruthy();
    expect(pinned.getByRole('button', { name: '2 earlier' })).toBeTruthy();
    expect(pinned.getAllByRole('link')[0]!.getAttribute('aria-label')).toBe('Fix the login test, Needs you, pinned, app, 5 minutes ago');
    // The earlier runs fold into the pinned one, not into a row of their own.
    expect(titles('Today')).toEqual(['Tidy the docs']);
  });

  it('lead the list grouped by project too, with each row’s project, which the rows under a project leave out', async () => {
    setPrefs({ listGroup: 'project' });
    list();
    await screen.findByRole('button', { name: /^Pinned/ });
    expect(groups().map((g) => g.heading)).toEqual(['Pinned', 'app', 'docs']);
    expect(titles('Pinned')).toEqual(['Fix the login test', 'Watch the dev server', 'Check the queue', 'Release notes']);
    expect(within(pinnedSection()).getByText('docs')).toBeTruthy();
    expect(titles('docs')).toEqual(['Tidy the docs']);
    expect(groups().find((g) => g.heading === 'docs')!.rows[0]).not.toContain(', docs,');
    // Folded away like any group.
    fireEvent.click(screen.getByRole('button', { name: /^Pinned/ }));
    expect(titles('Pinned')).toEqual([]);
  });

  it('keep to the project filter: a pinned session of another project stays under its own', async () => {
    list();
    await screen.findByText('Pinned');
    fireEvent.click(screen.getByRole('button', { name: 'docs' }));
    expect(titles('Pinned')).toEqual(['Release notes']);
    fireEvent.click(screen.getByRole('button', { name: 'app' }));
    expect(titles('Pinned')).toEqual(['Fix the login test', 'Watch the dev server', 'Check the queue']);
    expect(titles('Active')).toEqual(['Add a dark theme']);
  });

  it('stay in view when the list’s options leave others of their kind out: a temporary session, a side chat', async () => {
    server.push(
      session('x1', 'A run in the temp folder', { cwd: '/tmp/run-1', project: 'run-1', temp: true, pinned: true }),
      session('x2', 'A run in the temp folder too', { cwd: '/tmp/run-2', project: 'run-2', temp: true }),
      session('x3', 'Side chat', { sideChatOf: 'p3', pinned: true }),
      session('x4', 'Side chat', { sideChatOf: 'p2' }),
    );
    list();
    await screen.findByText('Pinned');
    expect(titles('Pinned')).toEqual(['A run in the temp folder', 'Side chat', 'Fix the login test', 'Watch the dev server', 'Check the queue', 'Release notes']);
    expect(screen.queryByText('A run in the temp folder too')).toBeNull();
    expect(screen.getAllByText('Side chat')).toHaveLength(1);
    // The count says what All shows.
    expect(screen.getByText('Claude Code · 10 sessions')).toBeTruthy();
  });

  it('are found by a search, in their group, and left out when they do not match', async () => {
    list();
    await screen.findByText('Pinned');
    const search = screen.getByRole('textbox', { name: 'Search sessions' });
    fireEvent.change(search, { target: { value: 'release' } });
    expect(groups().map((g) => g.heading)).toEqual(['Pinned']);
    expect(titles('Pinned')).toEqual(['Release notes']);
    fireEvent.change(search, { target: { value: 'docs' } });
    expect(groups().map((g) => g.heading)).toEqual(['Pinned', 'Today']);
    expect(titles('Today')).toEqual(['Tidy the docs']);
  });
});

