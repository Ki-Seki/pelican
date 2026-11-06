// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  // jsdom lays nothing out: a selection is somewhere, all the same.
  const rect = { x: 10, y: 40, top: 40, left: 10, bottom: 60, right: 200, width: 190, height: 20, toJSON: () => ({}) } as DOMRect;
  Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => rect;
});

const { PromptBody, QuoteAction } = await import('../src/web/components/Quotes');
const { setWaiting, waitingOf } = await import('../src/web/lib/drafts');
const { messageWith, quoteItem, sendNowMessage } = await import('../src/web/lib/quote');
type WaitingItem = import('../src/web/lib/quote').WaitingItem;

afterEach(() => {
  cleanup();
  getSelection()?.removeAllRanges();
  setWaiting('chat', []);
});

function Conversation() {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref}>
      <p data-testid="prompt">My own prompt</p>
      <div data-quotable><p data-testid="reply">The settings page already reads them, so a context adds nothing.</p></div>
      <QuoteAction within={ref} quoteKey="chat" />
    </div>
  );
}

function select(element: HTMLElement, from: number, to: number) {
  const range = document.createRange();
  range.setStart(element.firstChild!, from);
  range.setEnd(element.firstChild!, to);
  const selection = getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
}

describe('Quote, on text selected in a reply', () => {
  it('appears once the selection settles, and puts the text above the message box, waiting with the rest', () => {
    vi.useFakeTimers();
    try {
      render(<Conversation />);
      select(screen.getByTestId('reply'), 4, 31);
      act(() => {
        vi.advanceTimersByTime(300);
      });
      fireEvent.click(screen.getByRole('button', { name: 'Quote' }));
      expect(waitingOf('chat')).toMatchObject([{ kind: 'quote', text: 'settings page already reads' }]);
      expect(getSelection()?.isCollapsed).toBe(true);
      expect(screen.queryByRole('button', { name: 'Quote' })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('is not offered for your own prompt', () => {
    vi.useFakeTimers();
    try {
      render(<Conversation />);
      select(screen.getByTestId('prompt'), 0, 6);
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(screen.queryByRole('button', { name: 'Quote' })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a prompt with quotes, as it reads', () => {
  const reply = (text: string, note?: string): WaitingItem => quoteItem(text, { what: 'reply' }, note ? { note } : {})!;

  it('shows a reply’s quote quietly, its note in the prompt’s words, then what was typed', () => {
    const { container } = render(<PromptBody text={messageWith([reply('one more set of values', 'Use the names we have')], 'Then run the tests.')} />);
    const quotes = container.querySelectorAll('blockquote');
    expect([...quotes].map((q) => q.textContent)).toEqual(['one more set of values']);
    expect(screen.getByText('Use the names we have')).toBeTruthy();
    expect(screen.getByText('Then run the tests.')).toBeTruthy();
    expect(container.textContent).not.toContain('<!--');
  });

  it('shows Send now, lines of a file, a comment and a file as Desktop sends them', () => {
    const now = render(<PromptBody text={sendNowMessage('a passage', 'a note')} />);
    expect(now.container.querySelector('blockquote')!.textContent).toBe('a passage');
    expect(screen.getByText('a note')).toBeTruthy();
    cleanup();
    const text = '@"src/settings/prefs.ts"\nIn `src/styles/theme.css` at line 12:\n```css\n--surface: #fff;\n```\nKeep it\n\n\n<!-- attach: src/app.ts:7-8 -->\n> const a = 1;\n> const b = 2;\n\nWhy both?';
    const { container } = render(<PromptBody text={text} />);
    expect(screen.getByText('prefs.ts')).toBeTruthy();
    expect(screen.getByText('theme.css:12')).toBeTruthy();
    expect(screen.getByText('Keep it')).toBeTruthy();
    expect(screen.getByText('src/app.ts:7-8')).toBeTruthy();
    expect([...container.querySelectorAll('blockquote')].map((q) => q.textContent)).toEqual(['theme.css:12--surface: #fff;', 'src/app.ts:7-8const a = 1;\nconst b = 2;']);
    expect(screen.getByText('Why both?')).toBeTruthy();
  });

  it('still shows Pelican’s older quotes, a file’s under where it is from', () => {
    const { container } = render(<PromptBody text={'src/a.ts:7-8\n> one\n> two\n\n> Why?\n\nExplain both.'} />);
    const quotes = container.querySelectorAll('blockquote');
    expect(quotes).toHaveLength(2);
    expect(quotes[0]!.textContent).toBe('src/a.ts:7-8one\ntwo');
    expect(quotes[1]!.textContent).toBe('Why?');
    expect(screen.getByText('Explain both.')).toBeTruthy();
  });

  it('reads as typed when it has none', () => {
    const { container } = render(<PromptBody text="Fix the login test" />);
    expect(container.innerHTML).toBe('Fix the login test');
  });
});
