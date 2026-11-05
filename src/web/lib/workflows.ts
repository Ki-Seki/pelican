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

/** A result as a page shows it: JSON pretty, in a code block; anything else as Markdown. */
export function resultMarkdown(text: string): string {
  const trimmed = text.trim();
  if (/^[[{]/.test(trimmed)) {
    try {
      return fenced(JSON.stringify(JSON.parse(trimmed), null, 2), 'json');
    } catch {
      // Not whole JSON (a result cut short): as it is.
    }
  }
  return trimmed;
}
