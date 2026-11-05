import { Paperclip, X } from 'lucide-react';

import type { QueuedPrompt } from '../../shared/protocol';

/**
 * Prompts waiting for Claude's turn to end, above the composer, as Claude Code lists what you
 * queued: not in the conversation until Claude gets them. A tap on one takes it back to edit;
 * the cross drops it.
 */
export function QueuedStrip({ queued, onRemove, onEdit }: {
  queued: QueuedPrompt[];
  onRemove: (prompt: QueuedPrompt) => void;
  /** Takes the prompt back into the composer (prompts without files only: those stay with the queue). */
  onEdit: (prompt: QueuedPrompt) => void;
}) {
  return (
    <div className="mx-auto mb-2 max-w-3xl rounded-2xl border border-line bg-panel py-1">
      <div className="px-3 pt-1 text-[11.5px] text-faint">Queued · sent when this turn ends</div>
      {queued.map((prompt) => {
        const files = prompt.attachments?.length ?? 0;
        const text = prompt.text || (files === 1 ? prompt.attachments![0]!.name : `${files} files`);
        return (
          <div key={prompt.uuid} className="flex items-center gap-1 pr-1 pl-3">
            {files === 0 ? (
              <button type="button" title="Edit" onClick={() => onEdit(prompt)} className="min-w-0 flex-1 truncate py-1.5 text-left text-[13.5px] hover:text-muted">
                {text}
              </button>
            ) : (
              <span className="min-w-0 flex-1 truncate py-1.5 text-[13.5px]">{text}</span>
            )}
            {files > 0 && (
              <span className="flex shrink-0 items-center gap-0.5 text-[12px] text-faint tabular-nums"><Paperclip className="size-3" />{files}</span>
            )}
            <button type="button" aria-label="Remove from the queue" onClick={() => onRemove(prompt)} className="grid size-8 shrink-0 place-items-center rounded-full text-faint hover:bg-hover hover:text-fg">
              <X className="size-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
