import { useId, useMemo, useRef, useState } from 'react';

import { entries, LINES_ACTIONS, type LinesTarget } from '../lib/actions';
import { headerOnly } from '../lib/diff-header';
import { newId } from '../lib/ids';
import { hasKeyboard } from '../lib/keyboard';
import { markTipSeen, tipSeen } from '../lib/prefs';
import { type CodeLine, commentKey, type DiffLine, lastLine, type LineComment, lineKey, lineNumber, parseDiff, setComments, useComments, useCommentsChat } from '../lib/review';
import { ActionMenu, type MenuAnchor } from './ActionMenu';
import { CommentBox, CommentNote, useSendComments } from './Comments';
import { LinesBar } from './FileViewer';
import { useLineDrag, useLinePick, useLineSelection } from './line-pick';

const isCode = (line: { kind: string }): line is CodeLine => line.kind === 'add' || line.kind === 'del' || line.kind === 'same';

/**
 * A unified diff, one row per line, wrapped to the screen, with the line numbers. A tap on a line
 * (or Enter on the one the arrow keys reach) opens a comment on it for Claude, as the diff views of
 * Claude Code on the web and Claude Desktop do; the comments go into the message being written.
 * A diff read again can come back empty (the file was committed) or no longer empty (Claude edited
 * it): what shows in place of the lines is decided here, and the lines have a component of their own.
 */
export function UnifiedDiff({ diff, path, cwd }: { diff: string; path: string; cwd: string }) {
  const lines = useMemo(() => parseDiff(diff), [diff]);
  if (!diff.trim()) return <div className="px-3 py-6 text-center text-[13px] text-faint">No changes in this file</div>;
  if (/^Binary files /m.test(diff)) return <div className="px-3 py-6 text-center text-[13px] text-faint">A binary file changed</div>;
  if (lines.length === 0) {
    // A file renamed whole, or one whose mode alone changed: git's header says so, in its own terms.
    const said = headerOnly(diff);
    if (said) return <div className="px-3 py-6 text-center text-[13px] break-words text-faint">{said}</div>;
    return <pre className="px-3 py-6 font-mono text-[12px] whitespace-pre-wrap text-faint">{diff}</pre>;
  }
  return <DiffLines lines={lines} path={path} cwd={cwd} />;
}

/** The lines of one side of a diff numbered `from` to `to`: the new file's (added and unchanged), or the old one's removed lines. */
function sideText(lines: readonly DiffLine[], kind: CodeLine['kind'], from: number, to: number): string {
  return lines.filter(isCode)
    .filter((line) => (kind === 'del' ? line.kind === 'del' && line.oldLine >= from && line.oldLine <= to : line.kind !== 'del' && line.newLine >= from && line.newLine <= to))
    .map((line) => line.text)
    .join('\n');
}

/**
 * A comment on rows `from` to `to` (places in the diff): on the new file's lines, the removed ones
 * left out, or, where only removed lines were picked, on the old file's, Desktop's "(before changes)".
 */
function commentOn(lines: readonly DiffLine[], from: number, to: number): Pick<LineComment, 'kind' | 'line' | 'to' | 'code'> | undefined {
  const picked = lines.slice(Math.min(from, to), Math.max(from, to) + 1).filter(isCode);
  const removed = picked.every((line) => line.kind === 'del');
  const used = removed ? picked : picked.filter((line) => line.kind !== 'del');
  const [first, last] = [used[0], used.at(-1)];
  if (!first || !last) return undefined;
  const kind = removed ? 'del' : used.some((line) => line.kind === 'add') ? 'add' : 'same';
  return { kind, line: lineNumber(first), ...(lineNumber(last) > lineNumber(first) ? { to: lineNumber(last) } : {}), code: used.map((line) => line.text).join('\n') };
}

function DiffLines({ lines, path, cwd }: { lines: DiffLine[]; path: string; cwd: string }) {
  const chat = useCommentsChat(cwd);
  const all = useComments(chat);
  const comments = useMemo(() => all.filter((c) => c.path === path), [all, path]);
  // The rows a comment is being written on, by their place in the diff; what is typed follows a
  // tap on another line, so a missed line costs nothing.
  const [editing, setEditing] = useState<{ from: number; to: number; note: string }>();
  // Rows a finger is picking (a long press, then a drag), before the box opens on them.
  const [dragging, setDragging] = useState<{ from: number; to: number }>();
  const [cursor, setCursor] = useState<number>();
  const [menu, setMenu] = useState<{ at: MenuAnchor; from: number; to: number }>();
  const [showHint] = useState(() => !tipSeen('line-comments'));
  const box = useRef<HTMLDivElement | null>(null);
  const [boxShown, setBoxShown] = useState<HTMLDivElement | null>(null);
  const id = useId();
  const sendAll = useSendComments();
  const selection = useLineSelection(box, 'data-row');
  const open = (from: number, to = from) => setEditing((current) => ({ from: Math.min(from, to), to: Math.max(from, to), note: current?.note ?? '' }));
  const pick = useLinePick((row: number) => open(row));
  useLineDrag(boxShown, 'data-row', (anchor, end, done) => {
    if (!done) setDragging({ from: Math.min(anchor, end), to: Math.max(anchor, end) });
    else {
      setDragging(undefined);
      open(anchor, end);
    }
  });

  const digits = String(Math.max(...lines.map((line) => (isCode(line) ? lineNumber(line) : 0)))).length;
  const inPlace = (c: LineComment) => sideText(lines, c.kind, c.line, lastLine(c)) === c.code;
  const onLine = (line: CodeLine) => comments.filter((c) => commentKey(c) === lineKey(line) && inPlace(c));
  const outdated = comments.filter((c) => !inPlace(c) || !lines.some((line) => isCode(line) && commentKey(c) === lineKey(line)));
  const codeAt = lines.flatMap((line, i) => (isCode(line) ? [i] : []));
  const last = editing && [...codeAt].reverse().find((i) => i <= editing.to);

  const save = (note: string, now: boolean) => {
    const on = editing && commentOn(lines, editing.from, editing.to);
    if (!on) return;
    setComments(chat, [...all, { id: newId(), path, ...on, note: note.trim() }]);
    setEditing(undefined);
    markTipSeen('line-comments');
    box.current?.focus({ preventScroll: true });
    if (now) sendAll?.();
  };
  const remove = (comment: LineComment) => setComments(chat, all.filter((c) => c.id !== comment.id));
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
      pick(cursor, true);
    }
  };
  // Desktop's diff, on a selection or a right-click: Add comment and Copy, on the lines it covers.
  const target = (from: number, to: number, text?: string): LinesTarget => ({
    from,
    to,
    text: text ?? lines.slice(from, to + 1).filter(isCode).map((line) => line.text).join('\n'),
    comment: () => {
      window.getSelection()?.removeAllRanges();
      open(from, to);
    },
  });
  const numbered = (from: number, to: number) => {
    const on = commentOn(lines, from, to);
    return on ? { from: on.line, to: on.to ?? on.line } : { from, to };
  };
  const shownTarget = (t: LinesTarget, from: number, to: number): LinesTarget => ({ ...t, ...numbered(from, to) });

  return (
    <>
      {showHint && comments.length === 0 && (
        <p className="px-2 pb-1.5 text-[12px] text-faint">
          <span className="pointer-fine:hidden">Tap a line, or hold one and drag, to comment on it</span>
          <span className="hidden pointer-fine:inline">Click a line, or select lines, to comment on them</span>
        </p>
      )}
      <div
        ref={(el) => {
          box.current = el;
          setBoxShown(el);
        }}
        role="group"
        tabIndex={0}
        aria-label={`Changes to ${path}`}
        onKeyDown={onKeyDown}
        onPointerDown={() => setCursor(undefined)}
        onContextMenu={(e) => {
          const row = Number((e.target as Element).closest('[data-row]')?.getAttribute('data-row'));
          if (!Number.isFinite(row) || !hasKeyboard() || (e.target as Element).closest('[data-comment-box]')) return;
          e.preventDefault();
          const range = selection && row >= selection.from && row <= selection.to ? selection : { from: row, to: row };
          setMenu({ at: { x: e.clientX, y: e.clientY }, ...range });
        }}
        style={{ WebkitTouchCallout: 'none' }}
        className="overflow-hidden rounded-lg border border-line font-mono text-[12px] leading-[1.6] [@media(hover:none)]:select-none"
      >
        {outdated.map((c) => <CommentNote key={c.id} comment={c} outdated onRemove={() => remove(c)} />)}
        {lines.map((line, i) => {
          if (line.kind === 'hunk') return <div key={i} className="bg-chip px-3 whitespace-pre-wrap break-words text-faint">{line.text}</div>;
          if (line.kind === 'note') return <div key={i} className="px-3 whitespace-pre-wrap break-words text-faint">{line.text}</div>;
          const tone = line.kind === 'add' ? 'bg-add-bg text-add' : line.kind === 'del' ? 'bg-del-bg text-del' : '';
          const inRange = (range?: { from: number; to: number }) => Boolean(range && i >= range.from && i <= range.to);
          const marked = inRange(editing) || inRange(dragging) || cursor === i;
          return (
            <div key={i}>
              <div
                id={`${id}-${i}`}
                data-row={i}
                onClick={(e) => {
                  // Shift-click: the comment being written takes in the lines to here.
                  if (e.shiftKey && editing) open(Math.min(editing.from, i), Math.max(editing.to, i));
                  else pick(i);
                }}
                className={`group/line flex cursor-pointer ${tone} ${marked ? 'shadow-[inset_3px_0_0_var(--fg)]' : 'pointer-fine:hover:shadow-[inset_3px_0_0_var(--faint)]'}`}
              >
                {/* The numbers take the line's own colour on a tinted line, where faint is too faint. */}
                <span className={`relative shrink-0 pr-2 text-right tabular-nums select-none ${line.kind === 'same' ? 'text-faint' : ''}`} style={{ width: `${digits + 2}ch` }}>
                  {lineNumber(line)}
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={`Add comment on line ${lineNumber(line)}`}
                    title="Add comment on this line"
                    onClick={(e) => {
                      e.stopPropagation();
                      open(i);
                    }}
                    className="absolute inset-y-0 right-1 my-auto hidden size-4 place-items-center rounded bg-fg text-[12px] leading-none font-medium text-bg pointer-fine:group-hover/line:grid"
                  >
                    +
                  </button>
                </span>
                <span className="min-w-0 flex-1 pr-3 whitespace-pre-wrap break-words">{line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}{line.text || ' '}</span>
              </div>
              {onLine(line).map((c) => <CommentNote key={c.id} comment={c} onRemove={() => remove(c)} />)}
              {editing && last === i && (
                <CommentBox
                  note={editing.note}
                  onNote={(note) => setEditing({ ...editing, note })}
                  onSave={(now) => save(editing.note, now)}
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
      {selection && !editing && <LinesBar target={shownTarget(target(selection.from, selection.to, selection.from === selection.to ? selection.text : undefined), selection.from, selection.to)} place="sticky bottom-0 z-10 -mx-1 px-2 py-1.5" />}
      <ActionMenu
        open={Boolean(menu)}
        onClose={() => setMenu(undefined)}
        label="Lines"
        entries={menu ? entries(LINES_ACTIONS, target(menu.from, menu.to), 'menu', 'pointer') : []}
        at={menu?.at ?? null}
      />
    </>
  );
}
