import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { compare, intact, pinned } from '../scripts/pty-binaries.mjs';
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
      'package.json': '{"name":"@lydell/node-pty-plan9-x64"}',
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
    const changed = files(tgz({ 'prebuilds/plan9-x64/pty.node': Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 4]) }));
    expect(compare(changed, microsoft, 'plan9-x64').problems).toEqual([
      expect.stringMatching(/^plan9-x64: prebuilds\/plan9-x64\/pty\.node is not Microsoft's \(sha256 [0-9a-f]{64}, Microsoft's [0-9a-f]{64}\)$/),
      'plan9-x64: no native module that is Microsoft\'s',
    ]);
    const added = files(tgz({ 'prebuilds/plan9-x64/pty.node': Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]), 'lib/extra.js': 'more\n' }));
    expect(compare(added, microsoft, 'plan9-x64').problems).toEqual(['plan9-x64: lib/extra.js is not in Microsoft\'s package']);
    expect(compare(files(tgz({ 'lib/index.js': 'exports.spawn = () => {};\n' })), microsoft, 'plan9-x64').problems).toEqual(['plan9-x64: no native module that is Microsoft\'s']);
  });

  it('takes a download only when it is what its integrity says', () => {
    const data = tgz({ 'lib/index.js': 'x' });
    expect(intact(data, integrity(data))).toBe(true);
    expect(intact(Buffer.concat([data, Buffer.from([0])]), integrity(data))).toBe(false);
    expect(intact(data, `sha1-${createHash('sha1').update(data).digest('base64')}`)).toBe(false);
    expect(intact(data, '')).toBe(false);
  });

  it('reads the exact version package.json pins, and the platform packages npm-shrinkwrap.json pins for it', () => {
    const shrinkwrap = {
      packages: {
        'node_modules/@lydell/node-pty': { version: '1.2.0-beta.18', optionalDependencies: { '@lydell/node-pty-plan9-x64': '1.2.0-beta.18' } },
        'node_modules/@lydell/node-pty-plan9-x64': { version: '1.2.0-beta.18', resolved: 'https://registry.example/x.tgz', integrity: 'sha512-AAAA' },
      },
    };
    expect(pinned({ optionalDependencies: { '@lydell/node-pty': '1.2.0-beta.18' } }, shrinkwrap)).toEqual({
      version: '1.2.0-beta.18',
      platforms: [{ name: '@lydell/node-pty-plan9-x64', platform: 'plan9-x64', resolved: 'https://registry.example/x.tgz', integrity: 'sha512-AAAA' }],
    });
    expect(() => pinned({ optionalDependencies: { '@lydell/node-pty': '^1.2.0-beta.18' } }, shrinkwrap)).toThrow(/not pinned to one version/);
    expect(() => pinned({ optionalDependencies: { '@lydell/node-pty': '1.2.0-beta.17' } }, shrinkwrap)).toThrow(/npm-shrinkwrap.json pins/);
  });
});
