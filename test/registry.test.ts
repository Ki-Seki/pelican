import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { packument, serve, UPSTREAM } from '../scripts/registry.mjs';

/** A .tgz as npm pack writes one: ustar entries under package/. */
function tgz(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text);
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

const manifest = { name: 'pelican-cc', version: '0.3.0', bin: { pelican: 'dist/server/index.js' }, dependencies: { hono: '^4.13.16' } };
const shrinkwrapped = tgz({ 'package.json': JSON.stringify(manifest), 'npm-shrinkwrap.json': '{"lockfileVersion":3}', 'dist/server/index.js': '#!/usr/bin/env node\n' });
const plain = tgz({ 'package.json': JSON.stringify(manifest) });

describe('the registry CI installs the package through', () => {
  it('says what registry.npmjs.org says of it, npm-shrinkwrap.json included', () => {
    const document = packument(shrinkwrapped, 'http://127.0.0.1:4873/');
    expect(document).toMatchObject({ name: 'pelican-cc', 'dist-tags': { latest: '0.3.0' } });
    expect(document.versions['0.3.0']).toEqual({
      ...manifest,
      _id: 'pelican-cc@0.3.0',
      _hasShrinkwrap: true,
      dist: {
        tarball: 'http://127.0.0.1:4873/pelican-cc/-/pelican-cc-0.3.0.tgz',
        integrity: `sha512-${createHash('sha512').update(shrinkwrapped).digest('base64')}`,
        shasum: createHash('sha1').update(shrinkwrapped).digest('hex'),
      },
    });
    // npm reads a package's npm-shrinkwrap.json only when the registry says it has one.
    expect(packument(plain, 'http://127.0.0.1:4873/').versions['0.3.0']?._hasShrinkwrap).toBe(false);
    expect(packument(tgz({ 'package.json': JSON.stringify({ name: '@scope/tool', version: '1.0.0' }) }), 'http://h/').versions['1.0.0']?.dist.tarball)
      .toBe('http://h/@scope/tool/-/tool-1.0.0.tgz');
    expect(() => packument(tgz({ 'README.md': 'hi' }), 'http://h/')).toThrow(/package\.json/);
  });

  it('serves the package and its tarball, and sends everything else to npm', async () => {
    const registry = await serve(shrinkwrapped);
    try {
      const document = await (await fetch(`${registry.url}pelican-cc`)).json();
      expect(document).toEqual(packument(shrinkwrapped, registry.url));
      const tarball = await fetch(document.versions['0.3.0'].dist.tarball);
      expect(Buffer.from(await tarball.arrayBuffer())).toEqual(shrinkwrapped);
      for (const other of ['hono', '@hono%2fnode-server', 'hono/-/hono-4.13.16.tgz', 'pelican-cc/-/pelican-cc-0.2.3.tgz']) {
        const response = await fetch(`${registry.url}${other}`, { redirect: 'manual' });
        expect(response.status).toBe(307);
        expect(response.headers.get('location')).toBe(`${UPSTREAM}/${other}`);
      }
    } finally {
      await registry.close();
    }
  });

  describe('as a command', () => {
    let dir: string;
    beforeAll(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'pelican-registry-'));
      await writeFile(path.join(dir, 'pelican-cc-0.3.0.tgz'), shrinkwrapped);
    });
    afterAll(() => rm(dir, { recursive: true, force: true }));

    const run = (args: string[]) => new Promise<{ code: number | null; stdout: string }>((resolve) => {
      execFile(process.execPath, [path.resolve('scripts/registry.mjs'), ...args], { cwd: dir }, (error, stdout) => {
        resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout });
      });
    });

    it('runs the command with npm pointed at it, and ends with the command’s exit code', async () => {
      const ask = 'fetch(process.env.npm_config_registry + "pelican-cc").then((r) => r.json()).then((d) => { console.log(d.versions["0.3.0"]._hasShrinkwrap); process.exit(3); })';
      const { code, stdout } = await run(['pelican-cc-0.3.0.tgz', process.execPath, '-e', ask]);
      expect(stdout.trim()).toBe('true');
      expect(code).toBe(3);
      expect((await run(['pelican-cc-0.3.0.tgz', process.execPath, '-e', ''])).code).toBe(0);
      expect((await run(['pelican-cc-0.3.0.tgz'])).code).toBe(2);
    });
  });
}, 20_000);
