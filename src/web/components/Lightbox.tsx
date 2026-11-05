import { X } from 'lucide-react';
import { useSyncExternalStore } from 'react';

import { Modal } from './Modal';

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
  const close = () => openImage(undefined);
  return (
    <Modal open={Boolean(src)} onClose={close} label="Image">
      <div className="animate-fade flex h-full w-full items-center justify-center bg-black/90 p-3 transition-opacity duration-200 group-data-closing/modal:opacity-0" onClick={close}>
        <img src={src} alt="" className="max-h-full max-w-full rounded-lg object-contain" />
        <button type="button" aria-label="Close" data-autofocus className="pt-safe absolute top-3 right-3 grid size-11 place-items-center rounded-full bg-white/10 text-white" onClick={close}>
          <X className="size-5" />
        </button>
      </div>
    </Modal>
  );
}
