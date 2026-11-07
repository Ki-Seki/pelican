import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';

import type { PrStatus } from '../shared/protocol.js';
import { GITHUB_PULL } from '../shared/requests.js';
import { config } from './config.js';

const run = promisify(execFile);

/**
 * A pull request on GitHub, as Claude Desktop's Create PR asks Claude to name one in its
 * `<pr-created>` tag: the only address gh is ever asked about, and only to read it.
 */
export const PULL_URL = GITHUB_PULL;

/** What a page shows of a pull request is read again at most this often, however many pages ask. */
const FRESH_MS = 30_000;
const cache = new Map<string, { at: number; status: Promise<PrStatus> }>();
const NOT_READ: PrStatus = { live: false };

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
 * repository, in at most 10 seconds; none where gh is missing, not signed in or says nothing.
 * The demo reads nothing: its pull request is made up.
 */
export function pullRequestStatus(url: string): Promise<PrStatus> {
  if (!PULL_URL.test(url)) return Promise.resolve(NOT_READ);
  if (config.demo) return Promise.resolve(DEMO_PULLS[url] ?? NOT_READ);
  const kept = cache.get(url);
  if (kept && Date.now() - kept.at < FRESH_MS) return kept.status;
  const env: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_SPINNER_DISABLED: '1', NO_COLOR: '1' };
  for (const name of Object.keys(env)) if (name.startsWith('PELICAN_')) delete env[name];
  const status = run('gh', ['pr', 'view', url, '--json', 'number,title,state,isDraft,headRefName,baseRefName,statusCheckRollup'], { cwd: os.tmpdir(), env, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 })
    .then(({ stdout }) => readPull(stdout), () => NOT_READ);
  cache.set(url, { at: Date.now(), status });
  // A cache of a few dozen is plenty: one card per pull request a conversation names.
  if (cache.size > 64) cache.delete(cache.keys().next().value!);
  return status;
}
