// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

Object.assign(globalThis, { location: new URL('http://localhost:7860/') });
const { documentFor, hasScripts, stillHeight } = await import('../src/web/components/Preview');

describe('a still preview', () => {
  it('carries no script of Pelican’s, and keeps the policy first', () => {
    const still = documentFor({ kind: 'html', code: '<p>hi</p><script>alert(1)</script>' }, false, true);
    expect(still.indexOf('Content-Security-Policy')).toBeLessThan(still.indexOf('<p>hi'));
    expect(still).not.toContain('RTCPeerConnection');
    expect(still).not.toContain('pelicanPreviewHeight');
    expect(still).toContain('x-dns-prefetch-control');
    const running = documentFor({ kind: 'html', code: '<p>hi</p>' }, false);
    expect(running).toContain('RTCPeerConnection');
    expect(running).toContain('pelicanPreviewHeight');
  });

  it('is as tall as its drawing at the width it gets', () => {
    expect(stillHeight({ kind: 'svg', code: '<svg width="100%" viewBox="0 0 400 228"><rect/></svg>' }, 400)).toBe(232);
    expect(stillHeight({ kind: 'svg', code: '\n<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" stroke-width="3">' }, 300)).toBe(154);
    expect(stillHeight({ kind: 'svg', code: '<svg width="100%" height="50%">' }, 300)).toBeUndefined();
    expect(stillHeight({ kind: 'html', code: '<div>x</div>' }, 300)).toBeUndefined();
    expect(stillHeight({ kind: 'svg', code: '<svg viewBox="0 0 10 10">' }, 0)).toBeUndefined();
  });

  it('offers Run only when there is a script to run', () => {
    expect(hasScripts('<svg><rect/></svg>')).toBe(false);
    expect(hasScripts('<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>')).toBe(true);
    expect(hasScripts('<img src=x onerror="alert(1)">')).toBe(true);
    expect(hasScripts('<a href="javascript:void 0">x</a>')).toBe(true);
  });
});
