// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionSummary } from '../src/shared/protocol';

const MIN = 60_000;
const HOUR = 60 * MIN;
// At noon, whatever the time the tests run: a session minutes or hours old is today's, one a day
// old yesterday's (past midnight, 30 minutes ago was yesterday).
vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
vi.setSystemTime(new Date(new Date().setHours(12, 0, 0, 0)));
afterAll(() => vi.useRealTimers());
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
const rename = vi.fn(async (_id: string, _title: string) => ({ ok: true }));
const remove = vi.fn(async (_id: string) => ({ ok: true }));

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
      rename: (id: string, title: string) => rename(id, title),
      remove: (id: string) => remove(id),
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
const { noteDone } = await import('../src/web/lib/list-changes');

beforeEach(() => {
  server = initial();
  pin.mockClear();
  archive.mockClear();
  rename.mockClear();
  remove.mockClear();
  setPrefs({ listGroup: 'time', listDensity: 'detailed' });
});
afterEach(() => {
  cleanup();
  // What was done says so for a few seconds, wherever the list is: not into the next test's.
  noteDone(undefined);
});

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

/** A row's menu, opened from its ⋯, as a pointer or the keyboard opens it (a finger: a long press). */
const rowMenu = async (title: string) => {
  const more = screen.getByRole('button', { name: `More for ${title}` });
  more.focus();
  fireEvent.click(more);
  return screen.findByRole('menu', { name: title });
};
/** Picks an action of a row's menu. */
const fromMenu = async (title: string, action: string) => {
  fireEvent.click(within(await rowMenu(title)).getByRole('menuitem', { name: action }));
};

describe('pinned sessions in the list', () => {
  it('lead it, above Active, each keeping its status and its earlier runs, and say so to a screen reader', async () => {
    list();
    await screen.findByText('Pinned');
    expect(groups().map((g) => g.heading)).toEqual(['Pinned', 'Active', 'Today']);
    expect(titles('Pinned')).toEqual(['Fix the login test', 'Watch the dev server', 'Check the queue', 'Release notes']);
    expect(titles('Active')).toEqual(['Add a dark theme']);
    const pinned = within(pinnedSection());
    expect(pinned.getByText('Needs you')).toBeTruthy();
    expect(pinned.getByText('2 in background')).toBeTruthy();
    expect(pinned.getByRole('button', { name: '2 earlier' })).toBeTruthy();
    expect(pinned.getAllByRole('link')[0]!.getAttribute('aria-label')).toBe('Fix the login test, Needs you, pinned, app, 5 minutes ago');
    // Their heading says so: the rows carry no pin of their own; each has its ⋯, which has Unpin.
    expect(pinnedSection().querySelectorAll('.lucide-pin, .lucide-pin-off')).toHaveLength(0);
    expect(within(pinnedSection()).getAllByRole('button', { name: /^More for / })).toHaveLength(4);
    // The earlier runs fold into the pinned one, not into a row of their own.
    expect(titles('Today')).toEqual(['Tidy the docs']);
  });

  it('keep their earlier runs while working, as when idle, grouped by time or by project', async () => {
    server = server.map((s) => (s.id === 'p3' ? { ...s, status: 'running' } : s));
    list();
    await screen.findByText('Pinned');
    expect(groups().map((g) => g.heading)).toEqual(['Pinned', 'Active', 'Today']);
    expect(titles('Pinned')).toEqual(['Fix the login test', 'Watch the dev server', 'Check the queue', 'Release notes']);
    expect(within(pinnedSection()).getByRole('button', { name: '2 earlier' })).toBeTruthy();
    expect(titles('Today')).toEqual(['Tidy the docs']);
    act(() => setPrefs({ listGroup: 'project' }));
    expect(screen.getByRole('button', { name: /^Pinned/ }).textContent).toBe('Pinned6');
    expect(groups().map((g) => g.heading)).toEqual(['Pinned', 'app', 'docs']);
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

  it('are pinned and unpinned at once from a row’s menu, and put back when the server says no', async () => {
    list();
    await screen.findByText('Pinned');
    await fromMenu('Tidy the docs', 'Pin');
    expect(titles('Pinned')).toContain('Tidy the docs');
    expect(titles('Today')).toBeUndefined();
    expect(pin).toHaveBeenCalledWith('t1', true);
    expect(screen.getByRole('status').textContent).toContain('Pinned');

    pin.mockRejectedValueOnce(new Error('The disk is full'));
    await fromMenu('Release notes', 'Unpin');
    expect(titles('Yesterday')).toEqual(['Release notes']);
    await waitFor(() => expect(titles('Pinned')).toContain('Release notes'));
    expect(screen.getByRole('status').textContent).toContain('The disk is full');
  });

  it('are unpinned by archiving, which Undo takes back, pin and all', async () => {
    list();
    await screen.findByText('Pinned');
    await fromMenu('Release notes', 'Archive');
    expect(titles('Pinned')).not.toContain('Release notes');
    expect(archive).toHaveBeenCalledWith('p1', true);
    await waitFor(() => expect(screen.getByRole('button', { name: /^Archived\s*2$/ })).toBeTruthy());
    expect(screen.getByRole('status').textContent).toContain('Archived');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(pin).toHaveBeenCalledWith('p1', true);
    await waitFor(() => expect(titles('Pinned')).toContain('Release notes'));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Archived\s*1$/ })).toBeTruthy());
  });

  it('leave focus with the session a row’s menu changed: on its row where it went, or on the next one; Undo brings it back', async () => {
    list();
    await screen.findByText('Pinned');
    const link = (title: string) => screen.getByRole('link', { name: new RegExp(`^${title}, `) });
    const press = (name: string) => {
      const button = screen.getByRole('button', { name });
      button.focus();
      fireEvent.click(button);
    };
    await fromMenu('Tidy the docs', 'Pin');
    await waitFor(() => expect(document.activeElement).toBe(link('Tidy the docs')));
    expect(pinnedSection().contains(document.activeElement)).toBe(true);
    await fromMenu('Tidy the docs', 'Unpin');
    await waitFor(() => expect(titles('Today')).toEqual(['Tidy the docs']));
    expect(document.activeElement).toBe(link('Tidy the docs'));
    // Archived, it leaves the list: the row after it takes focus, and Undo gives it back.
    await fromMenu('Release notes', 'Archive');
    await waitFor(() => expect(document.activeElement).toBe(link('Add a dark theme')));
    press('Undo');
    await waitFor(() => expect(document.activeElement).toBe(link('Release notes')));
    // One the server refuses comes back, focus still with it.
    pin.mockRejectedValueOnce(new Error('The disk is full'));
    await fromMenu('Release notes', 'Unpin');
    await screen.findByText('The disk is full');
    await waitFor(() => expect(pinnedSection().contains(link('Release notes'))).toBe(true));
    expect(document.activeElement).toBe(link('Release notes'));
  });

  it('leave focus where it is when it was not on the row: a slide, or a button pressed elsewhere', async () => {
    list();
    await screen.findByText('Pinned');
    const search = screen.getByRole('textbox', { name: 'Search sessions' });
    search.focus();
    // A right-click on the row leaves focus where it was; so does what is picked in its menu.
    fireEvent.contextMenu(screen.getByRole('link', { name: /^Tidy the docs, / }), { clientX: 100, clientY: 200 });
    fireEvent.click(within(await screen.findByRole('menu', { name: 'Tidy the docs' })).getByRole('menuitem', { name: 'Pin' }));
    await waitFor(() => expect(titles('Pinned')).toContain('Tidy the docs'));
    expect(document.activeElement).toBe(search);
  });

  it('offer no pin for an archived session, under Archived: it is brought back first', async () => {
    list();
    await screen.findByText('Pinned');
    fireEvent.click(screen.getByRole('button', { name: /^Archived/ }));
    const menu = await rowMenu('Old idea');
    expect(within(menu).getByRole('menuitem', { name: 'Unarchive' })).toBeTruthy();
    expect(within(menu).queryByRole('menuitem', { name: /^(Pin|Unpin)$/ })).toBeNull();
  });
});

describe('a list whose only sessions are temporary ones', () => {
  it('says they are there, and how to show them, the Temporary chip or the list’s options, rather than that there are none', async () => {
    setPrefs({ showTemporary: false });
    // As the CLI leaves them: runs in folders under /tmp, which All leaves out.
    server = [
      session('x1', 'A run in the temp folder', { cwd: '/tmp/run-1', project: 'run-1', temp: true }),
      session('x2', 'Another run there', { cwd: '/tmp/run-2', project: 'run-2', temp: true, lastActivity: now - 2 * MIN }),
    ];
    list();
    expect(await screen.findByText('2 temporary sessions')).toBeTruthy();
    expect(screen.getByText('Claude Code · 2 temporary sessions')).toBeTruthy();
    expect(screen.queryByText('No sessions yet')).toBeNull();
    expect(screen.queryByText('A run in the temp folder')).toBeNull();
    // Their chip is there, and Show them picks it.
    expect(screen.getByRole('button', { name: 'Temporary2' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show them' }));
    expect(screen.getByRole('button', { name: 'Temporary2' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('A run in the temp folder')).toBeTruthy();
    expect(screen.getByText('Another run there')).toBeTruthy();
  });

  it('with one, says it of the one; shown by the list’s options, lists them as ever', async () => {
    server = [session('x1', 'A run in the temp folder', { cwd: '/tmp/run-1', project: 'run-1', temp: true })];
    setPrefs({ showTemporary: false });
    list();
    expect(await screen.findByText('A temporary session')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show it' })).toBeTruthy();
    cleanup();
    setPrefs({ showTemporary: true });
    try {
      list();
      expect(await screen.findByText('A run in the temp folder')).toBeTruthy();
      expect(screen.getByText('Claude Code · 1 session')).toBeTruthy();
    } finally {
      setPrefs({ showTemporary: false });
    }
  });
});

describe('a finger on a row', () => {
  /** A finger on a row's title at `from` (180px from the screen's left), across by `dx` and down by `dy`, then let go. */
  const slide = async (title: string, dx: number, { from = 180, dy = 0 } = {}) => {
    const row = screen.getByRole('link', { name: new RegExp(`^${title}`) });
    const at = { pointerType: 'touch', isPrimary: true, pointerId: 1 };
    fireEvent.pointerDown(row, { ...at, clientX: from, clientY: 100 });
    for (const step of [0.25, 0.5, 0.75, 1]) fireEvent.pointerMove(row, { ...at, clientX: from + dx * step, clientY: 100 + dy * step });
    fireEvent.pointerUp(row, { ...at, clientX: from + dx, clientY: 100 + dy });
  };
  /** The buttons a slide shows under the rows, left to right, by the names a screen reader gives them. */
  const under = () => [...document.querySelectorAll('button[data-row-action]:not([aria-label])')].map((button) => button.textContent);

  it('slid a little to the left, shows Pin and Archive side by side, Archive at the edge, and leaves them to a tap', async () => {
    list();
    await screen.findByText('Pinned');
    await act(() => slide('Tidy the docs', -100));
    expect(under()).toEqual(['Pin', 'Archive']);
    expect(pin).not.toHaveBeenCalled();
    expect(archive).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Pin' }));
    await waitFor(() => expect(pin).toHaveBeenCalledWith('t1', true));
    expect(titles('Pinned')).toContain('Tidy the docs');
    // A pinned row has Unpin there; a tap on the row closes it rather than opening the session.
    await act(() => slide('Release notes', -100));
    expect(under()).toEqual(['Unpin', 'Archive']);
    fireEvent.click(screen.getByRole('link', { name: /^Release notes, / }));
    await waitFor(() => expect(under()).toEqual([]));
    await act(() => slide('Release notes', -100));
    fireEvent.click(screen.getByRole('button', { name: 'Unpin' }));
    await waitFor(() => expect(pin).toHaveBeenCalledWith('p1', false));
    expect(archive).not.toHaveBeenCalled();
  });

  it('slid all the way to the left, archives it when let go, with Undo, also once it shows its buttons', async () => {
    list();
    await screen.findByText('Pinned');
    await act(() => slide('Tidy the docs', -300));
    await waitFor(() => expect(archive).toHaveBeenCalledWith('t1', true));
    expect(screen.getByRole('status').textContent).toContain('Archived');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(archive).toHaveBeenCalledWith('t1', false));
    await act(() => slide('Fix the login test', -100));
    expect(under()).toEqual(['Unpin', 'Archive']);
    await act(() => slide('Fix the login test', -200));
    await waitFor(() => expect(archive).toHaveBeenCalledWith('p2', true));
    expect(pin).not.toHaveBeenCalled();
  });

  it('takes no slide to the right, which is Safari’s Back, nor one that starts at the edge of the screen', async () => {
    list();
    await screen.findByText('Pinned');
    await act(() => slide('Tidy the docs', 300));
    await act(() => slide('Release notes', 300));
    expect(under()).toEqual([]);
    // Within 24px of either edge, either way, it is the browser's.
    await act(() => slide('Tidy the docs', 300, { from: 20 }));
    await act(() => slide('Tidy the docs', -300, { from: 20 }));
    await act(() => slide('Tidy the docs', -300, { from: window.innerWidth - 20 }));
    expect(under()).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(pin).not.toHaveBeenCalled();
    expect(archive).not.toHaveBeenCalled();
    await act(() => slide('Tidy the docs', -100, { from: window.innerWidth - 30 }));
    expect(under()).toEqual(['Pin', 'Archive']);
  });

  it('leaves a slide more up or down than across to the list, which scrolls', async () => {
    list();
    await screen.findByText('Pinned');
    await act(() => slide('Tidy the docs', -60, { dy: 40 }));
    expect(under()).toEqual([]);
    await act(() => slide('Tidy the docs', -100, { dy: 40 }));
    expect(under()).toEqual(['Pin', 'Archive']);
  });

  it('shows Unarchive alone on an archived row, which a full slide does', async () => {
    list();
    await screen.findByText('Pinned');
    fireEvent.click(screen.getByRole('button', { name: /^Archived/ }));
    await act(() => slide('Old idea', 300));
    expect(under()).toEqual([]);
    await act(() => slide('Old idea', -80));
    expect(under()).toEqual(['Unarchive']);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(archive).not.toHaveBeenCalled();
    await act(() => slide('Old idea', -300));
    await waitFor(() => expect(archive).toHaveBeenCalledWith('o1', false));
    expect(pin).not.toHaveBeenCalled();
  });
});

describe('a session’s menu', () => {
  /** What each row of a menu says, as a screen reader names it. */
  const items = (menu: HTMLElement) => within(menu).getAllByRole('menuitem').map((item) => item.textContent);

  it('from a row: Rename · Pin · Side chat · Fork · Copy resume command · Export · Archive · Delete, without the open session’s view or keys', async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SessionList machine="studio" onOpen={() => {}} onNew={() => {}} onSettings={() => {}} onSideChat={() => {}} connected />
      </QueryClientProvider>,
    );
    await screen.findByText('Pinned');
    const menu = await rowMenu('Tidy the docs');
    // Copy resume command is there for a session Claude Code can resume, by its id (these are made up).
    expect(items(menu)).toEqual(['Rename', 'Pin', 'Side chat', 'Fork', 'Export', 'Archive', 'Delete']);
    expect(within(menu).queryByText('Transcript view')).toBeNull();
    // A session Claude works in can be deleted once it stops.
    fireEvent.keyDown(menu, { key: 'Escape' });
    document.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(items(await rowMenu('Add a dark theme'))).not.toContain('Delete');
  });

  it('opens on a long press of a finger, with the row raised over the dimmed list', async () => {
    list();
    await screen.findByText('Pinned');
    const row = screen.getByRole('link', { name: /^Tidy the docs, / });
    // The page's clock stays the file's (noon today), which the sessions' times count from.
    const clock = Date.now();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      fireEvent.pointerDown(row, { pointerType: 'touch', isPrimary: true, pointerId: 1, clientX: 120, clientY: 100 });
      act(() => vi.advanceTimersByTime(520));
    } finally {
      vi.useRealTimers();
      vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
      vi.setSystemTime(clock);
    }
    fireEvent.pointerUp(row, { pointerType: 'touch', isPrimary: true, pointerId: 1, clientX: 120, clientY: 100 });
    const menu = await screen.findByRole('menu', { name: 'Tidy the docs' });
    expect(items(menu)[0]).toBe('Rename');
    // The row itself, raised over the dim, takes no taps.
    expect(document.querySelector('dialog [inert] [data-session]')).not.toBeNull();
    // The click that ends the press is the press's: the session does not open, nor the menu close.
    fireEvent.click(row);
    expect(screen.getByRole('menu', { name: 'Tidy the docs' })).toBeTruthy();
  });

  it('says why when the server says no', async () => {
    list();
    await screen.findByText('Pinned');
    pin.mockRejectedValueOnce(new Error('The disk is full'));
    await fromMenu('Tidy the docs', 'Pin');
    expect(await screen.findByText('The disk is full')).toBeTruthy();
  });

  it('archives a pinned session, which the list shows archived and unpinned, with Undo', async () => {
    list();
    await screen.findByText('Pinned');
    await fromMenu('Release notes', 'Archive');
    await waitFor(() => expect(archive).toHaveBeenCalledWith('p1', true));
    expect(titles('Pinned')).not.toContain('Release notes');
    expect(screen.getByRole('status').textContent).toContain('Archived');
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
  });

  it('renames in a sheet of its own, the title selected to type over', async () => {
    list();
    await screen.findByText('Pinned');
    await fromMenu('Tidy the docs', 'Rename');
    const field = await screen.findByRole('textbox', { name: 'Session title' }) as HTMLInputElement;
    expect(field.value).toBe('Tidy the docs');
    fireEvent.change(field, { target: { value: 'Tidy the docs site' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(rename).toHaveBeenCalledWith('t1', 'Tidy the docs site'));
  });

  it('asks before Delete, in Desktop’s words, and deletes only then', async () => {
    const onGone = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SessionList machine="studio" onOpen={() => {}} onNew={() => {}} onSettings={() => {}} onGone={onGone} connected />
      </QueryClientProvider>,
    );
    await screen.findByText('Pinned');
    await fromMenu('Tidy the docs', 'Delete');
    const ask = await screen.findByRole('dialog', { name: 'Delete this session?' });
    expect(ask.textContent).toContain('Its transcript is removed from this computer, for every Claude Code app.');
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(within(ask).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('t1'));
    await waitFor(() => expect(onGone).toHaveBeenCalledWith('t1'));
  });

  it('from the open session’s title: its view, all three, and its start and ID at its foot, over another app it is open in', async () => {
    const choose = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SessionMenu
          open
          onClose={() => {}}
          sessionId="7f3c2a10-0000-4000-8000-000000000001"
          session={{ ...server.find((s) => s.id === 't1')!, createdAt: now - 2 * HOUR, openIn: 'Claude Desktop' }}
          from="title"
          view={{ value: 'normal', options: [{ value: 'normal', label: 'Normal' }, { value: 'thinking', label: 'Thinking' }, { value: 'verbose', label: 'Verbose' }], choose }}
          onForked={() => {}}
          onRenamed={() => {}}
          onDeleted={() => {}}
          onProblem={() => {}}
        />
      </QueryClientProvider>,
    );
    const sheet = screen.getByRole('dialog');
    expect(within(sheet).getByRole('group', { name: 'Transcript view' }).textContent).toBe('NormalThinkingVerbose');
    fireEvent.click(within(sheet).getByRole('menuitemradio', { name: 'Verbose' }));
    expect(choose).toHaveBeenCalledWith('verbose');
    expect(sheet.textContent).toMatch(/Also open in Claude DesktopStarted today, .* · ID 7f3c2a10/);
    expect(within(sheet).getByRole('button', { name: 'Copy the session’s ID' })).toBeTruthy();
  });
});
