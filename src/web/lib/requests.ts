import type { GitStatus } from '../../shared/protocol';
import { COMMIT_REQUEST, createPrRequest, GITHUB_PULL } from '../../shared/requests';

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

/**
 * A pull request a reply names in Desktop's `<pr-created>` tag: its host as the address reaches
 * it, and `github` for a github.com pull request's address exactly (GITHUB_PULL), the only one whose
 * card names its repository as GitHub's and asks what GitHub says of it.
 */
export type PrCreated = { url: string; host: string; repo: string; number: number; github: boolean };

const TAG = /<pr-created>\s*(https?:\/\/\S+?)\s*<\/pr-created>/gi;
/** The path of a pull request's address: `/owner/name/pull/n`, and perhaps more after it (`/files`). */
const PULL_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d{1,10})(?:\/|$)/;
const WORD = /[A-Za-z0-9_-]/;

/**
 * A pull request's address, read as the browser that opens it reads it: its host (a name in
 * another script as its punycode, without a user name or password), `owner/name` and number.
 */
export function pullOf(url: string): PrCreated | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const found = PULL_PATH.exec(parsed.pathname);
  if (!/^https?:$/.test(parsed.protocol) || !parsed.host || !found) return undefined;
  return { url, host: parsed.host, repo: `${found[1]}/${found[2]}`, number: Number(found[3]), github: GITHUB_PULL.test(url) };
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
  /** The pull request a tag names, for a card, once however often it is named. */
  const card = (url: string) => {
    const pr = pullOf(url);
    if (pr && !prs.some((other) => other.url === pr.url)) prs.push(pr);
    return pr;
  };
  let out = text.replace(/^[ \t]*<pr-created>\s*(https?:\/\/\S+?)\s*<\/pr-created>[ \t]*(?:\r?\n|$)/gim, (whole: string, url: string) => {
    if (card(url)) return '';
    return whole.endsWith('\n') ? `${url}\n` : url;
  });
  out = out.replace(TAG, (whole, url: string, at: number, all: string) => {
    card(url);
    const next = all[at + whole.length];
    return next !== undefined && WORD.test(next) && WORD.test(url.at(-1) ?? '') ? `${url} ` : url;
  });
  if (streaming) out = out.replace(/<pr-created>[^<]*$/i, '');
  return { text: out.replace(/\n+$/, (end) => (text.endsWith('\n') ? end : '')), prs };
}
