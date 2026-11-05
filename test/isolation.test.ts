import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { config } from '../src/server/config';

const tmp = realpathSync(os.tmpdir());
const inTemp = (dir: string) => {
  const relative = path.relative(tmp, realpathSync(path.dirname(dir)));
  return !relative.startsWith('..') && !path.isAbsolute(relative);
};

describe('the tests themselves', () => {
  it('use temporary folders, never the Claude Code sessions or Pelican sign-in of this computer', () => {
    for (const dir of [config.claudeHome, config.configDir, config.stateDir]) expect(inTemp(dir), dir).toBe(true);
    expect(config.claudeHome).not.toBe(path.join(os.homedir(), '.claude'));
  });

  it('run git without the settings of whoever runs them', () => {
    expect(execFileSync('git', ['config', '--show-origin', '--list'], { cwd: tmp, encoding: 'utf8' })).toBe('');
  });
});
