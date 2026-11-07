// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { type DefaultChange, OWN_EFFORT, type StartDefaults } from '../src/shared/defaults';
import type { ModelOption, RunSettings } from '../src/shared/protocol';
import { BUILT_IN } from './start-defaults';

const models: ModelOption[] = [
  { value: 'default', label: 'Default (recommended)', description: '', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], supportsFast: true, supportsAuto: true, resolvedModel: 'claude-opus-5-5' },
  { value: 'sonnet', label: 'Sonnet', description: '', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], supportsFast: false, supportsAuto: true, resolvedModel: 'claude-sonnet-5-5' },
  { value: 'haiku', label: 'Haiku', description: '', efforts: [], supportsFast: false, supportsAuto: false, resolvedModel: 'claude-haiku-5-5' },
];
/** Claude Code's settings as the server reads them, per folder ('' for none), and what was saved. */
const claudeCode = vi.hoisted(() => ({
  byFolder: new Map<string, unknown>(),
  saved: [] as Array<{ change: unknown; cwd?: string }>,
  refuse: undefined as string | undefined,
  asked: [] as Array<string | undefined>,
}));
const calls = vi.hoisted(() => ({ created: [] as Array<{ settings: RunSettings }>, applied: [] as RunSettings[] }));

vi.mock('../src/web/lib/api', async (original) => {
  const actual = await original<typeof import('../src/web/lib/api')>();
  const { BUILT_IN: builtIn } = await import('./start-defaults');
  const read = (cwd?: string) => (claudeCode.byFolder.get(cwd ?? '') ?? claudeCode.byFolder.get('') ?? builtIn) as StartDefaults;
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
        return structuredClone(read(cwd));
      },
      saveDefault: async (change: DefaultChange, cwd?: string) => {
        if (claudeCode.refuse) throw new actual.ApiError(claudeCode.refuse, 409);
        claudeCode.saved.push({ change, ...(cwd ? { cwd } : {}) });
        // What Claude Code's file says now, as the server would read it back.
        const next = structuredClone(read(cwd));
        if ('model' in change) next.model = change.model === 'default' ? { value: 'default', source: 'built-in' } : { value: change.model, source: 'user' };
        if ('permissionMode' in change) next.permissionMode = { value: change.permissionMode, source: 'user' };
        if ('fast' in change) next.fast = { value: change.fast, source: 'user', perSession: false };
        claudeCode.byFolder.set(cwd ?? '', next);
        return next;
      },
      create: async (body: { settings: RunSettings }) => {
        calls.created.push(body);
        return { sessionId: '11111111-2222-4333-8444-555555555555' };
      },
      applySettings: async (_id: string, settings: RunSettings) => {
        calls.applied.push(settings);
        return { ok: true };
      },
      // A session of its own in Bypass, Claude running, for its branches and its model sheet.
      session: async (id: string) => ({
        session: { id, title: 'Clean up the build', cwd: '/code/app', project: 'app', lastActivity: Date.now(), status: 'idle' },
        run: { sessionId: id, cwd: '/code/app', busy: false, settings: { model: 'default', effort: 'high', permissionMode: 'bypassPermissions' }, permissions: [], partial: [] },
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

/** The title's ▾, which opens the session's menu. */
const sessionMenu = () => document.querySelector<HTMLElement>('header h2 button')!;

afterEach(() => {
  cleanup();
  localStorage.clear();
  Object.assign(claudeCode, { byFolder: new Map(), saved: [], refuse: undefined, asked: [] });
  Object.assign(calls, { created: [], applied: [] });
});

const wrap = (node: React.ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);
const info = { machine: 'studio', home: '/home/me', version: '0.5.0', auth: false, demo: false };
const lastSheet = () => screen.getAllByRole('dialog').at(-1)!;
const options = (sheet: HTMLElement) => within(sheet).getAllByRole('button').map((b) => b.querySelector('.text-\\[15px\\]')?.textContent).filter(Boolean);
const said = (defaults: Partial<StartDefaults>) => ({ ...BUILT_IN, ...defaults });

function settings() {
  wrap(<SettingsSheet open onClose={() => {}} info={info} notifications="off" onToggleNotifications={() => {}} onSignOut={() => {}} />);
  return { model: () => screen.getByRole('button', { name: /^Model/ }), mode: () => screen.getByRole('button', { name: /^Mode(?!l)/ }) };
}

describe('Settings › New sessions start with', () => {
  it('shows what Claude Code starts new sessions with, and that these are its defaults', async () => {
    const rows = settings();
    await waitFor(() => expect(rows.mode().textContent).toBe('ModeClaude Code’s defaultAuto'));
    expect(rows.model().textContent).toContain('Claude Code’s defaults');
    expect(rows.model().textContent).toContain('Default');
    expect(screen.getByText(/A change here is saved in/).textContent).toContain('~/.claude/settings.json');
  });

  it('shows where each value comes from', async () => {
    claudeCode.byFolder.set('', said({
      model: { value: 'claude-sonnet-5-5', source: 'user' },
      effort: { byModel: { 'claude-sonnet-5-5': { level: 'low', source: 'user' } } },
      permissionMode: { value: 'acceptEdits', source: 'managed' },
    }));
    const rows = settings();
    await waitFor(() => expect(rows.mode().textContent).toBe('ModeManaged settingsAccept edits'));
    expect(rows.model().textContent).toBe('ModelYour Claude Code settingsSonnetLow');
  });

  it('saves a model, an effort and fast mode in Claude Code’s settings, offering what Claude Code keeps as a default', async () => {
    const rows = settings();
    await waitFor(() => expect(rows.model().textContent).toContain('Default'));
    fireEvent.click(rows.model());
    const sheet = lastSheet();
    // Max is for one session, Ultracode is a session's own: neither is offered here.
    expect(within(sheet).getAllByRole('button', { pressed: false }).map((b) => b.textContent)).not.toContain('Max');
    expect(within(sheet).queryByText('Max')).toBeNull();
    expect(within(sheet).queryByText('Ultracode')).toBeNull();
    fireEvent.click(within(sheet).getByText('High'));
    await waitFor(() => expect(claudeCode.saved).toEqual([{ change: { effort: { model: 'default', level: 'high' } } }]));
    fireEvent.click(within(sheet).getByRole('switch', { name: /Fast mode/ }));
    await waitFor(() => expect(claudeCode.saved.at(-1)).toEqual({ change: { fast: true } }));
    fireEvent.click(within(sheet).getByText('Sonnet'));
    await waitFor(() => expect(claudeCode.saved.at(-1)).toEqual({ change: { model: 'sonnet' } }));
    await waitFor(() => expect(rows.model().textContent).toContain('Sonnet'));
  });

  it('offers Manual, Accept edits, Plan and Auto as the mode, never Bypass, and saves the one picked', async () => {
    const rows = settings();
    await waitFor(() => expect(rows.mode().textContent).toContain('Auto'));
    fireEvent.click(rows.mode());
    expect(options(lastSheet())).toEqual(['Manual', 'Accept edits', 'Plan', 'Auto']);
    fireEvent.click(within(lastSheet()).getByText('Plan'));
    await waitFor(() => expect(claudeCode.saved).toEqual([{ change: { permissionMode: 'plan' } }]));
    await waitFor(() => expect(rows.mode().textContent).toBe('ModeYour Claude Code settingsPlan'));
  });

  it('says plainly when Claude Code’s settings start new sessions in Bypass, and saves no Bypass', async () => {
    claudeCode.byFolder.set('', said({ permissionMode: { value: 'bypassPermissions', source: 'user' } }));
    const rows = settings();
    await waitFor(() => expect(rows.mode().textContent).toContain('Bypass permissions'));
    expect(screen.getByText(/start new sessions in Bypass permissions: Claude runs everything without asking/)).toBeTruthy();
    fireEvent.click(rows.mode());
    expect(options(lastSheet())).toEqual(['Bypass permissions', 'Manual', 'Accept edits', 'Plan', 'Auto']);
    fireEvent.click(within(lastSheet()).getByText('Bypass permissions'));
    expect(claudeCode.saved).toEqual([]);
  });

  it('says when the settings file cannot be changed, and why a change was not saved', async () => {
    claudeCode.byFolder.set('', said({ file: { path: '/home/me/.claude/settings.json', state: 'invalid', problem: 'It is not valid JSON: Unexpected token' } }));
    claudeCode.refuse = 'Pelican left /home/me/.claude/settings.json as it is: It is not valid JSON.';
    const rows = settings();
    await waitFor(() => expect(screen.getByText(/Claude Code skips this file and Pelican changes nothing in it: It is not valid JSON/)).toBeTruthy());
    fireEvent.click(rows.mode());
    fireEvent.click(within(lastSheet()).getByText('Plan'));
    fireEvent.click(rows.model());
    await waitFor(() => expect(within(lastSheet()).getByText(/Pelican left .* as it is/)).toBeTruthy());
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

  it('shows what Claude Code’s settings start it with in its folder, and sends only what was picked', async () => {
    claudeCode.byFolder.set('/code/app', said({
      model: { value: 'haiku', source: 'project', user: 'sonnet' },
      permissionMode: { value: 'plan', source: 'project', user: 'acceptEdits' },
    }));
    chat();
    await waitFor(() => expect(screen.getByLabelText('Permission mode').textContent).toBe('Plan'));
    expect(screen.getByLabelText('Model, effort and speed').textContent).toBe('Haiku');
    expect(claudeCode.asked).toContain('/code/app');
    // The sheets say where that comes from.
    fireEvent.click(screen.getByLabelText('Model, effort and speed'));
    expect(within(lastSheet()).getByText('This folder’s .claude/settings.json starts sessions here with Haiku (yours: Sonnet).')).toBeTruthy();
    fireEvent.click(within(lastSheet()).getByText('Done'));
    fireEvent.click(screen.getByLabelText('Permission mode'));
    expect(within(lastSheet()).getByText('This folder’s .claude/settings.json starts sessions here in Plan (yours: Accept edits).')).toBeTruthy();
    fireEvent.click(within(lastSheet()).getByText('Plan'));
    await send('Fix the login test');
    // Nothing picked: the server starts it as Claude Code's settings say.
    await waitFor(() => expect(calls.created).toHaveLength(1));
    expect(calls.created[0]!.settings).toEqual({});
  });

  it('starts in a mode picked for it, and keeps a pick of Manual on a model without Auto', async () => {
    chat();
    await waitFor(() => expect(screen.getByLabelText('Permission mode').textContent).toBe('Auto'));
    fireEvent.click(screen.getByLabelText('Permission mode'));
    fireEvent.click(within(lastSheet()).getByText('Accept edits'));
    await send('One');
    await waitFor(() => expect(calls.created.at(-1)?.settings).toEqual({ permissionMode: 'acceptEdits' }));
    // The mode is the session's own: nothing of it is saved for new sessions.
    expect(claudeCode.saved).toEqual([]);
  });

  it('saves a model picked for it as Claude Code’s default too, as /model does', async () => {
    chat();
    await waitFor(() => expect(screen.getByLabelText('Permission mode').textContent).toBe('Auto'));
    fireEvent.click(screen.getByLabelText('Model, effort and speed'));
    expect(within(lastSheet()).getByText(/saved for new sessions too\. Max effort and Ultracode stay with this session\./)).toBeTruthy();
    fireEvent.click(within(lastSheet()).getByText('Haiku'));
    await waitFor(() => expect(claudeCode.saved).toEqual([{ change: { model: 'haiku' }, cwd: '/code/app' }]));
    // A model without Auto starts in Manual, which is no pick of its own.
    await waitFor(() => expect(screen.getByLabelText('Permission mode').textContent).toBe('Manual'));
    fireEvent.click(within(lastSheet()).getByText('Done'));
    await send('Two');
    await waitFor(() => expect(calls.created.at(-1)?.settings).toEqual({ model: 'haiku' }));
  });

  it('sends Default, picked where Claude Code’s settings give another model or effort, as Claude Code’s own: /model default and /effort auto', async () => {
    claudeCode.byFolder.set('/code/app', said({ model: { value: 'sonnet', source: 'project' }, effort: { byModel: { 'claude-sonnet-5-5': { level: 'low', source: 'project' } } } }));
    chat();
    await waitFor(() => expect(screen.getByLabelText('Model, effort and speed').textContent).toBe('SonnetLow'));
    fireEvent.click(screen.getByLabelText('Model, effort and speed'));
    fireEvent.click(within(lastSheet()).getByText('Default'));
    await waitFor(() => expect(screen.getByLabelText('Model, effort and speed').textContent).toBe('Sonnet'));
    fireEvent.click(within(lastSheet()).getByText('Done'));
    await send('Three');
    await waitFor(() => expect(calls.created.at(-1)?.settings).toEqual({ effort: OWN_EFFORT }));
    cleanup();
    chat();
    await waitFor(() => expect(screen.getByLabelText('Model, effort and speed').textContent).toBe('SonnetLow'));
    fireEvent.click(screen.getByLabelText('Model, effort and speed'));
    fireEvent.click(within(lastSheet()).getByText('Default (recommended)'));
    fireEvent.click(within(lastSheet()).getByText('Done'));
    await send('Four');
    await waitFor(() => expect(calls.created.at(-1)?.settings).toMatchObject({ model: 'default' }));
  });

  it('says plainly when Claude Code’s settings start it in Bypass', async () => {
    claudeCode.byFolder.set('/code/app', said({ permissionMode: { value: 'bypassPermissions', source: 'user' } }));
    chat();
    await waitFor(() => expect(screen.getByLabelText('Permission mode').textContent).toBe('Bypass'));
    fireEvent.click(screen.getByLabelText('Permission mode'));
    expect(within(lastSheet()).getByText(/start new sessions in Bypass permissions: Claude runs everything without asking/)).toBeTruthy();
  });
});

describe('a session’s own model sheet', () => {
  const SESSION = '22222222-2222-4333-8444-555555555555';
  const BRANCH = '99999999-2222-4333-8444-555555555555';
  const session = (props: Partial<Parameters<typeof Chat>[0]> = {}) => wrap(<Chat sessionId={SESSION} home="/home/me" machine="studio" wide onBack={() => {}} onOpen={() => {}} onStartIn={() => {}} {...props} />);

  it('saves a model, an effort or fast mode for new sessions, as /model, /effort and /fast do; Max and Ultracode stay with it', async () => {
    session();
    await waitFor(() => expect(screen.getByLabelText('Permission mode').textContent).toBe('Bypass'));
    fireEvent.click(screen.getByLabelText('Model, effort and speed'));
    const sheet = lastSheet();
    fireEvent.click(within(sheet).getByText('Max'));
    fireEvent.click(within(sheet).getByRole('switch', { name: /Ultracode/ }));
    await waitFor(() => expect(calls.applied).toHaveLength(2));
    expect(claudeCode.saved).toEqual([]);
    fireEvent.click(within(sheet).getByText('Low'));
    await waitFor(() => expect(claudeCode.saved).toEqual([{ change: { effort: { model: 'default', level: 'low' } }, cwd: '/code/app' }]));
    fireEvent.click(within(sheet).getByText('Sonnet'));
    await waitFor(() => expect(claudeCode.saved.at(-1)).toEqual({ change: { model: 'sonnet' }, cwd: '/code/app' }));
    // The session switches too, and keeps its mode.
    expect(calls.applied.at(-1)).toMatchObject({ model: 'sonnet', permissionMode: 'bypassPermissions' });
  });

  it('branches out of Bypass into the mode Claude Code’s settings start a new session in', async () => {
    claudeCode.byFolder.set('/code/app', said({ permissionMode: { value: 'plan', source: 'user' } }));
    const onOpen = vi.fn();
    session({ demo: true, onOpen });
    await waitFor(() => expect(screen.getByLabelText('Permission mode').textContent).toBe('Bypass'));
    fireEvent.click(sessionMenu());
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Fork/ }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(BRANCH));
    const choices = JSON.parse(localStorage.getItem('pelican:session-settings')!) as Record<string, { settings: RunSettings }>;
    expect(choices[BRANCH]!.settings.permissionMode).toBe('plan');
  });

  it('hands a /clear on to a new session, which starts as Claude Code’s settings start one', async () => {
    const onStartIn = vi.fn();
    session({ demo: true, onStartIn });
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
