import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { closeEntry, openEntry } from '../lib/sheet-history';

/** As long as a sheet takes to come in. */
const CLOSE_MS = 200;
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Under a finger, where Back (Android's button, an edge swipe) is how a sheet is left. */
const underFinger = () => typeof window.matchMedia === 'function' && !window.matchMedia('(hover: hover) and (pointer: fine)').matches;

/**
 * A modal dialog in the browser's top layer: everything behind it is inert, focus moves in (to
 * the element marked data-autofocus, else the dialog) and goes back where it was, and Esc closes
 * only the topmost one. Closing plays out before the dialog goes, showing what it showed while
 * open; meanwhile the dialog carries data-closing, for the way out (group-data-closing/modal), and
 * is inert itself: what it still shows takes no taps or keys, so the second tap of a double tap
 * cannot choose an option again (and send a message twice). On a phone each open one has an entry in
 * the history, so Back closes it and goes no further (lib/sheet-history).
 */
export function Modal({
  open, onClose, label, labelledBy, className = '', children,
}: {
  open: boolean;
  onClose: () => void;
  label?: string;
  labelledBy?: string;
  className?: string;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  const closing = mounted && !open;
  const shown = useRef(children);
  if (open) shown.current = children;
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  const isOpen = useRef(open);
  isOpen.current = open;
  const close = useRef(onClose);
  close.current = onClose;

  const restoreFocus = () => {
    const back = opener.current;
    opener.current = null;
    if (back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true });
  };

  useLayoutEffect(() => {
    const el = dialog.current;
    if (!mounted || !el || el.open) return;
    opener.current = document.activeElement;
    el.showModal();
    (el.querySelector<HTMLElement>('[data-autofocus]') ?? el).focus({ preventScroll: true });
  }, [mounted]);

  useEffect(() => {
    const el = dialog.current;
    if (!mounted || !el) return undefined;
    // Esc asks the topmost dialog to close; it goes once its way out has played.
    const onCancel = (e: Event) => {
      e.preventDefault();
      if (isOpen.current) close.current();
    };
    // Closed by the browser itself (a second Esc, which it does not let a page hold back).
    const onClosed = () => {
      if (isOpen.current) close.current();
    };
    el.addEventListener('cancel', onCancel);
    el.addEventListener('close', onClosed);
    return () => {
      el.removeEventListener('cancel', onCancel);
      el.removeEventListener('close', onClosed);
    };
  }, [mounted]);

  // Back closes it on a phone; closed any other way, its entry goes, without going anywhere.
  useEffect(() => {
    if (!open || !underFinger()) return undefined;
    const entry = openEntry(() => close.current());
    return () => closeEntry(entry);
  }, [open]);

  useEffect(() => {
    if (!closing) return undefined;
    const finish = () => {
      dialog.current?.close();
      setMounted(false);
      restoreFocus();
    };
    if (reducedMotion()) {
      finish();
      return undefined;
    }
    const timer = setTimeout(finish, CLOSE_MS);
    return () => clearTimeout(timer);
  }, [closing]);

  // Taken away with what holds it (the chat it belongs to closed): focus still goes back.
  useEffect(() => () => {
    if (dialog.current?.open) {
      dialog.current.close();
      restoreFocus();
    }
  }, []);

  if (!mounted) return null;
  return createPortal(
    <dialog
      ref={dialog}
      tabIndex={-1}
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      data-closing={closing || undefined}
      inert={closing || undefined}
      className={`group/modal fixed inset-0 m-0 h-[var(--app-h,100%)] max-h-none w-full max-w-none overflow-hidden border-0 bg-transparent p-0 text-fg outline-none backdrop:bg-transparent ${className}`}
    >
      {open ? children : shown.current}
    </dialog>,
    document.body,
  );
}
