import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/web/styles.css', import.meta.url), 'utf8');

/** The custom properties set in the first block that starts with `selector {`. */
function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`No ${selector} block`);
  const body = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1]!, m[2]!.toLowerCase()]));
}

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};

/** WCAG 2 contrast ratio. */
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

const themes = {
  light: tokens(':root'),
  dark: tokens(":root[data-theme='dark']"),
};

describe('colours', () => {
  it('give text at least 4.5:1 on every surface, in both themes', () => {
    const failures: string[] = [];
    for (const [name, t] of Object.entries(themes)) {
      // Selected rows sit on chip, hovered ones on hover, sheets and cards on panel.
      for (const text of ['fg', 'muted', 'faint', 'run', 'wait', 'live', 'danger']) {
        for (const surface of ['bg', 'panel', 'chip', 'hover']) {
          const ratio = contrast(t[text]!, t[surface]!);
          if (ratio < 4.5) failures.push(`${name} ${text} on ${surface}: ${ratio.toFixed(2)}`);
        }
      }
      for (const [text, surface] of [['add', 'add-bg'], ['del', 'del-bg'], ['bg', 'fg'], ['bg', 'danger'], ['accent-fg', 'accent'], ['fg', 'mark']] as const) {
        const ratio = contrast(t[text]!, t[surface]!);
        if (ratio < 4.5) failures.push(`${name} ${text} on ${surface}: ${ratio.toFixed(2)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('mark what a search found so it stands out from the line around it, on a row and under the pointer', () => {
    for (const t of Object.values(themes)) {
      expect(contrast(t.mark!, t.bg!)).toBeGreaterThan(1.3);
      expect(contrast(t.mark!, t.hover!)).toBeGreaterThan(1.25);
    }
  });

  it('let a waiting quote’s chip and its passage’s mark read: the faint lead and the note, and words under the mark', () => {
    /** `top` laid over `under` at `amount`, as color-mix does (here in sRGB, near enough for a check). */
    const over = (top: string, under: string, amount: number) => `#${[1, 3, 5].map((i) => {
      const value = Math.round(parseInt(top.slice(i, i + 2), 16) * amount + parseInt(under.slice(i, i + 2), 16) * (1 - amount));
      return value.toString(16).padStart(2, '0');
    }).join('')}`;
    for (const t of Object.values(themes)) {
      // A chip sits on bg: the passage's lead faint, the note in fg, a comment's place faint.
      expect(contrast(t.faint!, t.bg!)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.fg!, t.bg!)).toBeGreaterThanOrEqual(4.5);
      // Where it was said, marked in the amber at 60% (styles.css, ::highlight(pelican-quote-source)).
      const marked = over(t.mark!, t.bg!, 0.6);
      expect(contrast(t.fg!, marked)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.muted!, marked)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(marked, t.bg!)).toBeGreaterThan(1.2);
    }
  });

  it('ring what has the keys in a colour that stands out from what it sits on: a chip, the pill, the bar', () => {
    for (const t of Object.values(themes)) {
      for (const surface of ['bg', 'panel', 'hover']) expect(contrast(t.faint!, t[surface]!)).toBeGreaterThanOrEqual(3);
    }
  });

  it('keep faint a step lighter than muted, so the two still read apart', () => {
    for (const t of Object.values(themes)) {
      expect(contrast(t.muted!, t.bg!) / contrast(t.faint!, t.bg!)).toBeGreaterThan(1.3);
    }
  });

  it('are the same dark theme whether the system or Settings picks it', () => {
    expect(tokens(":root:not([data-theme='light'])")).toEqual(themes.dark);
  });
});
