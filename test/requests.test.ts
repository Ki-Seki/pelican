import { describe, expect, it } from 'vitest';

import { requestsFor } from '../src/web/lib/requests';

const labels = (git: Parameters<typeof requestsFor>[0]) => requestsFor(git).map((r) => r.label);

describe('requests to Claude on the branch line', () => {
  it('offers what applies now: commit what is uncommitted, push what is ahead, a pull request off the default branch', () => {
    const changed = [{ path: 'a.ts', status: 'modified' as const }];
    expect(labels({ repo: true, branch: 'feat/x', base: 'main', remote: true, files: changed })).toEqual(['Commit', 'Push', 'Create PR']);
    expect(labels({ repo: true, branch: 'feat/x', base: 'main', remote: true, upstream: 'origin/feat/x', ahead: 0, files: [] })).toEqual(['Create PR']);
    expect(labels({ repo: true, branch: 'main', base: 'main', remote: true, upstream: 'origin/main', ahead: 2, files: [] })).toEqual(['Push']);
    expect(labels({ repo: true, branch: 'main', base: 'main', remote: true, upstream: 'origin/main', files: [] })).toEqual([]);
    // A detached head: nothing to push or to open a pull request from.
    expect(labels({ repo: true, remote: true, files: changed })).toEqual(['Commit']);
  });

  it('offers nothing that needs a remote in a repository without one', () => {
    expect(labels({ repo: true, branch: 'feat/x', base: 'main', files: [{ path: 'a.ts', status: 'modified' }] })).toEqual(['Commit']);
    expect(labels({ repo: true, branch: 'feat/x', base: 'main', files: [] })).toEqual([]);
  });

  it('says plainly what to do, naming the branches', () => {
    const [commit, push, pr] = requestsFor({ repo: true, branch: 'feat/x', base: 'main', remote: true, files: [{ path: 'a.ts', status: 'modified' }] });
    expect(commit!.text).toMatch(/^Commit the uncommitted changes/);
    expect(push!.text).toBe('Push feat/x, and set its upstream.');
    expect(pr!.text).toMatch(/^Create a pull request from feat\/x into main/);
    expect(requestsFor({ repo: true, branch: 'feat/x', base: 'main', remote: true, upstream: 'origin/feat/x', ahead: 1, files: [] })[0]!.text).toBe('Push feat/x to origin/feat/x.');
  });
});
