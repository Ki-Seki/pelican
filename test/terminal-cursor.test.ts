// @vitest-environment jsdom
// The terminal's cursor shows though its screen never had the keys, as on a phone
// (src/web/lib/terminal-cursor.ts), through xterm's own way of showing it.
import { Terminal } from '@xterm/xterm';
import { expect, it } from 'vitest';

import { showCursor } from '../src/web/lib/terminal-cursor';

it('has xterm draw the cursor before the screen has had the keys, as it did when this was written', () => {
  const t = new Terminal();
  const core = (t as unknown as { _core: { coreService: { isCursorInitialized: boolean } } })._core;
  expect(core.coreService.isCursorInitialized).toBe(false);
  expect(showCursor(t)).toBe(true);
  expect(core.coreService.isCursorInitialized).toBe(true);
  t.dispose();
});
