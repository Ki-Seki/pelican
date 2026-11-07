import { MessageSquare, X } from 'lucide-react';
import { createContext, useContext } from 'react';

import { ariaKeys, composing, hasKeyboard, keyText } from '../lib/keyboard';
import { enterSends } from '../lib/prefs';
import type { LineComment } from '../lib/review';

/**
 * Sends the session's line comments to Claude now, all at once (Claude Desktop's ⌘↵); otherwise
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
 * Claude Desktop's box for a comment on a line, or on a few in a row: Cancel · Send to Claude · Add
 * comment, with its keys. Enter adds the comment where Enter sends a message (a computer, unless
 * Settings says otherwise); ⌘↵ (Ctrl Enter) is Send to Claude: it adds it and sends everything that
 * waits at once; Esc lets it go. `onSave(true)`: send it all now.
 */
export function CommentBox({ note, onNote, onSave, onCancel }: { note: string; onNote: (note: string) => void; onSave: (sendAll: boolean) => void; onCancel: () => void }) {
  const ready = note.trim().length > 0;
  const sends = useSendComments();
  // Keys, faintly, where there is a keyboard to press them; where Enter makes a new line, Add comment has none.
  const keyboard = hasKeyboard();
  const addKey = keyboard && enterSends() ? keyText('commentAdd') : undefined;
  const sendKey = keyboard ? keyText('commentSend') : undefined;
  return (
    <form
      data-comment-box
      className="mx-1.5 my-1.5 rounded-2xl border border-line bg-panel p-2.5 font-sans shadow-sm"
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
            if (ready) onSave(Boolean(sends));
          } else if (e.key === 'Enter' && !e.shiftKey && !e.altKey && enterSends()) {
            e.preventDefault();
            if (ready) onSave(false);
          }
        }}
        className="block w-full resize-none rounded-xl border border-line bg-bg px-3 py-2 text-[16px] leading-snug outline-none placeholder:text-faint focus:border-fg pointer-fine:text-[14px]"
      />
      <div className="mt-2 flex items-center justify-end gap-1.5">
        <button type="button" onClick={onCancel} className="mr-auto h-11 rounded-full px-3 text-[14px] text-muted hover:bg-hover hover:text-fg pointer-fine:mr-0 pointer-fine:h-8 pointer-fine:text-[13px]">Cancel</button>
        {sends && (
          <button type="button" disabled={!ready} onClick={() => onSave(true)} aria-keyshortcuts={ariaKeys('commentSend')} className="flex h-11 items-center gap-1.5 rounded-full bg-chip px-4 text-[14px] hover:bg-hover disabled:opacity-40 pointer-fine:h-8 pointer-fine:px-3 pointer-fine:text-[13px]">
            Send to Claude{sendKey && <span aria-hidden className="text-[11.5px] text-faint">{sendKey}</span>}
          </button>
        )}
        <button type="submit" disabled={!ready} aria-keyshortcuts={addKey ? ariaKeys('commentAdd') : undefined} className="flex h-11 items-center gap-1.5 rounded-full bg-fg px-4 text-[14px] font-medium text-bg disabled:opacity-40 pointer-fine:h-8 pointer-fine:px-3.5 pointer-fine:text-[13px]">
          Add comment{addKey && <span aria-hidden className="text-[11.5px] font-normal opacity-60">{addKey}</span>}
        </button>
      </div>
    </form>
  );
}
