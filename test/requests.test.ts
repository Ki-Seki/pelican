import { describe, expect, it } from 'vitest';

import type { GitStatus } from '../src/shared/protocol';
import { promptGist } from '../src/shared/quoted';
import { requestShown } from '../src/shared/requests';
import { COMMIT_REQUEST, createPrRequest, prBase, readPrCreated, requestsFor } from '../src/web/lib/requests';

// Claude Desktop's own texts (its Code tab's cached build, 2026-11: chunk c17fc4411 for Commit
// changes, c1128a44c for Create PR), as its own function writes them for these targets.
const DESKTOP_READY = '<create-pr-command>\n## Overview\n\nCreate a pull request for the changes in this session, ready for review (not a draft).\n\n## Steps\n\n1. Check for uncommitted changes. If any exist, stage and commit them with a message that describes what changed and why.\n2. Push the branch to the remote.\n3. Open the PR with `gh pr create`. Do not pass `--draft`: the user chose \u201cCreate PR\u201d, not \u201cCreate draft PR\u201d, for this request, and that explicit choice overrides any saved memory, standing instruction, or earlier plan to open it as a draft. When the target below names a base branch and that branch exists on origin (`git ls-remote --heads origin <base>`), pass it with `--base`; otherwise leave `--base` off and let gh infer it. Write a title that summarizes the change and a body that covers what changed, why, and anything a reviewer should know. If the repo has a PR template, follow it.\n4. Report the PR URL when done. Wrap the URL in a `<pr-created>` tag on its own line so the UI can render a live status card, like this: `<pr-created>https://github.com/owner/repo/pull/123</pr-created>`\n\nIf a PR already exists for this branch, push any new commits and report the existing URL wrapped in the same `<pr-created>` tag instead of creating a duplicate, and leave that PR\'s draft or ready state as it is.\n\n## Target\n\nRepository: acme/web\nBranch: feat/dark-theme\nBase branch: main\nWorking directory: /Users/me/code/acme-web\n</create-pr-command>';
const DESKTOP_NO_REMOTE = '<create-pr-command>\n## Overview\n\nThis folder has no GitHub remote. Set one up, then create a pull request, ready for review (not a draft).\n\n## Steps\n\n1. Check `gh auth status`. If gh isn\'t authenticated, say so and stop \u2014 don\'t loop on auth prompts.\n2. Look for a likely existing repo: `gh repo list --limit 100 --json nameWithOwner,url` and match on the folder name.\n3. Use the AskUserQuestion tool to let the user pick the path forward. Offer the options that actually apply \u2014 e.g. "Link <owner/repo>" when step 2 found a match, "Create private repo", "Create public repo". The built-in "Other" option covers pasting a URL. Skip the question only if step 2 found exactly one obvious match.\n4. Add the remote (`git remote add origin <url>`) or create it (`gh repo create <name> --private|--public --source=. --remote=origin`).\n5. Commit anything uncommitted and push the branch with `-u`. Open the PR with `gh pr create`. Do not pass `--draft`: the user chose \u201cCreate PR\u201d, not \u201cCreate draft PR\u201d, for this request, and that explicit choice overrides any saved memory, standing instruction, or earlier plan to open it as a draft. Set `--base` to the base branch below when the target names one and it exists on origin.\n6. Report the PR URL wrapped in a `<pr-created>` tag on its own line so the UI can render a live status card, like this: `<pr-created>https://github.com/owner/repo/pull/123</pr-created>`\n\n## Target\n\nBranch: feat/dark-theme\nBase branch: main\nWorking directory: /Users/me/code/acme-web\n</create-pr-command>';

const target = { repo: 'acme/web', branch: 'feat/dark-theme', baseBranch: 'main', cwd: '/Users/me/code/acme-web' };

describe('Desktop’s requests, byte for byte', () => {
  it('asks to commit in Desktop’s words', () => {
    expect(COMMIT_REQUEST).toBe('Commit the working tree changes with a sensible message.');
  });

  it('writes Create PR, ready, draft and with no GitHub remote, as Desktop does', () => {
    expect(createPrRequest({ ...target, draft: false })).toBe(DESKTOP_READY);
    const draft = createPrRequest({ ...target, draft: true });
    // The draft is the same request, opened as a draft, and says so where Desktop's does.
    expect(draft).toBe(DESKTOP_READY
      .replace('ready for review (not a draft)', 'as a draft')
      .replace(/Open the PR with `gh pr create`\. Do not pass[^]*?as a draft\./, 'Open the PR as a draft with `gh pr create --draft`. The user chose “Create draft PR” for this request, so keep `--draft` even if you would otherwise open it ready for review.'));
    const { repo: _none, ...noRemote } = target;
    expect(createPrRequest({ ...noRemote, draft: false })).toBe(DESKTOP_NO_REMOTE);
    expect(createPrRequest({ ...noRemote, draft: true })).toContain('then create a pull request, as a draft.');
  });

  it('names a base branch only when it is another, plainly named one', () => {
    expect(prBase('feat/x', 'main')).toBe('main');
    expect(prBase('main', 'main')).toBeUndefined();
    expect(prBase('feat/x', 'main; rm -rf')).toBeUndefined();
    expect(createPrRequest({ ...target, baseBranch: 'feat/dark-theme', draft: false })).not.toContain('Base branch:');
    expect(createPrRequest({ repo: 'acme/web', branch: 'x', draft: false })).toMatch(/\n\n## Target\n\nRepository: acme\/web\nBranch: x\n<\/create-pr-command>$/);
  });

  it('shows a Create PR request as Desktop does, /create-pr and /create-pr --draft, and nothing else so', () => {
    expect(requestShown(createPrRequest({ ...target, draft: false }))).toBe('/create-pr');
    expect(requestShown(createPrRequest({ ...target, draft: true }))).toBe('/create-pr --draft');
    expect(requestShown(`  ${DESKTOP_NO_REMOTE}\n`)).toBe('/create-pr');
    expect(promptGist(DESKTOP_READY)).toBe('/create-pr');
    // Not whole, or wrapped twice, or with words around it: a message as it reads.
    expect(requestShown(`Please: ${DESKTOP_READY}`)).toBeUndefined();
    expect(requestShown('<create-pr-command>a<create-pr-command>b</create-pr-command></create-pr-command>')).toBeUndefined();
    expect(requestShown(COMMIT_REQUEST)).toBeUndefined();
  });
});

describe('what Changes offers at its foot', () => {
  const changed = { path: 'a.ts', status: 'modified' as const, added: 1 };
  const committed = { path: 'b.ts', status: 'modified' as const, added: 2, committed: true as const };
  const repo = (extra: Partial<Extract<GitStatus, { repo: true }>>): Extract<GitStatus, { repo: true }> => ({ repo: true, branch: 'feat/x', base: 'main', remote: true, github: 'acme/web', files: [changed], uncommitted: 1, ...extra });
  const offered = (git: Extract<GitStatus, { repo: true }>) => Object.keys(requestsFor(git, '/code/web'));

  it('offers Commit changes while anything is not committed, and Create PR off the default branch', () => {
    expect(offered(repo({}))).toEqual(['commit', 'pr']);
    // Committed already: only a pull request.
    expect(offered(repo({ files: [committed], uncommitted: 0 }))).toEqual(['pr']);
    // On the default branch, or with nothing changed, no pull request; a detached head neither.
    expect(offered(repo({ branch: 'main' }))).toEqual(['commit']);
    expect(offered(repo({ files: [], uncommitted: 0 }))).toEqual([]);
    expect(offered(repo({ branch: undefined }))).toEqual(['commit']);
    // There is never a Push.
    expect(JSON.stringify(requestsFor(repo({ ahead: 3, upstream: 'origin/feat/x' })))).not.toMatch(/push feat/i);
  });

  it('writes the pull request for origin on GitHub, sets one up where there is no remote, and offers none for another host', () => {
    const { pr } = requestsFor(repo({}), '/code/web');
    expect(pr?.ready).toBe(createPrRequest({ repo: 'acme/web', branch: 'feat/x', baseBranch: 'main', cwd: '/code/web', draft: false }));
    expect(pr?.draft).toBe(createPrRequest({ repo: 'acme/web', branch: 'feat/x', baseBranch: 'main', cwd: '/code/web', draft: true }));
    expect(requestsFor(repo({ remote: undefined, github: undefined }), '/code/web').pr?.ready).toContain('This folder has no GitHub remote.');
    expect(requestsFor(repo({ github: undefined })).pr).toBeUndefined();
  });
});

describe('a pull request Claude made', () => {
  it('reads Desktop’s <pr-created> tag: a card for each, and the reply’s words without it', () => {
    const read = readPrCreated('The pull request is open.\n<pr-created>https://github.com/acme/web/pull/128</pr-created>');
    expect(read.text).toBe('The pull request is open.');
    expect(read.prs).toEqual([{ url: 'https://github.com/acme/web/pull/128', host: 'github.com', repo: 'acme/web', number: 128, github: true }]);
    // Among words, the address stays, as Desktop leaves it, apart from the next word.
    expect(readPrCreated('See <pr-created> https://github.com/acme/web/pull/7 </pr-created>now').text).toBe('See https://github.com/acme/web/pull/7 now');
    // Named twice, one card; a tag on an address that is no pull request, its address only.
    expect(readPrCreated('<pr-created>https://github.com/a/b/pull/1</pr-created>\nAgain: <pr-created>https://github.com/a/b/pull/1</pr-created>').prs).toHaveLength(1);
    expect(readPrCreated('<pr-created>https://example.com/x</pr-created>')).toEqual({ text: 'https://example.com/x', prs: [] });
    // A reply that names none is as it was.
    expect(readPrCreated('No PR here.')).toEqual({ text: 'No PR here.', prs: [] });
  });

  it('takes only a github.com pull request’s address for GitHub’s, and names any other by the host a browser would open', () => {
    const pr = (url: string) => readPrCreated(`<pr-created>${url}</pr-created>`).prs[0];
    expect(pr('https://github.com/acme/web/pull/128')).toMatchObject({ host: 'github.com', repo: 'acme/web', github: true });
    // A host made to look like GitHub's, or GitHub's name where a user name goes.
    expect(pr('https://github-com.pr-review.example/acme/acme-web/pull/128')).toEqual({
      url: 'https://github-com.pr-review.example/acme/acme-web/pull/128', host: 'github-com.pr-review.example', repo: 'acme/acme-web', number: 128, github: false,
    });
    expect(pr('https://github.com.evil.example/acme/web/pull/1')).toMatchObject({ host: 'github.com.evil.example', github: false });
    expect(pr('https://github.com@evil.example/acme/web/pull/1')).toMatchObject({ host: 'evil.example', github: false });
    // A name in another script, as the browser reaches it: its punycode.
    expect(pr('https://g\u0456thub.com/acme/web/pull/1')).toMatchObject({ host: 'xn--gthub-n2e.com', github: false });
    // GitHub's own, but not a pull request's address as GitHub gives one: no status asked, the host said.
    expect(pr('http://github.com/acme/web/pull/2')).toMatchObject({ host: 'github.com', github: false });
    expect(pr('https://github.com/acme/web/pull/2/files')).toMatchObject({ host: 'github.com', number: 2, github: false });
    // A pull request's address only further along another's is none.
    expect(pr('https://evil.example/go?to=https://github.com/acme/web/pull/1')).toBeUndefined();
  });

  it('makes at most five cards for a reply: the tags past them stay as their addresses', () => {
    const urls = Array.from({ length: 7 }, (_, i) => `https://github.com/acme/web/pull/${i + 1}`);
    const read = readPrCreated(`Opened them all.\n${urls.map((url) => `<pr-created>${url}</pr-created>`).join('\n')}\nDone.`);
    expect(read.prs.map((pr) => pr.number)).toEqual([1, 2, 3, 4, 5]);
    expect(read.text).toBe(`Opened them all.\n${urls.slice(5).join('\n')}\nDone.`);
  });

  it('leaves a tag still being written out until it is whole', () => {
    expect(readPrCreated('Done.\n<pr-created>https://github.com/acme/we', true).text).toBe('Done.');
    expect(readPrCreated('Done.\n<pr-created>https://github.com/acme/web/pull/3</pr-created>', true).prs).toHaveLength(1);
  });
});
