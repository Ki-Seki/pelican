// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

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
});

const { ShortcutsSheet, showShortcuts } = await import('../src/web/components/Shortcuts');
const { closesPane } = await import('../src/web/lib/keyboard');

afterEach(() => {
  act(() => showShortcuts(false));
  cleanup();
});

/** Each row of the sheet as its name and its keys, and the headings between them. */
function rows(): string[] {
  render(<ShortcutsSheet />);
  act(() => showShortcuts(true));
  const sheet = document.querySelector('dialog[open]')!;
  const items = [...sheet.querySelectorAll('div')].filter((el) => el.querySelector('kbd') ? el.matches('.gap-3') : el.children.length === 0 && /^In /.test(el.textContent ?? ''));
  return items.map((row) => {
    const keys = [...row.querySelectorAll('kbd')].map((k) => k.textContent);
    return keys.length > 0 ? `${row.querySelector('span')!.textContent}: ${keys.join(' ')}` : `# ${row.textContent}`;
  });
}

describe('the keyboard shortcuts sheet', () => {
  it('lists the keys of the panes beside the conversation, as Claude Desktop has them, under the names the app gives them', () => {
    const listed = rows();
    // Off Apple keyboards (as here) the modifier is Ctrl; on them, ⌘.
    expect(listed).toEqual(expect.arrayContaining([
      'Transcript view: Ctrl O',
      'Changes and files: Ctrl Shift D',
      'Terminal: Ctrl `',
      'Side chat: Ctrl ;',
      'Close pane: Ctrl \\',
      'Send comments: Ctrl Enter',
    ]));
    // Sending the comments works in Changes and files, and says so.
    const heading = listed.indexOf('# In Changes and files');
    expect(heading).toBeGreaterThan(0);
    expect(listed[heading + 1]).toBe('Send comments: Ctrl Enter');
    expect(listed.some((row) => /view modes/.test(row))).toBe(false);
  });

  it('Close pane is Cmd/Ctrl+\\ and nothing else', () => {
    expect(closesPane({ key: '\\', metaKey: true })).toBe(true);
    expect(closesPane({ key: '\\', ctrlKey: true })).toBe(true);
    expect(closesPane({ key: '\\' })).toBe(false);
    expect(closesPane({ key: '|', metaKey: true, shiftKey: true })).toBe(false);
  });
});
