/**
 * Commit changes and Create PR, as Claude Desktop has them: requests to Claude, in Desktop's own
 * words, byte for byte (its Code tab, 2026-11), so Claude Code reads the same request whichever app
 * sent it, and Desktop shows Pelican's as its own: Create PR as /create-pr. The page sends them
 * (web/lib/requests); the demo writes them into its made-up sessions.
 */

/** Claude Desktop's Create PR request is wrapped in this tag, whole; it shows as /create-pr. */
export const CREATE_PR_OPEN = '<create-pr-command>';
export const CREATE_PR_CLOSE = '</create-pr-command>';
/** What a Create draft PR request holds and a Create PR one does not. */
export const CREATE_PR_DRAFT = '`gh pr create --draft`';

/**
 * A request Claude Desktop shows as a command, as it shows it: Create PR as `/create-pr`, Create
 * draft PR as `/create-pr --draft`; none for any other message. Only the text decides, as in Desktop.
 */
export function requestShown(text: string): string | undefined {
  const whole = text.trim();
  if (!whole.startsWith(CREATE_PR_OPEN) || !whole.endsWith(CREATE_PR_CLOSE)) return undefined;
  const inside = whole.slice(CREATE_PR_OPEN.length, whole.length - CREATE_PR_CLOSE.length);
  if (inside.includes(CREATE_PR_OPEN) || inside.includes(CREATE_PR_CLOSE)) return undefined;
  return whole.includes(CREATE_PR_DRAFT) ? '/create-pr --draft' : '/create-pr';
}

/**
 * A message Claude Code made of prompts taken together (queued while Claude worked, then read as
 * one), as Desktop shows its parts: each Create PR request in it, whole on lines of its own, as the
 * command it shows, the rest as typed. None where no part is one.
 */
export function partsShown(text: string): string | undefined {
  let found = false;
  const shown = text.replace(/(^|\n)([ \t]*<create-pr-command>[\s\S]*?<\/create-pr-command>[ \t]*)(?=\n|$)/g, (whole, start: string, part: string) => {
    const command = requestShown(part);
    if (!command) return whole;
    found = true;
    return `${start}${command}`;
  });
  return found ? shown.replace(/\n{3,}/g, '\n\n') : undefined;
}

/** Desktop's Commit changes. */
export const COMMIT_REQUEST = 'Commit the working tree changes with a sensible message.';

/** One of Desktop's requests, as sent from Changes: a message of its own, as Desktop sends each. */
export const isRequest = (text: string): boolean => text === COMMIT_REQUEST || requestShown(text) !== undefined;

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
