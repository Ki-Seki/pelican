import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Folder, FolderOpen, Loader2, NotebookPen } from 'lucide-react';
import { useState } from 'react';

import { api } from '../lib/api';
import { relativeTime, shortPath } from '../lib/format';

/** Where a new session runs: a recent project, or any folder on the machine. */
export function FolderPicker({ home, onPick, onScratch }: { home?: string; onPick: (path: string) => void; onScratch: () => void }) {
  const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const [browsing, setBrowsing] = useState<string>();
  const { data: listing, isFetching } = useQuery({
    queryKey: ['dirs', browsing],
    queryFn: () => api.dirs(browsing),
    enabled: browsing !== undefined,
  });

  if (browsing !== undefined) {
    return (
      <div className="mx-auto max-w-xl px-4 py-4">
        <div className="flex items-center gap-2">
          <button type="button" aria-label="Back to recent folders" className="grid size-9 place-items-center rounded-full hover:bg-hover" onClick={() => setBrowsing(undefined)}>
            <ChevronLeft className="size-5" />
          </button>
          <div className="min-w-0 flex-1 truncate font-mono text-[13px] text-muted">{listing ? shortPath(listing.path, home) : '…'}</div>
          {listing && (
            <button type="button" className="h-9 rounded-full bg-fg px-4 text-[14px] font-medium text-bg" onClick={() => onPick(listing.path)}>
              Start here
            </button>
          )}
        </div>
        <div className="mt-3 overflow-hidden rounded-2xl border border-line bg-panel">
          {listing?.parent && (
            <button type="button" className="flex w-full items-center gap-3 border-b border-line px-4 py-3 text-left text-[14.5px] hover:bg-hover" onClick={() => setBrowsing(listing.parent)}>
              <FolderOpen className="size-4 text-faint" /> ..
            </button>
          )}
          {isFetching && !listing && <div className="flex justify-center py-8"><Loader2 className="size-5 animate-spin text-faint" /></div>}
          {listing?.dirs.map((dir) => (
            <button key={dir.path} type="button" className="flex w-full items-center gap-3 border-b border-line px-4 py-3 text-left text-[14.5px] last:border-0 hover:bg-hover" onClick={() => setBrowsing(dir.path)}>
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
    <div className="mx-auto max-w-xl px-4 py-6">
      <h2 className="text-[20px] font-semibold tracking-tight">New session</h2>
      <p className="mt-1 text-[13.5px] text-muted">Choose the folder Claude works in.</p>
      <button
        type="button"
        onClick={onScratch}
        className="mt-4 flex w-full items-center gap-3 rounded-2xl border border-line bg-panel px-4 py-3 text-left hover:bg-hover"
      >
        <NotebookPen className="size-4 shrink-0 text-faint" />
        <div className="min-w-0 flex-1">
          <div className="text-[14.5px]">Scratch folder</div>
          <div className="text-[12px] text-faint">For something quick: a new empty folder in ~/scratch</div>
        </div>
        <ChevronRight className="size-4 text-faint" />
      </button>
      <div className="mt-5 mb-1.5 px-1 text-[11.5px] font-medium tracking-wide text-faint uppercase">Projects</div>
      <div className="overflow-hidden rounded-2xl border border-line bg-panel">
        {!projects && <div className="flex justify-center py-8"><Loader2 className="size-5 animate-spin text-faint" /></div>}
        {projects?.slice(0, 12).map((p) => (
          <button key={p.path} type="button" className="flex w-full items-center gap-3 border-b border-line px-4 py-3 text-left hover:bg-hover" onClick={() => onPick(p.path)}>
            <Folder className="size-4 shrink-0 text-faint" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14.5px]">{p.name}</div>
              <div className="truncate font-mono text-[11.5px] text-faint">{shortPath(p.path, home)}</div>
            </div>
            <span className="shrink-0 text-[12px] text-faint">{relativeTime(p.lastActivity)}</span>
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
