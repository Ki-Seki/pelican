import { useSyncExternalStore } from 'react';

import { MOD } from '../lib/keyboard';
import { enterSends, usePrefs } from '../lib/prefs';
import { Sheet, SheetHeading } from './Sheet';

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
      {keys.map((key) => (
        <kbd key={key} className="min-w-6 rounded-md border border-line bg-chip px-1.5 py-0.5 text-center font-sans text-[12px] text-muted">{key}</kbd>
      ))}
    </span>
  );
}

function Row({ label, keys, or }: { label: string; keys: string[]; or?: string[] }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2 text-[14px]">
      <span className="min-w-0 flex-1">{label}</span>
      <Keys keys={keys} />
      {or && <><span className="text-[12px] text-faint">or</span><Keys keys={or} /></>}
    </div>
  );
}

/** The keys Pelican knows, the same as Claude Desktop's and the CLI's where they overlap. */
export function ShortcutsSheet() {
  const open = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => shown,
  );
  usePrefs();
  // The composer's own rule: Auto sends on Enter where the pointer is fine (not an iPad with a keyboard).
  const enter = enterSends();
  return (
    <Sheet open={open} onClose={() => showShortcuts(false)} title="Keyboard shortcuts" done>
      <Row label="Send" keys={enter ? ['Enter'] : [MOD, 'Enter']} {...(enter ? { or: [MOD, 'Enter'] } : {})} />
      <Row label="New line" keys={enter ? ['Shift', 'Enter'] : ['Enter']} />
      <Row label="Stop Claude" keys={['Esc']} />
      <Row label="Search sessions" keys={[MOD, 'K']} />
      <Row label="Transcript view" keys={['Ctrl', 'O']} />
      <Row label="Changes and files" keys={[MOD, 'Shift', 'D']} />
      <Row label="Side chat" keys={[MOD, ';']} />
      <Row label="Close pane" keys={[MOD, '\\']} />
      <Row label="Close a sheet" keys={['Esc']} />
      <Row label="Keyboard shortcuts" keys={[MOD, '/']} />
      <SheetHeading>In Changes and files</SheetHeading>
      <Row label="Send comments" keys={[MOD, 'Enter']} />
      <SheetHeading>In the message box</SheetHeading>
      <Row label="Commands" keys={['/']} />
      <Row label="Files and agents" keys={['@']} />
      <Row label="Shell command" keys={['!']} />
    </Sheet>
  );
}
