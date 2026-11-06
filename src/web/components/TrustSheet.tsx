import { ShieldCheck, TriangleAlert, User } from 'lucide-react';

import { revealHidden } from '../../shared/hidden';
import type { CommandAt } from '../../shared/protocol';
import type { TrustChoice } from '../lib/api';
import { shortPath } from '../lib/format';
import { Sheet, SheetOption } from './Sheet';

/**
 * A send that waits for an answer: the folder Claude Code would start in has programs of its own,
 * and where in each item a command is.
 */
export type TrustAsk = { brings: string[]; commands?: CommandAt[][]; answer: (choice: TrustChoice) => void; cancel: () => void };

/**
 * An item with what it may hide written out: its commands as they run (a space other than a plain
 * one where a shell reads it as part of a word, or every one between a program's arguments), the
 * rest as names. Told nothing of its commands, or what cannot be: every such space written out.
 */
function revealItem(item: string, commands: CommandAt[] | undefined): { text: string; hidden: boolean } {
  if (commands === undefined) return revealHidden(item, { runs: 'argv' });
  let text = '';
  let hidden = false;
  let at = 0;
  const add = (shown: { text: string; hidden: boolean }) => {
    text += shown.text;
    hidden ||= shown.hidden;
  };
  for (const [from, to, runs] of commands) {
    if (from < at || to < from || to > item.length) return revealHidden(item, { runs: 'argv' });
    add(revealHidden(item.slice(at, from)));
    add(revealHidden(item.slice(from, to), { runs }));
    at = to;
  }
  add(revealHidden(item.slice(at)));
  return { text, hidden };
}

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
  const items = (ask?.brings ?? []).map((item, i) => revealItem(item, ask?.commands?.[i]));
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
