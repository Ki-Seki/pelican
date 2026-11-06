// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { entries, PATH_ACTIONS, type PathTarget, SESSION_ACTIONS, type SessionTarget } from '../src/web/lib/actions';

let pointer = true;
beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: query === '(hover: hover) and (pointer: fine)' ? pointer : false,
    media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});

const { ActionMenu, place } = await import('../src/web/components/ActionMenu');

afterEach(() => {
  cleanup();
  pointer = true;
});

const noop = () => {};
const session = (extra: Partial<SessionTarget> = {}): SessionTarget => ({
  title: 'Add a dark theme to the settings page', archived: false, pinned: false, from: 'title',
  resume: 'claude --resume 7f3c2a10-0000-4000-8000-000000000001',
  rename: noop, pin: noop, sideChat: noop, fork: noop, export: noop, archive: noop, remove: noop, ...extra,
});

/** A button that opens a list, as a way in does, and the list. */
function Harness({ list, as, keys, footer, lift }: {
  list: Parameters<typeof ActionMenu>[0]['entries'];
  as?: 'menu' | 'sheet';
  keys?: boolean;
  footer?: string;
  lift?: Element;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>More</button>
      <ActionMenu
        open={open}
        onClose={() => setOpen(false)}
        label="Session"
        title="Add a dark theme to the settings page"
        entries={list}
        {...(as ? { as } : {})}
        {...(keys === undefined ? {} : { keys })}
        {...(footer ? { footer } : {})}
        {...(lift ? { lift } : {})}
        at={{ x: 200, y: 120 }}
      />
    </>
  );
}

const openIt = () => {
  const button = screen.getByRole('button', { name: 'More' });
  button.focus();
  act(() => button.click());
  return button;
};
const theMenu = () => screen.getByRole('menu', { name: 'Session' });
const rows = () => within(theMenu()).getAllByRole('menuitem');

describe('a list of actions on a computer', () => {
  it('is a menu where the pointer is, its parts apart, the keys that work faint beside their actions', () => {
    render(<Harness list={entries(SESSION_ACTIONS, session(), 'menu', 'pointer')} />);
    openIt();
    expect(rows().map((row) => row.textContent)).toEqual([
      'Rename', 'Pin', 'Side chatCtrl+;', 'Fork', 'Copy resume command', 'Export', 'Archive', 'Delete',
    ]);
    // A rule between Pin and Side chat, Export and Archive.
    expect(theMenu().querySelectorAll('.h-px')).toHaveLength(2);
    expect(within(theMenu()).getByText('Delete').closest('button')!.className).toContain('text-danger');
  });

  it('shows no keys for a list row’s menu, which may be another session’s', () => {
    render(<Harness list={entries(SESSION_ACTIONS, session({ from: 'row' }), 'menu', 'pointer')} keys={false} />);
    openIt();
    expect(rows().map((row) => row.textContent)).toContain('Side chat');
  });

  it('does what is picked once it has gone, with focus back on what opened it', () => {
    // What the page is like when the action runs: by then the menu is gone, focus back.
    let seen: { dialog: boolean; focus: Element | null } | undefined;
    const rename = vi.fn(() => {
      seen = { dialog: Boolean(document.querySelector('dialog')), focus: document.activeElement };
    });
    render(<Harness list={entries(SESSION_ACTIONS, session({ rename }), 'menu', 'pointer')} />);
    const opener = openIt();
    act(() => within(theMenu()).getByRole('menuitem', { name: 'Rename' }).click());
    expect(rename).toHaveBeenCalledOnce();
    expect(seen).toEqual({ dialog: false, focus: opener });
    expect(screen.queryByRole('menu')).toBeNull();
    // It opens again as before.
    openIt();
    expect(theMenu()).toBeTruthy();
  });

  it('closes on a click or a right-click outside it, and on Esc', () => {
    render(<Harness list={entries(SESSION_ACTIONS, session(), 'menu', 'pointer')} />);
    openIt();
    const outside = document.querySelector('dialog > .absolute') as HTMLElement;
    act(() => fireEvent.contextMenu(outside));
    expect(document.querySelector('dialog[data-closing]')).not.toBeNull();
    cleanup();
    render(<Harness list={entries(SESSION_ACTIONS, session(), 'menu', 'pointer')} />);
    openIt();
    act(() => {
      document.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }));
    });
    expect(document.querySelector('dialog[data-closing]')).not.toBeNull();
  });

  it('moves with the arrows, Home and End, and a letter', () => {
    render(<Harness list={entries(SESSION_ACTIONS, session(), 'menu', 'pointer')} />);
    openIt();
    const menu = theMenu();
    // Opened by the pointer, the menu itself has focus: nothing looks picked yet.
    expect(document.activeElement).toBe(menu);
    const key = (k: string) => act(() => fireEvent.keyDown(document.activeElement!, { key: k }));
    key('ArrowDown');
    expect(document.activeElement!.textContent).toBe('Rename');
    key('ArrowUp');
    expect(document.activeElement!.textContent).toBe('Delete');
    key('Home');
    expect(document.activeElement!.textContent).toBe('Rename');
    key('e');
    expect(document.activeElement!.textContent).toBe('Export');
    key('End');
    expect(document.activeElement!.textContent).toBe('Delete');
  });

  it('opens a list one level down beside its row: by the pointer, a click, or →, and ← goes back', () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const target: PathTarget = { path: 'src/styles/theme.css', cwd: '/code/acme-web', attach: noop, openInFiles: noop, download: noop };
    render(<Harness list={entries(PATH_ACTIONS, target, 'menu', 'pointer')} />);
    openIt();
    const copy = within(theMenu()).getByRole('menuitem', { name: 'Copy' });
    expect(copy.getAttribute('aria-haspopup')).toBe('menu');
    act(() => copy.focus());
    act(() => fireEvent.keyDown(copy, { key: 'ArrowRight' }));
    const sub = screen.getByRole('menu', { name: 'Copy' });
    expect(within(sub).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Absolute path', 'Relative path', 'Filename']);
    expect(document.activeElement!.textContent).toBe('Absolute path');
    act(() => fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' }));
    expect(screen.queryByRole('menu', { name: 'Copy' })).toBeNull();
    expect(document.activeElement).toBe(copy);
    act(() => copy.click());
    act(() => within(screen.getByRole('menu', { name: 'Copy' })).getByRole('menuitem', { name: 'Relative path' }).click());
    expect(writeText).toHaveBeenCalledWith('src/styles/theme.css');
    expect(screen.queryByRole('menu')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('keeps a choice in place: picking one changes it and the menu stays', () => {
    const choose = vi.fn();
    const view = { value: 'normal', options: [{ value: 'normal', label: 'Normal' }, { value: 'verbose', label: 'Verbose' }], choose };
    render(<Harness list={entries(SESSION_ACTIONS, session({ view }), 'menu', 'pointer')} footer="Started 10:41 AM · ID a3f1c2d4" />);
    openIt();
    const group = within(theMenu()).getByRole('group', { name: 'Transcript view' });
    expect(within(group).getByRole('menuitemradio', { name: 'Normal' }).getAttribute('aria-checked')).toBe('true');
    act(() => within(group).getByRole('menuitemradio', { name: 'Verbose' }).click());
    expect(choose).toHaveBeenCalledWith('verbose');
    expect(theMenu()).toBeTruthy();
    // The transcript view's own key, which works, is beside it.
    expect(within(theMenu()).getByText('Ctrl+O')).toBeTruthy();
    expect(within(theMenu()).getByText('Started 10:41 AM · ID a3f1c2d4')).toBeTruthy();
  });
});

describe('a list of actions on a phone', () => {
  it('is a sheet with its title, rows a finger can hit, no rules and no keys', () => {
    pointer = false;
    render(<Harness list={entries(SESSION_ACTIONS, session(), 'menu', 'touch')} />);
    openIt();
    const sheet = document.querySelector('dialog[open]') as HTMLElement;
    expect(within(sheet).getByRole('heading', { name: 'Add a dark theme to the settings page' })).toBeTruthy();
    expect(rows().map((row) => row.textContent)).toEqual(['Rename', 'Pin', 'Side chat', 'Fork', 'Copy resume command', 'Export', 'Archive', 'Delete']);
    expect(rows().every((row) => row.className.includes('min-h-12'))).toBe(true);
    expect(theMenu().querySelectorAll('.h-px')).toHaveLength(0);
    expect(within(sheet).queryByText('Ctrl+;')).toBeNull();
  });

  it('opens a list one level down in place, under its row', () => {
    pointer = false;
    render(<Harness list={entries(PATH_ACTIONS, { path: 'src/a.ts', cwd: '/code/app', attach: noop }, 'menu', 'touch')} />);
    openIt();
    const copy = within(theMenu()).getByRole('menuitem', { name: 'Copy' });
    expect(screen.queryByRole('menuitem', { name: 'Filename' })).toBeNull();
    act(() => copy.click());
    expect(copy.getAttribute('aria-expanded')).toBe('true');
    expect(within(screen.getByRole('menu', { name: 'Copy' })).getAllByRole('menuitem').map((row) => row.textContent)).toEqual(['Absolute path', 'Relative path', 'Filename']);
  });

  it('raises what a long press opened it for over the dim, a copy that takes no taps', () => {
    pointer = false;
    const bubble = document.createElement('div');
    bubble.id = 'prompt-1';
    bubble.className = 'rounded-2xl bg-chip';
    bubble.innerHTML = '<span id="inner">Now remember the choice</span>';
    document.body.append(bubble);
    render(<Harness list={entries(SESSION_ACTIONS, session(), 'menu', 'touch')} lift={bubble} />);
    openIt();
    const raised = document.querySelector('dialog [aria-hidden="true"][inert]') as HTMLElement;
    expect(raised.textContent).toBe('Now remember the choice');
    expect(raised.querySelector('[id]')).toBeNull();
    expect(document.querySelectorAll('#prompt-1')).toHaveLength(1);
    bubble.remove();
  });
});

describe('where a menu opens', () => {
  it('at the pointer, turned back from the window’s right and bottom edges', () => {
    // jsdom's window is 1024 × 768.
    expect(place({ x: 200, y: 120 }, 256, 300)).toEqual({ left: 200, top: 120 });
    expect(place({ x: 1000, y: 700 }, 256, 300)).toEqual({ left: 744, top: 400 });
    // Taller than the room above and below: as high as it fits.
    expect(place({ x: 10, y: 600 }, 256, 760)).toEqual({ left: 10, top: 8 });
  });

  it('under its button, or above it where there is no room below, never past an edge', () => {
    const button = document.createElement('button');
    document.body.append(button);
    button.getBoundingClientRect = () => ({ left: 900, right: 940, top: 40, bottom: 72, width: 40, height: 32, x: 900, y: 40, toJSON() {} });
    expect(place(button, 256, 300)).toEqual({ left: 684, top: 76 });
    button.getBoundingClientRect = () => ({ left: 100, right: 140, top: 700, bottom: 732, width: 40, height: 32, x: 100, y: 700, toJSON() {} });
    expect(place(button, 256, 300)).toEqual({ left: 100, top: 396 });
    button.remove();
    // Gone from the page: near the top, in the middle.
    expect(place(button, 256, 300)).toEqual({ left: 384, top: 96 });
  });
});
