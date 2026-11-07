import { History, Loader2, Undo2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { RewindCheck, RewindRestore } from '../../shared/protocol';
import { clockTime } from '../lib/format';
import { Sheet } from './Sheet';

/** Desktop's names for the three choices, in its order. */
const CHOICES: Record<RewindRestore, string> = { both: 'Code and conversation', conversation: 'Conversation only', code: 'Code only' };

/** Claude Desktop's words for what a rewind does not touch, and what Pelican adds of its own. */
const BACK_IN_BOX = 'Your message goes back in the box.';
const NOT_REVERTED = 'Changes made through shell commands aren’t reverted. Commits stay in place.';

/** A rewind going wrong, or the demo saying what it does not do. */
export type RewindProblem = { text: string; note: boolean };

/**
 * Rewind to here, asked: Claude Desktop's dialog, "Rewind to this message?". When files changed
 * after the message, it offers Desktop's three choices (Code and conversation, Conversation only,
 * Code only) and what goes back; when none did, no choices, and Rewind takes the conversation
 * back. While another app has the session open, the code alone can go back. While Claude Code's
 * check of the files runs it says so, its choices not yet offered.
 */
export function RewindDialog({ open, text, preview, cwd, working, problem, onCancel, onRewind }: {
  open: boolean;
  /** The message's words, as the conversation shows them. */
  text: string;
  /** What can go back, by Claude Code's check; `pending` while it runs. */
  preview: RewindCheck | 'pending';
  cwd?: string;
  working: boolean;
  problem?: RewindProblem;
  onCancel: () => void;
  onRewind: (restore: RewindRestore) => void;
}) {
  const check = preview === 'pending' ? undefined : preview;
  const files = check?.files ?? [];
  const stays = check?.conversationStays;
  const offered: RewindRestore[] = files.length === 0 ? [] : stays ? ['code'] : ['both', 'conversation', 'code'];
  const [picked, setPicked] = useState<RewindRestore>('both');
  useEffect(() => {
    if (open) setPicked('both');
  }, [open, text]);
  // Without choices the conversation goes back; with them, Desktop's default, Code and conversation.
  const restore: RewindRestore = offered.length === 0 ? 'conversation' : offered.includes(picked) ? picked : offered[0]!;
  const code = restore !== 'conversation';
  const note = !check ? '' : [
    ...(stays ? [stays] : []),
    ...(restore !== 'code' ? [BACK_IN_BOX] : []),
    ...(code ? [NOT_REVERTED] : []),
  ].join(' ');
  const rel = (file: string) => (cwd && file.startsWith(`${cwd.replace(/\/$/, '')}/`) ? file.slice(cwd.replace(/\/$/, '').length + 1) : file);
  const close = () => {
    if (!working) onCancel();
  };
  return (
    <Sheet open={open} onClose={close} title="Rewind to this message?">
      <div className="px-3 pb-1">
        <div className="ml-auto w-fit max-w-[85%] rounded-2xl bg-chip px-3.5 py-2 text-[14px] leading-snug text-muted">
          <div className="line-clamp-2 break-words whitespace-pre-wrap">{text}</div>
        </div>
      </div>
      {!check && (
        <div className="flex items-center gap-2 px-3 pt-3 text-[13px] text-muted" aria-live="polite">
          <Loader2 className="size-4 animate-spin" /> Checking for file changes…
        </div>
      )}
      {offered.length > 0 && (
        <>
          <div id="rewind-restore" className="px-3 pt-4 pb-1.5 text-[12px] text-faint">Restore</div>
          <div role="radiogroup" aria-labelledby="rewind-restore">
            {offered.map((choice) => (
              <button
                key={choice}
                type="button"
                role="radio"
                aria-checked={restore === choice}
                disabled={working}
                onClick={() => setPicked(choice)}
                className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-hover disabled:opacity-60 pointer-fine:min-h-10"
              >
                <span aria-hidden className={`grid size-5 shrink-0 place-items-center rounded-full border-2 ${restore === choice ? 'border-fg' : 'border-line'}`}>
                  {restore === choice && <span className="size-2.5 rounded-full bg-fg" />}
                </span>
                <span className="text-[15px] pointer-fine:text-[14px]">{CHOICES[choice]}</span>
              </button>
            ))}
          </div>
          {/* Kept in its place, unseen, while the code stays, so the dialog does not jump. */}
          <div className={`mx-3 mt-2 rounded-xl border border-line px-3 py-2 text-[12px] text-muted ${code ? '' : 'invisible'}`} aria-hidden={!code}>
            <div className="flex items-baseline justify-between gap-3 pb-1 text-[12.5px] text-fg">
              <span>{files.length === 1 ? '1 file goes back' : `${files.length} files go back`}</span>
              <span className="font-mono text-[11.5px] tabular-nums">
                {(check?.insertions ?? 0) > 0 && <span className="text-add">+{check!.insertions}</span>}
                {(check?.insertions ?? 0) > 0 && (check?.deletions ?? 0) > 0 && ' '}
                {(check?.deletions ?? 0) > 0 && <span className="text-del">−{check!.deletions}</span>}
              </span>
            </div>
            <div className="max-h-28 overflow-y-auto">
              {files.map((file) => <div key={file} className="truncate font-mono">{rel(file)}</div>)}
            </div>
          </div>
        </>
      )}
      {note && <p className="px-3 pt-2.5 text-[12.5px] leading-snug text-muted">{note}</p>}
      {problem && <p role="alert" className={`px-3 pt-2 text-[13px] leading-snug ${problem.note ? 'text-muted' : 'text-danger'}`}>{problem.text}</p>}
      <div className="flex gap-2 px-3 pt-3 pb-1 pointer-fine:justify-end">
        <button type="button" data-autofocus disabled={working} onClick={close} className="h-11 flex-1 rounded-full bg-chip px-4 text-[15px] disabled:opacity-40 pointer-fine:h-9 pointer-fine:flex-none pointer-fine:text-[14px]">
          Cancel
        </button>
        <button
          type="button"
          disabled={working || !check}
          aria-busy={working || undefined}
          onClick={() => onRewind(restore)}
          className="flex h-11 flex-1 items-center justify-center gap-2 rounded-full bg-fg px-4 text-[15px] font-medium text-bg disabled:opacity-40 pointer-fine:h-9 pointer-fine:flex-none pointer-fine:text-[14px]"
        >
          {working ? <><Loader2 className="size-4 animate-spin" />Rewinding…</> : 'Rewind'}
        </button>
      </div>
    </Sheet>
  );
}

/** Desktop's words for Undo rewind, said by its button. */
export const UNDO_SAYS = 'Brings back the messages this rewind took out of the conversation. Your files stay as they are. Undo works until you send your next message.';

/**
 * Where a rewind cut the conversation: Claude Desktop's marker, "Rewound here", with Undo rewind,
 * which brings the messages back (the files stay as they are) until the next message.
 */
export function RewoundMarker({ onUndo }: { onUndo?: () => Promise<void> }) {
  const [undoing, setUndoing] = useState(false);
  return (
    <div data-rewound className="flex items-center gap-3 py-1 text-[12px] text-faint">
      <span className="h-px flex-1 bg-line" />
      <span className="flex items-center gap-1.5"><History className="size-3.5" />Rewound here</span>
      {onUndo && (
        <>
          <span aria-hidden className="opacity-60">·</span>
          <button
            type="button"
            title={UNDO_SAYS}
            aria-description={UNDO_SAYS}
            disabled={undoing}
            aria-busy={undoing || undefined}
            onClick={() => {
              setUndoing(true);
              void onUndo().finally(() => setUndoing(false));
            }}
            className="relative flex h-11 items-center gap-1 rounded-full px-1 font-medium text-fg after:absolute after:-inset-x-1 hover:underline disabled:opacity-50 pointer-fine:h-7"
          >
            {undoing ? <Loader2 className="size-3.5 animate-spin" /> : <Undo2 className="size-3.5" />}Undo rewind
          </button>
        </>
      )}
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

/** A prompt, as Rewind to here and /rewind's list name it: its id, its words in a few, and when it was sent. */
export type RewindPoint = { uuid: string; text: string; timestamp?: number };

/**
 * /rewind: which message to rewind to, as Claude Code's Rewind and Desktop's list them: the
 * conversation's prompts, oldest first, the newest picked to begin with. Picking one is its
 * Rewind to here.
 */
export function RewindPicker({ open, points, onClose, onPick }: { open: boolean; points: RewindPoint[]; onClose: () => void; onPick: (point: RewindPoint) => void }) {
  return (
    <Sheet open={open} onClose={onClose} title="Rewind">
      {points.length === 0 ? (
        <div className="px-3 py-6 text-center text-[13px] text-faint italic">Nothing to rewind to yet</div>
      ) : (
        <ul className="pb-1">
          {points.map((point, i) => (
            <li key={point.uuid}>
              <button
                type="button"
                {...(i === points.length - 1 ? { 'data-autofocus': true } : {})}
                onClick={() => onPick(point)}
                className="flex min-h-12 w-full items-baseline gap-3 rounded-xl px-3 py-2 text-left hover:bg-hover focus-visible:bg-hover pointer-fine:min-h-10"
              >
                <span className="line-clamp-2 min-w-0 flex-1 text-[14.5px] break-words">{point.text}</span>
                {point.timestamp && <span className="shrink-0 text-[12px] text-faint tabular-nums">{clockTime(point.timestamp)}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}
