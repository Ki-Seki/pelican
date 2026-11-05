import { ShieldCheck, User } from 'lucide-react';

import type { TrustChoice } from '../lib/api';
import { shortPath } from '../lib/format';
import { Sheet, SheetOption } from './Sheet';

/** A send that waits for an answer: the folder Claude Code would start in has programs of its own. */
export type TrustAsk = { brings: string[]; answer: (choice: TrustChoice) => void; cancel: () => void };

/**
 * Asked before Claude Code first starts in a folder nobody has trusted, as the CLI's trust dialog
 * asks: what the folder would run, and whether to run it or to start with the user's settings only.
 */
export function TrustSheet({ ask, folder, home, onDone }: { ask?: TrustAsk; folder?: string; home?: string; onDone: () => void }) {
  const choose = (choice: TrustChoice) => {
    onDone();
    ask?.answer(choice);
  };
  return (
    <Sheet
      open={Boolean(ask)}
      onClose={() => {
        onDone();
        ask?.cancel();
      }}
      title="Trust this folder?"
    >
      <div className="px-3 pt-1 pb-2 text-[14px] leading-relaxed">
        {folder && <div className="truncate font-mono text-[12.5px] text-muted" title={folder}>{shortPath(folder, home)}</div>}
        <p className="mt-1">Claude Code will run what it brings:</p>
        <ul className="mt-2 max-h-52 overflow-y-auto overscroll-contain rounded-lg border border-line px-3 py-1.5 font-mono text-[12px] leading-snug text-muted">
          {(ask?.brings ?? []).map((item) => <li key={item} className="py-0.5 break-words">{item}</li>)}
        </ul>
      </div>
      <SheetOption icon={<ShieldCheck className="size-4" />} label="Trust and start" onSelect={() => choose('trusted')} />
      <SheetOption
        icon={<User className="size-4" />}
        label="Use my settings only"
        description="Leaves out this folder’s settings, hooks, MCP servers and CLAUDE.md"
        onSelect={() => choose('user-only')}
      />
    </Sheet>
  );
}
