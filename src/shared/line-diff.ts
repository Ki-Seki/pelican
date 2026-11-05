/**
 * A line diff (Myers' O(ND) algorithm), for the server, which bundles no diff library: what one
 * turn changed in a file Claude edited several times is the difference between the file before
 * its first edit and after its last. Lines the two texts share at either end are set aside first,
 * so an edit in a long file costs about as much as the edit. Past `maxD` differing lines it gives
 * up (undefined) and the caller shows the edits one by one instead.
 */
export type LineOp = { kind: 'same' | 'del' | 'add'; text: string };

export function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

export function lineDiff(a: readonly string[], b: readonly string[], maxD = 1000): LineOp[] | undefined {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const middle = myers(a.slice(start, endA), b.slice(start, endB), maxD);
  if (!middle) return undefined;
  return [
    ...a.slice(0, start).map((text): LineOp => ({ kind: 'same', text })),
    ...middle,
    ...a.slice(endA).map((text): LineOp => ({ kind: 'same', text })),
  ];
}

function myers(a: readonly string[], b: readonly string[], maxD: number): LineOp[] | undefined {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((text) => ({ kind: 'add', text }));
  if (m === 0) return a.map((text) => ({ kind: 'del', text }));
  const max = Math.min(n + m, maxD);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // How far each diagonal reached before each step, only the diagonals that step can read
  // (k from -d to d, at k + d): walking back from the end needs them, and no more.
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return walkBack(trace, a, b, d);
    }
  }
  return undefined;
}

function walkBack(trace: readonly Int32Array[], a: readonly string[], b: readonly string[], steps: number): LineOp[] {
  const ops: LineOp[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = steps; d > 0; d -= 1) {
    const before = trace[d]!;
    const at = (k: number) => before[k + d]!;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      ops.push({ kind: 'same', text: a[x]! });
    }
    if (down) {
      y -= 1;
      ops.push({ kind: 'add', text: b[y]! });
    } else {
      x -= 1;
      ops.push({ kind: 'del', text: a[x]! });
    }
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    ops.push({ kind: 'same', text: a[x]! });
  }
  return ops.reverse();
}

/** How many lines a diff adds and removes. */
export function diffCounts(ops: readonly LineOp[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.kind === 'add') added += 1;
    else if (op.kind === 'del') removed += 1;
  }
  return { added, removed };
}

export type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] };

/** A diff as unified hunks with `context` lines around each change, numbered as git numbers them. */
export function toHunks(ops: readonly LineOp[], context = 3): Hunk[] {
  const hunks: Hunk[] = [];
  const changed = ops.flatMap((op, i) => (op.kind === 'same' ? [] : [i]));
  if (changed.length === 0) return hunks;
  // Line numbers before each op, in the old file and the new one.
  const oldAt: number[] = [];
  const newAt: number[] = [];
  let o = 1;
  let n = 1;
  for (const op of ops) {
    oldAt.push(o);
    newAt.push(n);
    if (op.kind !== 'add') o += 1;
    if (op.kind !== 'del') n += 1;
  }
  let from = Math.max(0, changed[0]! - context);
  let to = Math.min(ops.length, changed[0]! + context + 1);
  const close = () => {
    const part = ops.slice(from, to);
    hunks.push({
      oldStart: part.some((op) => op.kind !== 'add') ? oldAt[from]! : oldAt[from]! - 1,
      oldLines: part.filter((op) => op.kind !== 'add').length,
      newStart: part.some((op) => op.kind !== 'del') ? newAt[from]! : newAt[from]! - 1,
      newLines: part.filter((op) => op.kind !== 'del').length,
      lines: part.map((op) => `${op.kind === 'add' ? '+' : op.kind === 'del' ? '-' : ' '}${op.text}`),
    });
  };
  for (const i of changed.slice(1)) {
    if (i - context <= to) {
      to = Math.min(ops.length, i + context + 1);
    } else {
      close();
      from = i - context;
      to = Math.min(ops.length, i + context + 1);
    }
  }
  close();
  return hunks;
}

/** Hunks as the text of a unified diff for one file, as `git diff` writes it. */
export function unifiedDiff(path: string, hunks: readonly Hunk[]): string {
  if (hunks.length === 0) return '';
  const range = (start: number, lines: number) => (lines === 1 ? `${start}` : `${start},${lines}`);
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    ...hunks.flatMap((h) => [`@@ -${range(h.oldStart, h.oldLines)} +${range(h.newStart, h.newLines)} @@`, ...h.lines]),
  ].join('\n').concat('\n');
}

/**
 * Applies hunks to a text, as a tool's structured patch was made from it: the text after the
 * edit, or undefined when a hunk does not fit (the file was not what the patch says it was).
 */
export function applyHunks(text: string, hunks: readonly Hunk[]): string | undefined {
  const lines = splitLines(text);
  const endsInBreak = text.endsWith('\n') || text === '';
  const out: string[] = [];
  let at = 0;
  for (const hunk of hunks) {
    const start = Math.max(0, hunk.oldStart - (hunk.oldLines === 0 ? 0 : 1));
    if (start < at || start > lines.length) return undefined;
    out.push(...lines.slice(at, start));
    at = start;
    for (const line of hunk.lines) {
      const mark = line[0];
      const body = line.slice(1);
      if (mark === ' ' || mark === '-') {
        if (lines[at] !== body) return undefined;
        at += 1;
        if (mark === ' ') out.push(body);
      } else if (mark === '+') {
        out.push(body);
      }
      // "\ No newline at end of file" and the like change nothing here.
    }
  }
  out.push(...lines.slice(at));
  return out.length === 0 ? '' : `${out.join('\n')}${endsInBreak ? '\n' : ''}`;
}
