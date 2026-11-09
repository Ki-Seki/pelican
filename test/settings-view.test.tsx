// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const asked = vi.hoisted(() => ({ ranges: [] as string[] }));

vi.mock('../src/web/lib/api', async (original) => {
  const actual = await original<typeof import('../src/web/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      models: async () => ({ models: [], signedIn: true, account: { email: 'me@example.com', plan: 'max' } }),
      usage: async () => [{ type: 'five_hour', status: 'allowed', utilization: 0.4 }],
      planUsage: async () => null,
      defaults: async () => (await import('./start-defaults')).BUILT_IN,
      phoneAddress: async () => null,
      // Still being read: the page is there, its figures to come.
      usageStats: (range: string) => {
        asked.ranges.push(range);
        return new Promise(() => {});
      },
    },
  };
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

const { SettingsSheet } = await import('../src/web/components/Settings');

afterEach(() => {
  cleanup();
  asked.ranges = [];
});

const { setPrefs, getPrefs } = await import('../src/web/lib/prefs');

describe('Settings', () => {
  it('says what each applies to, in Claude Desktop’s words: Default transcript view, and While Claude works, Send', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <SettingsSheet open onClose={() => {}} info={{ version: '0.5.0', machine: 'studio', demo: true } as never} notifications="off" onToggleNotifications={() => {}} onSignOut={() => {}} />
      </QueryClientProvider>,
    );
    expect(screen.getByText('Default transcript view')).toBeTruthy();
    expect(screen.queryByText('Sessions open in')).toBeNull();
    expect(screen.getByText('While Claude works, Send')).toBeTruthy();
    expect(screen.getByText('Claude reads it at its next step.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Queues for later' }));
    expect(getPrefs().sendWhileBusy).toBe('queue');
    expect(screen.getByText('It goes once the turn ends.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sends now' }));
    expect(getPrefs().sendWhileBusy).toBe('steer');
    // The account and its plan on one line; the plan's limits are in Usage and in Context, not here.
    expect(await screen.findByText(/· Max plan/)).toBeTruthy();
    expect(screen.queryByText('5-hour')).toBeNull();
    setPrefs({ sendWhileBusy: 'steer' });
  });

  it('opens Usage and activity, whose page loads when Settings opens rather than with it', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <SettingsSheet open onClose={() => {}} info={{ version: '0.4.0', machine: 'studio', demo: true } as never} notifications="off" onToggleNotifications={() => {}} onSignOut={() => {}} />
      </QueryClientProvider>,
    );
    // Not asked for yet: nothing of the usage page is shown, or read.
    expect(screen.queryByRole('dialog', { name: 'Usage and activity' })).toBeNull();
    expect(asked.ranges).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: /^Usage and activity/ }));
    // It loads when first asked for, which takes longer on a busy machine.
    expect(await screen.findByRole('dialog', { name: 'Usage and activity' }, { timeout: 5000 })).toBeTruthy();
    expect(asked.ranges.length).toBeGreaterThan(0);
  });

  it('says in About which Claude Code runs, when it is older than the one Pelican was tested with, and how to install it where there is none', () => {
    const about = (claudeCode: Record<string, unknown>) => {
      cleanup();
      render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <SettingsSheet open onClose={() => {}} info={{ version: '0.6.0', machine: 'studio', home: '/home/ada', demo: false, claudeCode } as never} notifications="off" onToggleNotifications={() => {}} onSignOut={() => {}} />
        </QueryClientProvider>,
      );
      return screen.getByText(/^Pelican 0\.6\.0 on/).closest('div')!.textContent;
    };
    expect(about({ version: '2.1.318', path: '/home/ada/.local/bin/claude' })).toContain('Claude Code 2.1.318 from ~/.local/bin/claude');
    expect(about({ version: '2.1.318', path: '/home/ada/.local/bin/claude' })).not.toContain('older');
    expect(about({ version: '2.1.300', path: '/usr/bin/claude', tested: '2.1.318' }))
      .toContain('Claude Code 2.1.300 from /usr/bin/claude' + 'Claude Code 2.1.300 is older than 2.1.318, which Pelican was tested with: run claude update');
    expect(about({ missing: true, install: 'curl -fsSL https://claude.ai/install.sh | bash' }))
      .toContain('Claude Code not found: install it with curl -fsSL https://claude.ai/install.sh | bash, or set PELICAN_CLAUDE_PATH to it');
    expect(about({ missing: true, path: '/opt/claude' })).toContain('Claude Code not found at /opt/claude (PELICAN_CLAUDE_PATH)');
  });
});
