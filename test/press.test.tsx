// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LONG_PRESS_MS, type Press, useLongPress, useSwipeLeft } from '../src/web/lib/press';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  getSelection()?.removeAllRanges();
});

/** A row with a long press on it, and a link and an image inside, as a session row or a prompt has. */
function Held({ onPress, onClick = () => {}, nativeMenu, enabled }: {
  onPress: (press: Press) => void;
  onClick?: () => void;
  nativeMenu?: (target: Element) => boolean;
  enabled?: boolean;
}) {
  const { className, ...press } = useLongPress<HTMLDivElement>(onPress, {
    ...(nativeMenu ? { nativeMenu } : {}),
    ...(enabled === undefined ? {} : { enabled }),
  });
  return (
    <div data-testid="row" className={className} {...press} onClick={onClick}>
      Review the checkout flow <a href="#pr">#128</a> <img alt="chart" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" />
    </div>
  );
}

const finger = { pointerType: 'touch', pointerId: 1, isPrimary: true };

describe('a long press', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('acts at 500 ms of a finger held still, where the finger is, and not before', () => {
    const onPress = vi.fn();
    render(<Held onPress={onPress} />);
    const row = screen.getByTestId('row');
    fireEvent.pointerDown(row, { ...finger, clientX: 40, clientY: 300 });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS - 1));
    expect(onPress).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onPress).toHaveBeenCalledWith(expect.objectContaining({ x: 40, y: 300, pointerType: 'touch' }));
    expect((onPress.mock.calls[0]![0] as Press).element).toBe(row);
  });

  it('lets go when the finger drifts more than 10 px, or lifts, or the page scrolls', () => {
    const onPress = vi.fn();
    render(<Held onPress={onPress} />);
    const row = screen.getByTestId('row');
    fireEvent.pointerDown(row, { ...finger, clientX: 40, clientY: 300 });
    fireEvent.pointerMove(row, { ...finger, clientX: 46, clientY: 307 });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    // 9.2 px: still holding.
    expect(onPress).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(row, { ...finger, clientX: 40, clientY: 300 });
    fireEvent.pointerMove(row, { ...finger, clientX: 40, clientY: 311 });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    expect(onPress).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(row, { ...finger, clientX: 40, clientY: 300 });
    fireEvent.pointerUp(row, finger);
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    expect(onPress).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(row, { ...finger, clientX: 40, clientY: 300 });
    fireEvent.scroll(document.body);
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    expect(onPress).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(row, { ...finger, clientX: 40, clientY: 300 });
    fireEvent.pointerCancel(row, finger);
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('is not a second finger’s, a held mouse button’s, or a thing’s whose press is off', () => {
    const onPress = vi.fn();
    const { rerender } = render(<Held onPress={onPress} />);
    const row = screen.getByTestId('row');
    fireEvent.pointerDown(row, { ...finger, pointerId: 2, isPrimary: false, clientX: 40, clientY: 300 });
    fireEvent.pointerDown(row, { pointerType: 'mouse', pointerId: 3, isPrimary: true, clientX: 40, clientY: 300 });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    expect(onPress).not.toHaveBeenCalled();
    rerender(<Held onPress={onPress} enabled={false} />);
    fireEvent.pointerDown(row, { ...finger, clientX: 40, clientY: 300 });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    fireEvent.contextMenu(row, { clientX: 40, clientY: 300 });
    expect(onPress).not.toHaveBeenCalled();
  });

  it('keeps the tap that ends it, and the menu Android shows after it, from the thing', () => {
    const onPress = vi.fn();
    const onClick = vi.fn();
    render(<Held onPress={onPress} onClick={onClick} />);
    const row = screen.getByTestId('row');
    fireEvent.pointerDown(row, { ...finger, clientX: 40, clientY: 300 });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    fireEvent.pointerUp(row, finger);
    expect(fireEvent.contextMenu(row, { clientX: 40, clientY: 300 })).toBe(false);
    fireEvent.click(row);
    expect(onClick).not.toHaveBeenCalled();
    expect(onPress).toHaveBeenCalledTimes(1);
    // A tap later is a tap.
    act(() => vi.advanceTimersByTime(1000));
    fireEvent.click(row);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('opens at once where the browser’s own long press comes first (Android’s context menu)', () => {
    const onPress = vi.fn();
    render(<Held onPress={onPress} />);
    const row = screen.getByTestId('row');
    fireEvent.pointerDown(row, { ...finger, clientX: 40, clientY: 300 });
    act(() => vi.advanceTimersByTime(400));
    expect(fireEvent.contextMenu(row, { clientX: 41, clientY: 301 })).toBe(false);
    expect(onPress).toHaveBeenCalledWith(expect.objectContaining({ x: 40, y: 300, pointerType: 'touch' }));
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('turns off iOS’s callout on links, and under a finger the text selection a press would start', () => {
    render(<Held onPress={() => {}} />);
    const row = screen.getByTestId('row');
    expect(row.style.getPropertyValue('-webkit-touch-callout') || (row.style as unknown as Record<string, string>).WebkitTouchCallout).toBe('none');
    expect(row.className).toContain('[@media(hover:none)]:select-none');
  });
});

describe('a right-click', () => {
  it('opens the same list at once, where the pointer is, and the browser’s menu stays its own', () => {
    const onPress = vi.fn();
    render(<Held onPress={onPress} />);
    const row = screen.getByTestId('row');
    fireEvent.pointerDown(row, { pointerType: 'mouse', pointerId: 1, isPrimary: true, button: 2, clientX: 600, clientY: 240 });
    expect(fireEvent.contextMenu(row, { clientX: 600, clientY: 240, button: 2 })).toBe(false);
    expect(onPress).toHaveBeenCalledWith(expect.objectContaining({ x: 600, y: 240, pointerType: 'mouse' }));
    expect((onPress.mock.calls[0]![0] as Press).element).toBe(row);
  });

  it('leaves links and images to the browser’s own menu, where a way in asks for that', () => {
    const onPress = vi.fn();
    render(<Held onPress={onPress} nativeMenu={(target) => Boolean(target.closest('a, img'))} />);
    const link = screen.getByText('#128');
    fireEvent.pointerDown(link, { pointerType: 'mouse', pointerId: 1, isPrimary: true, button: 2 });
    expect(fireEvent.contextMenu(link, { clientX: 600, clientY: 240, button: 2 })).toBe(true);
    expect(fireEvent.contextMenu(screen.getByAltText('chart'), { clientX: 600, clientY: 240, button: 2 })).toBe(true);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('opens from the keyboard’s menu key too, under the thing', () => {
    const onPress = vi.fn();
    render(<Held onPress={onPress} />);
    const row = screen.getByTestId('row');
    row.getBoundingClientRect = () => ({ left: 16, right: 360, top: 100, bottom: 160, width: 344, height: 60, x: 16, y: 100, toJSON() {} });
    fireEvent.contextMenu(row, { clientX: 0, clientY: 0 });
    expect(onPress).toHaveBeenCalledWith(expect.objectContaining({ x: 16, y: 160, pointerType: 'keyboard' }));
  });
});

/** A paragraph of a reply that a swipe quotes, with a code block and a table in it, following the finger. */
function Swiped({ onSwipe }: { onSwipe: () => void }) {
  const { dx, armed, bind } = useSwipeLeft<HTMLDivElement>(onSwipe);
  return (
    <div data-testid="para" data-dx={dx} data-armed={armed} {...bind}>
      <p>Done. The toggle sits under Display in Settings.</p>
      <pre>npm test -- theme</pre>
      <table><tbody><tr><td>14 passed</td></tr></tbody></table>
      <div data-diff>+ --bg: #0a0a0a;</div>
    </div>
  );
}

/** A finger from (x, y) moving by (dx, dy) in steps, then lifting. */
function swipe(el: Element, x: number, y: number, dx: number, dy: number, { lift = true } = {}) {
  fireEvent.pointerDown(el, { ...finger, clientX: x, clientY: y });
  for (let step = 1; step <= 4; step += 1) fireEvent.pointerMove(el, { ...finger, clientX: x + (dx * step) / 4, clientY: y + (dy * step) / 4 });
  if (lift) fireEvent.pointerUp(el, { ...finger, clientX: x + dx, clientY: y + dy });
}

describe('a swipe to the left', () => {
  it('follows the finger and acts when let go past 64 px', () => {
    const onSwipe = vi.fn();
    render(<Swiped onSwipe={onSwipe} />);
    const para = screen.getByTestId('para');
    const text = screen.getByText(/The toggle sits/);
    swipe(text, 300, 400, -50, 4, { lift: false });
    expect(para.dataset.dx).toBe('-50');
    expect(para.dataset.armed).toBe('false');
    fireEvent.pointerUp(text, { ...finger, clientX: 250, clientY: 404 });
    expect(onSwipe).not.toHaveBeenCalled();
    expect(para.dataset.dx).toBe('0');
    swipe(text, 300, 400, -90, 6, { lift: false });
    expect(para.dataset.armed).toBe('true');
    // Past where it acts, it follows more slowly.
    expect(Number(para.dataset.dx)).toBeGreaterThan(-90);
    fireEvent.pointerUp(text, { ...finger, clientX: 210, clientY: 406 });
    expect(onSwipe).toHaveBeenCalledOnce();
    const swiped = onSwipe.mock.calls[0]![0] as { target: Element; element: Element };
    expect(swiped.target).toBe(text);
    expect(swiped.element).toBe(para);
  });

  it('never goes right: that is Back', () => {
    const onSwipe = vi.fn();
    render(<Swiped onSwipe={onSwipe} />);
    const text = screen.getByText(/The toggle sits/);
    swipe(text, 100, 400, 120, 0);
    expect(onSwipe).not.toHaveBeenCalled();
    expect(screen.getByTestId('para').dataset.dx).toBe('0');
  });

  it('leaves a drag mostly up or down to the page’s scrolling', () => {
    const onSwipe = vi.fn();
    render(<Swiped onSwipe={onSwipe} />);
    const text = screen.getByText(/The toggle sits/);
    // Sideways, but not twice as far as down.
    swipe(text, 300, 400, -80, 50);
    swipe(text, 300, 400, -10, -120);
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it('starting within 24 px of either edge is the system’s', () => {
    const onSwipe = vi.fn();
    render(<Swiped onSwipe={onSwipe} />);
    const text = screen.getByText(/The toggle sits/);
    swipe(text, innerWidth - 10, 400, -150, 0);
    swipe(text, 20, 400, -15, 0);
    expect(onSwipe).not.toHaveBeenCalled();
    swipe(text, innerWidth - 30, 400, -150, 0);
    expect(onSwipe).toHaveBeenCalledOnce();
  });

  it('is not one on code, a table or a diff, which scroll sideways, nor while text is selected', () => {
    const onSwipe = vi.fn();
    render(<Swiped onSwipe={onSwipe} />);
    swipe(screen.getByText('npm test -- theme'), 300, 400, -150, 0);
    swipe(screen.getByText('14 passed'), 300, 400, -150, 0);
    swipe(screen.getByText(/--bg/), 300, 400, -150, 0);
    const text = screen.getByText(/The toggle sits/);
    const range = document.createRange();
    range.selectNodeContents(text);
    getSelection()!.addRange(range);
    swipe(text, 300, 400, -150, 0);
    expect(onSwipe).not.toHaveBeenCalled();
    getSelection()!.removeAllRanges();
    swipe(text, 300, 400, -150, 0);
    expect(onSwipe).toHaveBeenCalledOnce();
  });

  it('is a finger’s alone, and the click some browsers send after it is not a tap', () => {
    const onSwipe = vi.fn();
    const onClick = vi.fn();
    render(<div onClick={onClick}><Swiped onSwipe={onSwipe} /></div>);
    const text = screen.getByText(/The toggle sits/);
    fireEvent.pointerDown(text, { pointerType: 'mouse', pointerId: 1, isPrimary: true, clientX: 300, clientY: 400 });
    fireEvent.pointerMove(text, { pointerType: 'mouse', pointerId: 1, isPrimary: true, clientX: 150, clientY: 400 });
    fireEvent.pointerUp(text, { pointerType: 'mouse', pointerId: 1, isPrimary: true, clientX: 150, clientY: 400 });
    expect(onSwipe).not.toHaveBeenCalled();
    swipe(text, 300, 400, -150, 0);
    expect(onSwipe).toHaveBeenCalledOnce();
    fireEvent.click(text);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('lets the page scroll up and down and zoom, and takes the sideways drag', () => {
    render(<Swiped onSwipe={() => {}} />);
    expect(screen.getByTestId('para').style.touchAction).toBe('pan-y pinch-zoom');
  });
});

/** A row with its actions under it, 176 px of them, as a session's row has Pin and Archive. */
function Row({ onSwipe, onTap, onPin }: { onSwipe: () => void; onTap: () => void; onPin: () => void }) {
  const { dx, armed, dragging, bind } = useSwipeLeft<HTMLDivElement>(onSwipe, { opens: 176, acts: (row) => Math.max(row.offsetWidth * 0.6, 240) });
  return (
    <div data-testid="row" data-dx={dx} data-armed={armed} data-dragging={dragging} {...bind}>
      <button type="button" data-swipe-action onClick={onPin}>Pin</button>
      <a href="#s1" onClick={(e) => { e.preventDefault(); onTap(); }}>Release notes</a>
    </div>
  );
}

describe('a swipe to the left on a thing with actions under it', () => {
  it('leaves it open on them past half of them, for a tap on one; a tap on it, a touch elsewhere or a drag back closes it', () => {
    const [onSwipe, onTap, onPin] = [vi.fn(), vi.fn(), vi.fn()];
    render(<Row onSwipe={onSwipe} onTap={onTap} onPin={onPin} />);
    const row = screen.getByTestId('row');
    const link = screen.getByText('Release notes');
    swipe(link, 300, 400, -60, 0);
    expect(row.dataset.dx).toBe('0');
    swipe(link, 300, 400, -100, 0);
    expect(row.dataset.dx).toBe('-176');
    // A tap on it closes it, and is not a tap on what it is.
    fireEvent.click(link);
    expect(onTap).not.toHaveBeenCalled();
    expect(row.dataset.dx).toBe('0');
    swipe(link, 300, 400, -100, 0);
    fireEvent.click(screen.getByText('Pin'));
    expect(onPin).toHaveBeenCalledOnce();
    fireEvent.pointerDown(document.body, { ...finger, clientX: 300, clientY: 100 });
    expect(row.dataset.dx).toBe('0');
    // Open, it goes back to the right; closed, it takes no swipe that way.
    swipe(link, 300, 400, -100, 0);
    swipe(link, 300, 400, 100, 0);
    expect(row.dataset.dx).toBe('0');
    swipe(link, 300, 400, 100, 0);
    expect(row.dataset.dx).toBe('0');
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it('follows the finger all the way, and acts let go past where its width says', () => {
    const onSwipe = vi.fn();
    render(<Row onSwipe={onSwipe} onTap={() => {}} onPin={() => {}} />);
    const row = screen.getByTestId('row');
    const link = screen.getByText('Release notes');
    swipe(link, 300, 400, -200, 0, { lift: false });
    expect([row.dataset.dx, row.dataset.armed, row.dataset.dragging]).toEqual(['-200', 'false', 'true']);
    fireEvent.pointerMove(link, { ...finger, clientX: 40, clientY: 400 });
    expect([row.dataset.dx, row.dataset.armed]).toEqual(['-260', 'true']);
    fireEvent.pointerUp(link, { ...finger, clientX: 40, clientY: 400 });
    expect(onSwipe).toHaveBeenCalledOnce();
    expect([row.dataset.dx, row.dataset.dragging]).toEqual(['0', 'false']);
  });
});
