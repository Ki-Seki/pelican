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
const { receiveQuotes } = await import('../src/web/lib/quote');

afterEach(() => {
  cleanup();
  getSelection()?.removeAllRanges();
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
  it('appears once the selection settles, and puts the text above the message box', () => {
    vi.useFakeTimers();
    try {
      const quotes: string[] = [];
      const stop = receiveQuotes('chat', (quote) => quotes.push(quote));
      render(<Conversation />);
      select(screen.getByTestId('reply'), 4, 31);
      act(() => {
        vi.advanceTimersByTime(300);
      });
      fireEvent.click(screen.getByRole('button', { name: 'Quote' }));
      expect(quotes).toEqual(['> settings page already reads']);
      expect(getSelection()?.isCollapsed).toBe(true);
      expect(screen.queryByRole('button', { name: 'Quote' })).toBeNull();
      stop();
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

describe('a prompt with quotes', () => {
  it('shows each quote apart from the words, a file quote under where it is from', () => {
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
