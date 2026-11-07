// @vitest-environment jsdom
// Settings › About, of updates (src/web/components/UpdateSection.tsx): quiet until npm's registry
// has a newer Pelican; then what changed, and Update, or the command to run and why; what an update
// would end, with Update now and Update when idle; the update as it goes, and what failed. And a
// page that connects again to another version loads its app, once (src/web/lib/update.ts).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ServerInfo } from '../src/shared/protocol';
import type { UpdateInfo } from '../src/shared/update';

const server = vi.hoisted(() => ({
  info: { current: '0.5.0' } as UpdateInfo,
  asked: [] as boolean[],
  started: [] as unknown[][],
  cancelled: 0,
  version: '0.5.0',
  /** How long the server takes to answer a look (what runs is read with ps). */
  slow: 0,
}));

vi.mock('../src/web/lib/api', async (original) => {
  const actual = await original<typeof import('../src/web/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      update: async (check = false) => {
        server.asked.push(check);
        if (server.slow) await new Promise((resolve) => setTimeout(resolve, server.slow));
        return server.info;
      },
      startUpdate: async (...args: unknown[]) => {
        server.started.push(args);
        if (server.slow) await new Promise((resolve) => setTimeout(resolve, server.slow));
        return server.info;
      },
      cancelUpdate: async () => {
        server.cancelled += 1;
        return server.info;
      },
      info: async () => ({ version: server.version, machine: 'studio', home: '/Users/me', auth: true, demo: false }) as ServerInfo,
    },
  };
});

const connections = vi.hoisted(() => ({ listeners: [] as Array<(connected: boolean) => void> }));
vi.mock('../src/web/lib/socket', () => ({
  socket: {
    onConnection: (listener: (connected: boolean) => void) => {
      connections.listeners.push(listener);
      return () => undefined;
    },
  },
}));

const { UpdateSection } = await import('../src/web/components/UpdateSection');
const { APP_VERSION, page, useNewVersion } = await import('../src/web/lib/update');

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);

const NEWER: UpdateInfo = {
  current: '0.5.0',
  latest: '0.5.1',
  changes: '## 0.5.1\n\nFaster terminals, and updates from Settings.\n\n### Highlights\n\n- **Update.** From Settings.',
  install: { kind: 'npm', folder: '/usr/local/lib/node_modules/pelican-cc', prefix: '/usr/local', self: true, restart: 'launchd' },
  busy: [],
};

afterEach(() => {
  cleanup();
  Object.assign(server, { info: { current: '0.5.0' }, asked: [], started: [], cancelled: 0, version: '0.5.0', slow: 0 });
  connections.listeners = [];
  sessionStorage.clear();
});

describe('Settings › About, of updates', () => {
  it('says nothing while this is the newest Pelican, or in the demo, which asks nothing', async () => {
    const { container, rerender } = render(<UpdateSection open />, { wrapper });
    await waitFor(() => expect(server.asked).toEqual([true]));
    expect(container.textContent).toBe('');
    server.asked = [];
    rerender(<UpdateSection open demo />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.asked).toEqual([]);
    expect(container.textContent).toBe('');
  });

  it('says a newer one is out, what changed, how it updates, and updates at once when nothing runs', async () => {
    server.info = NEWER;
    render(<UpdateSection open />, { wrapper });
    expect(await screen.findByText('Pelican 0.5.1 is out.')).toBeTruthy();
    expect(screen.getByText('Faster terminals, and updates from Settings.')).toBeTruthy();
    expect(screen.queryByText('Update.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'What’s new in 0.5.1' }));
    expect(screen.getByText('Update.')).toBeTruthy();
    expect(screen.getByText(/Installed with npm in \/usr\/local: Pelican installs it, checks that it starts, and its login item starts it again/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Update to 0.5.1' }));
    await waitFor(() => expect(server.started).toEqual([['0.5.1', 'now']]));
  });

  it('lists what an update would end first, with Update now, Update when idle and Cancel', async () => {
    server.info = {
      ...NEWER,
      busy: [
        { kind: 'session', title: 'Fix the build', detail: 'Claude is working', sessionId: 's1' },
        { kind: 'terminal', title: 'vim', detail: 'in ~/repo' },
        { kind: 'command', title: '!npm test', detail: 'in Fix the build', sessionId: 's1' },
      ],
    };
    render(<UpdateSection open />, { wrapper });
    fireEvent.click(await screen.findByRole('button', { name: 'Update to 0.5.1' }));
    expect(await screen.findByText('Updating restarts Pelican, which ends:')).toBeTruthy();
    for (const words of ['Fix the build', 'vim', '!npm test', 'Transcripts, files, pins, settings and drafts stay.']) expect(screen.getByText(words)).toBeTruthy();
    expect(server.started).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Updating restarts Pelican, which ends:')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Update to 0.5.1' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Update when idle' }));
    await waitFor(() => expect(server.started).toEqual([['0.5.1', 'idle']]));
    fireEvent.click(screen.getByRole('button', { name: 'Update to 0.5.1' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Update now' }));
    await waitFor(() => expect(server.started).toEqual([['0.5.1', 'idle'], ['0.5.1', 'now', true]]));
  });

  it('asks the server once for a double click on Update, its buttons off until it answers', async () => {
    server.info = NEWER;
    render(<UpdateSection open />, { wrapper });
    const update = await screen.findByRole('button', { name: 'Update to 0.5.1' });
    server.slow = 60;
    fireEvent.click(update);
    fireEvent.click(update);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((update as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(update);
    await waitFor(() => expect(server.started).toEqual([['0.5.1', 'now']]));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(server.started).toEqual([['0.5.1', 'now']]);
    // The look before it, once too.
    expect(server.asked.filter((check) => !check)).toHaveLength(1);
    // The confirmation's Update now, tapped twice: once.
    server.slow = 0;
    server.info = { ...NEWER, busy: [{ kind: 'session', title: 'Fix the build', detail: 'Claude is working', sessionId: 's1' }] };
    server.started = [];
    cleanup();
    render(<UpdateSection open />, { wrapper });
    fireEvent.click(await screen.findByRole('button', { name: 'Update to 0.5.1' }));
    server.slow = 60;
    const now = await screen.findByRole('button', { name: 'Update now' });
    fireEvent.click(now);
    fireEvent.click(now);
    await waitFor(() => expect(server.started).toEqual([['0.5.1', 'now', true]]));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(server.started).toEqual([['0.5.1', 'now', true]]);
  });

  it('says that messages queued for the end of a turn are not sent, where an update now would end them', async () => {
    server.info = {
      ...NEWER,
      busy: [
        { kind: 'session', title: 'Fix the build', detail: 'Claude is working', sessionId: 's1' },
        { kind: 'queued', title: 'Fix the build', detail: '2 messages for when this turn ends', sessionId: 's1' },
      ],
    };
    render(<UpdateSection open />, { wrapper });
    fireEvent.click(await screen.findByRole('button', { name: 'Update to 0.5.1' }));
    expect(await screen.findByText('Updating restarts Pelican, which ends:')).toBeTruthy();
    expect(screen.getByText('Queued')).toBeTruthy();
    expect(screen.getByText(/2 messages for when this turn ends/)).toBeTruthy();
    expect(screen.getByText('Transcripts, files, pins, settings and drafts stay; queued messages are not sent.')).toBeTruthy();
    expect(screen.queryByText('Transcripts, files, pins, settings and drafts stay.')).toBeNull();
  });

  it('says to stop Pelican and start it with the new version where npx, pnpm dlx or bunx runs it', async () => {
    server.info = {
      ...NEWER,
      install: {
        kind: 'npx', folder: '/Users/me/.npm/_npx/6c0de8e1/node_modules/pelican-cc', self: false, restart: 'in-place',
        command: 'npx pelican-cc@0.5.1 --port 7860',
        why: 'This Pelican runs from npx’s cache, which npx fills again: it starts the new version when asked for it by number.',
      },
    };
    render(<UpdateSection open />, { wrapper });
    expect(await screen.findByText('npx pelican-cc@0.5.1 --port 7860')).toBeTruthy();
    expect(screen.getByText('To update, stop Pelican, then start it with:')).toBeTruthy();
    expect(screen.queryByText(/run this in a terminal/)).toBeNull();
  });

  it('shows the command to run, and why, where Pelican cannot update itself', async () => {
    server.info = {
      ...NEWER,
      install: {
        kind: 'managed', folder: '/Users/me/.local/lib/node_modules/pelican-cc', prefix: '/Users/me/.local', self: false, restart: 'in-place',
        command: 'npm install --global --prefix ~/.local pelican-cc@0.5.1',
        why: 'This Pelican is installed in ~/.local, not in npm’s global folder (/usr/local).',
      },
    };
    render(<UpdateSection open />, { wrapper });
    expect(await screen.findByText('npm install --global --prefix ~/.local pelican-cc@0.5.1')).toBeTruthy();
    expect(screen.getByText(/To update, run this in a terminal, then restart Pelican/)).toBeTruthy();
    expect(screen.getByText(/not in npm’s global folder/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Update/ })).toBeNull();
  });

  it('follows the update: getting it ready, waiting for idle with Cancel, installing, starting, and says what failed', async () => {
    server.info = { ...NEWER, state: { phase: 'preparing', version: '0.5.1', when: 'idle' } };
    render(<UpdateSection open />, { wrapper });
    expect(await screen.findByText('Getting 0.5.1 and checking that it starts. Nothing changes until it does.')).toBeTruthy();
    server.info = { ...NEWER, busy: [{ kind: 'work', title: 'Redo the site', detail: 'an agent in the background', sessionId: 's3' }], state: { phase: 'waiting', version: '0.5.1', since: 1 } };
    expect(await screen.findByText('0.5.1 is ready. Pelican updates once nothing has run for a minute.', {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.getByText('Waiting for:')).toBeTruthy();
    expect(screen.getByText('Redo the site')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(server.cancelled).toBe(1));
    for (const [phase, words] of [['installing', 'Installing 0.5.1…'], ['checking', 'Checking that 0.5.1 starts…'], ['restarting', 'Starting 0.5.1. This page reconnects by itself.']] as const) {
      server.info = { ...NEWER, state: { phase, version: '0.5.1' } };
      cleanup();
      render(<UpdateSection open />, { wrapper });
      expect(await screen.findByText(words)).toBeTruthy();
    }
    cleanup();
    server.info = { ...NEWER, state: { phase: 'failed', version: '0.5.1', error: 'npm could not install 0.5.1: npm error code ENOTFOUND', running: '0.5.0' } };
    render(<UpdateSection open />, { wrapper });
    const alert = await screen.findByRole('alert');
    expect([...alert.querySelectorAll('p')].map((line) => line.textContent)).toEqual(['npm could not install 0.5.1: npm error code ENOTFOUND', 'Pelican 0.5.0 keeps running.']);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('a page back after Pelican started again', () => {
  it('loads the app of the version that runs now, once for that version, and not for the same one', async () => {
    const reload = vi.spyOn(page, 'reload').mockImplementation(() => undefined);
    renderHook(() => useNewVersion(), { wrapper });
    const say = (connected: boolean) => act(() => {
      for (const listener of connections.listeners) listener(connected);
    });
    // The first connection is no coming back; the same version back again changes nothing.
    server.version = APP_VERSION;
    say(true);
    say(false);
    say(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reload).not.toHaveBeenCalled();
    // Another version: the new app, once.
    server.version = '9.9.9';
    say(false);
    say(true);
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    say(false);
    say(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reload).toHaveBeenCalledTimes(1);
    reload.mockRestore();
  });
});
