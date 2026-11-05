import { MessageSquare, X } from 'lucide-react';
import { createContext, useContext } from 'react';

import { composing } from '../lib/keyboard';
import { enterSends } from '../lib/prefs';
import type { LineComment } from '../lib/review';

/**
 * Sends the folder's line comments to Claude now, all at once (Claude Desktop's ⌘↵); otherwise
 * they go with the next message. Provided by Changes and files.
 */
export const SendComments = createContext<(() => void) | undefined>(undefined);
export const useSendComments = () => useContext(SendComments);

/** A comment under its line; one whose line has changed since shows the line as it was. */
export function CommentNote({ comment, outdated = false, onRemove }: { comment: LineComment; outdated?: boolean; onRemove: () => void }) {
  return (
    <div className="flex items-start gap-2 border-y border-line bg-panel py-2 pr-1 pl-3 font-sans text-[13px] leading-snug">
      <MessageSquare className="mt-0.5 size-3.5 shrink-0 text-faint" />
      <div className="min-w-0 flex-1">
        {outdated && <div className="truncate font-mono text-[11.5px] text-faint">{comment.line}: {comment.code.trim()}</div>}
        <p className="whitespace-pre-wrap break-words">{comment.note}</p>
      </div>
      <button type="button" aria-label="Remove comment" onClick={onRemove} className="-my-2 grid size-10 shrink-0 place-items-center rounded-full text-faint hover:text-fg pointer-fine:size-8 pointer-fine:-my-1">
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/**
 * Writing a comment on a line, with Claude Desktop's keys: Enter adds it where Enter sends a
 * message (a computer, unless Settings says otherwise), ⌘↵ (Ctrl Enter) adds it and sends all the
 * comments at once, Esc lets it go. `onSave(true)`: send them all now.
 */
export function CommentBox({ note, onNote, onSave, onCancel }: { note: string; onNote: (note: string) => void; onSave: (sendAll: boolean) => void; onCancel: () => void }) {
  const ready = note.trim().length > 0;
  return (
    <form
      className="border-y border-line bg-panel p-2 font-sans"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) onSave(false);
      }}
    >
      <textarea
        autoFocus
        rows={2}
        value={note}
        aria-label="Comment for Claude"
        placeholder="Comment for Claude"
        onChange={(e) => onNote(e.target.value)}
        onKeyDown={(e) => {
          // Keys an input method takes are its own: Esc there cancels a conversion, not the comment.
          if (composing(e.nativeEvent)) return;
          if (e.key === 'Escape') {
            // The comment goes; the view around it stays.
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            e.stopPropagation();
            if (ready) onSave(true);
          } else if (e.key === 'Enter' && !e.shiftKey && !e.altKey && enterSends()) {
            e.preventDefault();
            if (ready) onSave(false);
          }
        }}
        className="block w-full resize-none rounded-lg border border-line bg-bg px-2.5 py-2 text-[16px] leading-snug outline-none placeholder:text-faint focus:border-fg pointer-fine:text-[14px]"
      />
      <div className="mt-2 flex justify-end gap-1.5">
        <button type="button" onClick={onCancel} className="h-10 rounded-full px-3.5 text-[14px] text-muted hover:bg-hover hover:text-fg pointer-fine:h-9">Cancel</button>
        <button type="submit" disabled={!ready} className="h-10 rounded-full bg-fg px-4 text-[14px] font-medium text-bg disabled:opacity-40 pointer-fine:h-9">Comment</button>
      </div>
    </form>
  );
}
