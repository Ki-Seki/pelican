import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { folderKind, scratchRoot } from '../src/server/folders';

describe('folderKind', () => {
  it('sorts folders into projects, scratch folders and temp folders', () => {
    expect(folderKind(path.join(os.homedir(), 'code', 'app'))).toBe('project');
    expect(folderKind(path.join(scratchRoot, '2026-11-05-a1b2'))).toBe('scratch');
    expect(folderKind(path.join(os.homedir(), 'Library/Application Support/Claude/scratch-workspaces/x'))).toBe('scratch');
    expect(folderKind('/tmp/claude-run')).toBe('temp');
    expect(folderKind(path.join(os.tmpdir(), 'pelican-x'))).toBe('temp');
  });

  it('does not mistake a sibling for a child', () => {
    expect(folderKind('/tmpfiles/project')).toBe('project');
    expect(folderKind(`${scratchRoot}-old/x`)).toBe('project');
  });
});
