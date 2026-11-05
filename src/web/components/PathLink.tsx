import type { ReactNode } from 'react';

import { useFileLink } from '../lib/path-links';

/** How a path that opens its file looks in a reply: its own text, underlined quietly, as links there are. */
export const PATH_LINK = 'underline decoration-faint decoration-1 underline-offset-[3px] hover:decoration-fg focus-visible:decoration-fg';

/** In a step, whose row reads as one to tap already: underlined only under the pointer. */
export const STEP_LINK = 'decoration-faint decoration-1 underline-offset-[3px] hover:underline focus-visible:underline';

/**
 * A file reference in a reply (marked by rehypePathRefs): a link to the file at its line once the
 * session's folder is known to hold it, else just what it was.
 */
export function PathRef({ node, children }: { node?: { properties?: Record<string, unknown> }; children?: ReactNode }) {
  const properties = node?.properties ?? {};
  const line = Number(properties.dataLine) || undefined;
  const link = useFileLink(typeof properties.dataPath === 'string' ? properties.dataPath : undefined, line);
  if (!link) return <>{children}</>;
  return (
    <a href={link.href} onClick={link.onClick} title={`Open ${link.path}${line ? ` at line ${line}` : ''}`} className={PATH_LINK}>
      {children}
    </a>
  );
}
