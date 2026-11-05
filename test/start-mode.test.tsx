// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ModelOption, PermissionMode, RunSettings } from '../src/shared/protocol';

const models: ModelOption[] = [
  { value: 'default', label: 'Default', description: '', efforts: [], supportsFast: false, supportsAuto: true },
  { value: 'haiku', label: 'Haiku', description: '', efforts: [], supportsFast: false, supportsAuto: false },
];
/** What Claude Code's settings say new sessions start in; answered after `delay` ms. */
const claudeCode = vi.hoisted(() => ({ mode: null as PermissionMode | null, delay: 0, asked: [] as Array<string | undefined> }));
const created = vi.hoisted(() => [] as Array<{ settings: RunSettings }>);

vi.mock('../src/web/lib/api', async (original) => {
  const actual = await original<typeof import('../src/web/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      models: async () => ({ models, signedIn: true }),
      usage: async () => [],
      planUsage: async () => null,
      projects: async () => [],
      git: async () => ({ repo: false }),
      defaults: async (cwd?: string) => {
        claudeCode.asked.push(cwd);
        await new Promise((resolve) => setTimeout(resolve, claudeCode.delay));
        return { permissionMode: claudeCode.mode };
      },
      create: async (body: { settings: RunSettings }) => {
        created.push(body);
        return { sessionId: '11111111-2222-4333-8444-555555555555' };
      },
      // A session of its own in Bypass, for its branches.
      session: async (id: string) => ({
        session: { id, title: 'Clean up the build', cwd: '/code/app', project: 'app', lastActivity: Date.now(), status: 'idle' },
        run: { sessionId: id, cwd: '/code/app', busy: false, settings: { model: 'default', permissionMode: 'bypassPermissions' }, permissions: [], partial: [] },
        tasks: [],
        settings: {},
      }),
      messages: async () => ({ messages: [{ uuid: 'u1', role: 'user', blocks: [{ type: 'text', text: 'Clean up the build' }], timestamp: Date.now() }], total: 1, offset: 0 }),
      mcp: async () => ({ servers: [], live: false }),
      fork: async () => '99999999-2222-4333-8444-555555555555',
    },
  };
});

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
  window.matchMedia = ((query: string) => ({
    matches: query.includes('reduce'), media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
});

const { SettingsSheet } = await import('../src/web/components/Settings');
const { Chat } = await import('../src/web/components/Chat');

afterEach(() => {
  cleanup();
  localStorage.clear();
  Object.assign(claudeCode, { mode: null, delay: 0, asked: [] });
  created.length = 0;
});

const wrap = (node: React.ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);
const info = { machine: 'studio', home: '/home/me', version: '0.3.0', auth: false, demo: true };

function settings() {
  wrap(<SettingsSheet open onClose={() => {}} info={info} notifications="off" onToggleNotifications={() => {}} onSignOut={() => {}} />);
  return () => screen.getByRole('button', { name: /^Mode(?!l)/ });
}

describe('the mode new sessions start in, in Settings', () => {
  it('is Auto, or Claude Code’s own default, until one is picked; Bypass is never offered', async () => {
    claudeCode.mode = 'plan';
    const row = settings();
    await waitFor(() => expect(row().textContent).toBe('ModePlan'));
    fireEvent.click(row());
    const sheet = screen.getAllByRole('dialog').at(-1)!;
    expect(within(sheet).getAllByRole('button').map((b) => b.querySelector('.text-\\[15px\\]')?.textContent).filter(Boolean))
      .toEqual(['Manual', 'Accept edits', 'Plan', 'Auto']);
    fireEvent.click(within(sheet).getByText('Auto'));
    await waitFor(() => expect(row().textContent).toBe('ModeAuto'));
    expect(JSON.parse(localStorage.getItem('pelican:settings')!).permissionMode).toBe('auto');
  });

  it('keeps a picked Auto when the model has none, and starts such a model in Manual', async () => {
    localStorage.setItem('pelican:settings', JSON.stringify({ model: 'haiku', permissionMode: 'auto' }));
    const row = settings();
    await waitFor(() => expect(row().textContent).toBe('ModeManual'));
    expect(JSON.parse(localStorage.getItem('pelican:settings')!).permissionMode).toBe('auto');
  });
});

describe('a new session', () => {
  const chat = () => wrap(<Chat newCwd="/code/app" home="/home/me" machine="studio" wide onBack={() => {}} onOpen={() => {}} onStartIn={() => {}} />);
  const send = async (text: string) => {
    const box = screen.getByLabelText('Message Claude');
    fireEvent.change(box, { target: { value: text } });
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter', keyCode: 13 });
    });
  };

  it('starts in Claude Code’s default for its folder, read before the first message goes, even when sent at once', async () => {
    Object.assign(claudeCode, { mode: 'acceptEdits', delay: 30 });
    chat();
    await send('Fix the login test');
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]!.settings.permissionMode).toBe('acceptEdits');
    expect(claudeCode.asked).toContain('/code/app');
  });

  it('starts in Auto when nothing says otherwise, in the mode picked in Settings when one is, and in a mode picked for it', async () => {
    chat();
    await waitFor(() => expect(screen.getByLabelText('Permission mode').textContent).toBe('Auto'));
    await send('One');
    await waitFor(() => expect(created.at(-1)?.settings.permissionMode).toBe('auto'));
    cleanup();

    localStorage.setItem('pelican:settings', JSON.stringify({ permissionMode: 'plan' }));
    claudeCode.mode = 'acceptEdits';
    chat();
    await send('Two');
    await waitFor(() => expect(created.at(-1)?.settings.permissionMode).toBe('plan'));
    cleanup();

    chat();
    fireEvent.click(screen.getByLabelText('Permission mode'));
    fireEvent.click(within(screen.getAllByRole('dialog').at(-1)!).getByText('Manual'));
    await send('Three');
    await waitFor(() => expect(created.at(-1)?.settings.permissionMode).toBe('default'));
  });
});

describe('a session in Bypass', () => {
  const SESSION = '22222222-2222-4333-8444-555555555555';
  const BRANCH = '99999999-2222-4333-8444-555555555555';

  it('branches into the mode a new session would start in, never into Bypass', async () => {
    claudeCode.mode = 'plan';
    const onOpen = vi.fn();
    wrap(<Chat sessionId={SESSION} home="/home/me" machine="studio" demo wide onBack={() => {}} onOpen={onOpen} onStartIn={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('Permission mode').textContent).toBe('Bypass'));
    fireEvent.click(screen.getByLabelText('Session menu'));
    fireEvent.click(await screen.findByText('Branch'));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(BRANCH));
    const choices = JSON.parse(localStorage.getItem('pelican:session-settings')!) as Record<string, { settings: RunSettings }>;
    expect(choices[BRANCH]!.settings.permissionMode).toBe('plan');
  });

  it('hands a /clear on to a new session in the mode a new session starts in', async () => {
    const onStartIn = vi.fn();
    wrap(<Chat sessionId={SESSION} home="/home/me" machine="studio" demo wide onBack={() => {}} onOpen={() => {}} onStartIn={onStartIn} />);
    await waitFor(() => expect(screen.getByLabelText('Permission mode').textContent).toBe('Bypass'));
    const box = screen.getByLabelText('Message Claude');
    fireEvent.change(box, { target: { value: '/clear' } });
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 13 });
    expect(onStartIn).toHaveBeenCalledWith({ cwd: '/code/app' });
    cleanup();
    wrap(<Chat newCwd="/code/app" home="/home/me" machine="studio" wide onBack={() => {}} onOpen={() => {}} onStartIn={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('Permission mode').textContent).toBe('Auto'));
  });
});
