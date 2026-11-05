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
      models: async () => ({ models: [], signedIn: true }),
      usage: async () => [],
      planUsage: async () => null,
      defaults: async () => ({ permissionMode: null }),
      phoneAddress: async () => undefined,
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

describe('Settings', () => {
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
    expect(await screen.findByRole('dialog', { name: 'Usage and activity' })).toBeTruthy();
    expect(asked.ranges.length).toBeGreaterThan(0);
  });
});
