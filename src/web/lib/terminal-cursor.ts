import type { Terminal } from '@xterm/xterm';

/**
 * Has xterm draw the cursor though its screen has not had the keys yet. xterm waits for a first
 * focus, key or switch of screens before it draws one, and a phone types in the line field: its
 * screen never gets the keys, so at a shell prompt it showed none, nor on a computer after a reload
 * until a click. xterm keeps this to itself; the version is pinned, and
 * test/terminal-cursor.test.ts fails should it move. Whether it did.
 */
export function showCursor(t: Terminal): boolean {
  const core = (t as unknown as { _core?: { _showCursor?: () => void } })._core;
  if (typeof core?._showCursor !== 'function') return false;
  core._showCursor();
  return true;
}
