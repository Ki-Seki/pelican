import { ShieldCheck, TriangleAlert, User } from 'lucide-react';
import { useMemo } from 'react';

import { revealItem } from '../../shared/hidden';
import type { CommandAt } from '../../shared/protocol';
import { sharedBudget } from '../../shared/shell-words';
import type { TrustChoice } from '../lib/api';
import { shortPath } from '../lib/format';
import { Sheet, SheetOption } from './Sheet';

/**
 * A send that waits for an answer: the folder Claude Code would start in has programs of its own,
 * and where in each item a command is.
 */
export type TrustAsk = { brings: string[]; commands?: CommandAt[][]; answer: (choice: TrustChoice) => void; cancel: () => void };

/**
 * Asked before Claude Code first starts in a folder nobody has trusted, as the CLI's trust dialog
 * asks: what the folder would run, and whether to run it or to start with the user's settings only.
 * Every item is shown whole, its lines kept, and with any character that changes how it reads
 * shown as a token, as approvals show them: this is where the folder's programs are let in.
 */
export function TrustSheet({ ask, folder, home, onDone }: { ask?: TrustAsk; folder?: string; home?: string; onDone: () => void }) {
  const choose = (choice: TrustChoice) => {
    onDone();
    ask?.answer(choice);
  };
  // Read once per question, every item's commands within one budget (src/shared/hidden.ts): past
  // it, every space but a plain one in what is left is written out. The server read them first
  // within as much, and marked any it could not read, so this reads no more than it did.
  const items = useMemo(() => {
    const budget = sharedBudget();
    return (ask?.brings ?? []).map((item, i) => revealItem(item, ask?.commands?.[i], budget));
  }, [ask]);
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
          {items.map((item, i) => <li key={i} className="py-0.5 whitespace-pre-wrap break-words">{item.text}</li>)}
        </ul>
        {items.some((item) => item.hidden) && (
          <div className="mt-2 flex items-start gap-1.5 text-[12.5px] leading-snug text-danger">
            <TriangleAlert className="mt-px size-3.5 shrink-0" />
            This contains invisible or direction-changing characters, shown as ⟨U+…⟩. It may not do what it seems to.
          </div>
        )}
      </div>
      <SheetOption icon={<ShieldCheck className="size-4" />} label="Trust and start" onSelect={() => choose('trusted')} />
      <SheetOption
        icon={<User className="size-4" />}
        label="Use my settings only"
        description="Leaves out this folder’s settings, hooks, commands, MCP servers and CLAUDE.md"
        onSelect={() => choose('user-only')}
      />
    </Sheet>
  );
}
