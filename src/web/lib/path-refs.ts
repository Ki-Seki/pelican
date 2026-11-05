import { parseRef } from './path-links';

/**
 * A rehype step for Markdown: inline code that names a file (`src/app.ts:42`) and words in prose
 * that surely do (src/app.ts:42, README.md) are wrapped in a `pelican-path` element carrying the
 * path and line, for the conversation to link them (PathRef). Code blocks, links and code keep
 * their text as it is; nothing here looks at the disk.
 */
type Node = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: Node[] };

/** Words in prose with a dot or a slash in them, and maybe a line after: the candidates. */
const WORD = /(?<![\w@~+./-])((?:\.{1,2}\/|\/)?[\w@~+-]+(?:[./][\w@~+-]+)+\/?(?::\d{1,7}(?:[-–]\d{1,7})?)?)(?![\w@~+/-])/g;

const textOf = (node: Node): string => (node.type === 'text' ? node.value ?? '' : (node.children ?? []).map(textOf).join(''));

function wrap(text: string, children: Node[], code: boolean): Node | undefined {
  const ref = parseRef(text, code);
  if (!ref) return undefined;
  return {
    type: 'element',
    tagName: 'pelican-path',
    properties: { dataPath: ref.path, ...(ref.line ? { dataLine: String(ref.line) } : {}), ...(ref.end ? { dataEnd: String(ref.end) } : {}) },
    children,
  };
}

function split(value: string): Node[] {
  const out: Node[] = [];
  let at = 0;
  for (const match of value.matchAll(WORD)) {
    const word = match[1]!;
    const element = wrap(word, [{ type: 'text', value: word }], false);
    if (!element) continue;
    if (match.index > at) out.push({ type: 'text', value: value.slice(at, match.index) });
    out.push(element);
    at = match.index + word.length;
  }
  if (at === 0) return [{ type: 'text', value }];
  if (at < value.length) out.push({ type: 'text', value: value.slice(at) });
  return out;
}

function walk(node: Node, plain: boolean): void {
  if (!node.children) return;
  const out: Node[] = [];
  for (const child of node.children) {
    if (child.type === 'element' && child.tagName === 'code' && node.tagName !== 'pre') {
      out.push(wrap(textOf(child), [child], true) ?? child);
    } else if (child.type === 'element') {
      walk(child, plain && !['a', 'pre', 'code', 'button'].includes(child.tagName ?? ''));
      out.push(child);
    } else if (child.type === 'text' && plain && child.value) {
      out.push(...split(child.value));
    } else {
      out.push(child);
    }
  }
  node.children = out;
}

export function rehypePathRefs() {
  return (tree: Node) => walk(tree, true);
}
