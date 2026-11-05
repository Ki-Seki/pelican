import { useEffect, useState } from 'react';

/**
 * A line about a workflow's end leads to its card: the card listens for its own id, opens and
 * comes into view.
 */
const revealing = new Set<(toolUseId: string) => void>();

export function revealWorkflow(toolUseId: string): void {
  for (const listener of revealing) listener(toolUseId);
}

export function useRevealed(toolUseId: string, reveal: () => void): void {
  useEffect(() => {
    const listener = (id: string) => {
      if (id === toolUseId) reveal();
    };
    revealing.add(listener);
    return () => {
      revealing.delete(listener);
    };
  }, [toolUseId, reveal]);
}

/** The time, every second while `ticking`, for what counts up as it runs. */
export function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

const WIDE = '(min-width: 640px)';

/** A screen as wide as a computer's, where more of a workflow shows at once. */
export function useWide(): boolean {
  const [wide, setWide] = useState(() => typeof matchMedia === 'function' && matchMedia(WIDE).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return undefined;
    const media = matchMedia(WIDE);
    const change = () => setWide(media.matches);
    change();
    media.addEventListener?.('change', change);
    return () => media.removeEventListener?.('change', change);
  }, []);
  return wide;
}

/** Whether an element is on screen; what is scrolled away asks the server for nothing. */
export function useOnScreen(element: Element | null): boolean {
  const [seen, setSeen] = useState(true);
  useEffect(() => {
    if (!element || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver((entries) => setSeen(entries.some((e) => e.isIntersecting)), { rootMargin: '200px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return seen;
}

/** A fence for a code block longer than any run of backticks in it. */
export function fenced(code: string, language: string): string {
  const longest = Math.max(2, ...[...code.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${language}\n${code.replace(/\n$/, '')}\n${fence}`;
}

/** The start of JSON: an array or object laid out over lines, or one whose first key or item begins. */
const JSON_START = /^(?:[[{][ \t]*\r?\n|\{\s*["}]|\[\s*[[{"\]])/;

/**
 * A result as a page shows it: JSON pretty, in a code block, also when it was cut short (Claude
 * Code and Pelican cut long results), never read as Markdown; a string Claude Code wrote as JSON
 * as its text; anything else, an agent's own words, as Markdown.
 */
export function resultMarkdown(text: string): string {
  const trimmed = text.trim();
  if (/^[[{"]/.test(trimmed)) {
    try {
      const value: unknown = JSON.parse(trimmed);
      return typeof value === 'string' ? value : fenced(JSON.stringify(value, null, 2), 'json');
    } catch {
      if (JSON_START.test(trimmed)) return fenced(trimmed, 'json');
    }
  }
  return trimmed;
}
