// @vitest-environment jsdom
// Back on a phone (Android's button, the browser's) closes the sheet or menu that is open, and goes
// no further; a sheet closed another way takes its entry out of the history without going anywhere.
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let finger = true;
beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: query === '(hover: hover) and (pointer: fine)' ? !finger : false,
    media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});

const { Sheet } = await import('../src/web/components/Sheet');
const { whenSettled } = await import('../src/web/lib/sheet-history');
const { goTo, stepOf } = await import('../src/web/lib/workspace-route');

/** What the page's own router hears: every popstate that reaches it. */
const heard: string[] = [];
const router = () => heard.push(location.search);
window.addEventListener('popstate', router);

beforeEach(() => history.replaceState(null, '', '/?s=one'));

afterEach(async () => {
  cleanup();
  // A step back still on its way lands before the next test begins.
  await new Promise((resolve) => setTimeout(resolve, 20));
  finger = true;
  heard.length = 0;
  history.replaceState(null, '', '/?s=one');
});

/** Two sheets, the second opened from the first, as Settings opens Usage and activity. */
function Sheets({ onNavigate }: { onNavigate?: () => void }) {
  const [first, setFirst] = useState(false);
  const [second, setSecond] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setFirst(true)}>Open</button>
      <Sheet open={first} onClose={() => setFirst(false)} title="Settings" done>
        <button type="button" onClick={() => setSecond(true)}>Usage</button>
        <button
          type="button"
          onClick={() => {
            setFirst(false);
            onNavigate?.();
          }}
        >
          Go
        </button>
      </Sheet>
      <Sheet open={second} onClose={() => setSecond(false)} title="Usage and activity" done>
        <p>Figures</p>
      </Sheet>
    </>
  );
}

const open = (name: string) => act(() => screen.getByRole('button', { name }).click());
const shown = () => [...document.querySelectorAll('dialog[open]:not([data-closing])')].map((dialog) => dialog.querySelector('h2')?.textContent);
/** Back, as the browser's button: once the step back has landed (later on a busy computer), and what it set off with it. */
const back = () => act(async () => {
  // Heard first: the sheets' own listener keeps a step that was theirs alone from the others.
  const landed = new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true, capture: true }));
  history.back();
  await landed;
  await new Promise((resolve) => setTimeout(resolve, 20));
});

describe('a sheet on a phone', () => {
  it('has an entry of its own in the history, at the page’s address: Back closes it, and goes no further', async () => {
    render(<Sheets />);
    open('Open');
    await waitFor(() => expect(history.state?.pelicanSheet).toBeDefined());
    expect(location.search).toBe('?s=one');
    await back();
    expect(shown()).toEqual([]);
    expect(location.search).toBe('?s=one');
    // The page's own router never heard it: nothing else moved.
    expect(heard).toEqual([]);
  });

  it('closes the top sheet only, one Back at a time', async () => {
    render(<Sheets />);
    open('Open');
    open('Usage');
    await waitFor(() => expect(shown()).toEqual(['Settings', 'Usage and activity']));
    await back();
    expect(shown()).toEqual(['Settings']);
    await back();
    expect(shown()).toEqual([]);
    expect(location.search).toBe('?s=one');
  });

  it('closed another way, takes its entry out without going anywhere, unheard', async () => {
    render(<Sheets />);
    open('Open');
    await waitFor(() => expect(history.state?.pelicanSheet).toBeDefined());
    act(() => screen.getByRole('button', { name: 'Done' }).click());
    // Its entry is stepped back out of: Back now leaves the page as it would have.
    await waitFor(() => expect(history.state?.pelicanSheet).toBeUndefined());
    expect(location.search).toBe('?s=one');
    expect(heard).toEqual([]);
  });

  it('lets a step the page takes as it closes wait for its entry to go, so neither undoes the other', async () => {
    const navigate = () => whenSettled(() => history.pushState(null, '', '/?s=two'));
    render(<Sheets onNavigate={navigate} />);
    open('Open');
    await waitFor(() => expect(history.state?.pelicanSheet).toBeDefined());
    act(() => screen.getByRole('button', { name: 'Go' }).click());
    await waitFor(() => expect(location.search).toBe('?s=two'));
    // Back from there comes back to the page the sheet was over, not to the sheet.
    await back();
    expect(location.search).toBe('?s=one');
    expect(history.state?.pelicanSheet).toBeUndefined();
    expect(shown()).toEqual([]);
  });

  it('keeps what the page changed in its address while the sheet was up, as a pane’s tab', async () => {
    history.replaceState(null, '', '/?s=one&w=changes');
    render(<Sheets />);
    open('Open');
    await waitFor(() => expect(history.state?.pelicanSheet).toBeDefined());
    act(() => goTo({ tab: 'files' }, false));
    act(() => screen.getByRole('button', { name: 'Done' }).click());
    await waitFor(() => expect(history.state?.pelicanSheet).toBeUndefined());
    expect(stepOf(location.search)).toEqual({ tab: 'files' });
  });
});

describe('a sheet on a computer', () => {
  it('has no entry: Back is the page’s own, and Esc closes it', async () => {
    finger = false;
    render(<Sheets />);
    open('Open');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(shown()).toEqual(['Settings']);
    expect(history.state?.pelicanSheet).toBeUndefined();
  });
});

it('runs a step at once while no sheet is on its way out', () => {
  const step = vi.fn();
  whenSettled(step);
  expect(step).toHaveBeenCalledOnce();
});
