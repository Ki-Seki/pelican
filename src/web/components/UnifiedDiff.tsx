import { useId, useMemo, useRef, useState } from 'react';

import { newId } from '../lib/ids';
import { markTipSeen, tipSeen } from '../lib/prefs';
import { type CodeLine, commentKey, type LineComment, lineKey, lineNumber, parseDiff, setComments, useComments } from '../lib/review';
import { CommentBox, CommentNote } from './Comments';

const isCode = (line: { kind: string }): line is CodeLine => line.kind === 'add' || line.kind === 'del' || line.kind === 'same';

/**
 * A unified diff, one row per line, wrapped to the screen, with the line numbers. A tap on a line
 * (or Enter on the one the arrow keys reach) opens a comment on it for Claude, as the diff views of
 * Claude Code on the web and Claude Desktop do; the comments go into the message being written.
 */
export function UnifiedDiff({ diff, path, cwd }: { diff: string; path: string; cwd: string }) {
  const lines = useMemo(() => parseDiff(diff), [diff]);
  const all = useComments(cwd);
  const comments = useMemo(() => all.filter((c) => c.path === path), [all, path]);
  // What is typed follows a tap on another line, so a missed line costs nothing.
  const [editing, setEditing] = useState<{ key: string; note: string }>();
  const [cursor, setCursor] = useState<number>();
  const [showHint] = useState(() => !tipSeen('line-comments'));
  const box = useRef<HTMLDivElement>(null);
  const id = useId();

  if (!diff.trim()) return <div className="px-3 py-6 text-center text-[13px] text-faint">No changes in this file</div>;
  if (/^Binary files /m.test(diff)) return <div className="px-3 py-6 text-center text-[13px] text-faint">A binary file changed</div>;
  if (lines.length === 0) return <pre className="px-3 py-6 font-mono text-[12px] whitespace-pre-wrap text-faint">{diff}</pre>;

  const digits = String(Math.max(...lines.map((line) => (isCode(line) ? lineNumber(line) : 0)))).length;
  const onLine = (line: CodeLine) => comments.filter((c) => commentKey(c) === lineKey(line) && c.code === line.text);
  const outdated = comments.filter((c) => !lines.some((line) => isCode(line) && commentKey(c) === lineKey(line) && c.code === line.text));
  const codeAt = lines.flatMap((line, i) => (isCode(line) ? [i] : []));

  const pick = (line: CodeLine) => {
    // Selecting text to copy is not asking to comment.
    if (window.getSelection()?.toString()) return;
    setEditing((current) => ({ key: lineKey(line), note: current?.note ?? '' }));
  };
  const save = (line: CodeLine, note: string) => {
    setComments(cwd, [...all, { id: newId(), path, kind: line.kind, line: lineNumber(line), code: line.text, note: note.trim() }]);
    setEditing(undefined);
    markTipSeen('line-comments');
    box.current?.focus({ preventScroll: true });
  };
  const remove = (comment: LineComment) => setComments(cwd, all.filter((c) => c.id !== comment.id));
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget || codeAt.length === 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const at = cursor === undefined ? -1 : codeAt.indexOf(cursor);
      const next = e.key === 'ArrowDown' ? codeAt[Math.min(codeAt.length - 1, at + 1)]! : codeAt[Math.max(0, at - 1)]!;
      setCursor(next);
      document.getElementById(`${id}-${next}`)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && cursor !== undefined) {
      e.preventDefault();
      pick(lines[cursor] as CodeLine);
    }
  };

  return (
    <>
      {showHint && comments.length === 0 && (
        <p className="px-2 pb-1.5 text-[12px] text-faint"><span className="pointer-fine:hidden">Tap</span><span className="hidden pointer-fine:inline">Click</span> a line to comment on it</p>
      )}
      <div
        ref={box}
        role="group"
        tabIndex={0}
        aria-label={`Changes to ${path}`}
        onKeyDown={onKeyDown}
        onPointerDown={() => setCursor(undefined)}
        className="overflow-hidden rounded-lg border border-line font-mono text-[12px] leading-[1.6]"
      >
        {outdated.map((c) => <CommentNote key={c.id} comment={c} outdated onRemove={() => remove(c)} />)}
        {lines.map((line, i) => {
          if (line.kind === 'hunk') return <div key={i} className="bg-chip px-3 whitespace-pre-wrap break-words text-faint">{line.text}</div>;
          if (line.kind === 'note') return <div key={i} className="px-3 whitespace-pre-wrap break-words text-faint">{line.text}</div>;
          const key = lineKey(line);
          const tone = line.kind === 'add' ? 'bg-add-bg text-add' : line.kind === 'del' ? 'bg-del-bg text-del' : '';
          const marked = editing?.key === key || cursor === i;
          return (
            <div key={i}>
              <div
                id={`${id}-${i}`}
                onClick={() => pick(line)}
                className={`flex cursor-pointer ${tone} ${marked ? 'shadow-[inset_3px_0_0_var(--fg)]' : 'pointer-fine:hover:shadow-[inset_3px_0_0_var(--faint)]'}`}
              >
                {/* The numbers take the line's own colour on a tinted line, where faint is too faint. */}
                <span className={`shrink-0 pr-2 text-right tabular-nums select-none ${line.kind === 'same' ? 'text-faint' : ''}`} style={{ width: `${digits + 2}ch` }}>{lineNumber(line)}</span>
                <span className="min-w-0 flex-1 pr-3 whitespace-pre-wrap break-words">{line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}{line.text || ' '}</span>
              </div>
              {onLine(line).map((c) => <CommentNote key={c.id} comment={c} onRemove={() => remove(c)} />)}
              {editing?.key === key && (
                <CommentBox
                  note={editing.note}
                  onNote={(note) => setEditing({ key, note })}
                  onSave={() => save(line, editing.note)}
                  onCancel={() => {
                    setEditing(undefined);
                    box.current?.focus({ preventScroll: true });
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

