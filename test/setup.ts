// Runs before every test file, before anything it imports reads the environment: config.ts takes
// its folders from it once, at import. Every folder a test could read or write is a fresh
// temporary one, so no test sees or changes the Claude Code sessions, the Pelican sign-in or the
// git settings of the computer it runs on.
// PELICAN_SCRATCH_DIR stays as it is: folderKind counts everything in the temp folder as temp, and
// its tests need the scratch root elsewhere. No test makes a scratch folder.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll } from 'vitest';

const root = mkdtempSync(path.join(os.tmpdir(), 'pelican-test-'));
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
  PELICAN_CONFIG_DIR: path.join(root, 'config'),
  PELICAN_STATE_DIR: path.join(root, 'state'),
  // The developer's hooks, templates and signing would run in the repositories tests make.
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: '1',
});
// Whatever launchd job started the tests, a server they start is none, and asks launchd nothing.
delete process.env.XPC_SERVICE_NAME;

afterAll(() => rmSync(root, { recursive: true, force: true }));
