import type { GitStatus } from '../../shared/protocol';

/**
 * Commit, Push and Create PR, as requests to Claude in the conversation, the way Claude Desktop's
 * Create PR is: they fill the message box, to be read and changed before sending, and Claude does
 * the work in the open, with Claude Code's own attribution, hooks and permission rules. Pelican
 * runs no git write of its own.
 */
export type Request = { label: 'Commit' | 'Push' | 'Create PR'; text: string };

type Repository = Extract<GitStatus, { repo: true }>;

/** The requests that apply to a repository as it is now, in the order they are usually made. */
export function requestsFor(git: Repository): Request[] {
  const branch = git.branch;
  const out: Request[] = [];
  if (git.files.length > 0) out.push({ label: 'Commit', text: 'Commit the uncommitted changes, with a message that says what changed and why.' });
  if (branch && (git.ahead || (!git.upstream && branch !== git.base))) {
    out.push({ label: 'Push', text: git.upstream ? `Push ${branch} to ${git.upstream}.` : `Push ${branch}, and set its upstream.` });
  }
  if (branch && git.base && branch !== git.base) {
    out.push({ label: 'Create PR', text: `Create a pull request from ${branch} into ${git.base}: push the branch if needed, and give the pull request a title and a description of the changes.` });
  }
  return out;
}
