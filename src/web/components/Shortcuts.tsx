import { X } from 'lucide-react';
import { useId, useSyncExternalStore } from 'react';

import { shortcutList } from '../lib/keyboard';
import { enterSends, usePrefs } from '../lib/prefs';
import { Modal } from './Modal';

let shown = false;
const listeners = new Set<() => void>();

/** Opens (or closes) the list of keys; ⌘/ and Settings call it. */
export function showShortcuts(open: boolean): void {
  shown = open;
  for (const listener of listeners) listener();
}
export const shortcutsShown = () => shown;

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {keys.map((key, i) => (
        <kbd key={i} className="grid h-6 min-w-6 place-items-center rounded-md border border-line bg-bg px-1.5 font-sans text-[12px] text-muted">{key}</kbd>
      ))}
    </span>
  );
}

/**
 * The keys Pelican knows: Claude Desktop's web keys, by part, as lib/keyboard has them. Only a key
 * that works is listed; the message box's follow the Enter key setting, and Send's while Claude works.
 */
export function ShortcutsSheet() {
  const open = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => shown,
  );
  const { sendWhileBusy } = usePrefs();
  const titleId = useId();
  const close = () => showShortcuts(false);
  // The composer's own rule: Auto sends on Enter where the pointer is fine (not an iPad with a
  // keyboard); and ⌘↵ while Claude works is the other of Send's two ways, by Settings.
  const parts = shortcutList({ enterSends: enterSends(), sendWhileBusy });
  return (
    <Modal open={open} onClose={close} labelledBy={titleId}>
      <div className="flex h-full w-full items-end justify-center sm:items-start sm:p-6 sm:pt-[8vh]">
        <div className="animate-fade absolute inset-0 bg-black/20 transition-opacity duration-200 group-data-closing/modal:opacity-0" onClick={close} />
        <div className="animate-sheet pb-safe relative flex max-h-[85%] w-full max-w-[900px] flex-col rounded-t-2xl border border-line bg-panel shadow-2xl transition-[translate,opacity] duration-200 group-data-closing/modal:translate-y-full motion-reduce:transition-none sm:max-h-full sm:rounded-2xl sm:group-data-closing/modal:translate-y-3 sm:group-data-closing/modal:opacity-0">
          <div className="flex shrink-0 items-center justify-between px-6 pt-5 pb-3">
            <h2 id={titleId} className="text-[17px] font-semibold">Keyboard shortcuts</h2>
            <button type="button" aria-label="Close" onClick={close} className="-mr-2 grid size-9 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg">
              <X className="size-[18px]" />
            </button>
          </div>
          <div className="grid min-h-0 grid-cols-1 gap-x-10 gap-y-5 overflow-y-auto overscroll-contain px-6 pb-6 sm:grid-cols-2 lg:grid-cols-3">
            {parts.map((part) => (
              <section key={part.group} aria-label={part.group}>
                <h3 className="pb-1.5 text-[12px] font-medium text-faint">{part.group}</h3>
                {part.rows.map((row) => (
                  <div key={row.id} data-key={row.id} className="flex min-h-8 items-center justify-between gap-3 py-0.5 text-[13.5px] leading-snug">
                    <span className="min-w-0">{row.label}</span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      {row.keys.map((keys, i) => (
                        <span key={i} className="contents">
                          {i > 0 && <span className="text-[12px] text-faint">{row.range ? '–' : 'or'}</span>}
                          <Keys keys={keys} />
                        </span>
                      ))}
                    </span>
                  </div>
                ))}
              </section>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
