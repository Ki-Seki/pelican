import { CREATE_PR_CLOSE, CREATE_PR_DRAFT, CREATE_PR_OPEN } from '../../shared/quoted';
import type { GitStatus } from '../../shared/protocol';

/**
 * Commit changes and Create PR, as Claude Desktop has them: requests to Claude, in Desktop's own
 * words, byte for byte (its Code tab, 2026-11), so Claude Code reads the same request whichever app
 * sent it, and Desktop shows Pelican's as its own: Create PR as /create-pr. A tap sends one at once,
 * as Desktop's button does; ⌘-click or a long press puts it in the message box first. Claude does
 * the work in the open, with Claude Code's own attribution, hooks and permission rules: Pelican runs
 * no git write of its own, and has no Push (Desktop has none; Create PR pushes).
 */

/** Desktop's Commit changes. */
export const COMMIT_REQUEST = 'Commit the working tree changes with a sensible message.';

/** Desktop's Create PR, ready for review, and Create draft PR: what step 3 says to open the PR with. */
const OPEN_READY = 'Open the PR with `gh pr create`. Do not pass `--draft`: the user chose “Create PR”, not “Create draft PR”, for this request, and that explicit choice overrides any saved memory, standing instruction, or earlier plan to open it as a draft.';
const OPEN_DRAFT = `Open the PR as a draft with ${CREATE_PR_DRAFT}. The user chose “Create draft PR” for this request, so keep \`--draft\` even if you would otherwise open it ready for review.`;

/** Desktop's request where origin is a repository on GitHub. */
const WITH_REMOTE = '## Overview\n\nCreate a pull request for the changes in this session, {{PR_KIND}}.\n\n## Steps\n\n1. Check for uncommitted changes. If any exist, stage and commit them with a message that describes what changed and why.\n2. Push the branch to the remote.\n3. {{OPEN_STEP}} When the target below names a base branch and that branch exists on origin (`git ls-remote --heads origin <base>`), pass it with `--base`; otherwise leave `--base` off and let gh infer it. Write a title that summarizes the change and a body that covers what changed, why, and anything a reviewer should know. If the repo has a PR template, follow it.\n4. Report the PR URL when done. Wrap the URL in a `<pr-created>` tag on its own line so the UI can render a live status card, like this: `<pr-created>https://github.com/owner/repo/pull/123</pr-created>`\n\nIf a PR already exists for this branch, push any new commits and report the existing URL wrapped in the same `<pr-created>` tag instead of creating a duplicate, and leave that PR\'s draft or ready state as it is.';

/** Desktop's request where the folder has no GitHub remote: Claude sets one up first, asking how. */
const NO_REMOTE = '## Overview\n\nThis folder has no GitHub remote. Set one up, then create a pull request, {{PR_KIND}}.\n\n## Steps\n\n1. Check `gh auth status`. If gh isn\'t authenticated, say so and stop — don\'t loop on auth prompts.\n2. Look for a likely existing repo: `gh repo list --limit 100 --json nameWithOwner,url` and match on the folder name.\n3. Use the AskUserQuestion tool to let the user pick the path forward. Offer the options that actually apply — e.g. "Link <owner/repo>" when step 2 found a match, "Create private repo", "Create public repo". The built-in "Other" option covers pasting a URL. Skip the question only if step 2 found exactly one obvious match.\n4. Add the remote (`git remote add origin <url>`) or create it (`gh repo create <name> --private|--public --source=. --remote=origin`).\n5. Commit anything uncommitted and push the branch with `-u`. {{OPEN_STEP}} Set `--base` to the base branch below when the target names one and it exists on origin.\n6. Report the PR URL wrapped in a `<pr-created>` tag on its own line so the UI can render a live status card, like this: `<pr-created>https://github.com/owner/repo/pull/123</pr-created>`';

/** Where a pull request is to come from: `repo`, origin's `owner/name` on GitHub, none where there is no GitHub remote. */
export type PrTarget = { repo?: string; branch: string; cwd?: string; baseBranch?: string; draft: boolean };

/** The base branch a request names: another branch than the PR's, with a plain name; none otherwise (Desktop's). */
export const prBase = (branch: string, base: string | undefined): string | undefined =>
  (base && base !== branch && /^[\w./-]+$/.test(base) ? base : undefined);

/** Desktop's Create PR (or Create draft PR) request, its target at the end: the repository, the branch, the base, the folder. */
export function createPrRequest(target: PrTarget): string {
  const base = prBase(target.branch, target.baseBranch);
  const head = `\n\n## Target\n\n${target.repo ? `Repository: ${target.repo}\n` : ''}Branch: ${target.branch}${base ? `\nBase branch: ${base}` : ''}${target.cwd ? `\nWorking directory: ${target.cwd}` : ''}`;
  const body = (target.repo ? WITH_REMOTE : NO_REMOTE)
    .replace('{{PR_KIND}}', target.draft ? 'as a draft' : 'ready for review (not a draft)')
    .replace('{{OPEN_STEP}}', target.draft ? OPEN_DRAFT : OPEN_READY);
  return `${CREATE_PR_OPEN}\n${body}${head}\n${CREATE_PR_CLOSE}`;
}

/** The requests that apply to a folder as it is now: Commit changes, and Create PR in its two kinds. */
export type Requests = { commit?: string; pr?: { ready: string; draft: string } };

type Repository = Extract<GitStatus, { repo: true }>;

/**
 * What Changes offers at its foot, as all of the changes stand (`git`, by /diff's rule, gitStatus's
 * `base` scope): Commit changes while anything is not committed; Create PR on a branch other than
 * the default one with changes of its own, where origin is on GitHub, or where there is no remote
 * at all (then Claude sets one up first, as Desktop's request says). Another host's remote gets
 * none: the request is GitHub's, as Desktop's is.
 */
export function requestsFor(git: Repository, cwd?: string): Requests {
  const out: Requests = {};
  const uncommitted = git.uncommitted ?? git.files.filter((f) => !f.committed).length;
  if (uncommitted > 0) out.commit = COMMIT_REQUEST;
  const { branch } = git;
  const offers = Boolean(branch) && branch !== (git.base ?? 'main') && git.files.length > 0 && (Boolean(git.github) || !git.remote);
  if (branch && offers) {
    const target = { branch, ...(git.github ? { repo: git.github } : {}), ...(git.base ? { baseBranch: git.base } : {}), ...(cwd ? { cwd } : {}) };
    out.pr = { ready: createPrRequest({ ...target, draft: false }), draft: createPrRequest({ ...target, draft: true }) };
  }
  return out;
}

/* ---------- a pull request Claude made ---------- */

/** A pull request a reply names in Desktop's `<pr-created>` tag. */
export type PrCreated = { url: string; host: string; repo: string; number: number };

const TAG = /<pr-created>\s*(https?:\/\/\S+?)\s*<\/pr-created>/gi;
const PULL = /https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/;
const WORD = /[A-Za-z0-9_-]/;

/** A pull request's address, read as Desktop reads one: its host, `owner/name` and number. */
export function pullOf(url: string): PrCreated | undefined {
  const found = PULL.exec(url);
  return found ? { url, host: found[1]!, repo: `${found[2]}/${found[3]}`, number: Number(found[4]) } : undefined;
}

/**
 * A reply's text with Desktop's `<pr-created>` tags taken out, as Desktop reads them: each pull
 * request it names, for a card, and the text as it reads without them. A tag on a line of its own
 * leaves no line; one among words leaves its address, as Desktop does. While a reply is still
 * coming (`streaming`), a tag not closed yet is left out until it is.
 */
export function readPrCreated(text: string, streaming = false): { text: string; prs: PrCreated[] } {
  if (!text.includes('<pr-created>')) return { text, prs: [] };
  const prs: PrCreated[] = [];
  let out = text.replace(/^[ \t]*<pr-created>\s*(https?:\/\/\S+?)\s*<\/pr-created>[ \t]*(?:\r?\n|$)/gim, (_whole, url: string) => {
    const pr = pullOf(url);
    if (pr) prs.push(pr);
    return pr ? '' : url;
  });
  out = out.replace(TAG, (whole, url: string, at: number, all: string) => {
    const pr = pullOf(url);
    if (pr) prs.push(pr);
    const next = all[at + whole.length];
    return next !== undefined && WORD.test(next) && WORD.test(url.at(-1) ?? '') ? `${url} ` : url;
  });
  if (streaming) out = out.replace(/<pr-created>[^<]*$/i, '');
  const seen = new Set<string>();
  return { text: out.replace(/\n+$/, (end) => (text.endsWith('\n') ? end : '')), prs: prs.filter((pr) => !seen.has(pr.url) && Boolean(seen.add(pr.url))) };
}
