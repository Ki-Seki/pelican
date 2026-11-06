// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionSummary } from '../src/shared/protocol';

const MIN = 60_000;
const HOUR = 60 * MIN;
const now = Date.now();
const session = (id: string, title: string, extra: Partial<SessionSummary> = {}): SessionSummary =>
  ({ id, title, cwd: '/code/app', project: 'app', lastActivity: now - MIN, status: 'idle', ...extra });
const docs = { cwd: '/code/docs', project: 'docs' };

/** The sessions as the server has them; pin and archive change them as the server would. */
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
const serverSets = (id: string, change: { pinned?: boolean; archived?: boolean }) => {
  server = server.map((s) => {
    if (s.id !== id) return s;
    const { pinned: _p, archived: _a, ...rest } = s;
    const pinned = change.pinned ?? (Boolean(s.pinned) && !change.archived);
    const archived = change.archived ?? (Boolean(s.archived) && !change.pinned);
    return { ...rest, ...(pinned ? { pinned } : {}), ...(archived ? { archived } : {}) };
  });
};

const pin = vi.fn(async (id: string, pinned: boolean) => {
  serverSets(id, { pinned });
  return { ok: true };
});
const archive = vi.fn(async (id: string, archived: boolean) => {
  serverSets(id, { archived });
  return { ok: true };
});

vi.mock('../src/web/lib/api', async (original) => {
  const actual = await original<typeof import('../src/web/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      // Newest first, as the server lists them.
      sessions: async () => [...server].sort((a, b) => b.lastActivity - a.lastActivity),
      pin: (id: string, pinned: boolean) => pin(id, pinned),
      archive: (id: string, archived: boolean) => archive(id, archived),
      mcp: async () => ({ servers: [], live: false }),
      sessionUsage: async () => null,
      models: async () => ({ models: [], signedIn: true }),
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
  // What a phone's layout would give: rows this wide, and a finger's pointer kept by the row.
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 360 });
  HTMLElement.prototype.setPointerCapture = () => {};
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) { this.removeAttribute('open'); };
});

const { SessionList } = await import('../src/web/components/SessionList');
const { SessionMenu } = await import('../src/web/components/SessionMenu');
const { setPrefs } = await import('../src/web/lib/prefs');

beforeEach(() => {
  server = initial();
  pin.mockClear();
  archive.mockClear();
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
    // Counted as a project is: each session under it, the earlier runs folded into a row too.
    expect(screen.getByRole('button', { name: /^Pinned/ }).textContent).toBe('Pinned6');
    expect(within(pinnedSection()).getByText('docs')).toBeTruthy();
    expect(titles('docs')).toEqual(['Tidy the docs']);
    expect(groups().find((g) => g.heading === 'docs')!.rows[0]).not.toContain(', docs,');
    // Folded away like any group.
    fireEvent.click(screen.getByRole('button', { name: /^Pinned/ }));
    expect(titles('Pinned')).toEqual([]);
  });

  it('folded under their heading grouped by project, still show grouped by time or under a chip, where nothing unfolds them', async () => {
    setPrefs({ listGroup: 'project' });
    list();
    await screen.findByRole('button', { name: /^Pinned/ });
    fireEvent.click(screen.getByRole('button', { name: /^Pinned/ }));
    expect(titles('Pinned')).toEqual([]);
    // A chip groups the list by time, under plain headings.
    fireEvent.click(screen.getByRole('button', { name: 'docs' }));
    expect(titles('Pinned')).toEqual(['Release notes']);
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(titles('Pinned')).toEqual([]);
    act(() => setPrefs({ listGroup: 'time' }));
    expect(titles('Pinned')).toEqual(['Fix the login test', 'Watch the dev server', 'Check the queue', 'Release notes']);
    // Back where its heading is, it is folded as it was left.
    act(() => setPrefs({ listGroup: 'project' }));
    expect(titles('Pinned')).toEqual([]);
    expect(screen.getByRole('button', { name: /^Pinned/ }).getAttribute('aria-expanded')).toBe('false');
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

  it('are pinned and unpinned at once from a row’s button, and put back when the server says no', async () => {
    list();
    await screen.findByText('Pinned');
    fireEvent.click(screen.getByRole('button', { name: 'Pin: Tidy the docs' }));
    expect(titles('Pinned')).toContain('Tidy the docs');
    expect(titles('Today')).toBeUndefined();
    expect(pin).toHaveBeenCalledWith('t1', true);
    expect(screen.getByRole('status').textContent).toContain('Pinned');

    pin.mockRejectedValueOnce(new Error('The disk is full'));
    fireEvent.click(screen.getByRole('button', { name: 'Unpin: Release notes' }));
    expect(titles('Yesterday')).toEqual(['Release notes']);
    await waitFor(() => expect(titles('Pinned')).toContain('Release notes'));
    expect(screen.getByRole('status').textContent).toContain('The disk is full');
  });

  it('are unpinned by archiving, which Undo takes back, pin and all', async () => {
    list();
    await screen.findByText('Pinned');
    fireEvent.click(screen.getByRole('button', { name: 'Archive: Release notes' }));
    expect(titles('Pinned')).not.toContain('Release notes');
    expect(archive).toHaveBeenCalledWith('p1', true);
    await waitFor(() => expect(screen.getByRole('button', { name: /^Archived\s*2$/ })).toBeTruthy());
    expect(screen.getByRole('status').textContent).toContain('Archived');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(pin).toHaveBeenCalledWith('p1', true);
    expect(titles('Pinned')).toContain('Release notes');
    await waitFor(() => expect(screen.getByRole('button', { name: /^Archived\s*1$/ })).toBeTruthy());
  });

  it('offer no pin for an archived session, under Archived: it is brought back first', async () => {
    list();
    await screen.findByText('Pinned');
    fireEvent.click(screen.getByRole('button', { name: /^Archived/ }));
    expect(screen.getByRole('button', { name: 'Unarchive: Old idea' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Pin: / })).toBeNull();
  });
});

describe('a finger on a row', () => {
  const slide = async (title: string, dx: number) => {
    const row = screen.getByRole('link', { name: new RegExp(`^${title}`) });
    const at = { pointerType: 'touch', isPrimary: true, pointerId: 1, clientY: 100 };
    fireEvent.pointerDown(row, { ...at, clientX: 180 });
    for (const step of [0.25, 0.5, 0.75, 1]) fireEvent.pointerMove(row, { ...at, clientX: 180 + dx * step });
    fireEvent.pointerUp(row, { ...at, clientX: 180 + dx });
  };

  it('pins it with a slide to the right, as far as Archive’s slide to the left', async () => {
    list();
    await screen.findByText('Pinned');
    await act(() => slide('Tidy the docs', 200));
    await waitFor(() => expect(pin).toHaveBeenCalledWith('t1', true));
    expect(titles('Pinned')).toContain('Tidy the docs');
    await act(() => slide('Release notes', 200));
    await waitFor(() => expect(pin).toHaveBeenCalledWith('p1', false));
    await act(() => slide('Fix the login test', -200));
    await waitFor(() => expect(archive).toHaveBeenCalledWith('p2', true));
  });

  it('a shorter slide shows the button and leaves it to a tap', async () => {
    list();
    await screen.findByText('Pinned');
    await act(() => slide('Tidy the docs', 80));
    expect(pin).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Pin' }));
    await waitFor(() => expect(pin).toHaveBeenCalledWith('t1', true));
  });

  it('an archived row slides only left, to Unarchive', async () => {
    list();
    await screen.findByText('Pinned');
    fireEvent.click(screen.getByRole('button', { name: /^Archived/ }));
    await act(() => slide('Old idea', 200));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(pin).not.toHaveBeenCalled();
    expect(archive).not.toHaveBeenCalled();
    await act(() => slide('Old idea', -200));
    await waitFor(() => expect(archive).toHaveBeenCalledWith('o1', false));
  });
});

describe('the session menu', () => {
  const menu = (shown: SessionSummary, onDeleted = () => {}) => {
    const client = new QueryClient();
    client.setQueryData(['sessions'], server);
    return {
      client,
      ...render(
        <QueryClientProvider client={client}>
          <SessionMenu open onClose={() => {}} sessionId={shown.id} session={shown} onRenamed={() => {}} onForked={() => {}} onDeleted={onDeleted} />
        </QueryClientProvider>,
      ),
    };
  };

  it('pins and unpins the session, next to Archive', async () => {
    const tidy = server.find((s) => s.id === 't1')!;
    const { unmount } = menu(tidy);
    const options = screen.getAllByRole('button').map((b) => b.textContent);
    expect(options.indexOf('Pin')).toBe(options.indexOf('Archive') - 1);
    fireEvent.click(screen.getByRole('button', { name: 'Pin' }));
    await waitFor(() => expect(pin).toHaveBeenCalledWith('t1', true));
    unmount();
    menu(server.find((s) => s.id === 't1')!);
    fireEvent.click(screen.getByRole('button', { name: 'Unpin' }));
    await waitFor(() => expect(pin).toHaveBeenCalledWith('t1', false));
  });

  it('says why when the server says no', async () => {
    pin.mockRejectedValueOnce(new Error('The disk is full'));
    menu(server.find((s) => s.id === 't1')!);
    fireEvent.click(screen.getByRole('button', { name: 'Pin' }));
    expect(await screen.findByText('The disk is full')).toBeTruthy();
  });

  it('archives a pinned session, which the list it goes back to shows archived and unpinned', async () => {
    const onDeleted = vi.fn();
    const { client } = menu(server.find((s) => s.id === 'p1')!, onDeleted);
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(archive).toHaveBeenCalledWith('p1', true);
    const listed = client.getQueryData<SessionSummary[]>(['sessions'])!.find((s) => s.id === 'p1');
    expect([listed?.archived, listed?.pinned]).toEqual([true, undefined]);
  });

  it('offers no pin for an archived session, only Unarchive', () => {
    menu(server.find((s) => s.id === 'o1')!);
    expect(screen.getByRole('button', { name: 'Unarchive' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pin' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Unpin' })).toBeNull();
  });
});
