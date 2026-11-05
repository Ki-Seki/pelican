// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  // jsdom has the element but not its modal behaviour; enough of it for focus and closing.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
  // Reduced motion: a sheet goes at once, without its way out.
  window.matchMedia = ((query: string) => ({
    matches: query.includes('reduce'), media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

const { Sheet, SheetOption } = await import('../src/web/components/Sheet');

afterEach(cleanup);

function Page({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState<'one' | 'both' | undefined>();
  return (
    <>
      <button type="button" onClick={() => setOpen('one')}>Settings</button>
      <Sheet open={Boolean(open)} onClose={() => { onClose(); setOpen(undefined); }} title="Settings">
        <SheetOption label="Model" onSelect={() => setOpen('both')} />
        <Sheet open={open === 'both'} onClose={() => setOpen('one')} title="Model">
          <SheetOption label="Opus" onSelect={() => {}} />
          <SheetOption label="Sonnet" selected onSelect={() => {}} />
        </Sheet>
      </Sheet>
    </>
  );
}

describe('sheets', () => {
  it('take focus, and give it back where it was when they close', () => {
    const onClose = vi.fn();
    render(<Page onClose={onClose} />);
    const opener = screen.getByText('Settings');
    opener.focus();
    act(() => opener.click());
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(document.activeElement).toBe(dialog);
    act(() => {
      dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('close one at a time: Esc goes to the topmost only, and focus lands on the picked option', () => {
    const onClose = vi.fn();
    render(<Page onClose={onClose} />);
    act(() => screen.getByText('Settings').click());
    const row = screen.getByText('Model').closest('button')!;
    row.focus();
    act(() => row.click());
    const model = screen.getByRole('dialog', { name: 'Model' });
    expect(document.activeElement?.textContent).toBe('Sonnet');
    // The browser sends Esc's cancel to the topmost dialog; a keydown alone closes nothing.
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(screen.getAllByRole('dialog')).toHaveLength(2);
    act(() => {
      model.dispatchEvent(new Event('cancel', { cancelable: true }));
    });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(row);
  });

  it('take no taps or keys on their way out, so the second tap of a double tap chooses nothing', () => {
    vi.useFakeTimers();
    const reduced = window.matchMedia;
    // Full motion: the sheet plays its way out, still showing its options meanwhile.
    window.matchMedia = ((query: string) => ({
      matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    try {
      function Ask() {
        const [open, setOpen] = useState(true);
        return (
          <Sheet open={open} onClose={() => setOpen(false)} title="Trust this folder?">
            <SheetOption label="Trust and start" onSelect={() => setOpen(false)} />
          </Sheet>
        );
      }
      render(<Ask />);
      const dialog = document.querySelector('dialog')!;
      expect(dialog.hasAttribute('inert')).toBe(false);
      act(() => screen.getByText('Trust and start').click());
      expect(dialog.hasAttribute('open')).toBe(true);
      expect(screen.getByText('Trust and start')).toBeTruthy();
      expect(dialog.hasAttribute('inert')).toBe(true);
      act(() => {
        vi.advanceTimersByTime(250);
      });
      expect(document.querySelector('dialog')).toBeNull();
    } finally {
      window.matchMedia = reduced;
      vi.useRealTimers();
    }
  });
});
