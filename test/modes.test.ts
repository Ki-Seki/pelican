import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readRecordedSettings } from '../src/server/history';
import { isPermissionMode, MODE_INFO, OFFERED_MODES, PERMISSION_MODES } from '../src/shared/modes';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'pelican-modes-'));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe('permission modes', () => {
  it('are Claude Code’s, with the names it gives them', () => {
    expect(PERMISSION_MODES).toEqual(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk']);
    expect(PERMISSION_MODES.map((m) => MODE_INFO[m].label)).toEqual(['Manual', 'Accept edits', 'Plan', 'Auto', 'Bypass permissions', 'Don’t ask']);
    expect(isPermissionMode('dontAsk')).toBe(true);
    expect(isPermissionMode('yolo')).toBe(false);
  });

  it('offers every mode but Don’t ask, which a session keeps but nobody picks here', () => {
    expect(OFFERED_MODES).not.toContain('dontAsk');
    expect(OFFERED_MODES).toHaveLength(5);
  });

  it('keeps a session’s recorded Don’t ask instead of falling back to an older mode', async () => {
    const file = path.join(dir, 'dontask.jsonl');
    const row = (uuid: string, parent: string | null, permissionMode: string) =>
      JSON.stringify({ uuid, parentUuid: parent, type: 'user', permissionMode, timestamp: new Date().toISOString(), message: { role: 'user', content: 'go' } });
    await writeFile(file, `${row('u1', null, 'plan')}\n${row('u2', 'u1', 'dontAsk')}\n`);
    expect(await readRecordedSettings(file)).toEqual({ permissionMode: 'dontAsk' });
  });
});
