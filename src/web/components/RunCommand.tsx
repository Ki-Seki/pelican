import { useEffect, useRef } from 'react';

import { columnsOf, isBlank } from '../../shared/terminal';

/**
 * Run in terminal's question: the command it runs, all of it, as it runs, before it does. A code
 * block scrolls sideways and a step's row says Claude's description of it, so neither is what is
 * asked about: the question shows the command wrapped, its lines numbered and counted, and the
 * blanks a line leads, ends or is padded with drawn (· a space, → a tab), so nothing of it sits
 * past the edge or under blank space. A command laid out so that even this would leave some of it
 * out of sight is never asked about (shared/terminal.ts commandRefusal), and the server refuses it.
 */

/** A part of a line as the question draws it: its text, or blanks drawn as marks. */
export type DrawnPart = { text: string; mark: boolean };

/**
 * A line of the command, drawn: a tab as → to its next stop, a blank in a run of two or more, at
 * the line's end, or other than a plain space as ·; a plain space between two words as itself.
 */
export function drawnLine(line: string): DrawnPart[] {
  const chars = [...line];
  let trailing = chars.length;
  while (trailing > 0 && isBlank(chars[trailing - 1]!)) trailing -= 1;
  const parts: DrawnPart[] = [];
  const add = (text: string, mark: boolean) => {
    const last = parts.at(-1);
    if (last && last.mark === mark) last.text += text;
    else parts.push({ text, mark });
  };
  let column = 0;
  chars.forEach((char, at) => {
    const width = columnsOf(char, column);
    column += width;
    if (char === '\t') return add(`→${' '.repeat(width - 1)}`, true);
    if (!isBlank(char)) return add(char, false);
    const alone = char === ' ' && at < trailing && !isBlank(chars[at - 1] ?? 'x') && !isBlank(chars[at + 1] ?? 'x');
    return add(alone ? ' ' : '·', !alone);
  });
  return parts;
}

/** The command, wrapped, each line numbered, its blanks drawn: all of it, however narrow the screen. */
export function CommandShown({ command }: { command: string }) {
  const lines = command.split('\n');
  const gutter = `${String(lines.length).length + 1}ch`;
  return (
    <div role="group" aria-label="The command" className="py-[0.6em] font-mono text-[12.5px] leading-[1.55]">
      {lines.map((line, at) => (
        <div key={at} className="flex">
          <span aria-hidden className="shrink-0 pr-[1ch] text-right text-faint select-none" style={{ width: gutter }}>{at + 1}</span>
          <span data-line className="min-w-0 flex-1 pr-3 whitespace-pre-wrap [overflow-wrap:anywhere]">
            {drawnLine(line).map((part, i) => (part.mark ? <span key={i} className="text-faint">{part.text}</span> : part.text))}
          </span>
        </div>
      ))}
    </div>
  );
}

/** How the question reads: the command's lines counted. */
export const runAsked = (command: string): string => {
  const lines = command.split('\n').length;
  return lines === 1 ? 'Run this line in a new terminal?' : `Run these ${lines} lines in a new terminal?`;
};

/**
 * Run in terminal's question, in place: what it runs, all of it, then Run or Cancel; Esc cancels
 * (and stops nothing else, Claude included). It takes the keys as it shows, on Run, in view.
 */
export function RunQuestion({ command, onRun, onCancel, className = 'my-[0.6em]' }: { command: string; onRun: () => void; onCancel: () => void; className?: string }) {
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const button = confirm.current;
    button?.focus({ preventScroll: true });
    button?.scrollIntoView?.({ block: 'nearest' });
  }, []);
  return (
    <div
      data-run-question
      className={`overflow-hidden rounded-[10px] border border-line bg-panel ${className}`}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }}
    >
      <div className="flex min-h-8 items-center gap-1 border-b border-line py-1 pr-1 pl-3 text-[11.5px] text-faint select-none">
        <span className="min-w-0 flex-1 text-[12.5px] leading-snug text-muted">{runAsked(command)}</span>
        <button
          ref={confirm}
          type="button"
          onClick={onRun}
          // Looks 28px on a touch screen, takes a finger's 44px: up to the bar's edge, which the
          // box's rounded corners clip, and the rest down over the command; beside each other, the
          // two share the gap.
          className="relative h-6 shrink-0 rounded-full bg-fg px-2.5 text-[12px] font-medium text-bg after:absolute after:-inset-x-0.5 after:-top-0.5 after:-bottom-3.5 pointer-coarse:h-7 pointer-coarse:px-3.5"
        >
          Run
        </button>
        <button type="button" onClick={onCancel} className="relative h-6 shrink-0 rounded-full px-2 text-[12px] text-muted after:absolute after:-inset-x-0.5 after:-top-0.5 after:-bottom-3.5 hover:bg-hover hover:text-fg pointer-coarse:h-7 pointer-coarse:px-3">Cancel</button>
      </div>
      <CommandShown command={command} />
    </div>
  );
}
