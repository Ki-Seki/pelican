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
