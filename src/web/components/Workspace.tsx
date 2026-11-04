import { useQuery } from '@tanstack/react-query';
import { AtSign, ChevronLeft, ChevronRight, File, Folder, GitBranch, Loader2, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import type { GitFile } from '../../shared/protocol';
import { api } from '../lib/api';
import { baseName, formatBytes } from '../lib/format';
import { Markdown } from './Markdown';
import { Segmented, Sheet } from './Sheet';

const LETTER: Record<GitFile['status'], string> = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U', conflicted: '!' };
const TONE: Record<GitFile['status'], string> = {
  modified: 'text-wait', added: 'text-add', untracked: 'text-add', deleted: 'text-del', renamed: 'text-run', conflicted: 'text-danger',
};

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

/** A unified diff, one row per line, wrapped to the screen. */
function UnifiedDiff({ diff }: { diff: string }) {
  const lines = useMemo(() => diff.split('\n').filter((line) => !/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to) |old mode|new mode)/.test(line)), [diff]);
  if (!diff.trim()) return <div className="px-3 py-6 text-center text-[13px] text-faint">No changes in this file</div>;
  if (/^Binary files /m.test(diff)) return <div className="px-3 py-6 text-center text-[13px] text-faint">A binary file changed</div>;
  return (
    <div className="overflow-hidden rounded-lg border border-line font-mono text-[12px] leading-[1.6]">
      {lines.map((line, i) => {
        const tone = line.startsWith('@@') ? 'bg-chip text-faint'
          : line.startsWith('+') ? 'bg-add-bg text-add'
            : line.startsWith('-') ? 'bg-del-bg text-del'
              : line.startsWith('\\') ? 'text-faint' : '';
        return <div key={i} className={`px-3 whitespace-pre-wrap break-words ${tone}`}>{line || ' '}</div>;
      })}
    </div>
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
        <button type="button" onClick={() => onMention(path)} className="flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] text-muted hover:bg-hover hover:text-fg">
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
 * What is in the session's folder: what changed since the last commit, with
 * each file's diff, and the files themselves. Read only; ask Claude to change things.
 */
export function Workspace({ open, onClose, cwd, onMention }: { open: boolean; onClose: () => void; cwd: string; onMention: (path: string) => void }) {
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
    <button type="button" onClick={() => setShown(undefined)} className="-ml-1 flex h-8 min-w-0 items-center gap-1 rounded-full pr-2 text-[13px] text-muted hover:text-fg">
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

  return (
    <Sheet open={open} onClose={onClose} title={baseName(cwd)} done size="large" header={header}>
      {shown?.kind === 'diff' && (
        <div className="px-1 pb-4">
          {diff.isLoading ? <div className="flex justify-center py-10 text-faint"><Loader2 className="size-5 animate-spin" /></div> : <UnifiedDiff diff={diff.data ?? ''} />}
        </div>
      )}
      {shown?.kind === 'file' && <FileView cwd={cwd} path={shown.path} onMention={onMention} />}

      {!shown && tab === 'changes' && (
        <div>
          {status.isLoading && <div className="flex justify-center py-10 text-faint"><Loader2 className="size-5 animate-spin" /></div>}
          {status.data && !status.data.repo && (
            <div className="px-3 py-10 text-center text-[13px] text-faint">
              {status.data.untrusted ? 'Changes show once Claude has worked in this folder: until then Pelican runs nothing of the folder’s own, git included.' : 'This folder is not a git repository'}
            </div>
          )}
          {git && (
            <>
              <div className="flex items-center gap-1.5 px-3 pb-2 text-[12.5px] text-muted">
                <GitBranch className="size-3.5" />
                <span className="font-mono">{git.branch ?? 'detached'}</span>
                {Boolean(git.ahead) && <span className="text-faint">· {git.ahead} ahead</span>}
                {Boolean(git.behind) && <span className="text-faint">· {git.behind} behind</span>}
                <button type="button" aria-label="Refresh" onClick={() => void status.refetch()} className="ml-auto grid size-7 place-items-center rounded-full text-faint hover:bg-hover hover:text-fg">
                  <RefreshCw className={`size-3.5 ${status.isFetching ? 'animate-spin' : ''}`} />
                </button>
              </div>
              {git.files.length === 0 && <div className="px-3 py-8 text-center text-[13px] text-faint">Nothing changed since the last commit</div>}
              {git.files.map((file) => (
                <button key={file.path} type="button" onClick={() => setShown({ kind: 'diff', path: file.path })} className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left hover:bg-hover">
                  <span className={`w-3 shrink-0 text-center font-mono text-[12px] font-semibold ${TONE[file.status]}`} title={file.status}>{LETTER[file.status]}</span>
                  <PathLabel path={file.path} />
                  <span className="ml-auto flex shrink-0 gap-1.5 pl-2 font-mono text-[11.5px]">
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
          <div className="no-scrollbar flex items-center gap-0.5 overflow-x-auto px-2 pb-1.5 text-[12.5px]">
            <button type="button" onClick={() => setDir('')} className={`shrink-0 rounded-md px-1.5 py-1 font-mono ${crumbs.length === 0 ? 'text-fg' : 'text-muted hover:text-fg'}`}>{baseName(cwd)}</button>
            {crumbs.map((part, i) => (
              <span key={i} className="flex shrink-0 items-center">
                <ChevronRight className="size-3 text-faint" />
                <button type="button" onClick={() => setDir(crumbs.slice(0, i + 1).join('/'))} className={`rounded-md px-1.5 py-1 font-mono ${i === crumbs.length - 1 ? 'text-fg' : 'text-muted hover:text-fg'}`}>{part}</button>
              </span>
            ))}
          </div>
          {tree.isLoading && <div className="flex justify-center py-10 text-faint"><Loader2 className="size-5 animate-spin" /></div>}
          {tree.error && <div className="px-3 py-6 text-[13px] text-danger">{(tree.error as Error).message}</div>}
          {tree.data?.length === 0 && <div className="px-3 py-8 text-center text-[13px] text-faint">An empty folder</div>}
          {tree.data?.map((entry) => (
            <button
              key={entry.path}
              type="button"
              onClick={() => (entry.dir ? setDir(entry.path) : setShown({ kind: 'file', path: entry.path }))}
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left hover:bg-hover"
            >
              {entry.dir ? <Folder className="size-4 shrink-0 text-faint" /> : <File className="size-4 shrink-0 text-faint" />}
              <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{entry.name}</span>
              {entry.size !== undefined && <span className="shrink-0 text-[11.5px] text-faint">{formatBytes(entry.size)}</span>}
            </button>
          ))}
        </div>
      )}
    </Sheet>
  );
}
