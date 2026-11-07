import { describe, expect, it } from 'vitest';

import { type Installed, ptyMissing, ptyMissingOn } from '../src/server/pty';

const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64'].map((p) => `@lydell/node-pty-${p}`);

/** A computer with these packages installed (by name), as npm lays them out. */
function computer(platform: NodeJS.Platform, arch: string, packages: string[]): Installed {
  return {
    platform,
    arch,
    resolve: (name) => {
      if (!packages.includes(name)) throw Object.assign(new Error(`Cannot find module '${name}'`), { code: 'MODULE_NOT_FOUND' });
      return `/lib/node_modules/pelican-cc/node_modules/${name}/index.js`;
    },
    optional: (index) => (index.endsWith('/@lydell/node-pty/index.js') ? PLATFORMS : []),
  };
}

describe('whether a terminal can start, found without loading anything', () => {
  it('can, with the package and its platform’s binary installed (as here)', () => {
    expect(ptyMissingOn(computer('linux', 'x64', ['@lydell/node-pty', '@lydell/node-pty-linux-x64']))).toBeUndefined();
    expect(ptyMissing()).toBeUndefined();
  });

  it('says what the install left out, and how to get it', () => {
    expect(ptyMissingOn(computer('linux', 'x64', []))).toBe(
      'The terminal needs @lydell/node-pty, which this install left out, as npm\'s --omit=optional does. Install Pelican again without that option; ! commands work as before.',
    );
    expect(ptyMissingOn(computer('darwin', 'arm64', ['@lydell/node-pty']))).toMatch(/^The terminal needs @lydell\/node-pty-darwin-arm64, which this install left out/);
  });

  it('says where there is none to be had', () => {
    expect(ptyMissingOn(computer('linux', 'arm', ['@lydell/node-pty']))).toBe('There is no terminal for linux-arm yet; ! commands work as before.');
    expect(ptyMissingOn(computer('freebsd', 'x64', ['@lydell/node-pty']))).toBe('There is no terminal for freebsd-x64 yet; ! commands work as before.');
    expect(ptyMissingOn(computer('win32', 'x64', ['@lydell/node-pty', '@lydell/node-pty-win32-x64']))).toBe('There is no terminal on Windows yet; in WSL there is one.');
  });
});
