// A pull request's live status, for its card: read with gh where it is installed and signed in,
// only for a github.com pull request's address, and canned in the demo. A gh of the test's own
// stands in, so nothing is asked of GitHub.
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checksOf, PULL_URL, pullRequestStatus, readPull } from '../src/server/pull-requests';

let bin: string;
let asked: string;
const savedPath = process.env.PATH;

beforeAll(async () => {
  bin = await mkdtemp(path.join(os.tmpdir(), 'pelican-gh-'));
  asked = path.join(bin, 'asked.txt');
  // Says what it was asked, and answers as gh does for an open pull request with checks running.
  const answer = JSON.stringify({
    number: 128, title: 'Add a dark theme', state: 'OPEN', isDraft: false, headRefName: 'feat/dark-theme', baseRefName: 'main',
    statusCheckRollup: [{ __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '' }, { __typename: 'StatusContext', state: 'SUCCESS' }],
  });
  await writeFile(path.join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${asked}'\nprintf '%s' '${answer}'\n`);
  await chmod(path.join(bin, 'gh'), 0o755);
});
afterAll(async () => {
  process.env.PATH = savedPath;
  await rm(bin, { recursive: true, force: true });
});

describe('a pull request’s live status', () => {
  it('reads a github.com pull request with gh pr view, and nothing else', async () => {
    process.env.PATH = `${bin}:${savedPath}`;
    try {
      expect(await pullRequestStatus('https://github.com/acme/web/pull/128')).toEqual({
        live: true, number: 128, title: 'Add a dark theme', state: 'open', draft: false, head: 'feat/dark-theme', base: 'main', checks: 'running',
      });
      // Read again within half a minute: what was read, not gh again.
      await pullRequestStatus('https://github.com/acme/web/pull/128');
      for (const elsewhere of ['https://example.com/acme/web/pull/1', 'https://github.com/acme/web/issues/3', 'https://github.com/acme/web/pull/1;rm', 'http://github.com/acme/web/pull/2', '--help']) {
        expect(await pullRequestStatus(elsewhere)).toEqual({ live: false });
      }
      const { readFile } = await import('node:fs/promises');
      expect((await readFile(asked, 'utf8')).trim().split('\n')).toEqual(['pr view https://github.com/acme/web/pull/128 --json number,title,state,isDraft,headRefName,baseRefName,statusCheckRollup']);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it('says nothing where gh is not there to ask', async () => {
    process.env.PATH = '/nonexistent';
    try {
      expect(await pullRequestStatus('https://github.com/acme/web/pull/9')).toEqual({ live: false });
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it('reads gh’s answer plainly: its state, a draft, merged, and its checks failing, running or passed', () => {
    expect(readPull(JSON.stringify({ number: 3, title: 'T', state: 'MERGED', isDraft: false }))).toEqual({ live: true, number: 3, title: 'T', state: 'merged', draft: false });
    expect(readPull(JSON.stringify({ number: 3, title: 'T', state: 'WHATEVER' }))).toEqual({ live: false });
    expect(checksOf([])).toBeUndefined();
    expect(checksOf([{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }, { __typename: 'StatusContext', state: 'SUCCESS' }])).toBe('passing');
    expect(checksOf([{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }, { __typename: 'CheckRun', status: 'QUEUED' }])).toBe('failing');
    expect(checksOf([{ __typename: 'StatusContext', state: 'PENDING' }])).toBe('running');
    expect(checksOf([{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SKIPPED' }])).toBe('passing');
  });

  it('takes only a github.com pull request’s address', () => {
    expect(PULL_URL.test('https://github.com/acme/web/pull/128')).toBe(true);
    expect(PULL_URL.test('https://github.com/acme/web/pull/128/files')).toBe(false);
    expect(PULL_URL.test('https://github.com.evil.example/acme/web/pull/1')).toBe(false);
  });
});

