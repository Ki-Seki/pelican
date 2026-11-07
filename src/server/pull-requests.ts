import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';

import type { PrStatus } from '../shared/protocol.js';
import { GITHUB_PULL } from '../shared/requests.js';
import { config } from './config.js';
import { withoutRepository } from './git.js';

const run = promisify(execFile);

/**
 * A pull request on GitHub, as Claude Desktop's Create PR asks Claude to name one in its
 * `<pr-created>` tag: the only address gh is ever asked about, and only to read it.
 */
export const PULL_URL = GITHUB_PULL;

/** What a page shows of a pull request is read again at most this often, however many pages ask. */
const FRESH_MS = 30_000;
/**
 * The answers of the last half minute, least recently asked for first (an LRU cache): an answer
 * still fresh is never let go of to make room, so no pull request is asked about twice within
 * FRESH_MS, whatever pages ask; with this many fresh, a new one is not asked about at all until
 * one is no longer fresh. More than any conversation's cards (PR_CARDS a reply).
 */
const KEPT = 256;
const cache = new Map<string, { at: number; status: Promise<PrStatus> }>();
const NOT_READ: PrStatus = { live: false };
/** gh runs at once, at most; those asked for meanwhile wait their turn. */
const RUNNING = 4;
let running = 0;
const waiting: Array<() => void> = [];

/** Runs `job` once fewer than RUNNING others run. */
async function inTurn<T>(job: () => Promise<T>): Promise<T> {
  if (running >= RUNNING) await new Promise<void>((resolve) => waiting.push(resolve));
  running += 1;
  try {
    return await job();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

/** The answer kept for a pull request, while fresh, as the most recently asked for now. */
function kept(url: string, now: number): Promise<PrStatus> | undefined {
  const entry = cache.get(url);
  if (!entry) return undefined;
  cache.delete(url);
  if (now - entry.at >= FRESH_MS) return undefined;
  cache.set(url, entry);
  return entry.status;
}

/** Whether a new answer can be kept: answers no longer fresh make room, the least recently asked for first. */
function room(now: number): boolean {
  for (const [url, entry] of cache) {
    if (cache.size < KEPT) break;
    if (now - entry.at >= FRESH_MS) cache.delete(url);
  }
  return cache.size < KEPT;
}

type Check = { __typename?: string; status?: string; conclusion?: string; state?: string };

const FAILED = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR']);

/** A pull request's checks in a word, as GitHub's own summary reads them: failing first, then running, then passing. */
export function checksOf(rollup: readonly Check[] | undefined): 'passing' | 'failing' | 'running' | undefined {
  if (!rollup || rollup.length === 0) return undefined;
  if (rollup.some((check) => FAILED.has(check.conclusion ?? '') || FAILED.has(check.state ?? ''))) return 'failing';
  const running = rollup.some((check) => (check.__typename === 'StatusContext' || check.state !== undefined
    ? check.state === 'PENDING' || check.state === 'EXPECTED'
    : check.status !== 'COMPLETED'));
  return running ? 'running' : 'passing';
}

/** gh's answer for a pull request, as its card shows it; none for anything gh did not say plainly. */
export function readPull(json: string): PrStatus {
  const pull = JSON.parse(json) as { number?: unknown; title?: unknown; state?: unknown; isDraft?: unknown; headRefName?: unknown; baseRefName?: unknown; statusCheckRollup?: unknown };
  const state = typeof pull.state === 'string' ? pull.state.toLowerCase() : '';
  if (typeof pull.number !== 'number' || typeof pull.title !== 'string' || (state !== 'open' && state !== 'closed' && state !== 'merged')) return NOT_READ;
  const checks = checksOf(Array.isArray(pull.statusCheckRollup) ? pull.statusCheckRollup as Check[] : undefined);
  return {
    live: true,
    number: pull.number,
    title: pull.title.slice(0, 300),
    state,
    draft: pull.isDraft === true,
    ...(typeof pull.headRefName === 'string' ? { head: pull.headRefName.slice(0, 250) } : {}),
    ...(typeof pull.baseRefName === 'string' ? { base: pull.baseRefName.slice(0, 250) } : {}),
    ...(checks ? { checks } : {}),
  };
}

/** The demo's pull request, as its session names it: made up, and never looked up anywhere. */
export const DEMO_PULL = 'https://github.com/acme/acme-web/pull/128';
const DEMO_PULLS: Record<string, PrStatus> = {
  [DEMO_PULL]: { live: true, number: 128, title: 'Wait for the CSRF token in the login test', state: 'open', draft: false, head: 'fix/login-test', base: 'main', checks: 'running' },
};

/**
 * What GitHub says of a pull request now, read with the GitHub CLI where it is installed and signed
 * in, as Claude Desktop's live card reads it: its title, whether it is open, a draft, merged or
 * closed, its branches and its checks. Only `gh pr view` on the address, with no prompt, from no
 * repository, in at most 10 seconds, at most RUNNING at once and once in FRESH_MS for a pull
 * request; none where gh is missing, not signed in or says nothing. The demo reads nothing: its
 * pull request is made up.
 */
export function pullRequestStatus(url: string): Promise<PrStatus> {
  if (!PULL_URL.test(url)) return Promise.resolve(NOT_READ);
  if (config.demo) return Promise.resolve(DEMO_PULLS[url] ?? NOT_READ);
  const now = Date.now();
  const known = kept(url, now);
  if (known) return known;
  if (!room(now)) return Promise.resolve(NOT_READ);
  // From no repository: none named by Pelican's environment either, nor git settings of its own.
  const env: NodeJS.ProcessEnv = { ...withoutRepository(process.env), GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_SPINNER_DISABLED: '1', NO_COLOR: '1' };
  for (const name of Object.keys(env)) if (name.startsWith('PELICAN_')) delete env[name];
  const status = inTurn(() => run('gh', ['pr', 'view', url, '--json', 'number,title,state,isDraft,headRefName,baseRefName,statusCheckRollup'], { cwd: os.tmpdir(), env, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }))
    .then(({ stdout }) => readPull(stdout), () => NOT_READ);
  cache.set(url, { at: now, status });
  return status;
}
