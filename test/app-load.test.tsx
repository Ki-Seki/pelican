// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { SessionSummary } from '../src/shared/protocol';

// The conversation and Settings are fetched after the page, when first needed. Each page load
// says how many requests for them drop before one goes through, as on a flaky phone connection.
const dropped = (name: string) => new TypeError(`Failed to fetch dynamically imported module: /assets/${name}.js`);

const SESSION = '55555555-2222-4333-8444-555555555555';
const listed: SessionSummary = { id: SESSION, title: 'Fix the flaky login test', cwd: '/code/app', project: 'app', lastActivity: Date.now() - 60_000, status: 'idle' };

vi.mock('../src/web/lib/api', async (original) => {
  const actual = await original<typeof import('../src/web/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      auth: async () => ({ required: false, mode: 'none', signedIn: true }),
      info: async () => ({ machine: 'studio', home: '/home/me', version: '0.3.0', auth: false, demo: false }),
      sessions: async () => [listed],
      models: async () => ({ models: [], signedIn: true }),
      usage: async () => [],
      planUsage: async () => null,
      defaults: async () => (await import('./start-defaults')).BUILT_IN,
      git: async () => ({ repo: false }),
      session: async () => ({ session: listed, run: null, tasks: [], settings: {} }),
      messages: async () => ({ messages: [], total: 0, offset: 0 }),
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

/** The app as a page loads it, at `route`, with `drops` requests for each part failing first. */
async function page(route: string, drops: { Chat?: number; Settings?: number }) {
  history.replaceState(null, '', `/${route}`);
  vi.resetModules();
  for (const name of ['Chat', 'Settings'] as const) {
    let left = drops[name] ?? 0;
    vi.doMock(`../src/web/components/${name}`, async (original) => {
      if (left > 0) {
        left -= 1;
        throw dropped(name);
      }
      return original();
    });
  }
  const { App } = await import('../src/web/App');
  render(<QueryClientProvider client={new QueryClient()}><App /></QueryClientProvider>);
}

describe('a part of the page that does not load', () => {
  it('leaves the list as it is when Settings does not load, and Settings offers to reload', async () => {
    await page('', { Settings: Infinity });
    expect(await screen.findByText('Fix the flaky login test')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Settings'));
    const sheet = await screen.findByRole('dialog', { name: 'Settings' }, { timeout: 3000 });
    expect(within(sheet).getByText('This part of Pelican did not load.')).toBeTruthy();
    expect(within(sheet).getByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(screen.getByText('Fix the flaky login test')).toBeTruthy();
  });

  it('offers to reload in place of a conversation that does not load, opened from a link', async () => {
    await page(`?s=${SESSION}`, { Chat: Infinity });
    expect(await screen.findByRole('button', { name: 'Reload' }, { timeout: 3000 })).toBeTruthy();
    expect(screen.getByText('This part of Pelican did not load.')).toBeTruthy();
  });

  it('is asked for once more: one dropped request costs nothing', async () => {
    await page('', { Settings: 1 });
    await screen.findByText('Fix the flaky login test');
    fireEvent.click(screen.getByLabelText('Settings'));
    expect(await screen.findByText('Appearance', {}, { timeout: 3000 })).toBeTruthy();
  });
  // Each loads the whole app afresh: about a second alone, many on a busy computer.
}, 20_000);
