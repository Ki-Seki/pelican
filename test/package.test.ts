// The package as npm installs it: the server with the packages it uses built in, and the terminal's
// PTY, optional, of whose native module for each platform npm installs this computer's alone. From
// a package that pins its tree with npm-shrinkwrap.json, npm installs every platform's: 2.6 GB, 1.2
// GB to download. No Agent SDK: Pelican fetches Anthropic's own package the first time it runs
// Claude Code, and runs the user's own Claude Code; the demo needs neither.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

import { serverBuild } from '../scripts/build-server.mjs';

const root = path.resolve(import.meta.dirname, '..');

/** A port nothing listens on: the command line takes no port 0. */
const freePort = () => new Promise<number>((resolve, reject) => {
  const probe = createServer().once('error', reject).listen(0, '127.0.0.1', () => {
    const { port } = probe.address() as { port: number };
    probe.close(() => resolve(port));
  });
});

describe('the package npm installs', () => {
  it('pins no tree with a shrinkwrap, and asks npm for nothing but the terminal’s PTY, as optional', async () => {
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>; devDependencies: Record<string, string>; optionalDependencies?: Record<string, string>; files: string[];
    };
    expect(manifest.dependencies ?? {}).toEqual({});
    // The Agent SDK builds and tests Pelican, exactly the version Pelican fetches when it runs.
    expect(manifest.devDependencies['@anthropic-ai/claude-agent-sdk']).toMatch(/^\d+\.\d+\.\d+$/);
    // Exactly the one scripts/pty-binaries.mjs checked, with its platforms' binaries.
    expect(Object.keys(manifest.optionalDependencies ?? {})).toEqual(['@lydell/node-pty']);
    expect(manifest.optionalDependencies?.['@lydell/node-pty']).toMatch(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/);
    expect(manifest.files).not.toContain('npm-shrinkwrap.json');
    expect(existsSync(path.join(root, 'npm-shrinkwrap.json'))).toBe(false);
  });

  it('is the version the changelog’s newest section names, in the lockfile too', async () => {
    const read = async (name: string) => JSON.parse(await readFile(path.join(root, name), 'utf8')) as { version: string; packages: Record<string, { version?: string }> };
    const changelog = await readFile(path.join(root, 'CHANGELOG.md'), 'utf8');
    const newest = /^## (\S+)$/m.exec(changelog)?.[1];
    const { version } = await read('package.json');
    expect(version).toBe(newest);
    const lock = await read('package-lock.json');
    expect([lock.version, lock.packages['']?.version]).toEqual([version, version]);
  });

  it('serves the demo with nothing installed beside it, and never fetches the Agent SDK for it', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pelican-package-'));
    const state = path.join(dir, 'state');
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const outfile = path.join(dir, 'dist', 'server', 'index.js');
      const { metafile } = await build({ ...serverBuild, absWorkingDir: root, outfile, metafile: true, logLevel: 'silent' });
      // What it imports from outside itself: Node's own modules, the Agent SDK (Anthropic's own
      // package, loaded only to run Claude Code, which the demo never does), the terminal's PTY
      // (loaded when a terminal is first asked for, which the demo never does either), and what ws
      // and debug try to load and go on without.
      const outside = new Set(Object.values(metafile.outputs).flatMap((output) => output.imports).filter((imported) => imported.external).map((imported) => imported.path));
      const others = [...outside].filter((name) => !name.startsWith('node:') && !builtinModules.includes(name));
      expect(others.sort()).toEqual(['@anthropic-ai/claude-agent-sdk', '@lydell/node-pty', 'bufferutil', 'supports-color', 'utf-8-validate']);

      const server = spawn(process.execPath, [outfile, '--demo'], {
        env: { ...process.env, PELICAN_HOST: '127.0.0.1', PELICAN_PORT: String(await freePort()), PELICAN_STATE_DIR: state, PELICAN_CONFIG_DIR: path.join(dir, 'config') },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child = server;
      let said = '';
      const url = await new Promise<string>((resolve, reject) => {
        const read = (chunk: Buffer) => {
          said += chunk.toString();
          const found = /http:\/\/\S+:\d+\//.exec(said);
          if (found) resolve(found[0]);
        };
        server.stdout!.on('data', read);
        server.stderr!.on('data', read);
        server.on('exit', () => reject(new Error(`It stopped: ${said}`)));
      });
      // web-push made the keys pushes are signed with, hono and its Node server answer.
      const info = (await (await fetch(new URL('api/info', url), { headers: { 'X-Pelican': '1' } })).json()) as { pushKey?: string; demo?: boolean };
      expect(info.demo).toBe(true);
      expect(info.pushKey).toMatch(/^[\w-]{80,}$/);
      // ws takes the page's socket.
      const socket = new WebSocket(new URL('api/ws', url.replace(/^http/, 'ws')));
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = () => reject(new Error('The socket failed'));
      });
      socket.close();
      // Its sessions, read with no SDK; and none fetched, nor asked for.
      const { sessions } = (await (await fetch(new URL('api/sessions', url), { headers: { 'X-Pelican': '1' } })).json()) as { sessions: unknown[] };
      expect(sessions.length).toBeGreaterThan(10);
      expect((await readdir(state, { recursive: true })).filter((file) => file.includes('agent-sdk'))).toEqual([]);
      expect(said).not.toMatch(/Agent SDK/);
    } finally {
      child?.kill();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
