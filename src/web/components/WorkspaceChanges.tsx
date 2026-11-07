import { useQuery } from '@tanstack/react-query';
import { ChevronDown, GitBranch, GitCommitHorizontal, GitPullRequest, Loader2, MessageSquare, RefreshCw } from 'lucide-react';
import { type MouseEvent, useEffect, useRef, useState } from 'react';

import type { GitFile, GitStatus, QueuedPrompt, SessionChanges, TurnChanges } from '../../shared/protocol';
import { entries, type MenuEntry, PATH_ACTIONS, PROMPT_ACTIONS, type PathTarget } from '../lib/actions';
import { announce } from '../lib/announce';
import { api } from '../lib/api';
import { addWaiting } from '../lib/drafts';
import { baseName } from '../lib/format';
import { hasKeyboard, MOD } from '../lib/keyboard';
import { setPrefs, usePrefs } from '../lib/prefs';
import { type Press, useLongPress } from '../lib/press';
import { fileItem } from '../lib/quote';
import { requestsFor } from '../lib/requests';
import { useCommentsChat } from '../lib/review';
import type { WorkspaceStep } from '../lib/workspace-route';
import { ActionMenu, type MenuAnchor } from './ActionMenu';
import { PathLabel } from './PathLabel';
import { downloadFile } from './PathMenu';
import type { RewindPoint } from './Rewind';
import { UnifiedDiff } from './UnifiedDiff';

const LETTER: Record<GitFile['status'], string> = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U', conflicted: '!' };
const TONE: Record<GitFile['status'], string> = {
  modified: 'text-wait', added: 'text-add', untracked: 'text-add', deleted: 'text-del', renamed: 'text-run', conflicted: 'text-danger',
};

/**
 * What Changes shows, in Claude Desktop's words: All changes (the default, by Claude Code's /diff:
 * the branch against where it split from the default branch when it has commits beyond it, else
 * what is not committed), Uncommitted changes (offered where that differs), or one turn's edits,
 * Pelican's own, under their own heading.
 */
export type Scope = { kind: 'all' } | { kind: 'uncommitted' } | { kind: 'turn'; uuid: string };

/** The address's `t`: none (or `base`, as 0.4 wrote it) for All changes, `uncommitted`, or a turn's prompt. */
export const scopeOf = (step: WorkspaceStep): Scope =>
  (!step.scope || step.scope === 'base' ? { kind: 'all' } : step.scope === 'uncommitted' ? { kind: 'uncommitted' } : { kind: 'turn', uuid: step.scope });

const scopeParam = (scope: Scope) => (scope.kind === 'all' ? {} : { scope: scope.kind === 'uncommitted' ? 'uncommitted' : scope.uuid });

const files = (n: number) => (n === 1 ? '1 file' : `${n} files`);

/** How long a request's button stays still after the request landed: until its queued state has come. */
const SETTLING_MS = 1000;

/** The turns that changed files, newest first, as Show offers them. */
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

type Row = { path: string; status: GitFile['status']; added?: number; removed?: number };

/** Where a row's menu opens: under a finger, raised over the dim; at the pointer; or under the row from the keyboard. */
type MenuAt = { path: string; status: GitFile['status']; at: MenuAnchor; lift?: Element; keys?: boolean };
type Where = Omit<MenuAt, 'path' | 'status'>;

const menuAt = (p: Press): Where => (p.pointerType === 'touch' || p.pointerType === 'pen' ? { at: p.element, lift: p.element } : p.pointerType === 'keyboard' ? { at: p.element, keys: true } : { at: { x: p.x, y: p.y } });

/** One changed file: its kind, its name, its comments and its lines; a long press or a right-click opens its path's menu. */
function FileRow({ file, comments, onOpen, onMenu }: { file: Row; comments?: number; onOpen: () => void; onMenu: (at: Where) => void }) {
  const press = useLongPress<HTMLButtonElement>((p) => onMenu(menuAt(p)));
  return (
    <button type="button" onClick={onOpen} {...press} className={`flex min-h-11 w-full min-w-0 items-center gap-2.5 rounded-lg px-3 py-2 text-left hover:bg-hover pointer-fine:min-h-10 ${press.className}`}>
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

/**
 * A request queued for the end of Claude's turn, where its button was: its name, that it is
 * queued, and Take back, which takes it out of the queue, as the queue above the message box does.
 */
function QueuedRequest({ icon: Icon, label, onTakeBack }: { icon: typeof GitCommitHorizontal; label: string; onTakeBack: () => void }) {
  return (
    <div role="group" aria-label={`${label}, queued`} title="Queued: sent when this turn ends" className="flex h-11 items-center rounded-full bg-bg text-[14px] ring-1 ring-line pointer-fine:h-9 pointer-fine:text-[13.5px]">
      <span className="flex items-center gap-2 pr-3 pl-4 text-muted">
        <Icon className="size-4 shrink-0 text-faint" />
        {label}
        <span className="text-faint">· Queued</span>
      </span>
      <span aria-hidden className="h-5 w-px shrink-0 bg-line" />
      <button type="button" onClick={onTakeBack} className="h-full rounded-r-full pr-4 pl-3 text-fg hover:bg-hover">Take back</button>
    </div>
  );
}

/**
 * Commit changes and Create PR at the foot of Changes, as Claude Desktop has them: requests to
 * Claude in Desktop's words. A tap sends one at once; while Claude works it is queued for the end
 * of the turn, never steered into it, whatever Settings says for what is typed, and its button says
 * so, with Take back. ⌘-click (Ctrl-click), or a long press on a phone, puts it in the message box
 * first. Create PR's ▾ picks Create PR or Create draft PR for the button, remembered here as
 * Desktop remembers it. There is no Push: Create PR pushes.
 */
function RequestsFoot({ commit, pr, onRequest, queued = [], onUnqueue }: {
  commit?: string;
  pr?: { ready: string; draft: string };
  onRequest: (text: string, how: 'send' | 'box') => Promise<void> | void;
  /** What waits for the end of Claude's turn, a request among it. */
  queued?: QueuedPrompt[];
  onUnqueue?: (uuid: string) => void;
}) {
  const { prKind } = usePrefs();
  const [kinds, setKinds] = useState<{ at: MenuAnchor; keys: boolean }>();
  const prText = pr && (prKind === 'draft' ? pr.draft : pr.ready);
  const prLabel = prKind === 'draft' ? 'Create draft PR' : 'Create PR';
  const waiting = (text: string | undefined) => (text ? queued.find((prompt) => prompt.text === text) : undefined);
  const commitQueued = waiting(commit);
  // Either kind, as it was sent: the ▾ may have changed since.
  const prQueued = pr && (waiting(pr.ready) ?? waiting(pr.draft));
  const commitPress = useLongPress<HTMLButtonElement>(() => commit && onRequest(commit, 'box'), { enabled: Boolean(commit) });
  const prPress = useLongPress<HTMLButtonElement>(() => prText && onRequest(prText, 'box'), { enabled: Boolean(prText) });
  // A request on its way, and a moment after it lands, while its button says it is queued: a
  // second tap (a double tap, a tap before the button changes) sends nothing more. That moment's
  // timer goes with the foot, and none starts once the foot has gone.
  const [going, setGoing] = useState<string>();
  const goingNow = useRef<string>(undefined);
  const settling = useRef<ReturnType<typeof setTimeout>>(undefined);
  const shown = useRef(false);
  useEffect(() => {
    shown.current = true;
    return () => {
      shown.current = false;
      clearTimeout(settling.current);
    };
  }, []);
  const send = (text: string) => {
    if (goingNow.current === text) return;
    goingNow.current = text;
    setGoing(text);
    void Promise.resolve(onRequest(text, 'send')).finally(() => {
      if (!shown.current) return;
      clearTimeout(settling.current);
      settling.current = setTimeout(() => {
        if (goingNow.current !== text) return;
        goingNow.current = undefined;
        setGoing(undefined);
      }, SETTLING_MS);
    });
  };
  const click = (text: string) => (e: MouseEvent) => (e.metaKey || e.ctrlKey ? void onRequest(text, 'box') : send(text));
  // Its menu is the button's own: a right-click on it opens none of the page's.
  const own = (e: MouseEvent) => e.stopPropagation();
  const title = (label: string) => (hasKeyboard() ? `${label} (${MOD}-click: in the message box first)` : undefined);
  // Drawn with a ring, outside their box: each is a finger's 44 px tall on a phone, its border included.
  const pill = 'flex h-11 items-center gap-2 rounded-full bg-bg text-[14px] text-fg ring-1 ring-line hover:bg-hover pointer-fine:h-9 pointer-fine:text-[13.5px]';
  const kindEntries: MenuEntry[] = [
    { id: 'ready', label: 'Create PR', checked: prKind !== 'draft', run: () => setPrefs({ prKind: 'ready' }) },
    { id: 'draft', label: 'Create draft PR', checked: prKind === 'draft', run: () => setPrefs({ prKind: 'draft' }) },
  ];
  if (!commit && !prText) return null;
  return (
    <div data-requests className="mx-3 mt-2 flex flex-wrap gap-2.5 border-t border-line px-px pt-3">
      {commit && commitQueued && onUnqueue && <QueuedRequest icon={GitCommitHorizontal} label="Commit changes" onTakeBack={() => onUnqueue(commitQueued.uuid)} />}
      {commit && !(commitQueued && onUnqueue) && (
        <button type="button" {...commitPress} onContextMenu={(e) => { commitPress.onContextMenu(e); own(e); }} onClick={click(commit)} disabled={going === commit} title={title('Commit changes')} className={`${pill} px-4 disabled:opacity-60 ${commitPress.className}`}>
          <GitCommitHorizontal className="size-4 shrink-0 text-muted" />
          Commit changes
        </button>
      )}
      {pr && prQueued && onUnqueue && (
        <QueuedRequest icon={GitPullRequest} label={prQueued.text === pr.draft ? 'Create draft PR' : 'Create PR'} onTakeBack={() => onUnqueue(prQueued.uuid)} />
      )}
      {prText && !(prQueued && onUnqueue) && (
        <div className="flex h-11 items-center rounded-full bg-bg ring-1 ring-line pointer-fine:h-9">
          <button type="button" {...prPress} onContextMenu={(e) => { prPress.onContextMenu(e); own(e); }} onClick={click(prText)} disabled={going === pr.ready || going === pr.draft} title={title(prLabel)} className={`flex h-full items-center gap-2 rounded-l-full pr-3 pl-4 text-[14px] text-fg hover:bg-hover disabled:opacity-60 pointer-fine:text-[13.5px] ${prPress.className}`}>
            <GitPullRequest className="size-4 shrink-0 text-muted" />
            {prLabel}
          </button>
          <span aria-hidden className="h-5 w-px shrink-0 bg-line" />
          <button
            type="button"
            aria-label="Create PR or Create draft PR"
            aria-haspopup="menu"
            aria-expanded={Boolean(kinds)}
            onClick={(e) => setKinds({ at: e.currentTarget, keys: e.detail === 0 })}
            className="grid h-full w-11 place-items-center rounded-r-full text-muted hover:bg-hover hover:text-fg pointer-fine:w-9"
          >
            <ChevronDown className="size-4" />
          </button>
          <ActionMenu open={Boolean(kinds)} onClose={() => setKinds(undefined)} label="Create PR" title="Create PR" entries={kindEntries} at={kinds?.at ?? null} focusFirst={Boolean(kinds?.keys)} />
        </div>
      )}
    </div>
  );
}

/**
 * The Changes tab: the branch, what Changes shows, the changed files, each opening its diff, and
 * at its foot Commit changes and Create PR. Git only where it may run (the server says so); a
 * turn's edits come from Claude Code's own records and show in any folder. A turn ends with its
 * prompt's Rewind to here. A file's row has its path's menu, as Desktop's diff file list does.
 */
export function WorkspaceChanges({ cwd, sessionId, step, looking, busy, status, commentsIn, go, setScope, onRewind, onRequest, queued, onUnqueue }: {
  cwd: string;
  sessionId?: string;
  step: WorkspaceStep;
  /** The tab is on screen: what it shows is read again while it is. */
  looking: boolean;
  busy: boolean;
  /** All of the changes, by /diff's rule (the `base` scope): the branch, and what the foot offers. */
  status: { data: GitStatus | undefined; isLoading: boolean; isFetching: boolean; refetch: () => unknown };
  commentsIn: Map<string, number>;
  go: (step: WorkspaceStep) => void;
  setScope: (step: WorkspaceStep) => void;
  /** Rewind to here, on the turn's prompt (Chat asks first). */
  onRewind?: (point: RewindPoint) => void;
  /** A request to Claude (Commit changes, Create PR): sent now, or put in the message box first. */
  onRequest?: (text: string, how: 'send' | 'box') => Promise<void> | void;
  /** What waits for the end of Claude's turn, and taking one out of the queue: a request queued shows on its button. */
  queued?: QueuedPrompt[];
  onUnqueue?: (uuid: string) => void;
}) {
  const scope = scopeOf(step);
  const chat = useCommentsChat(cwd);
  const [picking, setPicking] = useState<{ at: MenuAnchor; keys: boolean }>();
  const [rowMenu, setRowMenu] = useState<MenuAt>();
  const turns = useTurns(sessionId, looking && busy && scope.kind === 'turn' ? 5_000 : false);
  const git = status.data?.repo ? status.data : undefined;
  const uncommitted = useQuery({
    queryKey: ['git', cwd],
    queryFn: () => api.git(cwd),
    enabled: scope.kind === 'uncommitted',
    refetchInterval: looking && scope.kind === 'uncommitted' ? (busy ? 5_000 : 30_000) : false,
  });
  const turn = scope.kind === 'turn' ? turns.data?.turns.find((t) => t.uuid === scope.uuid) : undefined;
  const shown = step.path && !step.path.endsWith('/') ? step.path : undefined;
  const gitList = scope.kind === 'all' ? status.data : scope.kind === 'uncommitted' ? uncommitted.data : undefined;
  const renamedFrom = gitList?.repo ? gitList.files.find((f) => f.path === shown)?.from : undefined;
  const diff = useQuery({
    queryKey: ['diff', cwd, sessionId, step.scope ?? '', shown ?? '', renamedFrom ?? ''],
    queryFn: () => (scope.kind === 'turn' ? api.turnDiff(sessionId!, scope.uuid, shown!) : api.gitDiff(cwd, shown!, scope.kind === 'all' ? 'base' : undefined, renamedFrom)),
    enabled: Boolean(shown) && (scope.kind !== 'turn' || Boolean(sessionId)),
  });

  if (shown) {
    return (
      <div className="px-1 pb-4">
        {/* Each file's diff starts fresh: a comment being written on one never moves to another. */}
        {diff.isLoading ? <div className="flex justify-center py-10 text-faint"><Loader2 className="size-5 animate-spin" /></div> : <UnifiedDiff key={`${cwd}\0${step.scope ?? ''}\0${shown}`} diff={diff.data ?? ''} path={shown} cwd={cwd} />}
      </div>
    );
  }

  const newest = newestFirst(turns.data);
  const offersUncommitted = Boolean(git?.split);
  const choices = 1 + (offersUncommitted ? 1 : 0) + newest.length;
  const label = scope.kind === 'all' ? 'All changes' : scope.kind === 'uncommitted' ? 'Uncommitted changes' : turn?.text ?? 'A turn';
  const open = (path: string) => go({ tab: 'changes', path, ...scopeParam(scope) });
  // The files this session changed come first among those not committed, as in Claude Code's diff panel.
  const ours = new Set(turns.data?.turns.flatMap((t) => t.files.map((f) => f.path)) ?? []);
  const oursFirst = (list: GitFile[]) => [...list.filter((f) => !f.committed && ours.has(f.path)), ...list.filter((f) => !f.committed && !ours.has(f.path)), ...list.filter((f) => f.committed)];
  const list: Row[] | undefined = scope.kind === 'turn'
    ? turn?.files.map((file) => ({ path: file.path, status: file.created ? 'added' as const : 'modified' as const, added: file.added, removed: file.removed }))
    : gitList?.repo ? oursFirst(gitList.files) : undefined;
  const loading = scope.kind === 'turn' ? turns.isLoading : scope.kind === 'uncommitted' ? uncommitted.isLoading : status.isLoading;
  const requests = git && onRequest && scope.kind !== 'turn' ? requestsFor(git, cwd) : undefined;
  const pick = (next: Scope) => setScope({ tab: 'changes', ...scopeParam(next) });
  const showEntries: MenuEntry[] = [
    { id: 'all', label: 'All changes', checked: scope.kind === 'all', ...(git?.base ? { hint: `vs ${git.base}` } : {}), run: () => pick({ kind: 'all' }) },
    ...(offersUncommitted ? [{ id: 'uncommitted', label: 'Uncommitted changes', checked: scope.kind === 'uncommitted', ...(git?.uncommitted !== undefined ? { hint: files(git.uncommitted) } : {}), run: () => pick({ kind: 'uncommitted' }) }] : []),
    ...newest.map((t: TurnChanges, i): MenuEntry => ({
      id: `turn-${t.uuid}`,
      label: t.text,
      checked: scope.kind === 'turn' && scope.uuid === t.uuid,
      hint: files(t.files.length),
      ...(i === 0 ? { heading: 'Turns', rule: true } : {}),
      run: () => pick({ kind: 'turn', uuid: t.uuid }),
    })),
  ];
  const deleted = (row: MenuAt) => row.status === 'deleted';
  const pathTarget = (row: MenuAt): PathTarget => ({
    path: row.path,
    cwd,
    ...(!deleted(row) ? {
      attach: () => {
        if (addWaiting(chat, fileItem(row.path))) announce(`${baseName(row.path)} goes with your message`);
      },
      openInFiles: () => go({ tab: 'files', path: row.path }),
      download: () => downloadFile(cwd, row.path),
    } : {}),
  });

  return (
    <div>
      {git && (
        <div className="flex min-w-0 items-center gap-1.5 px-3 pb-1 text-[12.5px] text-muted">
          <GitBranch className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate font-mono">{git.branch ?? 'detached'}</span>
          {Boolean(git.ahead) && <span className="shrink-0 text-faint">· {git.ahead} ahead</span>}
          {Boolean(git.behind) && <span className="shrink-0 text-faint">· {git.behind} behind</span>}
          <button type="button" aria-label="Refresh" onClick={() => void status.refetch()} className="-my-2 ml-auto grid size-11 shrink-0 place-items-center rounded-full text-faint hover:bg-hover hover:text-fg pointer-fine:-my-1.5 pointer-fine:size-10">
            <RefreshCw className={`size-3.5 ${status.isFetching ? 'animate-spin' : ''}`} />
          </button>
        </div>
      )}
      {choices > 1 && (
        <button
          type="button"
          onClick={(e) => setPicking({ at: e.currentTarget, keys: e.detail === 0 })}
          aria-haspopup="menu"
          aria-expanded={Boolean(picking)}
          className="mx-1 mb-1 flex min-h-11 max-w-[calc(100%-0.5rem)] items-center gap-1 rounded-lg px-2 text-left text-[13px] hover:bg-hover pointer-fine:min-h-10"
        >
          <span className="shrink-0 text-faint">Show:</span>
          <span className="min-w-0 truncate">{label}</span>
          {scope.kind === 'all' && git?.base && <span className="shrink-0 text-faint">vs {git.base}</span>}
          <ChevronDown className="size-3.5 shrink-0 text-faint" />
        </button>
      )}
      {loading && <div className="flex justify-center py-10 text-faint"><Loader2 className="size-5 animate-spin" /></div>}
      {scope.kind !== 'turn' && gitList && !gitList.repo && (
        <div className="px-3 py-10 text-center text-[13px] text-faint">
          {gitList.untrusted ? 'Changes show once this folder is trusted.' : 'This folder is not a git repository'}
        </div>
      )}
      {list?.length === 0 && (
        <div className="px-3 py-8 text-center text-[13px] text-faint">
          {scope.kind === 'all' && git?.split ? `Nothing changed since the branch split from ${git.base}` : 'Nothing changed since the last commit'}
        </div>
      )}
      {scope.kind === 'turn' && !turns.isLoading && !turn && <div className="px-3 py-8 text-center text-[13px] text-faint">That turn changed no files</div>}
      {list?.map((file) => (
        <FileRow key={file.path} file={file} comments={commentsIn.get(file.path)} onOpen={() => open(file.path)} onMenu={(at) => setRowMenu({ path: file.path, status: file.status, ...at })} />
      ))}
      {/* The turn's prompt's own Rewind to here (lib/actions): its dialog offers the code back where Claude Code kept a copy. */}
      {turn && onRewind && entries(PROMPT_ACTIONS, { text: turn.text, rewind: () => onRewind({ uuid: turn.uuid, text: turn.text, ...(turn.at ? { timestamp: turn.at } : {}) }) }, 'menu', 'touch')
        .filter((entry) => entry.id === 'rewind')
        .map((entry) => 'run' in entry && (
          <button key={entry.id} type="button" onClick={entry.run} className="mt-1 flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13.5px] text-muted hover:bg-hover hover:text-fg pointer-fine:min-h-10">
            {entry.icon && <entry.icon className="size-4 shrink-0" />}
            {entry.label}
          </button>
        ))}
      {requests && onRequest && <RequestsFoot {...requests} onRequest={onRequest} {...(queued ? { queued } : {})} {...(onUnqueue ? { onUnqueue } : {})} />}
      <ActionMenu
        open={Boolean(picking)}
        onClose={() => setPicking(undefined)}
        label="Show"
        title="Show"
        entries={showEntries}
        at={picking?.at ?? null}
        focusFirst={Boolean(picking?.keys)}
      />
      <ActionMenu
        open={Boolean(rowMenu)}
        onClose={() => setRowMenu(undefined)}
        label={rowMenu?.path ?? 'File'}
        title={<span className="font-mono">{baseName(rowMenu?.path ?? '')}</span>}
        entries={rowMenu ? entries(PATH_ACTIONS, pathTarget(rowMenu), 'menu', hasKeyboard() ? 'pointer' : 'touch') : []}
        at={rowMenu?.at ?? null}
        focusFirst={Boolean(rowMenu?.keys)}
        {...(rowMenu?.lift ? { lift: rowMenu.lift } : {})}
      />
    </div>
  );
}
