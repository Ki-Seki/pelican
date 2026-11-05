import { diffLines } from 'diff';
import { useMemo, useState } from 'react';

type Line = { kind: 'add' | 'del' | 'same'; text: string };

function toLines(before: string, after: string): Line[] {
  const lines: Line[] = [];
  for (const part of diffLines(before, after)) {
    const kind = part.added ? 'add' : part.removed ? 'del' : 'same';
    const texts = part.value.replace(/\n$/, '').split('\n');
    for (const text of texts) lines.push({ kind, text });
  }
  return lines;
}

const CONTEXT = 3;

/** Line diff with unchanged stretches folded, like a pull request view. */
export function Diff({ before, after, maxLines = 400 }: { before: string; after: string; maxLines?: number }) {
  const lines = useMemo(() => toLines(before, after), [before, after]);
  const [expanded, setExpanded] = useState(false);

  const rows = useMemo(() => {
    if (expanded) return lines.map((line, i) => ({ line, i }));
    const keep = new Set<number>();
    lines.forEach((line, i) => {
      if (line.kind === 'same') return;
      for (let j = Math.max(0, i - CONTEXT); j <= Math.min(lines.length - 1, i + CONTEXT); j += 1) keep.add(j);
    });
    const out: Array<{ line: Line; i: number } | { gap: number; i: number }> = [];
    let gap = 0;
    lines.forEach((line, i) => {
      if (keep.has(i)) {
        if (gap > 0) out.push({ gap, i });
        gap = 0;
        out.push({ line, i });
      } else {
        gap += 1;
      }
    });
    if (gap > 0 && out.length > 0) out.push({ gap, i: lines.length });
    return out;
  }, [lines, expanded]);

  const shown = rows.slice(0, maxLines);
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-panel font-mono text-[12px] leading-[1.55]">
      {shown.map((row) =>
        'gap' in row ? (
          <button
            key={`gap-${row.i}`}
            type="button"
            aria-expanded={false}
            className="block w-full bg-hover px-3 py-0.5 text-left text-[11px] text-faint hover:text-fg"
            onClick={() => setExpanded(true)}
          >
            ⋯ {row.gap} unchanged line{row.gap === 1 ? '' : 's'}
          </button>
        ) : (
          <div
            key={row.i}
            className={`flex min-w-max ${row.line.kind === 'add' ? 'bg-add-bg text-add' : row.line.kind === 'del' ? 'bg-del-bg text-del' : 'text-muted'}`}
          >
            <span className="w-6 shrink-0 select-none text-center opacity-70">
              {row.line.kind === 'add' ? '+' : row.line.kind === 'del' ? '−' : ''}
            </span>
            <span className="whitespace-pre pr-3">{row.line.text || ' '}</span>
          </div>
        ),
      )}
      {rows.length > maxLines && (
        <div className="px-3 py-1 text-[11px] text-faint">{rows.length - maxLines} more lines</div>
      )}
    </div>
  );
}

export function diffStats(before: string, after: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(before, after)) {
    const count = part.count ?? part.value.split('\n').length - 1;
    if (part.added) added += count;
    else if (part.removed) removed += count;
  }
  return { added, removed };
}
