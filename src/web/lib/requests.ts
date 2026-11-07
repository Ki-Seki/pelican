import type { GitStatus } from '../../shared/protocol';
import { COMMIT_REQUEST, createPrRequest } from '../../shared/requests';

export { COMMIT_REQUEST, createPrRequest, prBase, type PrTarget } from '../../shared/requests';

/**
 * Commit changes and Create PR, as Claude Desktop has them: requests to Claude, in Desktop's own
 * words, byte for byte (its Code tab, 2026-11), so Claude Code reads the same request whichever app
 * sent it, and Desktop shows Pelican's as its own: Create PR as /create-pr. A tap sends one at once,
 * as Desktop's button does; ⌘-click or a long press puts it in the message box first. Claude does
 * the work in the open, with Claude Code's own attribution, hooks and permission rules: Pelican runs
 * no git write of its own, and has no Push (Desktop has none; Create PR pushes).
 */

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
