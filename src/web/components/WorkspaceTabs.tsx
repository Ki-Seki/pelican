import { Loader2 } from 'lucide-react';
import { Component, type ComponentProps, lazy, type ReactNode, Suspense } from 'react';

import { retried } from '../lib/load';

/**
 * Changes and Files, the tabs of Changes and files, with the diffs, the file viewer and search:
 * most of the pane's code, loaded when it first shows one of them, so a conversation opens without
 * it. One that did not arrive says so in the pane, and the conversation beside it stays.
 */
const loadChanges = () => import('./WorkspaceChanges');
const loadFiles = () => import('./WorkspaceFiles');
const LazyChanges = lazy(() => retried(loadChanges).then((m) => ({ default: m.WorkspaceChanges })));
const LazyFiles = lazy(() => retried(loadFiles).then((m) => ({ default: m.WorkspaceFiles })));

/** Loads both ahead of need, once the conversation is up; one that fails here is asked for again when shown. */
export function prefetchWorkspace(): void {
  void loadChanges().catch(() => undefined);
  void loadFiles().catch(() => undefined);
}

/** React keeps a load that failed: only a reload brings it back. */
class Loaded extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
        <p className="text-[13px] text-muted">This part of Pelican did not load.</p>
        <button type="button" onClick={() => location.reload()} className="h-9 rounded-full bg-fg px-4 text-[13px] font-medium text-bg">Reload</button>
      </div>
    );
  }
}

const loading = <div className="flex justify-center py-10 text-faint"><Loader2 className="size-5 animate-spin" /></div>;

export function WorkspaceChanges(props: ComponentProps<typeof LazyChanges>) {
  return <Loaded><Suspense fallback={loading}><LazyChanges {...props} /></Suspense></Loaded>;
}

export function WorkspaceFiles(props: ComponentProps<typeof LazyFiles>) {
  return <Loaded><Suspense fallback={loading}><LazyFiles {...props} /></Suspense></Loaded>;
}
