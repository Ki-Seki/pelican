// @vitest-environment jsdom
// A still preview loads nothing: no element that makes the browser look up a host or fetch is
// left in it, wherever it hides.
import { describe, expect, it } from 'vitest';

const { documentFor } = await import('../src/web/components/Preview');

const LOADER = /<(iframe|frame|frameset|object|embed|portal|fencedframe|link|base|script)\b|<meta\b(?![^>]*Content-Security-Policy|[^>]*x-dns-prefetch-control|[^>]*charset|[^>]*viewport)/i;
const leak = (name: string) => `https://${name}.leak.invalid/`;

const vectors: Record<string, string> = {
  frame: `<iframe src="${leak('frame')}"></iframe>`,
  svg: `<svg width="10" height="10"><foreignObject width="10" height="10"><iframe xmlns="http://www.w3.org/1999/xhtml" src="${leak('svg')}"></iframe></foreignObject></svg>`,
  noscript: `<noscript><iframe src="${leak('noscript')}"></iframe></noscript>`,
  shadow: `<div><template shadowrootmode="open"><iframe src="${leak('shadow')}"></iframe></template></div>`,
  nested: `<template><template shadowrootmode="open"><object data="${leak('nested')}"></object></template></template>`,
  prerender: `<link rel="prerender" href="${leak('prerender')}">`,
  preconnect: `<link rel="preconnect" href="${leak('preconnect')}">`,
  refresh: `<meta http-equiv="refresh" content="0;url=${leak('refresh')}">`,
  embed: `<embed src="${leak('embed')}">`,
  base: `<base href="${leak('base')}">`,
  rules: `<script type="speculationrules">{"prerender":[{"urls":["${leak('rules')}"]}]}</script>`,
};

describe('a still preview', () => {
  for (const [name, code] of Object.entries(vectors)) {
    it(`leaves out what would reach the network: ${name}`, () => {
      for (const source of [
        { kind: 'html' as const, code: `<p>Chart</p>${code}`, widget: true },
        { kind: 'html' as const, code: `<!doctype html><html><head>${code}</head><body><p>Chart</p>${code}</body></html>` },
        { kind: 'svg' as const, code: `<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>${code}` },
      ]) {
        const still = documentFor(source, false, true);
        expect(still, name).not.toContain('.leak.invalid');
        expect(still, name).not.toMatch(LOADER);
        expect(still, name).toMatch(/Chart|<rect/);
      }
    });
  }

  it('keeps the drawing and the page as they are otherwise', () => {
    const widget = '<style>.c{fill:red}</style><svg viewBox="0 0 100 50"><rect class="c" width="100" height="50"/><text x="5" y="20">Q3 &amp; Q4</text></svg><p class="note">Rising <b>fast</b></p>';
    const still = documentFor({ kind: 'html', code: widget, widget: true }, false, true);
    expect(still).toContain('<style>.c{fill:red}</style>');
    expect(still).toContain('<text x="5" y="20">Q3 &amp; Q4</text>');
    expect(still).toContain('<p class="note">Rising <b>fast</b></p>');
    const page = documentFor({ kind: 'html', code: '<!doctype html><html lang="en"><head><title>T</title><style>p{color:blue}</style></head><body><p>Hi</p></body></html>' }, true, true);
    expect(page.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(page).toContain('<html lang="en"><head><title>T</title><style>p{color:blue}</style></head><body><p>Hi</p></body></html>');
  });

  it('shows an SVG file Claude wrote or sent as it is, its colors and fonts its own; a visual in its vocabulary', () => {
    const drawing = '<svg viewBox="0 0 200 80"><rect class="box" fill="#fde68a" width="90" height="40"></rect><text class="t" fill="#dc2626" font-family="Georgia">Queue</text></svg>';
    for (const dark of [false, true]) {
      const file = documentFor({ kind: 'svg', code: drawing, file: true }, dark, true);
      expect(file).toContain(drawing);
      // Nothing of the visuals' styles: no fill, stroke, font or color scheme of Pelican's.
      expect(file).not.toMatch(/\.box\{|svg text\{|\.t\{|color-scheme|fill:var/);
      expect(file).toContain('svg{display:block;max-width:100%;height:auto}');
    }
    // A visual, and an SVG in a reply, as Claude Desktop's visuals draw them.
    expect(documentFor({ kind: 'svg', code: drawing, widget: true }, true, true)).toContain('.box{fill:var(--surface)');
    expect(documentFor({ kind: 'svg', code: drawing }, true, true)).toContain('.box{fill:var(--surface)');
  });

  it('runs as written once Run is tapped: only the still one is changed', () => {
    const running = documentFor({ kind: 'html', code: `<p>x</p>${vectors.frame}` }, false);
    expect(running).toContain(vectors.frame);
  });
});
