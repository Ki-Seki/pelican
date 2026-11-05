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

function renderComposer(draftKey = 'chat') {
  const onSend = vi.fn();
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <Composer busy={false} settings={{}} onSettings={() => {}} models={[]} onSend={onSend} onStop={() => {}} draftKey={draftKey} />
    </QueryClientProvider>,
  );
  return { onSend, box: screen.getByLabelText('Message Claude') as HTMLTextAreaElement, unmount: view.unmount };
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
