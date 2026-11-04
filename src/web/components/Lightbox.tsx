import { X } from 'lucide-react';
import { useEffect, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

let current: string | undefined;
const listeners = new Set<() => void>();

/** Shows an image full screen; any image in the chat can call this. */
export function openImage(src: string | undefined): void {
  current = src;
  for (const listener of listeners) listener();
}

export function Lightbox() {
  const src = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
  useEffect(() => {
    if (!src) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') openImage(undefined);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [src]);
  if (!src) return null;
  return createPortal(
    <div className="animate-fade fixed inset-0 z-[60] flex items-center justify-center bg-black/90 p-3" onClick={() => openImage(undefined)}>
      <img src={src} alt="" className="max-h-full max-w-full rounded-lg object-contain" />
      <button type="button" aria-label="Close" className="pt-safe absolute top-3 right-3 grid size-10 place-items-center rounded-full bg-white/10 text-white" onClick={() => openImage(undefined)}>
        <X className="size-5" />
      </button>
    </div>,
    document.body,
  );
}
