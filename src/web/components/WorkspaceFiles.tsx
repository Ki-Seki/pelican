import { useQuery } from '@tanstack/react-query';
import { ChevronRight, File, Folder, Loader2, Search, SquareTerminal, TextSearch, X } from 'lucide-react';
import { type ReactNode, useDeferredValue, useState } from 'react';

import { entries, PATH_ACTIONS, type PathTarget } from '../lib/actions';
import { announce } from '../lib/announce';
import { api, isDemoNote } from '../lib/api';
import { addWaiting } from '../lib/drafts';
import { baseName, formatBytes } from '../lib/format';
import { hasKeyboard } from '../lib/keyboard';
import { type Press, useLongPress } from '../lib/press';
import { fileItem } from '../lib/quote';
import { useCommentsChat } from '../lib/review';
import { askForTerminal, useTerminalsAvailable } from '../lib/terminals';
import type { WorkspaceStep } from '../lib/workspace-route';
import { ActionMenu, type MenuAnchor } from './ActionMenu';
import { FileViewer } from './FileViewer';
import { PathLabel } from './PathLabel';
import { downloadFile } from './PathMenu';

/** How far along a line what was found may start and still be shown from the line's start. */
const FROM_START = 20;
/** Further along, how much of the line comes before it, from the start of a word where one is near. */
const BEFORE = 12;

/**
 * A line of a file that holds the text, with the text marked where it is. A row shows one line
 * and cuts what does not fit at its end, so a line where the text is far along starts shortly
 * before it, after a "…": the text is always in view.
 */
function Found({ text, query }: { text: string; query: string }) {
  const caseless = query === query.toLowerCase();
  const at = (caseless ? text.toLowerCase() : text).indexOf(caseless ? query.toLowerCase() : query);
  if (at < 0) return <>{text}</>;
  let from = 0;
  if (at > FROM_START) {
    const start = at - BEFORE;
    const space = text.slice(start - 1, at).search(/\s/);
    from = space >= 0 ? start + space : start;
  }
  return (
    <>
      {from > 0 && '…'}
      {text.slice(from, at)}
      <mark className="rounded-sm bg-mark text-fg">{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}

/** Where a row's path menu opens: under a finger, raised over the dim; at the pointer; or under the row from the keyboard. */
type RowMenu = { path: string; folder: boolean; at: MenuAnchor; lift?: Element; keys?: boolean };

/** A row of a file or a folder: a tap opens it; a long press or a right-click opens its path's menu. */
function PathRow({ path, folder, className, onOpen, onMenu, children }: {
  path: string;
  folder: boolean;
  className: string;
  onOpen: () => void;
  onMenu: (menu: RowMenu) => void;
  children: ReactNode;
}) {
  const press = useLongPress<HTMLButtonElement>((p: Press) => onMenu({
    path, folder, ...(p.pointerType === 'touch' || p.pointerType === 'pen' ? { at: p.element, lift: p.element } : p.pointerType === 'keyboard' ? { at: p.element, keys: true } : { at: { x: p.x, y: p.y } }),
  }));
  return <button type="button" onClick={onOpen} {...press} className={`${className} ${press.className}`}>{children}</button>;
}

/**
 * The Files tab: search the folder by name as you type, or in the files' text; browse it folder
 * by folder; open a file to read it (FileViewer). The search is kept while a file found by it is
 * open, so going back finds it again. A row has its path's menu, as Desktop's file tree has: a
 * folder's has Open in terminal, a changed file's Open in Changes.
 */
export function WorkspaceFiles({ cwd, step, open, go, up, onAddToMessage, changed }: {
  cwd: string;
  step: WorkspaceStep;
  open: boolean;
  go: (step: WorkspaceStep) => void;
  up: (step: WorkspaceStep) => void;
  /** `block`: on lines of its own (a request); `quote`: a quote, which waits above the message box. */
  onAddToMessage: (text: string, how?: 'block' | 'quote') => void;
  /** The files with changes to show (all of them, by /diff's rule), for Open in Changes. */
  changed?: ReadonlySet<string>;
}) {
  const chat = useCommentsChat(cwd);
  const [rowMenu, setRowMenu] = useState<RowMenu>();
  const [query, setQuery] = useState('');
  const [inText, setInText] = useState('');
  const typed = useDeferredValue(query.trim());
  const file = step.path && !step.path.endsWith('/') ? step.path : undefined;
  const dir = step.path?.endsWith('/') ? step.path.slice(0, -1) : '';
  const tree = useQuery({ queryKey: ['tree', cwd, dir], queryFn: () => api.tree(cwd, dir), enabled: open && !file && !typed });
  const names = useQuery({ queryKey: ['files', cwd, typed], queryFn: () => api.files(cwd, typed), enabled: open && !file && Boolean(typed), staleTime: 10_000 });
  const text = useQuery({ queryKey: ['search', cwd, inText], queryFn: () => api.search(cwd, inText), enabled: open && Boolean(inText), staleTime: 10_000, retry: false });
  const terminals = useTerminalsAvailable();

  if (file) return <FileViewer cwd={cwd} path={file} {...(step.line ? { line: step.line } : {})} onAddToMessage={onAddToMessage} />;

  /** A new terminal in a folder of the session's (none: the session's own), as Desktop's Open in terminal. */
  const openTerminal = (folder: string) => {
    askForTerminal(folder ? `${cwd.replace(/\/$/, '')}/${folder.replace(/\/$/, '')}` : cwd);
    go({ tab: 'terminal' });
  };
  const pathTarget = (row: RowMenu): PathTarget => ({
    path: row.path,
    cwd,
    ...(row.folder ? { folder: true } : {}),
    attach: () => {
      if (addWaiting(chat, fileItem(row.path, row.folder))) announce(`${baseName(row.path)} goes with your message`);
    },
    ...(!row.folder && changed?.has(row.path) ? { changed: true, openInChanges: () => go({ tab: 'changes', path: row.path }) } : {}),
    ...(row.folder && terminals ? { openInTerminal: () => openTerminal(row.path) } : {}),
    ...(!row.folder ? { download: () => downloadFile(cwd, row.path) } : {}),
  });
  const pathMenu = (
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
  );

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
            <PathRow key={name} path={name.replace(/\/$/, '')} folder={name.endsWith('/')} onOpen={() => go({ tab: 'files', path: name })} onMenu={setRowMenu} className={row}>
              {name.endsWith('/') ? <Folder className="size-4 shrink-0 text-faint" /> : <File className="size-4 shrink-0 text-faint" />}
              <PathLabel path={name.replace(/\/$/, '')} />
            </PathRow>
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
                <button key={l.n} type="button" onClick={() => go({ tab: 'files', path: found.path, line: l.n })} className="flex min-h-11 w-full min-w-0 items-center gap-2 rounded-md py-1 pr-3 pl-4 text-left font-mono text-[12px] hover:bg-hover pointer-fine:min-h-0">
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
          <div className="flex items-center gap-1 pr-1 pb-1.5">
            <nav aria-label="Folder" className="no-scrollbar flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-2 text-[12.5px]">
              <button type="button" onClick={() => up({ tab: 'files' })} aria-current={crumbs.length === 0 ? 'location' : undefined} className={`h-9 shrink-0 rounded-md px-1.5 font-mono ${crumbs.length === 0 ? 'text-fg' : 'text-muted hover:text-fg'}`}>{baseName(cwd)}</button>
              {crumbs.map((part, i) => (
                <span key={i} className="flex shrink-0 items-center">
                  <ChevronRight className="size-3 text-faint" />
                  <button type="button" onClick={() => up({ tab: 'files', path: `${crumbs.slice(0, i + 1).join('/')}/` })} aria-current={i === crumbs.length - 1 ? 'location' : undefined} className={`h-9 rounded-md px-1.5 font-mono ${i === crumbs.length - 1 ? 'text-fg' : 'text-muted hover:text-fg'}`}>{part}</button>
                </span>
              ))}
            </nav>
            {terminals && (
              // A new terminal in the folder shown here, as Open in terminal on a folder does in Claude Desktop.
              <button
                type="button"
                aria-label="Open in terminal"
                title="Open in terminal"
                onClick={() => openTerminal(dir)}
                className="grid size-9 shrink-0 place-items-center rounded-full text-faint hover:bg-hover hover:text-fg"
              >
                <SquareTerminal className="size-4" />
              </button>
            )}
          </div>
          {tree.isLoading && <div className="flex justify-center py-10 text-faint"><Loader2 className="size-5 animate-spin" /></div>}
          {tree.error && <div className="px-3 py-6 text-[13px] text-danger">{(tree.error as Error).message}</div>}
          {tree.data?.length === 0 && <div className="px-3 py-8 text-center text-[13px] text-faint">An empty folder</div>}
          {tree.data?.map((entry) => (
            <PathRow key={entry.path} path={entry.path} folder={entry.dir} onOpen={() => go({ tab: 'files', path: entry.dir ? `${entry.path}/` : entry.path })} onMenu={setRowMenu} className={row}>
              {entry.dir ? <Folder className="size-4 shrink-0 text-faint" /> : <File className="size-4 shrink-0 text-faint" />}
              <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{entry.name}</span>
              {entry.size !== undefined && <span className="shrink-0 text-[11.5px] text-faint">{formatBytes(entry.size)}</span>}
            </PathRow>
          ))}
        </>
      )}
      {pathMenu}
    </div>
  );
}
