// Runs before every test file, before anything it imports reads the environment: config.ts takes
// its folders from it once, at import. Every folder a test could read or write is a fresh
// temporary one, so no test sees or changes the Claude Code sessions, the Pelican sign-in or the
// git settings of the computer it runs on.
// PELICAN_SCRATCH_DIR stays as it is: folderKind counts everything in the temp folder as temp, and
// its tests need the scratch root elsewhere. No test makes a scratch folder.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach } from 'vitest';

import { testClaude } from './test-claude';

const root = mkdtempSync(path.join(os.tmpdir(), 'pelican-test-'));
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
  PELICAN_CONFIG_DIR: path.join(root, 'config'),
  PELICAN_STATE_DIR: path.join(root, 'state'),
  // The developer's hooks, templates and signing would run in the repositories tests make.
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: '1',
  // The Claude Code a test starts is the one Pelican was tested with, whatever this computer has
  // installed, or not: the copy the Agent SDK's package for this platform brings, a devDependency.
  PELICAN_CLAUDE_PATH: testClaude() ?? path.join(root, 'no-claude-code'),
});
// Whatever launchd job started the tests, a server they start is none, and asks launchd nothing.
delete process.env.XPC_SERVICE_NAME;

afterAll(() => rmSync(root, { recursive: true, force: true }));

// A page's tests wait up to 3 s for what they look for, not testing-library's 1 s: on a busy
// computer (CI, or several suites at once) a page can take longer to draw while nothing is wrong.
if (typeof document !== 'undefined') {
  const { configure } = await import('@testing-library/dom');
  configure({ asyncUtilTimeout: 3000 });
  // A sheet closed on a phone takes its entry in the history back out with a step back, which
  // lands a moment later: before the next test, whose page it would otherwise move.
  afterEach(async () => {
    const { sheetHistorySettled } = await import('../src/web/lib/sheet-history');
    await sheetHistorySettled();
  });
}
