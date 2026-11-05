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
      for (const [text, surface] of [['add', 'add-bg'], ['del', 'del-bg'], ['bg', 'fg'], ['bg', 'danger'], ['accent-fg', 'accent']] as const) {
        const ratio = contrast(t[text]!, t[surface]!);
        if (ratio < 4.5) failures.push(`${name} ${text} on ${surface}: ${ratio.toFixed(2)}`);
      }
    }
    expect(failures).toEqual([]);
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
