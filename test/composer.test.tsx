// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  // A computer: a fine pointer, so Enter sends unless set otherwise.
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

const { Composer } = await import('../src/web/components/Composer');
const { setPrefs } = await import('../src/web/lib/prefs');
const { loadDraft, saveDraft } = await import('../src/web/lib/drafts');
const { addQuote } = await import('../src/web/lib/quote');

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

  it('brings back the files of a draft', () => {
    saveDraft('s2', 'look', [{ id: 'up1', name: 'shot.png', mime: 'image/png', size: 2048, path: '/tmp/up1' }]);
    const { box, onSend } = renderComposer('s2');
    expect(screen.getByAltText('shot.png').getAttribute('src')).toContain('api/uploads/up1');
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 13 });
    expect(onSend).toHaveBeenCalledWith('look', [expect.objectContaining({ id: 'up1' })], 'steer');
  });
});

describe('quotes above the message box', () => {
  it('show as chips, go above the words when sent, and each can be removed first', () => {
    const { onSend, box } = renderComposer('q1');
    act(() => {
      addQuote('q1', '> Why CSS variables?');
      addQuote('q1', 'src/styles/theme.css:2-3\n>   --bg: #ffffff;\n>   --fg: #111111;');
      addQuote('q1', '> left out');
    });
    expect(screen.getByText('Why CSS variables?')).toBeTruthy();
    expect(screen.getByText('theme.css:2-3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove the quote left out' }));
    fireEvent.change(box, { target: { value: 'And not a context?' } });
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 13 });
    expect(onSend).toHaveBeenCalledWith(
      '> Why CSS variables?\n\nsrc/styles/theme.css:2-3\n>   --bg: #ffffff;\n>   --fg: #111111;\n\nAnd not a context?',
      [],
      'steer',
    );
    expect(screen.queryByText('Why CSS variables?')).toBeNull();
  });

  it('removed with the keys, give them to the next quote, or to the message box once none is left', async () => {
    const { box } = renderComposer('q5');
    act(() => {
      addQuote('q5', '> first');
      addQuote('q5', '> second');
    });
    const frame = () => act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    const remove = (label: string) => screen.getByRole('button', { name: `Remove the quote ${label}` });
    remove('first').focus();
    // Enter or Space on a button clicks it with no pointer behind the click.
    fireEvent.click(remove('first'), { detail: 0 });
    await frame();
    expect(document.activeElement).toBe(remove('second'));
    fireEvent.click(remove('second'), { detail: 0 });
    await frame();
    expect(screen.queryByRole('list', { name: 'Quotes' })).toBeNull();
    expect(document.activeElement).toBe(box);
  });

  it('removed with a tap on a phone, leave the keyboard down', async () => {
    const { box } = renderComposer('q6');
    act(() => addQuote('q6', '> only'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove the quote only' }), { detail: 1 });
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    expect(document.activeElement).not.toBe(box);
  });

  it('wait for the next message when a / command goes, which has to start its own', () => {
    const { onSend, box } = renderComposer('q4');
    act(() => addQuote('q4', '> keep me'));
    fireEvent.change(box, { target: { value: '/compact focus on the export' } });
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 13 });
    expect(onSend).toHaveBeenCalledWith('/compact focus on the export', [], 'steer');
    expect(screen.getByText('keep me')).toBeTruthy();
  });

  it('can be sent alone, and are kept with the draft', () => {
    vi.useFakeTimers();
    try {
      const first = renderComposer('q2');
      act(() => addQuote('q2', '> The settings page already reads them.'));
      first.unmount();
      expect(loadDraft('q2')?.quotes).toEqual(['> The settings page already reads them.']);
      const again = renderComposer('q2');
      expect(screen.getByText('The settings page already reads them.')).toBeTruthy();
      fireEvent.keyDown(again.box, { key: 'Enter', keyCode: 13 });
      expect(again.onSend).toHaveBeenCalledWith('> The settings page already reads them.', [], 'steer');
    } finally {
      vi.useRealTimers();
    }
  });

  it('come back as chips with a message whose send failed', () => {
    const { box } = renderComposer('q3', { draft: { text: '> a quote\n\nmy words', key: 1 } });
    expect(box.value).toBe('my words');
    expect(screen.getByText('a quote')).toBeTruthy();
  });
});

describe('a message that did not go, given back while more was typed', () => {
  type Given = { text: string; key: number; back: true; attachments?: Array<{ id: string; name: string; mime: string; size: number; path: string }> };
  /** The box for chat `key` with `typed` in it, then `given` back to it (its send failed); and the same box after a reload. */
  function typedThenGiven(typed: string, given: Omit<Given, 'key' | 'back'>, key = 'g1') {
    const node = (draft?: Given) => (
      <QueryClientProvider client={new QueryClient()}>
        <Composer busy={false} settings={{}} onSettings={() => {}} models={[]} onSend={() => {}} onStop={() => {}} draftKey={key} {...(draft ? { draft } : {})} />
      </QueryClientProvider>
    );
    const view = render(node());
    const box = () => screen.getByLabelText('Message Claude') as HTMLTextAreaElement;
    fireEvent.change(box(), { target: { value: typed } });
    view.rerender(node({ ...given, key: 1, back: true }));
    return { box, reload: () => (view.unmount(), render(node())) };
  }
  const frame = () => act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  /** What waits above the box, each with Put back. */
  const waiting = () => screen.queryAllByText(/^Not sent:/).map((row) => row.textContent?.replace(/^Not sent:\s*/, ''));
  const putBack = (at = 0) => fireEvent.click(screen.getAllByRole('button', { name: 'Put back' })[at]!);

  it('joins what was typed, above it and a blank line apart', async () => {
    const { box } = typedThenGiven('Also: the logs', { text: 'Why does the export fail?' });
    await frame();
    expect(box().value).toBe('Why does the export fail?\n\nAlso: the logs');
    expect(waiting()).toEqual([]);
  });

  it('with quotes or files only, brings them back and leaves the words as they were, no blank lines above them', async () => {
    const { box } = typedThenGiven('typed since', { text: 'src/a.ts:3\n> const a = 1;' });
    await frame();
    expect(box().value).toBe('typed since');
    expect(screen.getByRole('list', { name: 'Quotes' }).textContent).toContain('a.ts:3');
    cleanup();
    const files = typedThenGiven('typed since', { text: '', attachments: [{ id: 'up1', name: 'shot.png', mime: 'image/png', size: 2048, path: '/tmp/up1' }] }, 'g2');
    await frame();
    expect(files.box().value).toBe('typed since');
    expect(screen.getByLabelText('Remove shot.png')).toBeTruthy();
  });

  it('a / command waits above the box: the words typed never become its arguments, and Put back swaps the two', async () => {
    const { box } = typedThenGiven('next question', { text: '/compact' });
    await frame();
    expect(box().value).toBe('next question');
    expect(waiting()).toEqual(['/compact']);
    putBack();
    expect(box().value).toBe('/compact');
    expect(waiting()).toEqual(['next question']);
    putBack();
    expect(box().value).toBe('next question');
    expect(waiting()).toEqual(['/compact']);
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
  it('asks in the side chat, with the quotes, instead of sending here', () => {
    const onSideChat = vi.fn();
    const { onSend, box } = renderComposer('b1', { onSideChat });
    act(() => addQuote('b1', '> the toggle'));
    fireEvent.change(box, { target: { value: '/btw why here?' } });
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 13 });
    expect(onSideChat).toHaveBeenCalledWith('> the toggle\n\nwhy here?');
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
