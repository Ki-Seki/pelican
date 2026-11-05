import { useQuery } from '@tanstack/react-query';
import { AtSign, ChevronLeft, ChevronRight, File, Folder, GitBranch, Loader2, MessageSquare, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import type { GitFile } from '../../shared/protocol';
import { api } from '../lib/api';
import { baseName, formatBytes } from '../lib/format';
import { newId } from '../lib/ids';
import { markTipSeen, setPrefs, tipSeen, usePrefs } from '../lib/prefs';
import { type CodeLine, commentKey, commentsMessage, type LineComment, lineKey, lineNumber, parseDiff, setComments, useComments } from '../lib/review';
import { Markdown } from './Markdown';
import { Segmented, Sheet } from './Sheet';

const LETTER: Record<GitFile['status'], string> = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U', conflicted: '!' };
const TONE: Record<GitFile['status'], string> = {
  modified: 'text-wait', added: 'text-add', untracked: 'text-add', deleted: 'text-del', renamed: 'text-run', conflicted: 'text-danger',
};

/** From this width Changes and files sits beside the conversation instead of over it. */
const DOCKS = '(min-width: 1440px)';

function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    onChange();
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/** The keys that show and hide the pane, as this computer writes them. */
export const PANE_KEYS = /Mac|iP(hone|ad|od)/.test(navigator.userAgent) ? '⌘⇧D' : 'Ctrl+Shift+D';

/**
 * Whether Changes and files is open, and where. On a wide screen it is a pane beside the
 * conversation that stays open from one session to the next (remembered in this browser), shown
 * and hidden with Cmd/Ctrl+Shift+D as in Claude Desktop; on a narrower one, a sheet over it.
 */
export function useWorkspacePane(available: boolean) {
  const dockable = useMedia(DOCKS);
  const { workspacePane } = usePrefs();
  const [sheetOpen, setSheetOpen] = useState(false);
  const open = available && (dockable ? workspacePane : sheetOpen);
  const setOpen = useCallback((next: boolean) => {
    if (dockable) setPrefs({ workspacePane: next });
    else setSheetOpen(next);
  }, [dockable]);
  useEffect(() => {
    if (!available) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey || e.key.toLowerCase() !== 'd') return;
      e.preventDefault();
      setOpen(!open);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [available, open, setOpen]);
  return { open, setOpen, dockable, docked: dockable && open };
}

/** A path as its file name, with the folder after it in a fainter, smaller type. */
function PathLabel({ path }: { path: string }) {
  const cut = path.lastIndexOf('/');
  return (
    <span className="flex min-w-0 items-baseline gap-1.5 overflow-hidden">
      <span className="shrink-0 font-mono text-[13px]">{cut >= 0 ? path.slice(cut + 1) : path}</span>
      {cut > 0 && <span className="min-w-0 truncate font-mono text-[11px] text-faint" dir="rtl">{`‎${path.slice(0, cut)}‎`}</span>}
    </span>
  );
}

const isCode = (line: { kind: string }): line is CodeLine => line.kind === 'add' || line.kind === 'del' || line.kind === 'same';

/** A comment under its line; one whose line has changed since shows the line as it was. */
function CommentNote({ comment, outdated = false, onRemove }: { comment: LineComment; outdated?: boolean; onRemove: () => void }) {
  return (
    <div className="flex items-start gap-2 border-y border-line bg-panel py-2 pr-1 pl-3 font-sans text-[13px] leading-snug">
      <MessageSquare className="mt-0.5 size-3.5 shrink-0 text-faint" />
      <div className="min-w-0 flex-1">
        {outdated && <div className="truncate font-mono text-[11.5px] text-faint">{comment.line}: {comment.code.trim()}</div>}
        <p className="whitespace-pre-wrap break-words">{comment.note}</p>
      </div>
      <button type="button" aria-label="Remove comment" onClick={onRemove} className="-my-2 grid size-10 shrink-0 place-items-center rounded-full text-faint hover:text-fg pointer-fine:size-8 pointer-fine:-my-1">
        <X className="size-3.5" />
      </button>
    </div>
  );
}

function CommentBox({ note, onNote, onSave, onCancel }: { note: string; onNote: (note: string) => void; onSave: () => void; onCancel: () => void }) {
  const ready = note.trim().length > 0;
  return (
    <form
      className="border-y border-line bg-panel p-2 font-sans"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) onSave();
      }}
    >
      <textarea
        autoFocus
        rows={2}
        value={note}
        aria-label="Comment for Claude"
        placeholder="Comment for Claude"
        onChange={(e) => onNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            // The comment goes; the sheet around it stays.
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && ready) {
            e.preventDefault();
            onSave();
          }
        }}
        className="block w-full resize-none rounded-lg border border-line bg-bg px-2.5 py-2 text-[16px] leading-snug outline-none placeholder:text-faint focus:border-fg pointer-fine:text-[14px]"
      />
      <div className="mt-2 flex justify-end gap-1.5">
        <button type="button" onClick={onCancel} className="h-10 rounded-full px-3.5 text-[14px] text-muted hover:bg-hover hover:text-fg pointer-fine:h-9">Cancel</button>
        <button type="submit" disabled={!ready} className="h-10 rounded-full bg-fg px-4 text-[14px] font-medium text-bg disabled:opacity-40 pointer-fine:h-9">Comment</button>
      </div>
    </form>
  );
}

/**
 * A unified diff, one row per line, wrapped to the screen, with the line numbers. A tap on a line
 * (or Enter on the one the arrow keys reach) opens a comment on it for Claude, as the diff views of
 * Claude Code on the web and Claude Desktop do; the comments go into the message being written.
 */
function UnifiedDiff({ diff, path, cwd }: { diff: string; path: string; cwd: string }) {
  const lines = useMemo(() => parseDiff(diff), [diff]);
  const all = useComments(cwd);
  const comments = useMemo(() => all.filter((c) => c.path === path), [all, path]);
  // What is typed follows a tap on another line, so a missed line costs nothing.
  const [editing, setEditing] = useState<{ key: string; note: string }>();
  const [cursor, setCursor] = useState<number>();
  const [showHint] = useState(() => !tipSeen('line-comments'));
  const box = useRef<HTMLDivElement>(null);
  const id = useId();

  if (!diff.trim()) return <div className="px-3 py-6 text-center text-[13px] text-faint">No changes in this file</div>;
  if (/^Binary files /m.test(diff)) return <div className="px-3 py-6 text-center text-[13px] text-faint">A binary file changed</div>;
  if (lines.length === 0) return <pre className="px-3 py-6 font-mono text-[12px] whitespace-pre-wrap text-faint">{diff}</pre>;

  const digits = String(Math.max(...lines.map((line) => (isCode(line) ? lineNumber(line) : 0)))).length;
  const onLine = (line: CodeLine) => comments.filter((c) => commentKey(c) === lineKey(line) && c.code === line.text);
  const outdated = comments.filter((c) => !lines.some((line) => isCode(line) && commentKey(c) === lineKey(line) && c.code === line.text));
  const codeAt = lines.flatMap((line, i) => (isCode(line) ? [i] : []));

  const pick = (line: CodeLine) => {
    // Selecting text to copy is not asking to comment.
    if (window.getSelection()?.toString()) return;
    setEditing((current) => ({ key: lineKey(line), note: current?.note ?? '' }));
  };
  const save = (line: CodeLine, note: string) => {
    setComments(cwd, [...all, { id: newId(), path, kind: line.kind, line: lineNumber(line), code: line.text, note: note.trim() }]);
    setEditing(undefined);
    markTipSeen('line-comments');
    box.current?.focus({ preventScroll: true });
  };
  const remove = (comment: LineComment) => setComments(cwd, all.filter((c) => c.id !== comment.id));
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget || codeAt.length === 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const at = cursor === undefined ? -1 : codeAt.indexOf(cursor);
      const next = e.key === 'ArrowDown' ? codeAt[Math.min(codeAt.length - 1, at + 1)]! : codeAt[Math.max(0, at - 1)]!;
      setCursor(next);
      document.getElementById(`${id}-${next}`)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && cursor !== undefined) {
      e.preventDefault();
      pick(lines[cursor] as CodeLine);
    }
  };

  return (
    <>
      {showHint && comments.length === 0 && (
        <p className="px-2 pb-1.5 text-[12px] text-faint"><span className="pointer-fine:hidden">Tap</span><span className="hidden pointer-fine:inline">Click</span> a line to comment on it</p>
      )}
      <div
        ref={box}
        role="group"
        tabIndex={0}
        aria-label={`Changes to ${path}`}
        onKeyDown={onKeyDown}
        onPointerDown={() => setCursor(undefined)}
        className="overflow-hidden rounded-lg border border-line font-mono text-[12px] leading-[1.6]"
      >
        {outdated.map((c) => <CommentNote key={c.id} comment={c} outdated onRemove={() => remove(c)} />)}
        {lines.map((line, i) => {
          if (line.kind === 'hunk') return <div key={i} className="bg-chip px-3 whitespace-pre-wrap break-words text-faint">{line.text}</div>;
          if (line.kind === 'note') return <div key={i} className="px-3 whitespace-pre-wrap break-words text-faint">{line.text}</div>;
          const key = lineKey(line);
          const tone = line.kind === 'add' ? 'bg-add-bg text-add' : line.kind === 'del' ? 'bg-del-bg text-del' : '';
          const marked = editing?.key === key || cursor === i;
          return (
            <div key={i}>
              <div
                id={`${id}-${i}`}
                onClick={() => pick(line)}
                className={`flex cursor-pointer ${tone} ${marked ? 'shadow-[inset_3px_0_0_var(--fg)]' : 'pointer-fine:hover:shadow-[inset_3px_0_0_var(--faint)]'}`}
              >
                {/* The numbers take the line's own colour on a tinted line, where faint is too faint. */}
                <span className={`shrink-0 pr-2 text-right tabular-nums select-none ${line.kind === 'same' ? 'text-faint' : ''}`} style={{ width: `${digits + 2}ch` }}>{lineNumber(line)}</span>
                <span className="min-w-0 flex-1 pr-3 whitespace-pre-wrap break-words">{line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}{line.text || ' '}</span>
              </div>
              {onLine(line).map((c) => <CommentNote key={c.id} comment={c} onRemove={() => remove(c)} />)}
              {editing?.key === key && (
                <CommentBox
                  note={editing.note}
                  onNote={(note) => setEditing({ key, note })}
                  onSave={() => save(line, editing.note)}
                  onCancel={() => {
                    setEditing(undefined);
                    box.current?.focus({ preventScroll: true });
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

const LANGUAGE: Record<string, string> = {
  ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js', json: 'json', md: 'markdown', py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
  java: 'java', kt: 'kotlin', swift: 'swift', c: 'c', h: 'c', cpp: 'cpp', cs: 'csharp', css: 'css', scss: 'scss', html: 'html', xml: 'xml',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', sh: 'bash', bash: 'bash', zsh: 'bash', sql: 'sql', php: 'php', lua: 'lua', vue: 'xml', svelte: 'xml',
};

function FileView({ cwd, path, onMention }: { cwd: string; path: string; onMention: (path: string) => void }) {
  const { data, isLoading, error } = useQuery({ queryKey: ['file', cwd, path], queryFn: () => api.file(cwd, path), staleTime: 5_000 });
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return (
    <div className="px-1 pb-4">
      <div className="mb-2 flex items-center gap-2 px-2">
        <span className="min-w-0 flex-1 truncate text-[12px] text-faint">{data ? formatBytes(data.size) : ''}</span>
        <button type="button" onClick={() => onMention(path)} className="flex h-10 items-center gap-1.5 rounded-full px-3 text-[13px] text-muted hover:bg-hover hover:text-fg">
          <AtSign className="size-3.5" /> Mention
        </button>
      </div>
      {isLoading && <div className="flex justify-center py-10 text-faint"><Loader2 className="size-5 animate-spin" /></div>}
      {error && <div className="px-3 py-6 text-[13px] text-danger">{(error as Error).message}</div>}
      {data?.image && <img src={data.image} alt={path} className="mx-auto max-h-[70dvh] max-w-full rounded-lg border border-line" />}
      {data?.binary && <div className="px-3 py-6 text-center text-[13px] text-faint">A binary file; nothing to show here</div>}
      {data?.text !== undefined && (
        data.text.length <= 120_000 && (LANGUAGE[ext] || ext === 'md')
          ? ext === 'md'
            ? <Markdown text={data.text} className="px-2" />
            : <Markdown text={`\`\`\`${LANGUAGE[ext]}\n${data.text.replace(/```/g, '``​`')}\n\`\`\``} className="text-[12.5px]" />
          : <pre className="overflow-x-auto rounded-lg border border-line px-3 py-2 font-mono text-[12px] leading-[1.55] whitespace-pre-wrap break-words">{data.text}</pre>
      )}
      {data?.truncated && <div className="pt-2 text-center text-[12px] text-faint">Only the first 512 KB is shown</div>}
    </div>
  );
}

type Open = { kind: 'diff'; path: string } | { kind: 'file'; path: string } | undefined;

/**
 * What is in the session's folder: what changed since the last commit, with each file's diff, and
 * the files themselves. Read only: comment on the changes, or ask Claude to change things. A sheet
 * over the conversation, or on a wide screen (`docked`) a pane beside it.
 */
export function Workspace({ open, docked = false, onClose, cwd, onAddToMessage }: {
  open: boolean;
  docked?: boolean;
  onClose: () => void;
  cwd: string;
  /** Adds text to the message being written: a file to mention, or comments on the changes. */
  onAddToMessage: (text: string) => void;
}) {
  const comments = useComments(cwd);
  const commentsIn = useMemo(() => {
    const count = new Map<string, number>();
    for (const c of comments) count.set(c.path, (count.get(c.path) ?? 0) + 1);
    return count;
  }, [comments]);
  const [tab, setTab] = useState<'changes' | 'files'>('changes');
  const [dir, setDir] = useState('');
  const [shown, setShown] = useState<Open>();
  const status = useQuery({ queryKey: ['git', cwd], queryFn: () => api.git(cwd), enabled: open, refetchInterval: open ? 5_000 : false });
  const tree = useQuery({ queryKey: ['tree', cwd, dir], queryFn: () => api.tree(cwd, dir), enabled: open && tab === 'files' });
  const diff = useQuery({
    queryKey: ['gitDiff', cwd, shown?.kind === 'diff' ? shown.path : ''],
    queryFn: () => api.gitDiff(cwd, shown!.path),
    enabled: open && shown?.kind === 'diff',
  });
  const git = status.data?.repo ? status.data : undefined;

  useEffect(() => {
    if (!open) setShown(undefined);
  }, [open]);
  // Not a repository: there is nothing to compare, so start in the files.
  useEffect(() => {
    if (status.data && !status.data.repo) setTab('files');
  }, [status.data]);

  const crumbs = dir ? dir.split('/') : [];
  const back = shown ? (
    <button type="button" onClick={() => setShown(undefined)} className="-ml-1 flex h-10 min-w-0 items-center gap-1 rounded-full pr-2 text-[13px] text-muted hover:text-fg">
      <ChevronLeft className="size-4 shrink-0" />
      <span className="truncate">{shown.kind === 'diff' ? 'Changes' : (crumbs.at(-1) ?? baseName(cwd))}</span>
    </button>
  ) : null;

  const header = (
    <div className="pt-1 pb-2">
      {shown ? (
        <div className="flex min-w-0 items-center gap-2">
          {back}
          <div className="min-w-0 flex-1"><PathLabel path={shown.path} /></div>
        </div>
      ) : (
        <Segmented<'changes' | 'files'>
          value={tab}
          onChange={setTab}
          options={[
            { value: 'changes', label: git && git.files.length > 0 ? `Changes · ${git.files.length}` : 'Changes' },
            { value: 'files', label: 'Files' },
          ]}
        />
      )}
    </div>
  );

  const body = (
    <>
      {shown?.kind === 'diff' && (
        <div className="px-1 pb-4">
          {diff.isLoading ? <div className="flex justify-center py-10 text-faint"><Loader2 className="size-5 animate-spin" /></div> : <UnifiedDiff diff={diff.data ?? ''} path={shown.path} cwd={cwd} />}
        </div>
      )}
      {shown?.kind === 'file' && <FileView cwd={cwd} path={shown.path} onMention={(path) => onAddToMessage(`@${path} `)} />}

      {!shown && tab === 'changes' && (
        <div>
          {status.isLoading && <div className="flex justify-center py-10 text-faint"><Loader2 className="size-5 animate-spin" /></div>}
          {status.data && !status.data.repo && (
            <div className="px-3 py-10 text-center text-[13px] text-faint">
              {status.data.untrusted ? 'Changes show once this folder is trusted.' : 'This folder is not a git repository'}
            </div>
          )}
          {git && (
            <>
              <div className="flex items-center gap-1.5 px-3 pb-2 text-[12.5px] text-muted">
                <GitBranch className="size-3.5" />
                <span className="font-mono">{git.branch ?? 'detached'}</span>
                {Boolean(git.ahead) && <span className="text-faint">· {git.ahead} ahead</span>}
                {Boolean(git.behind) && <span className="text-faint">· {git.behind} behind</span>}
                <button type="button" aria-label="Refresh" onClick={() => void status.refetch()} className="-my-1.5 ml-auto grid size-10 place-items-center rounded-full text-faint hover:bg-hover hover:text-fg">
                  <RefreshCw className={`size-3.5 ${status.isFetching ? 'animate-spin' : ''}`} />
                </button>
              </div>
              {git.files.length === 0 && <div className="px-3 py-8 text-center text-[13px] text-faint">Nothing changed since the last commit</div>}
              {git.files.map((file) => (
                <button key={file.path} type="button" onClick={() => setShown({ kind: 'diff', path: file.path })} className="flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left hover:bg-hover pointer-fine:min-h-10">
                  <span className={`w-3 shrink-0 text-center font-mono text-[12px] font-semibold ${TONE[file.status]}`} title={file.status}>{LETTER[file.status]}</span>
                  <PathLabel path={file.path} />
                  <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2 font-mono text-[11.5px]">
                    {commentsIn.has(file.path) && (
                      <span className="flex items-center gap-0.5 text-faint" aria-label={`${commentsIn.get(file.path)} comments`}>
                        <MessageSquare className="size-3" />{commentsIn.get(file.path)}
                      </span>
                    )}
                    {Boolean(file.added) && <span className="text-add">+{file.added}</span>}
                    {Boolean(file.removed) && <span className="text-del">−{file.removed}</span>}
                  </span>
                </button>
              ))}
            </>
          )}
        </div>
      )}

      {!shown && tab === 'files' && (
        <div>
          <nav aria-label="Folder" className="no-scrollbar flex items-center gap-0.5 overflow-x-auto px-2 pb-1.5 text-[12.5px]">
            <button type="button" onClick={() => setDir('')} aria-current={crumbs.length === 0 ? 'location' : undefined} className={`h-9 shrink-0 rounded-md px-1.5 font-mono ${crumbs.length === 0 ? 'text-fg' : 'text-muted hover:text-fg'}`}>{baseName(cwd)}</button>
            {crumbs.map((part, i) => (
              <span key={i} className="flex shrink-0 items-center">
                <ChevronRight className="size-3 text-faint" />
                <button type="button" onClick={() => setDir(crumbs.slice(0, i + 1).join('/'))} aria-current={i === crumbs.length - 1 ? 'location' : undefined} className={`h-9 rounded-md px-1.5 font-mono ${i === crumbs.length - 1 ? 'text-fg' : 'text-muted hover:text-fg'}`}>{part}</button>
              </span>
            ))}
          </nav>
          {tree.isLoading && <div className="flex justify-center py-10 text-faint"><Loader2 className="size-5 animate-spin" /></div>}
          {tree.error && <div className="px-3 py-6 text-[13px] text-danger">{(tree.error as Error).message}</div>}
          {tree.data?.length === 0 && <div className="px-3 py-8 text-center text-[13px] text-faint">An empty folder</div>}
          {tree.data?.map((entry) => (
            <button
              key={entry.path}
              type="button"
              onClick={() => (entry.dir ? setDir(entry.path) : setShown({ kind: 'file', path: entry.path }))}
              className="flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left hover:bg-hover pointer-fine:min-h-10"
            >
              {entry.dir ? <Folder className="size-4 shrink-0 text-faint" /> : <File className="size-4 shrink-0 text-faint" />}
              <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{entry.name}</span>
              {entry.size !== undefined && <span className="shrink-0 text-[11.5px] text-faint">{formatBytes(entry.size)}</span>}
            </button>
          ))}
        </div>
      )}
    </>
  );

  // Comments wait here, across files, until they go into the message together.
  const footer = comments.length > 0 && (
    <div className="flex items-center gap-2 border-t border-line py-2 pr-2 pl-4">
      <span className="min-w-0 flex-1 text-[13px] text-muted">{comments.length === 1 ? '1 comment' : `${comments.length} comments`}</span>
      <button
        type="button"
        onClick={() => {
          onAddToMessage(commentsMessage(comments));
          setComments(cwd, []);
        }}
        className="h-10 shrink-0 rounded-full bg-fg px-4 text-[14px] font-medium text-bg pointer-fine:h-9"
      >
        Add to message
      </button>
    </div>
  );

  if (docked) {
    if (!open) return null;
    return (
      <aside aria-label="Changes and files" className="absolute inset-y-0 right-0 flex w-(--pane-w) flex-col border-l border-line bg-bg">
        <div className="flex shrink-0 items-center gap-1 pt-1.5 pr-2 pl-5">
          <div className="min-w-0 flex-1 truncate text-[13px] font-medium text-muted">{baseName(cwd)}</div>
          <button type="button" aria-label="Close" title={`Close (${PANE_KEYS})`} onClick={onClose} className="grid size-10 shrink-0 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg">
            <X className="size-[18px]" />
          </button>
        </div>
        <div className="shrink-0 px-4">{header}</div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">{body}</div>
        {footer}
      </aside>
    );
  }
  return (
    <Sheet open={open} onClose={onClose} title={baseName(cwd)} done size="large" header={header}>
      <div className="flex min-h-full flex-col">
        <div className="flex-1">{body}</div>
        {footer && <div className="sticky bottom-0 -mx-2 -mb-2 bg-panel">{footer}</div>}
      </div>
    </Sheet>
  );
}
