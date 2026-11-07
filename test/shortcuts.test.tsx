// @vitest-environment jsdom
import { act, cleanup, render, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

let coarse = false;
beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: query === '(pointer: coarse)' ? coarse : false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});

const { ShortcutsSheet, showShortcuts } = await import('../src/web/components/Shortcuts');
const { closesPane, KEY_IDS, keyWorks, KEYS } = await import('../src/web/lib/keyboard');

afterEach(() => {
  act(() => showShortcuts(false));
  cleanup();
  coarse = false;
});

/** The sheet as its parts, each with its rows as their names and keys ("Search sessions: Ctrl Shift K"). */
function parts(): Record<string, string[]> {
  render(<ShortcutsSheet />);
  act(() => showShortcuts(true));
  const sheet = document.querySelector('dialog[open]') as HTMLElement;
  expect(within(sheet).getByRole('heading', { name: 'Keyboard shortcuts' })).toBeTruthy();
  return Object.fromEntries([...sheet.querySelectorAll('section')].map((section) => [
    section.getAttribute('aria-label'),
    [...section.querySelectorAll('[data-key]')].map((row) => {
      const keys = [...row.querySelectorAll('kbd')].map((k) => k.textContent).join(' ');
      return `${row.firstElementChild!.textContent}: ${keys}`;
    }),
  ]));
}

describe('the keyboard shortcuts sheet', () => {
  it('lists Claude Desktop’s web keys by part, as the table has them, as this keyboard prints them', () => {
    // Off Apple keyboards (as here) the keys are Ctrl, Alt and Shift; on them, ⌃ ⌥ ⇧ ⌘.
    expect(parts()).toEqual({
      General: [
        'Command menu: Ctrl K',
        'Search sessions: Ctrl Shift K',
        'New session: Ctrl Shift O',
        'Settings: Ctrl Shift ,',
        'Keyboard shortcuts: Ctrl /',
        'Show or hide the sidebar: Ctrl B',
        'Close a menu or sheet: Esc',
      ],
      'This session': ['Rename: Ctrl Alt R', 'Fork: Ctrl Alt O', 'Archive: Ctrl Alt A', 'Side chat: Ctrl ;', 'Transcript view: Ctrl O'],
      Panes: ['Changes: Ctrl Shift D', 'Files: Ctrl Shift F', 'Terminal: Ctrl `', 'New terminal: Ctrl Shift `', 'Close pane: Ctrl \\'],
      'Message box': [
        'Send: Enter Ctrl Enter',
        'New line: Shift Enter',
        'Add files or photos: Ctrl U',
        'Model: Ctrl Shift I',
        'Effort: Ctrl Shift E',
        'Fast mode: Ctrl Alt F',
        'Mode: Ctrl Alt M',
        'Stop: Esc',
        'Commands: /',
        'Files and agents: @',
        'Shell command: !',
      ],
      'Quotes and comments': [
        'Quote, with the pill showing: Enter',
        'Quote without a note: Ctrl Shift L',
        'Note box: add: Enter',
        'Note box: send now: Ctrl Enter',
        'Changes: send all comments: Ctrl Enter',
        'Comment box: add comment: Enter',
        'Comment box: send to Claude: Ctrl Enter',
      ],
    });
  });

  it('names only keys that work: those of parts still to come wait for them', () => {
    const listed = Object.values(parts()).flat().map((row) => row.slice(0, row.lastIndexOf(':')));
    for (const id of KEY_IDS) {
      const { label } = KEYS[id];
      if (!keyWorks(id)) expect(listed, label).not.toContain(label);
    }
    // Still to come: Queue for later (the next part of 0.5.0's message box), Background tasks, picking an answer by its number.
    expect(listed).not.toContain('Queue for later, while Claude works');
    expect(listed).not.toContain('Background tasks');
    expect(listed).not.toContain('Pick an answer');
    // The browser's own (Copy, Paste) are shown in menus, not here.
    expect(listed).not.toContain('Copy');
  });

  it('says Send and New line as the Enter key setting has them, and the note box’s Add only where Enter adds', () => {
    // Auto: a touch screen's Enter starts a new line.
    coarse = true;
    const all = parts();
    expect(all['Message box']).toContain('Send: Ctrl Enter');
    expect(all['Message box']).toContain('New line: Enter');
    // Enter starts a new line in a note too: no key adds it.
    expect(all['Quotes and comments']!.some((row) => row.startsWith('Note box: add'))).toBe(false);
    expect(all['Quotes and comments']!.some((row) => row.startsWith('Comment box: add comment'))).toBe(false);
    expect(all['Quotes and comments']).toContain('Note box: send now: Ctrl Enter');
  });

  it('closes with its button, and Esc is the dialog’s own', () => {
    parts();
    const sheet = document.querySelector('dialog[open]') as HTMLElement;
    act(() => within(sheet).getByRole('button', { name: 'Close' }).click());
    expect(document.querySelector('dialog[data-closing]')).not.toBeNull();
  });

  it('Close pane is Cmd/Ctrl+\\ and nothing else', () => {
    expect(closesPane({ key: '\\', metaKey: true })).toBe(true);
    expect(closesPane({ key: '\\', ctrlKey: true })).toBe(true);
    expect(closesPane({ key: '\\' })).toBe(false);
    expect(closesPane({ key: '|', metaKey: true, shiftKey: true })).toBe(false);
  });
});
