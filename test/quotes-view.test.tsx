// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  // jsdom lays nothing out: a selection is somewhere, all the same.
  const rect = { x: 10, y: 40, top: 40, left: 10, bottom: 60, right: 200, width: 190, height: 20, toJSON: () => ({}) } as DOMRect;
  Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => rect;
});

const { PromptBody, QuoteTargetContext, SelectionActions, SETTLE_MS, SwipeQuote } = await import('../src/web/components/Quotes');
const { keyText } = await import('../src/web/lib/keyboard');
/** Quote, with the key that quotes beside it, as this keyboard prints it. */
const QUOTE = `Quote${keyText('quote')}`;
const { addWaiting, setWaiting, waitingOf } = await import('../src/web/lib/drafts');
const { messageWith, quoteItem, sendNowMessage } = await import('../src/web/lib/quote');
type QuoteTarget = import('../src/web/components/Quotes').QuoteTarget;
type WaitingItem = import('../src/web/lib/quote').WaitingItem;

const SAID_AT = Date.UTC(2026, 10, 6, 10, 42);

function Conversation({ target }: { target: QuoteTarget }) {
  const content = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  return (
    <QuoteTargetContext.Provider value={target}>
      <div ref={frame} data-testid="frame">
        <div data-conversation>
          <div ref={content}>
            <div data-quotable data-quote-from="u1" data-quote-what="prompt"><p data-testid="prompt">Add a dark theme to the settings page.</p></div>
            <div data-quotable data-quote-from="a1" data-quote-what="reply" data-quote-at={SAID_AT}>
              <p data-testid="reply">The colors are already variables, so a dark theme is one more set of values.</p>
            </div>
            <div data-quotable data-quote-from="a2" data-quote-what="reply"><p data-testid="next">All 14 theme tests pass.</p></div>
            <SelectionActions within={content} dockTo={frame} />
          </div>
        </div>
      </div>
    </QuoteTargetContext.Provider>
  );
}

/** Selects text from `from` to `to` in one element, or from one into another. */
function select(element: HTMLElement, from: number, to: number, end: HTMLElement = element) {
  const range = document.createRange();
  range.setStart(element.firstChild!, from);
  range.setEnd(end.firstChild!, to);
  const selection = getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  act(() => {
    document.dispatchEvent(new Event('selectionchange'));
  });
}

/** A mouse's selection: pressed, dragged over the text, let go. */
function drag(element: HTMLElement, from: number, to: number, end?: HTMLElement) {
  fireEvent.pointerDown(element, { pointerType: 'mouse' });
  select(element, from, to, end);
  fireEvent.pointerUp(element, { pointerType: 'mouse' });
}

/** A finger's: the system's long press, then the handles, each move a selectionchange. */
function hold(element: HTMLElement, from: number, to: number) {
  fireEvent.pointerDown(element, { pointerType: 'touch' });
  select(element, from, to);
}

const wait = (ms: number) => act(() => {
  vi.advanceTimersByTime(ms);
});
const pill = () => screen.queryByRole('toolbar', { name: 'Selected text' });
const actions = () => [...(pill()?.querySelectorAll('button') ?? [])].map((b) => b.textContent);
const noteBox = () => screen.queryByRole('dialog', { name: 'Quote with a note' });

let target: QuoteTarget;
beforeEach(() => {
  vi.useFakeTimers();
  target = { chat: 'chat', sendNow: vi.fn(), focusBox: vi.fn(), sideChat: { open: false, start: vi.fn() } };
});
afterEach(() => {
  // A note left open is kept for its chat, as switching sessions keeps it: Esc lets it go.
  const open = noteBox();
  if (open) fireEvent.keyDown(within(open).getByLabelText('Your note'), { key: 'Escape' });
  cleanup();
  getSelection()?.removeAllRanges();
  setWaiting('chat', []);
  vi.useRealTimers();
});

describe('text selected with a mouse', () => {
  it('shows Desktop’s two, side chat then Quote, 250 ms after the button is let go', () => {
    render(<Conversation target={target} />);
    drag(screen.getByTestId('reply'), 53, 75);
    wait(SETTLE_MS - 10);
    expect(pill()).toBeNull();
    wait(20);
    expect(actions()).toEqual(['Start a side chat', QUOTE]);
    // Tabbed to, each part says it has the keys with a ring.
    for (const part of pill()!.querySelectorAll('button')) expect(part.className).toContain('focus-visible:ring-2');
  });

  it('says Send to side chat once one is open, and offers no side chat in a side chat', () => {
    const { rerender } = render(<Conversation target={{ ...target, sideChat: { open: true, start: vi.fn() } }} />);
    drag(screen.getByTestId('reply'), 53, 75);
    wait(SETTLE_MS);
    expect(actions()).toEqual(['Send to side chat', QUOTE]);
    rerender(<Conversation target={{ chat: 'side', side: true }} />);
    drag(screen.getByTestId('reply'), 53, 75);
    wait(SETTLE_MS);
    expect(actions()).toEqual([QUOTE]);
  });

  it('offers nothing for fewer than two characters, and only the side chat across two messages', () => {
    render(<Conversation target={target} />);
    drag(screen.getByTestId('reply'), 4, 5);
    wait(SETTLE_MS);
    expect(pill()).toBeNull();
    drag(screen.getByTestId('reply'), 53, 10, screen.getByTestId('next'));
    wait(SETTLE_MS);
    expect(actions()).toEqual(['Start a side chat']);
  });

  it('↵ quotes while the pill shows: Desktop’s note box at the selection, with the keys', () => {
    render(<Conversation target={target} />);
    drag(screen.getByTestId('reply'), 53, 75);
    wait(SETTLE_MS);
    fireEvent.keyDown(document.body, { key: 'Enter' });
    const box = noteBox()!;
    expect(within(box).getByText('one more set of values')).toBeTruthy();
    expect(document.activeElement).toBe(within(box).getByLabelText('Your note'));
    // The selection is the box's now, and the pill has gone.
    expect(getSelection()?.isCollapsed).toBe(true);
    expect(pill()).toBeNull();
  });

  it('↵ on a button or a link that has the keys presses it, and quotes nothing', () => {
    render(
      <>
        <Conversation target={target} />
        <button type="button">Allow</button>
        <a href="#docs">Docs</a>
      </>,
    );
    drag(screen.getByTestId('reply'), 53, 75);
    wait(SETTLE_MS);
    for (const control of [screen.getByRole('button', { name: 'Allow' }), screen.getByRole('link', { name: 'Docs' })]) {
      control.focus();
      // Not taken: the browser presses what has the keys.
      expect(fireEvent.keyDown(control, { key: 'Enter' })).toBe(true);
      expect(noteBox()).toBeNull();
      expect(pill()).not.toBeNull();
    }
    // With the keys back on the page, ↵ quotes.
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document.body, { key: 'Enter' });
    expect(noteBox()).not.toBeNull();
  });

  it('the note box: ↵ adds the quote with its note, where it is from kept to show it again', () => {
    render(<Conversation target={target} />);
    drag(screen.getByTestId('reply'), 53, 75);
    wait(SETTLE_MS);
    fireEvent.click(within(pill()!).getByRole('button', { name: /^Quote/ }));
    const note = within(noteBox()!).getByLabelText('Your note');
    fireEvent.change(note, { target: { value: 'Use the --bg and --fg names we have' } });
    fireEvent.keyDown(note, { key: 'Enter' });
    expect(noteBox()).toBeNull();
    expect(waitingOf('chat')).toMatchObject([{
      kind: 'quote', text: 'one more set of values', note: 'Use the --bg and --fg names we have',
      from: { what: 'reply', key: 'a1', at: SAID_AT, span: [43, 61] },
    }]);
    expect(target.focusBox).toHaveBeenCalled();
  });

  it('adds it as a plain quote without a note, and Shift+Enter starts a new line of the note', () => {
    render(<Conversation target={target} />);
    drag(screen.getByTestId('prompt'), 2, 16);
    wait(SETTLE_MS);
    fireEvent.click(within(pill()!).getByRole('button', { name: /^Quote/ }));
    const note = within(noteBox()!).getByLabelText('Your note');
    fireEvent.keyDown(note, { key: 'Enter', shiftKey: true });
    expect(noteBox()).not.toBeNull();
    fireEvent.click(within(noteBox()!).getByRole('button', { name: /^Add/ }));
    expect(waitingOf('chat')).toMatchObject([{ kind: 'quote', text: 'd a dark theme', from: { what: 'prompt', key: 'u1' } }]);
    expect(waitingOf('chat')[0]!.note).toBeUndefined();
  });

  it('⌘↵ sends it now with its note, which it needs; Esc lets it go', () => {
    render(<Conversation target={target} />);
    drag(screen.getByTestId('reply'), 53, 75);
    wait(SETTLE_MS);
    fireEvent.keyDown(document.body, { key: 'Enter' });
    const note = within(noteBox()!).getByLabelText('Your note');
    expect((within(noteBox()!).getByRole('button', { name: /^Send now/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(note, { key: 'Enter', metaKey: true });
    expect(target.sendNow).not.toHaveBeenCalled();
    fireEvent.change(note, { target: { value: 'Keep the names' } });
    fireEvent.keyDown(note, { key: 'Enter', ctrlKey: true });
    expect(target.sendNow).toHaveBeenCalledWith(expect.objectContaining({ text: 'one more set of values', note: 'Keep the names' }));
    expect(noteBox()).toBeNull();
    expect(waitingOf('chat')).toEqual([]);

    drag(screen.getByTestId('reply'), 53, 75);
    wait(SETTLE_MS);
    fireEvent.keyDown(document.body, { key: 'Enter' });
    fireEvent.change(within(noteBox()!).getByLabelText('Your note'), { target: { value: 'never mind' } });
    fireEvent.keyDown(within(noteBox()!).getByLabelText('Your note'), { key: 'Escape' });
    expect(noteBox()).toBeNull();
    expect(waitingOf('chat')).toEqual([]);
  });

  it('stays inside the conversation when its passage is scrolled out of view, never over the header or the box', () => {
    const frameRect = HTMLElement.prototype.getBoundingClientRect;
    const { getClientRects, getBoundingClientRect } = Range.prototype;
    // The conversation's frame runs from 60 to 520; the passage is wherever `at` says.
    let at = 300;
    const line = () => ({ x: 10, y: at, top: at, left: 10, bottom: at + 18, right: 200, width: 190, height: 18, toJSON: () => ({}) }) as DOMRect;
    HTMLElement.prototype.getBoundingClientRect = function frameOrNot(this: HTMLElement) {
      return this.dataset.testid === 'frame' ? ({ x: 0, y: 60, top: 60, left: 0, bottom: 520, right: 800, width: 800, height: 460, toJSON: () => ({}) } as DOMRect) : frameRect.call(this);
    };
    Range.prototype.getClientRects = () => [line()] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = line;
    try {
      render(<Conversation target={target} />);
      drag(screen.getByTestId('reply'), 53, 75);
      wait(SETTLE_MS);
      fireEvent.keyDown(document.body, { key: 'Enter' });
      const top = () => noteBox()!.style.top;
      expect(top()).toBe('326px');
      // Scrolled up: the passage is below the frame, the box at its foot.
      at = 700;
      act(() => {
        window.dispatchEvent(new Event('scroll'));
      });
      wait(20);
      expect(top()).toBe('508px');
      // Scrolled down: the passage is above it, under the header; the box at its top.
      at = 20;
      act(() => {
        window.dispatchEvent(new Event('scroll'));
      });
      wait(20);
      expect(top()).toBe('72px');
    } finally {
      HTMLElement.prototype.getBoundingClientRect = frameRect;
      Object.assign(Range.prototype, { getClientRects, getBoundingClientRect });
    }
  });

  it('a click outside closes the note box only while its note is empty', () => {
    render(<Conversation target={target} />);
    drag(screen.getByTestId('reply'), 53, 75);
    wait(SETTLE_MS);
    fireEvent.keyDown(document.body, { key: 'Enter' });
    fireEvent.change(within(noteBox()!).getByLabelText('Your note'), { target: { value: 'half a thought' } });
    fireEvent.pointerDown(screen.getByTestId('next'), { button: 0 });
    expect(noteBox()).not.toBeNull();
    fireEvent.change(within(noteBox()!).getByLabelText('Your note'), { target: { value: '  ' } });
    fireEvent.pointerDown(screen.getByTestId('next'), { button: 0 });
    expect(noteBox()).toBeNull();
    expect(waitingOf('chat')).toEqual([]);
  });

  it('keeps an unfinished note when another session is opened and this one again', () => {
    const first = render(<Conversation target={target} />);
    drag(screen.getByTestId('reply'), 53, 75);
    wait(SETTLE_MS);
    fireEvent.keyDown(document.body, { key: 'Enter' });
    fireEvent.change(within(noteBox()!).getByLabelText('Your note'), { target: { value: 'half a thought' } });
    first.rerender(<Conversation target={{ ...target, chat: 'other' }} />);
    expect(noteBox()).toBeNull();
    first.unmount();
    render(<Conversation target={target} />);
    expect((within(noteBox()!).getByLabelText('Your note') as HTMLTextAreaElement).value).toBe('half a thought');
    expect(within(noteBox()!).getByText('one more set of values')).toBeTruthy();
    // Esc lets it go for good.
    fireEvent.keyDown(within(noteBox()!).getByLabelText('Your note'), { key: 'Escape' });
    cleanup();
    render(<Conversation target={target} />);
    expect(noteBox()).toBeNull();
  });

  it('says so when the message holds 99 quotes with a note already, and keeps the note box', () => {
    for (let i = 0; i < 99; i += 1) addWaiting('chat', quoteItem(`quote ${i}`, { what: 'reply' }, { note: 'n' })!);
    render(<Conversation target={target} />);
    drag(screen.getByTestId('reply'), 53, 75);
    wait(SETTLE_MS);
    fireEvent.keyDown(document.body, { key: 'Enter' });
    fireEvent.change(within(noteBox()!).getByLabelText('Your note'), { target: { value: 'one more' } });
    fireEvent.click(within(noteBox()!).getByRole('button', { name: /^Add/ }));
    expect(within(noteBox()!).getByRole('alert').textContent).toBe('Your message can hold up to 99 quotes with a note. Send it, then add more.');
    expect(waitingOf('chat')).toHaveLength(99);
  });

  it('Start a side chat takes the passage to the side chat', () => {
    render(<Conversation target={target} />);
    drag(screen.getByTestId('reply'), 53, 75);
    wait(SETTLE_MS);
    fireEvent.click(within(pill()!).getByRole('button', { name: 'Start a side chat' }));
    expect(target.sideChat!.start).toHaveBeenCalledWith(expect.objectContaining({ kind: 'quote', text: 'one more set of values' }));
    expect(pill()).toBeNull();
  });

  it('⇧⌘L quotes what is selected, without a note', () => {
    render(<Conversation target={target} />);
    select(screen.getByTestId('reply'), 53, 75);
    fireEvent.keyDown(document.body, { key: 'L', code: 'KeyL', shiftKey: true, ctrlKey: true });
    expect(waitingOf('chat')).toMatchObject([{ kind: 'quote', text: 'one more set of values' }]);
    expect(waitingOf('chat')[0]!.note).toBeUndefined();
    expect(noteBox()).toBeNull();
  });
});

describe('text selected under a finger', () => {
  it('docks the pair above the message box once the handles rest, and takes it away while one is dragged', () => {
    render(<Conversation target={target} />);
    hold(screen.getByTestId('reply'), 53, 75);
    wait(SETTLE_MS);
    const dock = pill()!;
    expect(screen.getByTestId('frame').contains(dock)).toBe(true);
    expect(dock.className).toContain('h-11');
    expect(actions()).toEqual(['Start a side chat', 'Quote']);
    for (const part of dock.querySelectorAll('button')) expect(part.className).toContain('focus-visible:ring-2');
    // A handle moves: the bar goes, and comes back once it rests.
    select(screen.getByTestId('reply'), 49, 75);
    expect(pill()).toBeNull();
    wait(SETTLE_MS);
    expect(pill()).not.toBeNull();
  });

  it('moves the selection up out from under the bar, with room for its handle below the line', () => {
    const rectOf = HTMLElement.prototype.getBoundingClientRect;
    // The bar at the foot of the conversation, its top 10 px under the selection's line (which ends at 60).
    HTMLElement.prototype.getBoundingClientRect = function barOrNot(this: HTMLElement) {
      return this.matches('[data-selection-actions]') ? ({ x: 40, y: 70, top: 70, left: 40, bottom: 114, right: 300, width: 260, height: 44, toJSON: () => ({}) } as DOMRect) : rectOf.call(this);
    };
    try {
      render(<Conversation target={target} />);
      hold(screen.getByTestId('reply'), 53, 75);
      wait(SETTLE_MS);
      expect(pill()).not.toBeNull();
      // Up until 28 px lie between the line and the bar.
      expect(document.querySelector('[data-conversation]')!.scrollTop).toBe(18);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = rectOf;
    }
  });

  it('Quote puts the passage in the box as it is, with no note box and no keyboard', () => {
    render(<Conversation target={target} />);
    hold(screen.getByTestId('reply'), 53, 75);
    wait(SETTLE_MS);
    fireEvent.click(within(pill()!).getByRole('button', { name: 'Quote' }));
    expect(noteBox()).toBeNull();
    expect(waitingOf('chat')).toMatchObject([{ kind: 'quote', text: 'one more set of values', from: { key: 'a1' } }]);
    expect(target.focusBox).not.toHaveBeenCalled();
    expect(getSelection()?.isCollapsed).toBe(true);
  });
});

describe('a swipe to the left under a finger', () => {
  function Swiped({ whole }: { whole?: boolean }) {
    return (
      <QuoteTargetContext.Provider value={target}>
        <div data-quotable data-quote-from="a1" data-quote-what="reply" data-quote-at={SAID_AT}>
          {whole ? (
            <SwipeQuote whole={{ text: () => 'Test Files  2 passed (2)', from: () => ({ what: 'step', key: 'bash-1' }) }}>
              <div data-testid="step">Run npm test -- theme</div>
            </SwipeQuote>
          ) : (
            <SwipeQuote>
              <div>
                <p data-testid="first">Done. The toggle sits under Display in Settings.</p>
                <p data-testid="second">All 14 theme tests pass.</p>
                <pre data-testid="code">npm test -- theme</pre>
              </div>
            </SwipeQuote>
          )}
        </div>
      </QuoteTargetContext.Provider>
    );
  }
  /** A finger from x = 300 to `to`, sideways. */
  function swipe(element: HTMLElement, to: number, from = 300) {
    fireEvent.pointerDown(element, { pointerType: 'touch', isPrimary: true, pointerId: 1, clientX: from, clientY: 100 });
    for (let x = from; x !== to; x += to < from ? -10 : 10) fireEvent.pointerMove(element, { pointerType: 'touch', pointerId: 1, clientX: x, clientY: 101 });
    fireEvent.pointerMove(element, { pointerType: 'touch', pointerId: 1, clientX: to, clientY: 101 });
    fireEvent.pointerUp(element, { pointerType: 'touch', pointerId: 1, clientX: to, clientY: 101 });
  }

  it('quotes the paragraph it is on, from where it is in the reply', () => {
    render(<Swiped />);
    swipe(screen.getByTestId('second'), 200);
    expect(waitingOf('chat')).toMatchObject([{ kind: 'quote', text: 'All 14 theme tests pass.', from: { what: 'reply', key: 'a1', at: SAID_AT } }]);
  });

  it('does nothing to the right (Back’s), short of the mark, or on code, which scrolls sideways', () => {
    render(<Swiped />);
    swipe(screen.getByTestId('second'), 380);
    swipe(screen.getByTestId('second'), 260);
    swipe(screen.getByTestId('code'), 200);
    expect(waitingOf('chat')).toEqual([]);
  });

  it('quotes all of a step’s output, wherever on it the finger is', () => {
    render(<Swiped whole />);
    swipe(screen.getByTestId('step'), 200);
    expect(waitingOf('chat')).toMatchObject([{ kind: 'quote', text: 'Test Files  2 passed (2)', from: { what: 'step', key: 'bash-1' } }]);
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
