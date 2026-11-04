import os from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { config } from '../src/server/config';
import { hostAllowed, isLoopback, originAllowed } from '../src/server/security';

const saved = { allowedHosts: config.allowedHosts, allowedOrigins: config.allowedOrigins, host: config.host };
afterEach(() => Object.assign(config, saved));

describe('isLoopback', () => {
  it('knows the loopback names and addresses', () => {
    for (const host of ['localhost', 'localhost:7860', '127.0.0.1', '127.1.2.3:80', '[::1]:7860', 'app.localhost']) expect(isLoopback(host)).toBe(true);
    for (const host of ['0.0.0.0', '192.168.1.5', 'example.com', '127.0.0.1.example.com']) expect(isLoopback(host)).toBe(false);
  });
});

describe('hostAllowed', () => {
  it('answers to loopback and this machine, not to other names (DNS rebinding)', () => {
    expect(hostAllowed('127.0.0.1:7860')).toBe(true);
    expect(hostAllowed(`${os.hostname()}:7860`)).toBe(true);
    expect(hostAllowed('attacker.example:7860')).toBe(false);
    expect(hostAllowed(undefined)).toBe(false);
  });

  it('answers to configured hosts and to the hosts of allowed origins', () => {
    config.allowedHosts = ['pelican.internal'];
    config.allowedOrigins = ['https://code.example.com'];
    expect(hostAllowed('pelican.internal')).toBe(true);
    expect(hostAllowed('code.example.com')).toBe(true);
    expect(hostAllowed('other.example.com')).toBe(false);
    config.allowedHosts = ['*'];
    expect(hostAllowed('anything.example')).toBe(true);
  });
});

describe('originAllowed', () => {
  it('accepts the page’s own origin and configured ones', () => {
    expect(originAllowed('http://localhost:7860', 'localhost:7860')).toBe(true);
    expect(originAllowed('http://evil.example', 'localhost:7860')).toBe(false);
    config.allowedOrigins = ['https://code.example.com'];
    expect(originAllowed('https://code.example.com', 'localhost:7860')).toBe(true);
  });

  it('lets requests without an Origin through (not a browser) and refuses garbage', () => {
    expect(originAllowed(undefined, 'localhost:7860')).toBe(true);
    expect(originAllowed('not a url', 'localhost:7860')).toBe(false);
  });
});
