import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { config } from '../src/server/config';
import { checkAddress, findPhoneAddress, normalAddress, phoneBlock, servedAddress, setupHint } from '../src/server/phone';
import { instance, recordRunning, runningServer } from '../src/server/running';

const saved = { ...config };
let dir: string;
let server: Server;
let base: string;
let answer: { status: number; body: string } = { status: 200, body: '{}' };

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'pelican-phone-'));
  config.stateDir = dir;
  config.publicUrl = undefined;
  // Stands in for whatever an address reaches: this Pelican, another one, or something else.
  server = createServer((req, res) => {
    expect(req.headers.authorization).toBeUndefined();
    expect(req.headers.cookie).toBeUndefined();
    res.writeHead(answer.status, { 'content-type': 'application/json' }).end(answer.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/`;
});
afterAll(async () => {
  Object.assign(config, saved);
  server.close();
  await rm(dir, { recursive: true, force: true });
});

describe('the address `tailscale serve` gives Pelican', () => {
  const served = {
    TCP: { 443: { HTTPS: true } },
    Web: { 'laptop.tail1234.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:7860' } } } },
  };

  it('is the tailnet name whose handler forwards to Pelican’s port', () => {
    expect(servedAddress(served, 7860)).toEqual({ url: 'https://laptop.tail1234.ts.net/', from: 'tailscale serve' });
    expect(servedAddress(served, 7861)).toBeUndefined();
    expect(servedAddress({}, 7860)).toBeUndefined();
    expect(servedAddress(undefined, 7860)).toBeUndefined();
  });

  it('keeps a port and a path, finds foreground serves, and says when Funnel opens it to the internet', () => {
    expect(servedAddress({
      TCP: { 8443: { HTTPS: true } },
      Web: { 'laptop.tail1234.ts.net:8443': { Handlers: { '/pelican': { Proxy: 'localhost:7860' } } } },
      AllowFunnel: { 'laptop.tail1234.ts.net:8443': true },
    }, 7860)).toEqual({ url: 'https://laptop.tail1234.ts.net:8443/pelican/', from: 'tailscale serve', funnel: true });
    expect(servedAddress({ Foreground: { abc: served } }, 7860)?.url).toBe('https://laptop.tail1234.ts.net/');
    // Something else on that port of another machine is not this Pelican.
    expect(servedAddress({ Web: { 'x.ts.net:443': { Handlers: { '/': { Proxy: 'http://192.168.1.9:7860' } } } } }, 7860)).toBeUndefined();
  });
});

describe('an address', () => {
  it('as typed: https when no scheme is given, with a slash at the end', () => {
    expect(normalAddress('laptop.tail1234.ts.net')).toBe('https://laptop.tail1234.ts.net/');
    expect(normalAddress('http://192.168.1.5:7860')).toBe('http://192.168.1.5:7860/');
    expect(normalAddress('https://example.com/pelican?x=1')).toBe('https://example.com/pelican/');
    expect(() => normalAddress('ftp://example.com')).toThrow(/Not an address/);
    expect(() => normalAddress('https://user:pw@example.com')).toThrow(/Not an address/);
  });

  it('given, or set with PELICAN_PUBLIC_URL, comes first', async () => {
    expect((await findPhoneAddress(7860, '127.0.0.1', 'laptop.example.ts.net')).address).toEqual({ url: 'https://laptop.example.ts.net/', from: 'the address given' });
    config.publicUrl = 'https://pelican.example.com/';
    expect((await findPhoneAddress(7860, '127.0.0.1')).address).toEqual({ url: 'https://pelican.example.com/', from: 'PELICAN_PUBLIC_URL' });
    config.publicUrl = undefined;
  });

  it('is checked to reach this very Pelican, with no secret sent', async () => {
    answer = { status: 200, body: JSON.stringify({ required: true, mode: 'token', signedIn: false, instance: 'me' }) };
    expect(await checkAddress(base, 'me')).toBeUndefined();
    expect(await checkAddress(base, 'someone-else')).toMatch(/another Pelican/);
    answer = { status: 403, body: 'This host name is not allowed. Add it to PELICAN_ALLOWED_HOSTS.' };
    expect(await checkAddress(base, 'me')).toMatch(/does not answer to that name/);
    answer = { status: 404, body: '<html>' };
    expect(await checkAddress(base, 'me')).toMatch(/is not Pelican/);
    expect(await checkAddress('http://127.0.0.1:1/', 'me')).toMatch(/Could not reach/);
  });
});

describe('the terminal’s QR code', () => {
  it('carries a one-time code, never the token, and says how long it works', () => {
    const block = phoneBlock({ url: 'https://laptop.tail1234.ts.net/', from: 'tailscale serve' }, 'abc');
    expect(block).toContain('On your phone: https://laptop.tail1234.ts.net/ (tailscale serve)');
    expect(block).toContain('works once, for two minutes');
    expect(phoneBlock({ url: 'http://192.168.1.5:7860/', from: 'your network' }, null)).not.toContain('two minutes');
    expect(phoneBlock({ url: 'https://x.ts.net/', from: 'tailscale serve', funnel: true }, 'c')).toContain('open to the whole internet');
  });

  it('when there is no address yet, says the one command that makes one', () => {
    const hint = setupHint({ tailscale: { cli: '/Applications/Tailscale.app/Contents/MacOS/Tailscale', name: 'laptop.tail1234.ts.net' } }, 7860, 'pelican').join('\n');
    expect(hint).toContain('/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg 7860');
    expect(hint).toContain('https://laptop.tail1234.ts.net/');
    expect(setupHint({}, 7860, 'pelican-cc').join('\n')).toContain('`pelican-cc phone https://…`');
  });
});

describe('the running Pelican', () => {
  it('is found by the commands that talk to it, while it runs', async () => {
    await recordRunning({ port: 7861, host: '127.0.0.1', url: 'http://127.0.0.1:7861/', version: '0' });
    expect(await runningServer()).toMatchObject({ pid: process.pid, port: 7861, instance });
    await writeFile(path.join(dir, 'server.json'), JSON.stringify({ pid: 999_999_999, port: 7861, host: '127.0.0.1', url: 'x' }));
    expect(await runningServer()).toBeUndefined();
  });
});
