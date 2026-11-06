import { afterEach, describe, expect, it, vi } from 'vitest';

Object.assign(globalThis, { location: new URL('http://localhost:7860/') });
const { api, ApiError, isUnreachable } = await import('../src/web/lib/api');

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('requests to a computer that cannot be reached', () => {
  it('fail in words that name it, not the browser’s', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ machine: 'laptop', home: '/h', version: '0', auth: false, demo: false })));
    await api.info();
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const error = await api.sessions().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as Error).message).toBe('Can’t reach laptop');
    expect(isUnreachable(error)).toBe(true);
    await expect(api.probe()).resolves.toBe(false);
  });

  it('take a proxy’s 502, 503 or 504 page for the computer out of reach, not for an answer', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ machine: 'laptop', home: '/h', version: '0', auth: false, demo: false })));
    await api.info();
    for (const status of [502, 503, 504]) {
      globalThis.fetch = vi.fn(async () => new Response('<html><title>暂时连不上</title></html>', { status, headers: { 'content-type': 'text/html' } }));
      const error = await api.sessions().catch((e: unknown) => e);
      expect([status, (error as Error).message, isUnreachable(error)]).toEqual([status, 'Can’t reach laptop', true]);
    }
    await expect(api.probe()).resolves.toBe(false);
    // Once it answers again, it is in reach.
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ sessions: [] })));
    await expect(api.probe()).resolves.toBe(true);
  });

  it('keep the server’s own words when it answers', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'No such session' }), { status: 404 }));
    const error = await api.session('x').catch((e: unknown) => e);
    expect((error as Error).message).toBe('No such session');
    expect(isUnreachable(error)).toBe(false);
  });
});
