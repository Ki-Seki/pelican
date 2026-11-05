import { useQuery } from '@tanstack/react-query';
import { ChevronDown, GitBranch, History, Loader2, MessageSquare, RefreshCw } from 'lucide-react';
import { useState } from 'react';

import type { GitFile, GitStatus, SessionChanges, TurnChanges } from '../../shared/protocol';
import { api } from '../lib/api';
import { requestsFor } from '../lib/requests';
import type { WorkspaceStep } from '../lib/workspace-route';
import { PathLabel } from './PathLabel';
import { Sheet, SheetOption } from './Sheet';
import { UnifiedDiff } from './UnifiedDiff';

const LETTER: Record<GitFile['status'], string> = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U', conflicted: '!' };
const TONE: Record<GitFile['status'], string> = {
  modified: 'text-wait', added: 'text-add', untracked: 'text-add', deleted: 'text-del', renamed: 'text-run', conflicted: 'text-danger',
};

/**
 * What Changes shows, in the words of Claude Code's /diff: what is not committed yet (the
 * default), everything since the branch split from the default branch, or one turn's edits.
 */
export type Scope = { kind: 'uncommitted' } | { kind: 'base' } | { kind: 'turn'; uuid: string };

export const scopeOf = (step: WorkspaceStep): Scope =>
  !step.scope ? { kind: 'uncommitted' } : step.scope === 'base' ? { kind: 'base' } : { kind: 'turn', uuid: step.scope };

const scopeParam = (scope: Scope) => (scope.kind === 'uncommitted' ? {} : { scope: scope.kind === 'base' ? 'base' : scope.uuid });

const files = (n: number) => (n === 1 ? '1 file' : `${n} files`);
const turnLabel = (turn: TurnChanges) => `T${turn.n} · ${turn.text}`;

/** The turns that changed files, newest first, as the Show list offers them. */
const newestFirst = (changes: SessionChanges | undefined) => [...(changes?.turns ?? [])].reverse();

function useTurns(sessionId: string | undefined, refresh: number | false) {
  return useQuery({
    queryKey: ['changes', sessionId],
    queryFn: () => api.changes(sessionId!),
    enabled: Boolean(sessionId),
    staleTime: 30_000,
    refetchInterval: refresh,
  });
}

/** One changed file in a list: its kind, its name, its comments and its lines. */
function FileRow({ file, comments, onOpen }: { file: { path: string; status: GitFile['status']; added?: number; removed?: number }; comments?: number; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="flex min-h-11 w-full min-w-0 items-center gap-2.5 rounded-lg px-3 py-2 text-left hover:bg-hover pointer-fine:min-h-10">
      <span className={`w-3 shrink-0 text-center font-mono text-[12px] font-semibold ${TONE[file.status]}`} title={file.status}>{LETTER[file.status]}</span>
      <PathLabel path={file.path} />
      <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2 font-mono text-[11.5px]">
        {Boolean(comments) && (
          <span className="flex items-center gap-0.5 text-faint" aria-label={`${comments} comments`}>
            <MessageSquare className="size-3" />{comments}
          </span>
        )}
        {Boolean(file.added) && <span className="text-add">+{file.added}</span>}
        {Boolean(file.removed) && <span className="text-del">−{file.removed}</span>}
      </span>
    </button>
  );
}

/** Choosing what Changes shows, as /diff's source picker: Uncommitted, since the split, or a turn. */
function ShowSheet({ open, onClose, scope, status, base, turns, onPick }: {
  open: boolean;
  onClose: () => void;
  scope: Scope;
  status: GitStatus | undefined;
  base: GitStatus | undefined;
  turns: TurnChanges[];
  onPick: (scope: Scope) => void;
}) {
  const git = status?.repo ? status : undefined;
  const count = (value: GitStatus | undefined) => (value?.repo ? <span className="shrink-0 text-[12.5px] text-faint">{files(value.files.length)}</span> : undefined);
  const pick = (next: Scope) => {
    onPick(next);
    onClose();
  };
  return (
    <Sheet open={open} onClose={onClose} title="Show" done>
      <SheetOption label="Uncommitted" selected={scope.kind === 'uncommitted'} onSelect={() => pick({ kind: 'uncommitted' })} trailing={count(status)} />
      {git?.base && git.branch && git.branch !== git.base && (
        <SheetOption label={`Since ${git.base}`} selected={scope.kind === 'base'} onSelect={() => pick({ kind: 'base' })} trailing={count(base) ?? <Loader2 className="size-3.5 shrink-0 animate-spin text-faint" />} />
      )}
      {turns.map((turn) => (
        <SheetOption
          key={turn.uuid}
          label={<span className="line-clamp-2 break-words">{turnLabel(turn)}</span>}
          selected={scope.kind === 'turn' && scope.uuid === turn.uuid}
          onSelect={() => pick({ kind: 'turn', uuid: turn.uuid })}
          trailing={<span className="shrink-0 text-[12.5px] text-faint">{files(turn.files.length)}</span>}
        />
      ))}
    </Sheet>
  );
}

/**
 * The Changes tab: the branch, what Changes shows, and the changed files, each opening its diff.
 * Git only where it may run (the server says so); a turn's edits come from Claude Code's own
 * records and show in any folder. A turn ends with Rewind code when Claude Code kept the files
 * as they were before it.
 */
export function WorkspaceChanges({ cwd, sessionId, step, looking, busy, status, commentsIn, go, setScope, onRewind, onRequest }: {
  cwd: string;
  sessionId?: string;
  step: WorkspaceStep;
  /** The tab is on screen: what it shows is read again while it is. */
  looking: boolean;
  busy: boolean;
  status: { data: GitStatus | undefined; isLoading: boolean; isFetching: boolean; refetch: () => unknown };
  commentsIn: Map<string, number>;
  go: (step: WorkspaceStep) => void;
  setScope: (step: WorkspaceStep) => void;
  onRewind?: (uuid: string) => void;
  /** Puts a request to Claude in the message box (Commit, Push, Create PR), to be sent from there. */
  onRequest?: (text: string) => void;
}) {
  const scope = scopeOf(step);
  const [picking, setPicking] = useState(false);
  const turns = useTurns(sessionId, looking && busy && scope.kind === 'turn' ? 5_000 : false);
  const git = status.data?.repo ? status.data : undefined;
  const offersBase = Boolean(git?.base && git.branch && git.branch !== git.base);
  const base = useQuery({
    queryKey: ['git', cwd, 'base'],
    queryFn: () => api.git(cwd, 'base'),
    enabled: offersBase && (scope.kind === 'base' || picking),
    refetchInterval: looking && scope.kind === 'base' ? (busy ? 5_000 : 30_000) : false,
  });
  const turn = scope.kind === 'turn' ? turns.data?.turns.find((t) => t.uuid === scope.uuid) : undefined;
  const shown = step.path && !step.path.endsWith('/') ? step.path : undefined;
  const renamedFrom = scope.kind === 'turn' ? undefined : [scope.kind === 'base' ? base.data : status.data].flatMap((s) => (s?.repo ? s.files : [])).find((f) => f.path === shown)?.from;
  const diff = useQuery({
    queryKey: ['diff', cwd, sessionId, step.scope ?? '', shown ?? '', renamedFrom ?? ''],
    queryFn: () => (scope.kind === 'turn' ? api.turnDiff(sessionId!, scope.uuid, shown!) : api.gitDiff(cwd, shown!, scope.kind === 'base' ? 'base' : undefined, renamedFrom)),
    enabled: Boolean(shown) && (scope.kind !== 'turn' || Boolean(sessionId)),
  });

  if (shown) {
    return (
      <div className="px-1 pb-4">
        {diff.isLoading ? <div className="flex justify-center py-10 text-faint"><Loader2 className="size-5 animate-spin" /></div> : <UnifiedDiff diff={diff.data ?? ''} path={shown} cwd={cwd} />}
      </div>
    );
  }

  const choices = 1 + (offersBase ? 1 : 0) + (turns.data?.turns.length ?? 0);
  const label = scope.kind === 'uncommitted' ? 'Uncommitted' : scope.kind === 'base' ? `Since ${git?.base ?? 'the branch split'}` : turn ? turnLabel(turn) : 'A turn';
  const open = (path: string) => go({ tab: 'changes', path, ...scopeParam(scope) });
  // Uncommitted, the files this session changed come first, as in Claude Code's diff panel.
  const ours = new Set(turns.data?.turns.flatMap((t) => t.files.map((f) => f.path)) ?? []);
  const oursFirst = (list: GitFile[]) => [...list.filter((f) => ours.has(f.path)), ...list.filter((f) => !ours.has(f.path))];
  const list = scope.kind === 'turn'
    ? turn?.files.map((file) => ({ path: file.path, status: file.created ? 'added' as const : 'modified' as const, added: file.added, removed: file.removed }))
    : scope.kind === 'base' ? (base.data?.repo ? base.data.files : undefined) : git && oursFirst(git.files);
  const loading = scope.kind === 'turn' ? turns.isLoading : scope.kind === 'base' ? base.isLoading : status.isLoading;

  return (
    <div>
      {git && (
        <div className="flex min-w-0 items-center gap-1.5 px-3 pb-1 text-[12.5px] text-muted">
          <GitBranch className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate font-mono">{git.branch ?? 'detached'}</span>
          {Boolean(git.ahead) && <span className="shrink-0 text-faint">· {git.ahead} ahead</span>}
          {Boolean(git.behind) && <span className="shrink-0 text-faint">· {git.behind} behind</span>}
          <button type="button" aria-label="Refresh" onClick={() => void status.refetch()} className="-my-1.5 ml-auto grid size-10 shrink-0 place-items-center rounded-full text-faint hover:bg-hover hover:text-fg">
            <RefreshCw className={`size-3.5 ${status.isFetching ? 'animate-spin' : ''}`} />
          </button>
        </div>
      )}
      {git && onRequest && requestsFor(git).length > 0 && (
        // Requests to Claude, as Claude Desktop's Create PR is: into the message box, sent from there.
        <div className="flex flex-wrap gap-1.5 px-3 pt-0.5 pb-2">
          {requestsFor(git).map((request) => (
            <button key={request.label} type="button" title="Ask Claude to do it: the request goes into the message box" onClick={() => onRequest(request.text)} className="h-8 rounded-full border border-line px-3 text-[13px] text-muted hover:bg-hover hover:text-fg pointer-coarse:h-9">
              {request.label}
            </button>
          ))}
        </div>
      )}
      {choices > 1 && (
        <button type="button" onClick={() => setPicking(true)} aria-haspopup="dialog" className="mx-1 mb-1 flex min-h-10 max-w-[calc(100%-0.5rem)] items-center gap-1 rounded-lg px-2 text-left text-[13px] hover:bg-hover">
          <span className="shrink-0 text-faint">Show:</span>
          <span className="min-w-0 truncate">{label}</span>
          <ChevronDown className="size-3.5 shrink-0 text-faint" />
        </button>
      )}
      {loading && <div className="flex justify-center py-10 text-faint"><Loader2 className="size-5 animate-spin" /></div>}
      {scope.kind !== 'turn' && status.data && !status.data.repo && (
        <div className="px-3 py-10 text-center text-[13px] text-faint">
          {status.data.untrusted ? 'Changes show once this folder is trusted.' : 'This folder is not a git repository'}
        </div>
      )}
      {list?.length === 0 && (
        <div className="px-3 py-8 text-center text-[13px] text-faint">
          {scope.kind === 'base' ? `Nothing changed since the branch split from ${git?.base ?? 'the default branch'}` : 'Nothing changed since the last commit'}
        </div>
      )}
      {scope.kind === 'turn' && !turns.isLoading && !turn && <div className="px-3 py-8 text-center text-[13px] text-faint">That turn changed no files</div>}
      {list?.map((file) => <FileRow key={file.path} file={file} comments={commentsIn.get(file.path)} onOpen={() => open(file.path)} />)}
      {turn?.checkpoint && onRewind && (
        <button type="button" onClick={() => onRewind(turn.uuid)} className="mt-1 flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13.5px] text-muted hover:bg-hover hover:text-fg pointer-fine:min-h-10">
          <History className="size-4 shrink-0" />
          Rewind code
        </button>
      )}
      <ShowSheet
        open={picking}
        onClose={() => setPicking(false)}
        scope={scope}
        status={status.data}
        base={base.data}
        turns={newestFirst(turns.data)}
        onPick={(next) => setScope({ tab: 'changes', ...scopeParam(next) })}
      />
    </div>
  );
}
