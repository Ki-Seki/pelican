// @vitest-environment jsdom
// Parts fetched when a part around them first needs them: the usage page, once Settings is open, and
// the tabs of Changes and files, once the conversation is up. Each test says how many requests for
// a part drop before one goes through, as on a flaky phone connection, and counts the requests made.
// What holds them is never mocked: it loads afresh for each test, with nothing of the last.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { SessionSummary } from '../src/shared/protocol';

const dropped = (name: string) => new TypeError(`Failed to fetch dynamically imported module: /assets/${name}.js`);
const listed: SessionSummary = { id: '55555555-2222-4333-8444-555555555555', title: 'Fix the flaky login test', cwd: '/code/app', project: 'app', lastActivity: Date.now() - 60_000, status: 'idle' };

vi.mock('../src/web/lib/api', async (original) => {
  const actual = await original<typeof import('../src/web/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      auth: async () => ({ required: false, mode: 'none', signedIn: true }),
      info: async () => ({ machine: 'studio', home: '/home/me', version: '0.4.0', auth: false, demo: false }),
      sessions: async () => [listed],
      models: async () => ({ models: [], signedIn: true }),
      usage: async () => [],
      planUsage: async () => null,
      defaults: async () => ({ permissionMode: null }),
      // Still being read: the page is there, its figures to come.
      usageStats: () => new Promise(() => {}),
      git: async () => ({ repo: true, branch: 'main', files: [{ path: 'src/a.ts', status: 'modified', added: 1, removed: 0 }] }),
      changes: async () => ({ turns: [], lines: {} }),
      tree: async () => [{ name: 'notes.md', path: 'notes.md', dir: false, size: 30 }],
    },
  };
});

beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
  Object.assign(globalThis, {
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
  });
});

afterEach(() => {
  cleanup();
  history.replaceState(null, '', '/');
});

type Part = 'Usage' | 'WorkspaceChanges' | 'WorkspaceFiles';
/** How often each part was asked for since the test began, and how many of those requests dropped. */
const asked = new Map<Part, number>();
const drops = new Map<Part, number>();

/**
 * Makes the next `counts` requests for each of these parts drop, from a fresh start. Each takes a
 * moment to arrive or drop, as over a network, and one asked for while another is on its way
 * shares it, as a browser's does.
 */
function dropping(counts: Partial<Record<Part, number>>) {
  vi.resetModules();
  for (const [name, count] of Object.entries(counts) as Array<[Part, number]>) {
    let left = count;
    asked.set(name, 0);
    drops.set(name, 0);
    vi.doMock(`../src/web/components/${name}`, async (original) => {
      asked.set(name, asked.get(name)! + 1);
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (left > 0) {
        left -= 1;
        drops.set(name, drops.get(name)! + 1);
        throw dropped(name);
      }
      return original();
    });
  }
}

/** Past the second try, 800 ms after the first, on a busy machine too. */
const LATER = { timeout: 5000 };

describe('the usage page on a flaky link', () => {
  async function settings(count: number) {
    dropping({ Usage: count });
    const { App } = await import('../src/web/App');
    render(<QueryClientProvider client={new QueryClient()}><App /></QueryClientProvider>);
    await screen.findByText('Fix the flaky login test');
    fireEvent.click(screen.getByLabelText('Settings'));
    const usage = await screen.findByRole('button', { name: /^Usage and activity/ }, LATER);
    // Settings asks for the page ahead of need; here that request has dropped before the page is asked for.
    await waitFor(() => expect(drops.get('Usage')).toBe(1), LATER);
    fireEvent.click(usage);
  }

  it('is asked for once more: it opens after a dropped request, also when the one made ahead dropped', async () => {
    await settings(2);
    expect(await screen.findByRole('dialog', { name: 'Usage and activity' }, LATER)).toBeTruthy();
    // Ahead of need, when asked for, and once more.
    expect(asked.get('Usage')).toBe(3);
  }, 15_000);

  it('that does not load says so in Settings, which offers to reload, and the list stays', async () => {
    await settings(Infinity);
    const said = await screen.findByText('This part of Pelican did not load.', {}, LATER);
    const sheet = said.closest('dialog')!;
    expect(within(sheet).getByRole('heading', { name: 'Settings' })).toBeTruthy();
    expect(within(sheet).getByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(screen.getByText('Fix the flaky login test')).toBeTruthy();
    expect(asked.get('Usage')).toBe(3);
  }, 15_000);
});

describe('a tab of Changes and files on a flaky link', () => {
  /** Changes and files on a phone, at `tab`. */
  async function view(tab: 'changes' | 'files', counts: Parameters<typeof dropping>[0]) {
    history.replaceState(null, '', `/?s=s1&w=${tab}`);
    dropping(counts);
    const { Workspace } = await import('../src/web/components/Workspace');
    render(<QueryClientProvider client={new QueryClient()}><Workspace open cwd="/code/app" sessionId="s1" onClose={() => {}} onAddToMessage={() => {}} /></QueryClientProvider>);
    return screen.getByRole('region', { name: 'Changes and files' });
  }

  it('is asked for once more: one dropped request costs nothing', async () => {
    const changes = await view('changes', { WorkspaceChanges: 1 });
    expect(await within(changes).findByText('a.ts', {}, LATER)).toBeTruthy();
    expect(asked.get('WorkspaceChanges')).toBe(2);
    cleanup();
    const files = await view('files', { WorkspaceFiles: 1 });
    expect(await within(files).findByText('notes.md', {}, LATER)).toBeTruthy();
    expect(asked.get('WorkspaceFiles')).toBe(2);
  }, 15_000);

  it('that does not load says so in the pane, with Reload, and the view stays', async () => {
    const pane = await view('changes', { WorkspaceChanges: Infinity });
    expect(await within(pane).findByText('This part of Pelican did not load.', {}, LATER)).toBeTruthy();
    expect(within(pane).getByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(within(pane).getByRole('button', { name: 'Back to the conversation' })).toBeTruthy();
    expect(asked.get('WorkspaceChanges')).toBe(2);
  }, 15_000);
});
