import { useQuery } from '@tanstack/react-query';
import { ChevronRight, File, Folder, Loader2, Search, TextSearch, X } from 'lucide-react';
import { useDeferredValue, useState } from 'react';

import { api, isDemoNote } from '../lib/api';
import { baseName, formatBytes } from '../lib/format';
import type { WorkspaceStep } from '../lib/workspace-route';
import { FileViewer } from './FileViewer';
import { PathLabel } from './PathLabel';

/** A line of a file that holds the text, with the text shown where it is. */
function Found({ text, query }: { text: string; query: string }) {
  const caseless = query === query.toLowerCase();
  const at = (caseless ? text.toLowerCase() : text).indexOf(caseless ? query.toLowerCase() : query);
  if (at < 0) return <>{text}</>;
  return <>{text.slice(0, at)}<mark className="rounded-sm bg-chip text-fg">{text.slice(at, at + query.length)}</mark>{text.slice(at + query.length)}</>;
}

/**
 * The Files tab: search the folder by name as you type, or in the files' text; browse it folder
 * by folder; open a file to read it (FileViewer). The search is kept while a file found by it is
 * open, so going back finds it again.
 */
export function WorkspaceFiles({ cwd, step, open, go, up, onAddToMessage }: {
  cwd: string;
  step: WorkspaceStep;
  open: boolean;
  go: (step: WorkspaceStep) => void;
  up: (step: WorkspaceStep) => void;
  /** `block`: on lines of its own (a request); `quote`: a quote, which waits above the message box. */
  onAddToMessage: (text: string, how?: 'block' | 'quote') => void;
}) {
  const [query, setQuery] = useState('');
  const [inText, setInText] = useState('');
  const typed = useDeferredValue(query.trim());
  const file = step.path && !step.path.endsWith('/') ? step.path : undefined;
  const dir = step.path?.endsWith('/') ? step.path.slice(0, -1) : '';
  const tree = useQuery({ queryKey: ['tree', cwd, dir], queryFn: () => api.tree(cwd, dir), enabled: open && !file && !typed });
  const names = useQuery({ queryKey: ['files', cwd, typed], queryFn: () => api.files(cwd, typed), enabled: open && !file && Boolean(typed), staleTime: 10_000 });
  const text = useQuery({ queryKey: ['search', cwd, inText], queryFn: () => api.search(cwd, inText), enabled: open && Boolean(inText), staleTime: 10_000, retry: false });

  if (file) return <FileViewer cwd={cwd} path={file} {...(step.line ? { line: step.line } : {})} onAddToMessage={onAddToMessage} />;

  const crumbs = dir ? dir.split('/') : [];
  const row = 'flex min-h-11 w-full min-w-0 items-center gap-2.5 rounded-lg px-3 py-2 text-left hover:bg-hover pointer-fine:min-h-10';
  const searching = Boolean(typed);
  return (
    <div>
      <form
        role="search"
        className="mx-1 mb-1.5 flex h-10 items-center gap-2 rounded-xl bg-chip px-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (typed) setInText(typed);
        }}
      >
        <Search className="size-4 shrink-0 text-faint" />
        <input
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setInText('');
          }}
          aria-label="Search files"
          placeholder="Search files"
          enterKeyHint="search"
          className="min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-faint pointer-fine:text-[14px] [&::-webkit-search-cancel-button]:hidden"
        />
        {query && (
          <button type="button" aria-label="Clear search" onClick={() => { setQuery(''); setInText(''); }} className="relative -mr-1.5 grid size-7 shrink-0 place-items-center rounded-full text-faint after:absolute after:-inset-2 hover:text-fg">
            <X className="size-4" />
          </button>
        )}
      </form>

      {searching && !inText && (
        <>
          {names.isLoading && <div className="flex justify-center py-6 text-faint"><Loader2 className="size-5 animate-spin" /></div>}
          {names.data?.map((name) => (
            <button key={name} type="button" onClick={() => go({ tab: 'files', path: name })} className={row}>
              {name.endsWith('/') ? <Folder className="size-4 shrink-0 text-faint" /> : <File className="size-4 shrink-0 text-faint" />}
              <PathLabel path={name.replace(/\/$/, '')} />
            </button>
          ))}
          {names.data?.length === 0 && <div className="px-3 py-3 text-[13px] text-faint">No file is called that</div>}
          <button type="button" onClick={() => setInText(typed)} className={`${row} text-[13.5px] text-muted`}>
            <TextSearch className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">Search in files for “{typed}”</span>
            <ChevronRight className="size-4 shrink-0 text-faint" />
          </button>
        </>
      )}

      {inText && (
        <div>
          {text.isLoading && <div className="flex items-center justify-center gap-2 py-6 text-[13px] text-faint"><Loader2 className="size-4 animate-spin" /> Searching the files</div>}
          {text.error && <div className={`px-3 py-4 text-[13px] ${isDemoNote(text.error) ? 'text-muted' : 'text-danger'}`}>{(text.error as Error).message}</div>}
          {text.data?.files.length === 0 && <div className="px-3 py-4 text-[13px] text-faint">No file holds “{inText}”</div>}
          {text.data?.files.map((found) => (
            <div key={found.path} className="mb-1">
              <button type="button" onClick={() => go({ tab: 'files', path: found.path })} className={`${row} min-h-9`}>
                <PathLabel path={found.path} />
              </button>
              {found.lines.map((l) => (
                <button key={l.n} type="button" onClick={() => go({ tab: 'files', path: found.path, line: l.n })} className="flex w-full min-w-0 items-baseline gap-2 rounded-md py-1 pr-3 pl-4 text-left font-mono text-[12px] hover:bg-hover">
                  <span className="w-8 shrink-0 text-right text-faint tabular-nums">{l.n}</span>
                  <span className="min-w-0 flex-1 truncate text-muted"><Found text={l.text.trim()} query={inText} /></span>
                </button>
              ))}
            </div>
          ))}
          {text.data?.truncated && <div className="px-3 py-2 text-[12px] text-faint">Only the first results are shown</div>}
        </div>
      )}

      {!searching && (
        <>
          <nav aria-label="Folder" className="no-scrollbar flex items-center gap-0.5 overflow-x-auto px-2 pb-1.5 text-[12.5px]">
            <button type="button" onClick={() => up({ tab: 'files' })} aria-current={crumbs.length === 0 ? 'location' : undefined} className={`h-9 shrink-0 rounded-md px-1.5 font-mono ${crumbs.length === 0 ? 'text-fg' : 'text-muted hover:text-fg'}`}>{baseName(cwd)}</button>
            {crumbs.map((part, i) => (
              <span key={i} className="flex shrink-0 items-center">
                <ChevronRight className="size-3 text-faint" />
                <button type="button" onClick={() => up({ tab: 'files', path: `${crumbs.slice(0, i + 1).join('/')}/` })} aria-current={i === crumbs.length - 1 ? 'location' : undefined} className={`h-9 rounded-md px-1.5 font-mono ${i === crumbs.length - 1 ? 'text-fg' : 'text-muted hover:text-fg'}`}>{part}</button>
              </span>
            ))}
          </nav>
          {tree.isLoading && <div className="flex justify-center py-10 text-faint"><Loader2 className="size-5 animate-spin" /></div>}
          {tree.error && <div className="px-3 py-6 text-[13px] text-danger">{(tree.error as Error).message}</div>}
          {tree.data?.length === 0 && <div className="px-3 py-8 text-center text-[13px] text-faint">An empty folder</div>}
          {tree.data?.map((entry) => (
            <button key={entry.path} type="button" onClick={() => go({ tab: 'files', path: entry.dir ? `${entry.path}/` : entry.path })} className={row}>
              {entry.dir ? <Folder className="size-4 shrink-0 text-faint" /> : <File className="size-4 shrink-0 text-faint" />}
              <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{entry.name}</span>
              {entry.size !== undefined && <span className="shrink-0 text-[11.5px] text-faint">{formatBytes(entry.size)}</span>}
            </button>
          ))}
        </>
      )}
    </div>
  );
}
