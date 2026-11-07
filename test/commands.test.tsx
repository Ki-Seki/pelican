// @vitest-environment jsdom
// One list of everything done by name, the same behind the message box's / and ⌘K's command menu.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Command, SessionSummary } from '../src/shared/protocol';
import { type CommandItem, commandFor, commandList, filtered, forgetCommands, registered } from '../src/web/lib/commands';

const claude: Command[] = [
  { name: 'compact', description: 'Clear history but keep a summary in context', argumentHint: '', builtin: true },
  { name: 'fork', description: 'Copy this conversation into a new background session and keep working here', argumentHint: '', builtin: true },
  { name: 'context', description: 'Show how full the context window is', argumentHint: '', builtin: true },
  { name: 'export', description: 'Export notes to the wiki (project)', argumentHint: '' },
  { name: 'ship', description: 'Run the checks, then open a pull request (project)', argumentHint: '[base]' },
];

const item = (extra: Partial<CommandItem> & Pick<CommandItem, 'id' | 'label'>): CommandItem => ({ group: 'session', run: () => {}, ...extra });
const ours: CommandItem[] = [
  item({ id: 'side-chat', label: 'Side chat', name: 'btw', description: 'Ask in side chat', needsWords: true }),
  item({ id: 'fork', label: 'Fork', name: 'branch', description: 'Fork from here · new session' }),
  item({ id: 'rename', label: 'Rename', name: 'rename', description: 'Rename this session' }),
  item({ id: 'export', label: 'Export', name: 'export', description: 'Export' }),
  item({ id: 'context', label: 'Context', name: 'context', description: 'Context · 31%' }),
  item({ id: 'pin', group: 'pelican', label: 'Pin' }),
  item({ id: 'new-session', group: 'pelican', label: 'New session', name: 'new', aliases: ['clear', 'reset'] }),
  item({ id: 'shortcuts', group: 'pelican', label: 'Keyboard shortcuts', only: 'pointer' }),
];
const names = (list: CommandItem[]) => list.map((i) => (i.name ? `/${i.name}` : i.label));

afterEach(() => {
  cleanup();
  forgetCommands();
});

describe('the list', () => {
  it('has this session’s actions by Claude Code’s names, then Pelican’s, then Claude Code’s commands and skills', () => {
    const list = commandList(ours, claude, 'pointer');
    expect(list.map((i) => i.group)).toEqual(['session', 'session', 'session', 'session', 'session', 'pelican', 'pelican', 'pelican', 'claude', 'claude', 'claude', 'claude']);
    expect(names(list)).toEqual(['/btw', '/branch', '/rename', 'Export', '/context', 'Pin', '/new', 'Keyboard shortcuts', '/compact', '/fork', '/export', '/ship']);
  });

  it('gives a name of yours to your own command: Pelican’s Export stays, by its label, without the /', () => {
    const list = commandList(ours, claude, 'pointer');
    const exports = list.filter((i) => i.label === 'Export' || i.name === 'export');
    expect(exports.map((i) => [i.group, i.name])).toEqual([['session', undefined], ['claude', 'export']]);
    // Typed, /export goes to Claude Code, as yours.
    expect(commandFor('/export', list)).toBeUndefined();
  });

  it('lists one of Claude Code’s own that Pelican does its way once, as Pelican’s', () => {
    const list = commandList(ours, claude, 'pointer');
    expect(list.filter((i) => i.name === 'context').map((i) => i.group)).toEqual(['session']);
    // /fork stays Claude Code's: Pelican's Fork is /branch, as in the CLI.
    expect(list.filter((i) => i.name === 'fork').map((i) => i.group)).toEqual(['claude']);
  });

  it('leaves out on a phone what needs a keyboard', () => {
    expect(names(commandList(ours, [], 'touch'))).not.toContain('Keyboard shortcuts');
  });

  it('finds what was typed after the / by name, a name it also has, or the words of its label', () => {
    const list = commandList(ours, claude, 'pointer');
    expect(names(filtered(list, 're'))).toEqual(['/rename', '/new']);
    expect(names(filtered(list, 'pi'))).toEqual(['Pin']);
    expect(names(filtered(list, 'sh'))).toEqual(['Keyboard shortcuts', '/ship']);
    expect(names(filtered(list, '/co'))).toEqual(['/context', '/compact']);
  });

  it('reads a command typed whole, its words after it, and only Pelican’s', () => {
    const list = commandList(ours, claude, 'pointer');
    expect(commandFor('/rename Faster exports', list)).toMatchObject({ item: { id: 'rename' }, words: 'Faster exports' });
    expect(commandFor('/clear', list)).toMatchObject({ item: { id: 'new-session' }, words: '' });
    expect(commandFor('/compact keep the plan', list)).toBeUndefined();
    expect(commandFor('Rename it', list)).toBeUndefined();
  });
});

describe('the parts of the list', () => {
  it('put the open chat’s first, in place of the page’s by the same id', async () => {
    const { useCommandPart } = await import('../src/web/lib/commands');
    const page = [item({ id: 'new-session', group: 'pelican', label: 'New session' }), item({ id: 'settings', group: 'pelican', label: 'Settings', name: 'config' })];
    const chat = [item({ id: 'pin', group: 'pelican', label: 'Pin' }), item({ id: 'new-session', group: 'pelican', label: 'New session', name: 'new' })];
    function Parts() {
      useCommandPart('page', page);
      useCommandPart('chat', chat);
      return null;
    }
    render(<Parts />);
    expect(registered().map((i) => `${i.label}${i.name ? ` /${i.name}` : ''}`)).toEqual(['Pin', 'New session /new', 'Settings /config']);
  });
});

describe('the command menu (⌘K)', () => {
  beforeAll(() => {
    window.matchMedia = ((query: string) => ({
      matches: query === '(hover: hover) and (pointer: fine)', media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
  });

  const sessions: SessionSummary[] = [
    { id: 's1', title: 'Fix the flaky login test', cwd: '/code/app', project: 'app', lastActivity: Date.now(), status: 'idle' },
    { id: 's2', title: 'Release notes for v2.4', cwd: '/code/docs', project: 'docs', lastActivity: Date.now(), status: 'idle' },
  ];

  async function menu() {
    const { api } = await import('../src/web/lib/api');
    vi.spyOn(api, 'completions').mockResolvedValue({ commands: claude, agents: [] });
    const { CommandMenu, showCommandMenu } = await import('../src/web/components/CommandMenu');
    const { useCommandContext, useCommandPart } = await import('../src/web/lib/commands');
    const rename = vi.fn();
    const putInBox = vi.fn();
    const onOpenSession = vi.fn();
    const list = [item({ id: 'rename', label: 'Rename', name: 'rename', key: 'rename', run: rename }), item({ id: 'pin', group: 'pelican', label: 'Pin' })];
    const context = { cwd: '/code/app', putInBox };
    function Page() {
      useCommandPart('chat', list);
      useCommandContext(context);
      return <CommandMenu sessions={sessions} onOpenSession={onOpenSession} />;
    }
    render(<QueryClientProvider client={new QueryClient()}><Page /></QueryClientProvider>);
    act(() => showCommandMenu(true));
    const dialog = await screen.findByRole('dialog', { name: 'Command menu' });
    return { dialog, rename, putInBox, onOpenSession, field: within(dialog).getByRole('combobox', { name: 'Type a command or search' }), showCommandMenu };
  }

  it('shows the whole list by part, with each one’s key and Claude Code name, the field taking the keys', async () => {
    const { dialog, field, showCommandMenu } = await menu();
    expect(document.activeElement).toBe(field);
    await within(dialog).findByText('/ship');
    const options = within(dialog).getAllByRole('option').map((o) => o.textContent);
    expect(options.slice(0, 2)).toEqual(['Rename/renameCtrl+Alt+R', 'Pin']);
    expect(options).toContain('/compactClear history but keep a summary in context');
    act(() => showCommandMenu(false));
  });

  it('does one of Pelican’s at once, gone first; one of Claude Code’s goes in the message box for its words', async () => {
    const { dialog, field, rename, putInBox } = await menu();
    fireEvent.change(field, { target: { value: 'ren' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(rename).toHaveBeenCalledWith('');
    expect(document.querySelector('dialog[open]:not([data-closing])')).toBeNull();
    const { showCommandMenu } = await import('../src/web/components/CommandMenu');
    act(() => showCommandMenu(true));
    const again = await screen.findByRole('dialog', { name: 'Command menu' });
    await within(again).findByText('/ship');
    fireEvent.change(within(again).getByRole('combobox'), { target: { value: 'ship' } });
    fireEvent.keyDown(within(again).getByRole('combobox'), { key: 'Enter' });
    expect(putInBox).toHaveBeenCalledWith('/ship ');
    expect(dialog).toBeTruthy();
  });

  it('finds a session by its name too, and opens it', async () => {
    const { dialog, field, onOpenSession } = await menu();
    fireEvent.change(field, { target: { value: 'release' } });
    const found = within(dialog).getByRole('option', { name: /Release notes for v2\.4/ });
    expect(within(dialog).getByText('Sessions')).toBeTruthy();
    fireEvent.click(found);
    expect(onOpenSession).toHaveBeenCalledWith('s2');
  });

  it('moves with the arrows', async () => {
    const { dialog, field } = await menu();
    await within(dialog).findByText('/ship');
    const selected = () => within(dialog).getAllByRole('option').find((o) => o.getAttribute('aria-selected') === 'true')?.textContent;
    expect(selected()).toBe('Rename/renameCtrl+Alt+R');
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    expect(selected()).toBe('Pin');
    fireEvent.keyDown(field, { key: 'ArrowUp' });
    fireEvent.keyDown(field, { key: 'ArrowUp' });
    expect(selected()).toMatch(/^\/ship/);
  });
});
