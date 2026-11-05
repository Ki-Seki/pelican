import { memo } from 'react';

import { Markdown } from './Markdown';

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Markdown that is still being written, cut into blocks that are finished and the part still being
 * written. A block is finished once a blank line outside a code fence follows it and the next line
 * starts at the margin (an indented one may still belong to it, as in a list item). `code` is a
 * fence still open at the end, without its opening line.
 */
export function splitStreaming(text: string): { done: string[]; tail: string; code?: string } {
  const done: string[] = [];
  let start = 0;
  let fence: { char: string; size: number; at: number } | undefined;
  let afterBlank = false;
  for (let pos = 0; ;) {
    const end = text.indexOf('\n', pos);
    if (end < 0) {
      // The last line may be half written, but its first character already says where it starts.
      if (!fence && afterBlank && pos > start && /^\S/.test(text.slice(pos))) {
        done.push(text.slice(start, pos));
        start = pos;
      }
      break;
    }
    const line = text.slice(pos, end);
    if (fence) {
      const close = FENCE.exec(line);
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.size && !line.slice(close[0].length).trim()) fence = undefined;
    } else if (!line.trim()) {
      afterBlank = true;
    } else {
      if (afterBlank && pos > start && !/^[ \t]/.test(line)) {
        done.push(text.slice(start, pos));
        start = pos;
      }
      afterBlank = false;
      const open = FENCE.exec(line);
      if (open) fence = { char: open[1]![0]!, size: open[1]!.length, at: pos };
    }
    pos = end + 1;
  }
  if (!fence) return { done, tail: text.slice(start) };
  const fenceLine = text.indexOf('\n', fence.at);
  return { done, tail: text.slice(start, fence.at), code: text.slice(fenceLine + 1) };
}

/**
 * Claude's reply as it streams in. Finished blocks are parsed once and kept; only the block being
 * written is parsed again as text arrives, and code still being written is shown plain, to be
 * highlighted once its fence closes. Otherwise every few frames would re-parse and re-highlight
 * the whole reply, which slows a phone more the longer the reply gets.
 */
export const StreamingMarkdown = memo(function StreamingMarkdown({ text, className = '' }: { text: string; className?: string }) {
  const { done, tail, code } = splitStreaming(text);
  const parts = [...done, ...(tail.trim() ? [tail] : [])];
  return (
    <div className={className}>
      {parts.map((part, i) => <Markdown key={i} text={part} className={i > 0 ? 'mt-[0.6em]' : ''} />)}
      {code !== undefined && (
        <div className={`prose-chat ${parts.length > 0 ? 'mt-[0.6em]' : ''}`}>
          <pre className="pr-10"><code>{code}</code></pre>
        </div>
      )}
    </div>
  );
});
