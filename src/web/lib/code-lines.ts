/**
 * A rehype step for a highlighted code block: its content cut into one `pelican-line` element per
 * line (numbered from 1 in `dataN`), each keeping the highlighting it had, so a file can be shown
 * with line numbers, comments and selection by line. A span that runs over several lines (a long
 * comment, a template string) is repeated on each of them.
 */
type Node = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: Node[] };

/** Every line's pieces, each piece a text wrapped in copies of the spans around it. */
export function splitIntoLines(children: readonly Node[]): Node[][] {
  const lines: Node[][] = [[]];
  const visit = (node: Node, around: readonly Node[]) => {
    if (node.type === 'text') {
      const parts = (node.value ?? '').split('\n');
      parts.forEach((part, i) => {
        if (i > 0) lines.push([]);
        if (!part) return;
        let piece: Node = { type: 'text', value: part };
        for (const span of [...around].reverse()) piece = { type: 'element', tagName: span.tagName ?? 'span', properties: { ...span.properties }, children: [piece] };
        lines.at(-1)!.push(piece);
      });
    } else if (node.type === 'element') {
      for (const child of node.children ?? []) visit(child, [...around, node]);
    }
  };
  for (const child of children) visit(child, []);
  // A text ending in a line break has no line after it.
  if (lines.length > 1 && lines.at(-1)!.length === 0) lines.pop();
  return lines;
}

function walk(node: Node): void {
  for (const child of node.children ?? []) {
    if (child.type === 'element' && child.tagName === 'pre') {
      const code = child.children?.find((c) => c.type === 'element' && c.tagName === 'code');
      if (code) {
        code.children = splitIntoLines(code.children ?? []).map((pieces, i): Node => ({
          type: 'element', tagName: 'pelican-line', properties: { dataN: String(i + 1) }, children: pieces,
        }));
      }
    } else {
      walk(child);
    }
  }
}

export function rehypeCodeLines() {
  return (tree: Node) => walk(tree);
}
