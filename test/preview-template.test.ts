// @vitest-environment jsdom
// security#4 the still-preview cleaner with markup a reply could hold.
import { describe, expect, it } from 'vitest';

const { documentFor } = await import('../src/web/components/Preview');

describe('still preview cleaner', () => {
  const cases: Record<string, string> = {
    svgTemplate: '<svg viewBox="0 0 10 10"><template></template><rect width="10" height="10"/></svg>',
    mathTemplate: '<math><template></template><mi>x</mi></math>',
    foreignTemplate: '<svg><foreignObject><template><iframe src="https://ft.leak.invalid/"></iframe></template></foreignObject></svg>',
    annotation: '<math><annotation-xml encoding="text/html"><iframe src="https://ax.leak.invalid/"></iframe></annotation-xml></math>',
  };
  for (const [name, code] of Object.entries(cases)) {
    it(name, () => {
      let out: string | Error;
      try { out = documentFor({ kind: 'html', code, widget: true }, false, true); } catch (e) { out = e as Error; }
      console.log(name, out instanceof Error ? `THROWS: ${out.message}` : `ok, leak=${out.includes('.leak.invalid')}`);
      expect(out).not.toBeInstanceOf(Error);
      expect(String(out)).not.toContain('.leak.invalid');
    });
  }
});
