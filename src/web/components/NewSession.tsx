import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, ChevronLeft, ChevronRight, Folder, FolderOpen, FolderPlus, Loader2, NotebookPen } from 'lucide-react';
import { type FormEvent, useState } from 'react';

import { api, isDemoNote } from '../lib/api';
import { relativeTime, shortPath } from '../lib/format';
import type { Start } from '../lib/start';
import { Sheet } from './Sheet';

/**
 * Where a new session runs: a recent project, or any folder on the machine. On a page of its own
 * before the first session; after that in a sheet, from the folder under the new session's chat.
 */
export function FolderPicker({ home, onPick, onScratch, current, inSheet = false }: {
  home?: string;
  onPick: (path: string) => void;
  onScratch: () => void;
  /** The place picked now, marked in the list. */
  current?: Start;
  inSheet?: boolean;
}) {
  const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const [browsing, setBrowsing] = useState<string>();
  const { data: listing, isFetching } = useQuery({
    queryKey: ['dirs', browsing],
    queryFn: () => api.dirs(browsing),
    enabled: browsing !== undefined,
  });
  const frame = inSheet ? 'px-1 pb-2' : 'mx-auto max-w-xl px-4 py-6';
  const isCurrent = (path: string) => Boolean(current && 'cwd' in current && current.cwd === path);
  const scratchCurrent = Boolean(current && 'scratch' in current);
  const queryClient = useQueryClient();
  // A new folder's name while it is being typed; undefined when the field is closed.
  const [naming, setNaming] = useState<string>();
  const [making, setMaking] = useState(false);
  const [problem, setProblem] = useState<{ text: string; quiet: boolean }>();
  const make = (e: FormEvent) => {
    e.preventDefault();
    if (!listing || !naming?.trim() || making) return;
    setMaking(true);
    setProblem(undefined);
    api.makeDir(listing.path, naming)
      .then((made) => {
        void queryClient.invalidateQueries({ queryKey: ['dirs', listing.path] });
        // Into the new folder, where Start here starts the session in it.
        setNaming(undefined);
        setBrowsing(made);
      })
      // The demo saying it changes nothing is a note, not a failure.
      .catch((error: Error) => setProblem({ text: error.message, quiet: isDemoNote(error) }))
      .finally(() => setMaking(false));
  };

  if (browsing !== undefined) {
    const into = (dir: string) => {
      setBrowsing(dir);
      setNaming(undefined);
    };
    return (
      <div className={frame}>
        <div className="flex items-center gap-2">
          <button type="button" aria-label="Back to recent folders" className="grid size-10 shrink-0 place-items-center rounded-full hover:bg-hover" onClick={() => {
            setBrowsing(undefined);
            setNaming(undefined);
          }}>
            <ChevronLeft className="size-5" />
          </button>
          <div className="min-w-0 flex-1 truncate font-mono text-[13px] text-muted">{listing ? shortPath(listing.path, home) : '…'}</div>
          {listing && (
            <button type="button" className="h-10 shrink-0 rounded-full bg-fg px-4 text-[14px] font-medium text-bg" onClick={() => onPick(listing.path)}>
              Start here
            </button>
          )}
        </div>
        <div className="mt-3 overflow-hidden rounded-2xl border border-line bg-panel">
          {listing && (naming === undefined ? (
            <button type="button" className="flex w-full items-center gap-3 border-b border-line px-4 py-3 text-left text-[14.5px] hover:bg-hover" onClick={() => setNaming('')}>
              <FolderPlus className="size-4 text-faint" /> New folder
            </button>
          ) : (
            <form onSubmit={make} className="border-b border-line px-3 py-2">
              <div className="flex items-center gap-2">
                <FolderPlus className="ml-1 size-4 shrink-0 text-faint" />
                <input
                  autoFocus
                  value={naming}
                  onChange={(e) => {
                    setNaming(e.target.value);
                    setProblem(undefined);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
                      e.stopPropagation();
                      setNaming(undefined);
                    }
                  }}
                  aria-label="New folder name"
                  placeholder="Folder name"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  className="h-10 min-w-0 flex-1 rounded-xl border border-line bg-bg px-3 text-[16px] outline-none focus:border-fg"
                />
                <button type="submit" disabled={!naming.trim() || making} className="h-10 shrink-0 rounded-full bg-fg px-4 text-[14px] font-medium text-bg disabled:opacity-40">
                  {making ? <Loader2 className="size-4 animate-spin" /> : 'Create'}
                </button>
              </div>
              {problem && <div role="alert" className={`px-1 pt-1.5 text-[12.5px] ${problem.quiet ? 'text-muted' : 'text-danger'}`}>{problem.text}</div>}
            </form>
          ))}
          {listing?.parent && (
            <button type="button" className="flex w-full items-center gap-3 border-b border-line px-4 py-3 text-left text-[14.5px] hover:bg-hover" onClick={() => into(listing.parent!)}>
              <FolderOpen className="size-4 text-faint" /> ..
            </button>
          )}
          {isFetching && !listing && <div className="flex justify-center py-8"><Loader2 className="size-5 animate-spin text-faint" /></div>}
          {listing?.dirs.map((dir) => (
            <button key={dir.path} type="button" className="flex w-full items-center gap-3 border-b border-line px-4 py-3 text-left text-[14.5px] last:border-0 hover:bg-hover" onClick={() => into(dir.path)}>
              <Folder className="size-4 shrink-0 text-faint" />
              <span className="min-w-0 flex-1 truncate">{dir.name}</span>
              <ChevronRight className="size-4 text-faint" />
            </button>
          ))}
          {listing && listing.dirs.length === 0 && <div className="px-4 py-6 text-center text-[13px] text-faint">No subfolders</div>}
        </div>
      </div>
    );
  }

  return (
    <div className={frame}>
      {!inSheet && (
        <>
          <h2 className="text-[20px] font-semibold tracking-tight">New session</h2>
          <p className="mt-1 text-[13.5px] text-muted">Choose the folder Claude works in.</p>
        </>
      )}
      <button
        type="button"
        onClick={onScratch}
        aria-current={scratchCurrent || undefined}
        className={`flex w-full items-center gap-3 rounded-2xl border border-line bg-panel px-4 py-3 text-left hover:bg-hover ${inSheet ? '' : 'mt-4'}`}
      >
        <NotebookPen className="size-4 shrink-0 text-faint" />
        <div className="min-w-0 flex-1">
          <div className="text-[14.5px]">Scratch folder</div>
          <div className="text-[12px] text-faint">A new empty folder in ~/scratch</div>
        </div>
        {scratchCurrent ? <Check className="size-4 shrink-0" /> : <ChevronRight className="size-4 text-faint" />}
      </button>
      <div className="mt-5 mb-1.5 px-1 text-[11.5px] font-medium tracking-wide text-faint uppercase">Projects</div>
      <div className="overflow-hidden rounded-2xl border border-line bg-panel">
        {!projects && <div className="flex justify-center py-8"><Loader2 className="size-5 animate-spin text-faint" /></div>}
        {projects?.slice(0, 12).map((p) => (
          <button
            key={p.path}
            type="button"
            aria-current={isCurrent(p.path) || undefined}
            className="flex w-full items-center gap-3 border-b border-line px-4 py-3 text-left hover:bg-hover"
            onClick={() => onPick(p.path)}
          >
            <Folder className="size-4 shrink-0 text-faint" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14.5px]">{p.name}</div>
              <div className="truncate font-mono text-[11.5px] text-faint">{shortPath(p.path, home)}</div>
            </div>
            {isCurrent(p.path) ? <Check className="size-4 shrink-0" /> : <span className="shrink-0 text-[12px] text-faint">{relativeTime(p.lastActivity)}</span>}
          </button>
        ))}
        <button type="button" className="flex w-full items-center gap-3 px-4 py-3 text-left text-[14.5px] hover:bg-hover" onClick={() => setBrowsing('')}>
          <FolderOpen className="size-4 text-faint" />
          Browse folders…
        </button>
      </div>
    </div>
  );
}

/**
 * The folder a new session will run in, under its empty chat. + opens that chat straight away, in
 * the latest project, so you can type at once; a tap here picks another folder.
 */
export function StartIn({ start, home, onStart }: { start: Start; home?: string; onStart: (start: Start) => void }) {
  const [open, setOpen] = useState(false);
  const label = 'scratch' in start ? 'A new folder in ~/scratch' : shortPath(start.cwd, home);
  const pick = (next: Start) => {
    setOpen(false);
    onStart(next);
  };
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-label={`Folder: ${label}`}
        onClick={() => setOpen(true)}
        className="mx-auto mt-1 flex h-10 max-w-full min-w-0 items-center gap-1 rounded-full px-3 font-mono text-[12.5px] text-faint hover:bg-hover hover:text-fg"
      >
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDown className="size-3.5 shrink-0" />
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Start in">
        <FolderPicker inSheet current={start} {...(home ? { home } : {})} onPick={(cwd) => pick({ cwd })} onScratch={() => pick({ scratch: true })} />
      </Sheet>
    </>
  );
}
