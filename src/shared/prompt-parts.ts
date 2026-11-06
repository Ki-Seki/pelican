/**
 * A prompt as the conversation shows it: its words, and the quotes Pelican put above them
 * (web/lib/quote), each a run of lines that start with `>`, with the `path:line` line just above
 * it when it is from a file. The conversation and the export read prompts the same way.
 */

/** Where a quote is from: a path and a line or a range, as a line comment names it too (web/lib/review). */
export const HEADER = /^(\S(?:.*\S)?):(\d+)(?:-(\d+))?( \(removed\))?$/;
export const QUOTED = /^>( |$)/;
const FENCE = /^\s*(```|~~~)/;

/** A prompt as it is shown: its words, and the quotes in it (where one is from, and what it says). */
export type PromptPart = { kind: 'text'; text: string } | { kind: 'quote'; from?: string; text: string };

/**
 * A prompt cut into its words and its quotes: a quote is a run of lines that start with `>`, with
 * the `path:line` line just above it when there is one (a quote from a file, a comment on a line).
 * Lines in a fenced code block are never a quote.
 */
export function promptParts(text: string): PromptPart[] {
  const lines = text.split('\n');
  const parts: PromptPart[] = [];
  let words: string[] = [];
  let fenced = false;
  const flush = () => {
    const kept = words.join('\n').replace(/^\n+|\n+$/g, '');
    if (kept) parts.push({ kind: 'text', text: kept });
    words = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (FENCE.test(line)) fenced = !fenced;
    const from = !fenced && HEADER.test(line) && QUOTED.test(lines[i + 1] ?? '') ? line : undefined;
    const first = from ? i + 1 : i;
    if (fenced || !QUOTED.test(lines[first] ?? '')) {
      words.push(line);
      continue;
    }
    let end = first;
    while (end < lines.length && QUOTED.test(lines[end]!)) end += 1;
    flush();
    parts.push({ kind: 'quote', ...(from ? { from } : {}), text: lines.slice(first, end).map((l) => l.replace(QUOTED, '')).join('\n') });
    i = end - 1;
  }
  flush();
  return parts;
}
