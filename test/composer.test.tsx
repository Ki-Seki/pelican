// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Attachment } from '../src/shared/protocol';

/** The media queries that match: none (a touch screen as far as hover goes, Enter sending), or a computer's. */
let media: Record<string, boolean> = {};
const COMPUTER = '(hover: hover) and (pointer: fine)';
beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: Boolean(media[query]), media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  // jsdom has the element, not its modal behaviour.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    setTimeout(() => this.dispatchEvent(new Event('close')), 0);
  };
});

const { Composer } = await import('../src/web/components/Composer');
const { setPrefs } = await import('../src/web/lib/prefs');
const { addWaiting, loadDraft, saveDraft, waitingOf } = await import('../src/web/lib/drafts');
const { fileItem, quoteItem } = await import('../src/web/lib/quote');
type WaitingItem = import('../src/web/lib/quote').WaitingItem;

const quote = (text: string, note?: string): WaitingItem => quoteItem(text, { what: 'reply' }, note ? { note } : {})!;
const comment = (note: string): WaitingItem => ({ id: `c-${note}`, kind: 'comment', text: '  --surface: #fff;', note, path: 'src/styles/theme.css', lines: [12, 12], side: 'add', from: { what: 'diff' } });

function renderComposer(draftKey = 'chat', extra: { onSideChat?: (question: string) => void; side?: boolean; draft?: { text: string; key: number } } = {}) {
  const onSend = vi.fn();
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <Composer busy={false} settings={{}} onSettings={() => {}} models={[]} onSend={onSend} onStop={() => {}} draftKey={draftKey} {...extra} />
    </QueryClientProvider>,
  );
  return { onSend, box: screen.getByLabelText(extra.side ? 'Side question' : 'Message Claude') as HTMLTextAreaElement, unmount: view.unmount, rerender: view.rerender };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  setPrefs({ enterToSend: 'auto' });
  media = {};
});

describe('the message box', () => {
  it('does not send the Enter that picks an input method candidate, Safari’s included', () => {
    const { onSend, box } = renderComposer();
    fireEvent.change(box, { target: { value: '你好' } });
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 229 });
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 13, isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 13 });
    expect(onSend).toHaveBeenCalledWith('你好', [], 'steer');
  });

  it('sends on ⌘/Ctrl+Enter when Enter makes a new line', () => {
    setPrefs({ enterToSend: 'never' });
    const { onSend, box } = renderComposer();
    fireEvent.change(box, { target: { value: 'hello' } });
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 13 });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 13, ctrlKey: true });
    expect(onSend).toHaveBeenCalledWith('hello', [], 'steer');
  });

  it('keeps a half-written message for its chat, until it is sent', () => {
    vi.useFakeTimers();
    try {
      const first = renderComposer('s1');
      fireEvent.change(first.box, { target: { value: 'Also add a section on the migration steps, with' } });
      first.unmount();
      expect(loadDraft('s1')?.text).toBe('Also add a section on the migration steps, with');

      const again = renderComposer('s1');
      expect(again.box.value).toBe('Also add a section on the migration steps, with');
      fireEvent.keyDown(again.box, { key: 'Enter', keyCode: 13 });
      act(() => {
        vi.runAllTimers();
      });
      // Sent, but not yet through: the draft stays until the chat says it went (clearDraft).
      expect(again.onSend).toHaveBeenCalled();
      expect(again.box.value).toBe('');
      expect(loadDraft('s1')?.text).toBe('Also add a section on the migration steps, with');
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends a / command with its words alone: the files wait for the next message', () => {
    saveDraft('s3', '/compact', [{ id: 'up3', name: 'export.log', mime: 'text/plain', size: 2048, path: '/tmp/up3' }]);
    const { box, onSend } = renderComposer('s3');
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 13 });
    expect(onSend).toHaveBeenLastCalledWith('/compact', [], 'steer');
    expect(screen.getByText('export.log')).toBeTruthy();
    fireEvent.change(box, { target: { value: 'Now read this' } });
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 13 });
    expect(onSend).toHaveBeenLastCalledWith('Now read this', [expect.objectContaining({ id: 'up3' })], 'steer');
  });

  it('brings back the files of a draft', () => {
    saveDraft('s2', 'look', [{ id: 'up1', name: 'shot.png', mime: 'image/png', size: 2048, path: '/tmp/up1' }]);
    const { box, onSend } = renderComposer('s2');
    expect(screen.getByAltText('shot.png').getAttribute('src')).toContain('api/uploads/up1');
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 13 });
    expect(onSend).toHaveBeenCalledWith('look', [expect.objectContaining({ id: 'up1' })], 'steer');
  });
});

describe('what waits above the message box', () => {
  const chips = () => screen.queryByRole('list', { name: 'With your next message' });
  const frame = () => act(() => new Promise((resolve) => requestAnimationFrame(resolve)));

  it('shows four kinds, told apart: a quote in quotation marks, a quote with a note as its note, a comment where it is, a file by name', () => {
    media[COMPUTER] = true;
    renderComposer('w1');
    act(() => {
      addWaiting('w1', quote('All 14 theme tests pass.'));
      addWaiting('w1', quote('It follows the system until you pick one.', 'Also while the page is open'));
      addWaiting('w1', comment('Keep --surface'));
      addWaiting('w1', fileItem('src/settings/prefs.ts'));
    });
    const items = [...chips()!.querySelectorAll('li')];
    expect(items.map((li) => li.textContent)).toEqual([
      '“All 14 theme tests pass.”',
      '“It follows the system until you pick one.”Also while the page is open',
      'theme.css:12Keep --surface',
      'prefs.ts',
    ]);
    // Each says what it is to a screen reader, and on a computer has a × of its own.
    expect(screen.getByRole('button', { name: 'Quote “All 14 theme tests pass.”' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Your note on “It follows the system until you pick one.”: Also while the page is open' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Comment on theme.css:12: Keep --surface' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'File src/settings/prefs.ts' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(4);
    // The note reads as words, the passage before it quietly.
    const reply = items[1]!.querySelectorAll('span');
    expect(reply[0]!.className).toContain('text-faint');
    expect(reply[1]!.className).toContain('text-fg');
    // Tabbed to, a chip says it has the keys with a ring around it (its × with the browser's own).
    expect(items[1]!.className).toContain('has-[>button:first-child:focus-visible]:ring-2');
    expect(items[1]!.className).toContain('has-[>button:first-child:focus-visible]:ring-faint');
  });

  it('on a phone are a finger tall and have no ×: Remove is in what a tap opens', async () => {
    // There before the box opened: a chip, not the card a quote just taken gets.
    addWaiting('w2', quote('All 14 theme tests pass.'));
    renderComposer('w2');
    const chip = screen.getByRole('button', { name: 'Quote “All 14 theme tests pass.”' });
    expect(chip.className).toContain('h-11');
    expect(screen.queryAllByRole('button', { name: /^Remove / })).toEqual([]);
    fireEvent.click(chip);
    const sheet = screen.getByRole('dialog', { name: 'Quote from Claude’s reply' });
    expect(within(sheet).getByText('All 14 theme tests pass.')).toBeTruthy();
    fireEvent.change(within(sheet).getByLabelText('Your note'), { target: { value: 'Which ones?' } });
    expect(waitingOf('w2')[0]!.note).toBe('Which ones?');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Remove' }));
    // Once the sheet has played its way out.
    await waitFor(() => expect(waitingOf('w2')).toEqual([]));
    expect(chips()).toBeNull();
  });

  it('opened on a computer: the whole passage and its note, changed as it is typed; Done or Esc closes it', () => {
    media[COMPUTER] = true;
    renderComposer('w3');
    act(() => {
      addWaiting('w3', quote('It follows the system until you pick one.', 'Also follow it'));
    });
    fireEvent.click(screen.getByRole('button', { name: /^Your note on/ }));
    const editor = screen.getByRole('dialog', { name: /^Quote from Claude’s reply/ });
    const note = within(editor).getByLabelText('Your note') as HTMLTextAreaElement;
    expect(document.activeElement).toBe(note);
    fireEvent.change(note, { target: { value: 'Also follow it while the page is open' } });
    expect(waitingOf('w3')[0]!.note).toBe('Also follow it while the page is open');
    fireEvent.keyDown(note, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    // Emptied, a quote's note is gone and it is a plain quote again.
    fireEvent.click(screen.getByRole('button', { name: /^Your note on/ }));
    fireEvent.change(screen.getByLabelText('Your note'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(waitingOf('w3')[0]!.note).toBeUndefined();
    expect(screen.getByRole('button', { name: 'Quote “It follows the system until you pick one.”' })).toBeTruthy();
  });

  it('closed from inside on a computer, give the keys back to the chip they were opened from, or to the box once it has gone', async () => {
    media[COMPUTER] = true;
    const { box } = renderComposer('w10');
    act(() => {
      addWaiting('w10', quote('first one', 'a note'));
      addWaiting('w10', quote('second one'));
    });
    const chip = () => screen.getByRole('button', { name: /^Your note on “first one”/ });
    const note = () => screen.getByLabelText('Your note');
    for (const close of [
      () => fireEvent.keyDown(note(), { key: 'Escape' }),
      () => fireEvent.keyDown(note(), { key: 'Enter', metaKey: true }),
      () => fireEvent.click(screen.getByRole('button', { name: 'Done' })),
    ]) {
      fireEvent.click(chip());
      expect(document.activeElement).toBe(note());
      close();
      await frame();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(chip());
    }
    // A click elsewhere takes the keys where it was.
    fireEvent.click(chip());
    box.focus();
    fireEvent.pointerDown(box);
    await frame();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(box);
    // Removed from its editor, the next chip has them.
    fireEvent.click(chip());
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await frame();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Quote “second one”' }));
  });

  it('a comment keeps what it said when its note is emptied', () => {
    media[COMPUTER] = true;
    renderComposer('w4');
    act(() => {
      addWaiting('w4', comment('Keep --surface'));
    });
    fireEvent.click(screen.getByRole('button', { name: /^Comment on theme.css:12/ }));
    fireEvent.change(screen.getByLabelText('Your note'), { target: { value: ' ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(waitingOf('w4')[0]!.note).toBe('Keep --surface');
  });

  it('removed with the keys, give them to the next chip, or to the message box once none is left', async () => {
    media[COMPUTER] = true;
    const { box } = renderComposer('w5');
    act(() => {
      addWaiting('w5', quote('first one'));
      addWaiting('w5', quote('second one'));
    });
    const remove = (label: string) => screen.getByRole('button', { name: `Remove the quote ${label}` });
    remove('first one').focus();
    // Enter or Space on a button clicks it with no pointer behind the click.
    fireEvent.click(remove('first one'), { detail: 0 });
    await frame();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Quote “second one”' }));
    fireEvent.click(remove('second one'), { detail: 0 });
    await frame();
    expect(chips()).toBeNull();
    expect(document.activeElement).toBe(box);
  });

  it('on a phone, the quote just taken waits as a card that leaves the keyboard down, with Add a note to bring it up', async () => {
    const { box } = renderComposer('w6');
    act(() => {
      addWaiting('w6', quote('All 14 theme tests pass.'));
    });
    await frame();
    // Not the card: it was there before this quote came.
    act(() => {
      addWaiting('w6', quote('one more set of values'));
    });
    await frame();
    expect(document.activeElement).not.toBe(box);
    expect(screen.getByRole('button', { name: 'Quote “All 14 theme tests pass.”' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Quote “one more set of values”' })).toBeNull();
    expect(screen.getByText('one more set of values')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add a note' }));
    await frame();
    const note = screen.getByLabelText('Your note');
    expect(document.activeElement).toBe(note);
    fireEvent.change(note, { target: { value: 'Use the --bg and --fg names we have' } });
    expect(waitingOf('w6')[1]!.note).toBe('Use the --bg and --fg names we have');
    // Its × lets it go, a finger's width.
    const remove = screen.getByRole('button', { name: 'Remove the quote one more set of values' });
    expect(remove.className).toContain('size-11');
    fireEvent.click(remove);
    expect(waitingOf('w6').map((item) => item.text)).toEqual(['All 14 theme tests pass.']);
  });

  it('on a computer, take the keys to the message box as a quote comes, to say what about it', async () => {
    media[COMPUTER] = true;
    const { box } = renderComposer('w7');
    act(() => {
      addWaiting('w7', quote('one more set of values'));
    });
    await frame();
    expect(document.activeElement).toBe(box);
    expect(screen.queryByRole('button', { name: 'Add a note' })).toBeNull();
  });

  it('wait for the next message when a / command goes, which has to start its own', () => {
    const { onSend, box } = renderComposer('w8');
    act(() => {
      addWaiting('w8', quote('keep me here'));
    });
    fireEvent.change(box, { target: { value: '/compact focus on the export' } });
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 13 });
    expect(onSend).toHaveBeenCalledWith('/compact focus on the export', [], 'steer');
    expect(waitingOf('w8')).toHaveLength(1);
  });

  it('can be sent alone, and are kept with the draft', () => {
    vi.useFakeTimers();
    try {
      media[COMPUTER] = true;
      const first = renderComposer('w9');
      act(() => {
        addWaiting('w9', quote('The settings page already reads them.', 'So why a context?'));
      });
      first.unmount();
      expect(loadDraft('w9')?.items).toMatchObject([{ kind: 'quote', text: 'The settings page already reads them.', note: 'So why a context?' }]);
      const again = renderComposer('w9');
      expect(screen.getByText('So why a context?')).toBeTruthy();
      fireEvent.keyDown(again.box, { key: 'Enter', keyCode: 13 });
      // The chat takes them as the message goes (Chat), with whatever was typed: here, nothing.
      expect(again.onSend).toHaveBeenCalledWith('', [], 'steer');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a message that did not go, given back while more was typed', () => {
  type Given = { text: string; key: number; back: true; attachments?: Attachment[] };
  /**
   * The box for chat `key` with `typed` in it, then `given` back to it (its send failed); and the
   * same box after a reload. Files in the box come from its saved draft.
   */
  function typedThenGiven(typed: string, given: Omit<Given, 'key' | 'back'>, key = 'g1', onSend: (...args: unknown[]) => void = () => {}) {
    const node = (draft?: Given) => (
      <QueryClientProvider client={new QueryClient()}>
        <Composer busy={false} settings={{}} onSettings={() => {}} models={[]} onSend={onSend} onStop={() => {}} draftKey={key} {...(draft ? { draft } : {})} />
      </QueryClientProvider>
    );
    const view = render(node());
    const box = () => screen.getByLabelText('Message Claude') as HTMLTextAreaElement;
    fireEvent.change(box(), { target: { value: typed } });
    let sends = 0;
    /** Another message given back, from another send that failed. */
    const give = (next: Omit<Given, 'key' | 'back'>) => view.rerender(node({ ...next, key: (sends += 1), back: true }));
    give(given);
    return { box, give, reload: () => (view.unmount(), render(node())) };
  }
  const frame = () => act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  /** What waits above the box, each with Put back: what did not go, and what Put back took out of the box for it. */
  const waiting = () => screen.queryAllByText(/^Not sent:/).map((row) => row.textContent?.replace(/^Not sent:\s*/, ''));
  const setAside = () => screen.queryAllByText(/^Set aside:/).map((row) => row.textContent?.replace(/^Set aside:\s*/, ''));
  const putBack = (at = 0) => fireEvent.click(screen.getAllByRole('button', { name: /^Put back / })[at]!);
  const upload = (name: string): Attachment => ({ id: `up-${name}`, name, mime: 'text/plain', size: 20, path: `/tmp/${name}` });
  /** The files in the box, which go with what is sent from it. */
  const inBox = () => screen.queryAllByRole('button', { name: /^Remove (?!the quote |the comment |the file )/ }).map((b) => b.getAttribute('aria-label')!.replace(/^Remove /, ''));

  it('joins what was typed, above it and a blank line apart', async () => {
    const { box } = typedThenGiven('Also: the logs', { text: 'Why does the export fail?' });
    await frame();
    expect(box().value).toBe('Why does the export fail?\n\nAlso: the logs');
    expect(waiting()).toEqual([]);
  });

  it('with files only, brings them back and leaves the words as they were, no blank lines above them', async () => {
    const files = typedThenGiven('typed since', { text: '', attachments: [{ id: 'up1', name: 'shot.png', mime: 'image/png', size: 2048, path: '/tmp/up1' }] }, 'g2');
    await frame();
    expect(files.box().value).toBe('typed since');
    expect(screen.getByLabelText('Remove shot.png')).toBeTruthy();
  });

  it('a / command waits above the box: the words typed never become its arguments, and Put back swaps the two, the words set aside, never sent', async () => {
    const { box } = typedThenGiven('next question', { text: '/compact' });
    await frame();
    expect(box().value).toBe('next question');
    expect(waiting()).toEqual(['/compact']);
    putBack();
    expect(box().value).toBe('/compact');
    expect(waiting()).toEqual([]);
    expect(setAside()).toEqual(['next question']);
    putBack();
    expect(box().value).toBe('next question');
    expect(setAside()).toEqual(['/compact']);
  });

  it('names the buttons of each row for what it puts back, so two rows are told apart', async () => {
    const { give } = typedThenGiven('next question', { text: '/compact' }, 'g9');
    give({ text: '!npm test\nnpm run lint', attachments: [upload('trace.txt')] });
    await frame();
    expect(waiting()).toEqual(['/compact', '!npm test · trace.txt']);
    expect(screen.getAllByRole('button', { name: /^Put back / }).map((b) => b.getAttribute('aria-label'))).toEqual(['Put back /compact', 'Put back !npm test with trace.txt']);
    expect(screen.getAllByRole('button', { name: /^Discard / }).map((b) => b.getAttribute('aria-label'))).toEqual(['Discard /compact', 'Discard !npm test with trace.txt']);
    // Named as it reads: the visible Put back starts each name.
    expect(screen.getAllByRole('button', { name: /^Put back / }).every((b) => b.textContent === 'Put back')).toBe(true);
    // A long first line is named by its start, cut between words.
    give({ text: '/review the export job, its retries, its logging and the tests that cover them all' });
    await frame();
    expect(screen.getByRole('button', { name: 'Put back /review the export job, its retries, its logging and the…' })).toBeTruthy();
  });

  it('a ! command waits above the box too, and Put back puts it in once the box is empty', async () => {
    const { box } = typedThenGiven('next question', { text: '!npm test' });
    await frame();
    expect(box().value).toBe('next question');
    expect(waiting()).toEqual(['!npm test']);
    fireEvent.change(box(), { target: { value: '' } });
    putBack();
    expect(box().value).toBe('!npm test');
    expect(waiting()).toEqual([]);
    await frame();
    expect(document.activeElement).toBe(box());
  });

  it('a message, while a command is being typed, waits beside it: above the command it would make it words', async () => {
    const { box } = typedThenGiven('!ls -la', { text: 'Why does the export fail?' });
    await frame();
    expect(box().value).toBe('!ls -la');
    expect(waiting()).toEqual(['Why does the export fail?']);
  });

  it('a message with files, while a command is typed, waits with its files: the command goes without them, and Put back brings words and files back together', async () => {
    const onSend = vi.fn();
    const { box, reload } = typedThenGiven('/compact', { text: 'Why does this log say the export failed?', attachments: [upload('export.log')] }, 'g4', onSend);
    await frame();
    expect(box().value).toBe('/compact');
    expect(inBox()).toEqual([]);
    expect(waiting()).toEqual(['Why does this log say the export failed? · export.log']);
    // So it stays across a reload.
    reload();
    expect(waiting()).toEqual(['Why does this log say the export failed? · export.log']);
    fireEvent.keyDown(box(), { key: 'Enter', keyCode: 13 });
    expect(onSend).toHaveBeenCalledWith('/compact', [], 'steer');
    putBack();
    expect(box().value).toBe('Why does this log say the export failed?');
    expect(inBox()).toEqual(['export.log']);
    expect(waiting()).toEqual([]);
    fireEvent.keyDown(box(), { key: 'Enter', keyCode: 13 });
    expect(onSend).toHaveBeenLastCalledWith('Why does this log say the export failed?', [upload('export.log')], 'steer');
  });

  it('a message of files alone, while a command is typed, waits too: its files never go into the box beside the command', async () => {
    const { box } = typedThenGiven('!ls -la', { text: '', attachments: [upload('export.log'), upload('trace.txt')] }, 'g5');
    await frame();
    expect(box().value).toBe('!ls -la');
    expect(inBox()).toEqual([]);
    expect(waiting()).toEqual(['2 files']);
    fireEvent.change(box(), { target: { value: '' } });
    putBack();
    expect(inBox()).toEqual(['export.log', 'trace.txt']);
    expect(box().value).toBe('');
  });

  it('a command that comes back to a box holding files waits above it: the files never go with it', async () => {
    saveDraft('g6', '', [upload('notes.txt')]);
    const onSend = vi.fn();
    const { box } = typedThenGiven('', { text: '/compact' }, 'g6', onSend);
    await frame();
    expect(box().value).toBe('');
    expect(inBox()).toEqual(['notes.txt']);
    expect(waiting()).toEqual(['/compact']);
  });

  it('Put back trades places with what is in the box, words and files: a command never takes the files typed beside other words', async () => {
    saveDraft('g7', '', [upload('notes.txt')]);
    const onSend = vi.fn();
    const { box } = typedThenGiven('Summarise these notes', { text: '/compact' }, 'g7', onSend);
    await frame();
    expect(waiting()).toEqual(['/compact']);
    putBack();
    expect(box().value).toBe('/compact');
    expect(inBox()).toEqual([]);
    expect(setAside()).toEqual(['Summarise these notes · notes.txt']);
    fireEvent.keyDown(box(), { key: 'Enter', keyCode: 13 });
    expect(onSend).toHaveBeenCalledWith('/compact', [], 'steer');
    putBack();
    expect(box().value).toBe('Summarise these notes');
    expect(inBox()).toEqual(['notes.txt']);
  });

  it('waits there across a reload, and Discard lets it go for good', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { reload } = typedThenGiven('next question', { text: '!npm test' });
      act(() => {
        vi.runAllTimers();
      });
      reload();
      expect(waiting()).toEqual(['!npm test']);
      expect((screen.getByLabelText('Message Claude') as HTMLTextAreaElement).value).toBe('next question');
      fireEvent.click(screen.getByRole('button', { name: 'Discard !npm test' }));
      expect(waiting()).toEqual([]);
      act(() => {
        vi.runAllTimers();
      });
      cleanup();
      typedThenGiven('', { text: '' });
      expect(waiting()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('/btw', () => {
  it('asks in the side chat instead of sending here (the chat takes the quotes along)', () => {
    const onSideChat = vi.fn();
    const { onSend, box } = renderComposer('b1', { onSideChat });
    fireEvent.change(box, { target: { value: '/btw why here?' } });
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 13 });
    expect(onSideChat).toHaveBeenCalledWith('why here?');
    expect(onSend).not.toHaveBeenCalled();
    expect(box.value).toBe('');
    // On its own it is in the / list first, as a command: Enter takes it, the next Enter opens the side chat.
    fireEvent.change(box, { target: { value: '/btw' } });
    expect(screen.getByRole('option', { name: /\/btw/ })).toBeTruthy();
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 13 });
    expect(box.value).toBe('/btw ');
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 13 });
    expect(onSideChat).toHaveBeenLastCalledWith('');
  });

  it('in the side chat itself only says what the rest is', () => {
    const { onSend, box } = renderComposer('b2', { side: true });
    expect(screen.queryByRole('button', { name: 'Attach files' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Permission mode' })).toBeNull();
    fireEvent.change(box, { target: { value: '/btw what does it read?' } });
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 13 });
    expect(onSend).toHaveBeenCalledWith('what does it read?', [], 'steer');
  });
});
