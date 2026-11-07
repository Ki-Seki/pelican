import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, GitMerge } from 'lucide-react';

import type { PrStatus } from '../../shared/protocol';
import { api } from '../lib/api';
import type { PrCreated } from '../lib/requests';

const STATE: Record<'open' | 'draft' | 'merged' | 'closed', { word: string; tone: string; icon: typeof GitPullRequest }> = {
  open: { word: 'Open', tone: 'text-add', icon: GitPullRequest },
  draft: { word: 'Draft', tone: 'text-muted', icon: GitPullRequestDraft },
  merged: { word: 'Merged', tone: 'text-run', icon: GitMerge },
  closed: { word: 'Closed', tone: 'text-del', icon: GitPullRequestClosed },
};

const CHECKS: Record<'passing' | 'failing' | 'running', { word: string; tone: string }> = {
  passing: { word: 'checks passed', tone: 'text-faint' },
  failing: { word: 'checks failing', tone: 'text-del' },
  running: { word: 'checks running', tone: 'text-faint' },
};

/** Read again while it may still change: open, its checks running. */
const changing = (status: PrStatus | undefined) => Boolean(status?.live && status.state === 'open' && status.checks === 'running');

/**
 * The pull request Claude made, from Desktop's `<pr-created>` tag in its reply: a card with its
 * title and number, and View PR. Its live status (open, a draft, merged or closed, its branches,
 * its checks) shows only where gh on the computer can read it, as GitHub says it is now, read again
 * every half minute while its checks run; elsewhere the card names the repository alone.
 */
export function PrCard({ pr }: { pr: PrCreated }) {
  const { data } = useQuery({
    queryKey: ['pr', pr.url],
    queryFn: () => api.pr(pr.url),
    staleTime: 30_000,
    retry: false,
    refetchInterval: (query) => (changing(query.state.data) ? 30_000 : false),
  });
  const live = data?.live ? data : undefined;
  const state = live ? STATE[live.state === 'open' && live.draft ? 'draft' : live.state] : undefined;
  const Icon = state?.icon ?? GitPullRequest;
  return (
    <div data-pr-card className="my-2 flex items-center gap-3 rounded-xl border border-line bg-panel py-2.5 pr-2 pl-3.5">
      <Icon aria-hidden className={`size-4 shrink-0 ${state?.tone ?? 'text-muted'}`} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px]">
          {live ? live.title : 'Pull request'} <span className="text-faint">#{pr.number}</span>
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-faint">
          {live && state ? (
            <>
              <span className={`flex shrink-0 items-center gap-1 ${state.tone}`}><span aria-hidden className="size-1.5 rounded-full bg-current" />{state.word}</span>
              {live.head && live.base && <span className="min-w-0 truncate font-mono text-[12px] text-muted">{live.head} → {live.base}</span>}
              {live.checks && <span className={`shrink-0 ${CHECKS[live.checks].tone}`}>· {CHECKS[live.checks].word}</span>}
            </>
          ) : (
            <span className="min-w-0 truncate font-mono text-[12px]">{pr.repo}</span>
          )}
        </div>
      </div>
      <a href={pr.url} target="_blank" rel="noreferrer noopener" className="flex h-9 shrink-0 items-center gap-1 rounded-full px-3 text-[13px] text-muted hover:bg-hover hover:text-fg pointer-coarse:h-11">
        View PR <ArrowUpRight className="size-3.5" />
      </a>
    </div>
  );
}
