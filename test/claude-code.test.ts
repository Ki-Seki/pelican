// The Claude Code Pelican runs: the user's own, found as a shell finds it, else where Claude Code's
// installers put it; its version, said older than the one Pelican was tested with where it is, and
// how to install it where there is none. Stand-ins for Claude Code answer as it does.
import { access, chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { sdkPackage } from '../src/server/agent-sdk';
import { app } from '../src/server/app';
import { accessToken, loadAuth } from '../src/server/auth';
import {
  claudeCodeInfo, claudeCodeLine, claudeOnPath, claudePath, claudeSignIn, claudeToRun, INSTALL_COMMAND, installedPlaces, isNewer, notFoundLine, olderLine,
  useClaudePlaces,
} from '../src/server/claude-code';
import { config } from '../src/server/config';

const saved = { ...config };
const savedPath = process.env.PATH;
let dir: string;
/** A folder of nothing, as PATH or as where to look. */
let empty: string;
beforeAll(async () => {
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pelican-claude-')));
  empty = path.join(dir, 'empty');
  await mkdir(empty, { recursive: true });
  config.configDir = path.join(dir, 'config');
  await loadAuth();
});
afterEach(() => {
  Object.assign(config, saved);
  process.env.PATH = savedPath;
  useClaudePlaces();
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A folder holding a `claude` made of this script, which answers --version (and the rest) as asked. */
async function claudeIn(name: string, script: string): Promise<string> {
  const folder = path.join(dir, name);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'claude'), `#!/bin/sh\n${script}\n`);
  await chmod(path.join(folder, 'claude'), 0o755);
  return folder;
}

/** A stand-in for Claude Code that says its version, and what `auth status` says. */
const answering = (version: string, status: Record<string, unknown> = { loggedIn: false }, exit = 1) =>
  `if [ "$1" = "--version" ]; then echo "${version} (Claude Code)"; exit 0; fi\necho '${JSON.stringify(status)}'\nexit ${exit}`;

/** Nothing named, nothing on PATH, nothing where the installers put it. */
function nowhere(): void {
  config.claudeExecutable = undefined;
  process.env.PATH = empty;
  useClaudePlaces([path.join(empty, 'claude')]);
}

const info = async () => {
  const response = await app.request('/api/info', { headers: { host: 'localhost:7860', 'x-pelican': '1', authorization: `Bearer ${accessToken()}` } });
  return ((await response.json()) as { claudeCode?: unknown }).claudeCode;
};

describe('which Claude Code runs', () => {
  it('is the one PELICAN_CLAUDE_PATH names, else the first claude on PATH, else the first where an installer put it', async () => {
    const first = await claudeIn('first', answering('2.1.330'));
    const second = await claudeIn('second', answering('2.1.340'));
    const native = await claudeIn(path.join('home', '.local', 'bin'), answering('2.1.350'));
    const brew = await claudeIn(path.join('brew', 'bin'), answering('2.1.360'));
    useClaudePlaces([path.join(empty, 'claude'), path.join(native, 'claude'), path.join(brew, 'claude')]);

    config.claudeExecutable = '/named/by/PELICAN_CLAUDE_PATH/claude';
    expect(await claudePath([first, second].join(path.delimiter))).toBe('/named/by/PELICAN_CLAUDE_PATH/claude');
    config.claudeExecutable = undefined;
    expect(await claudePath([empty, first, second].join(path.delimiter))).toBe(path.join(first, 'claude'));
    // Not on PATH (a service's, an app's): where the installers put it, in their order.
    expect(await claudePath(empty)).toBe(path.join(native, 'claude'));
    useClaudePlaces([path.join(brew, 'claude'), path.join(native, 'claude')]);
    expect(await claudePath(empty)).toBe(path.join(brew, 'claude'));
    useClaudePlaces([path.join(empty, 'claude')]);
    expect(await claudePath(empty)).toBeUndefined();
  });

  it('on PATH is looked for in absolute folders only', async () => {
    const first = await claudeIn('first', answering('2.1.330'));
    const second = await claudeIn('second', answering('2.1.340'));
    expect(await claudeOnPath([empty, first, second].join(path.delimiter))).toBe(path.join(first, 'claude'));
    // An empty entry or a relative one means the folder Pelican started in: never looked in.
    expect(await claudeOnPath(['', path.relative(process.cwd(), first), second].join(path.delimiter))).toBe(path.join(second, 'claude'));
    expect(await claudeOnPath(empty)).toBeUndefined();
  });

  it('is looked for where Claude Code’s installers put it, as their docs and packages say', () => {
    const node = path.join('/opt', 'node', 'bin', 'node');
    expect(installedPlaces('/home/ada', {}, node, 'linux')).toEqual([
      // The native installer (curl -fsSL https://claude.ai/install.sh | bash): its launcher.
      '/home/ada/.local/bin/claude',
      // Homebrew's cask, in Homebrew's prefix: Apple silicon, Intel, Linux.
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
      '/home/linuxbrew/.linuxbrew/bin/claude',
      // The apt, dnf and apk packages.
      '/usr/bin/claude',
      // npm install -g @anthropic-ai/claude-code, by the npm beside this Node.
      '/opt/node/bin/claude',
      // The local install of older versions of Claude Code, which a shell alias runs.
      '/home/ada/.claude/local/claude',
    ]);
    // A Homebrew of its own prefix, as `brew shellenv` names it, first among Homebrew's.
    expect(installedPlaces('/home/ada', { HOMEBREW_PREFIX: '/srv/brew' }, node, 'linux').slice(0, 3)).toEqual(['/home/ada/.local/bin/claude', '/srv/brew/bin/claude', '/opt/homebrew/bin/claude']);
    expect(installedPlaces('/home/ada', { HOMEBREW_PREFIX: 'relative' }, node, 'linux')).toEqual(installedPlaces('/home/ada', {}, node, 'linux'));
  });
}, 20_000);

describe('its version', () => {
  it('is asked of it, and asked again once it changes, as an update changes it', async () => {
    const folder = await claudeIn('updated', answering('2.1.300'));
    config.claudeExecutable = path.join(folder, 'claude');
    expect(await claudeCodeInfo()).toMatchObject({ path: config.claudeExecutable, version: '2.1.300' });
    await writeFile(config.claudeExecutable, `#!/bin/sh\n${answering('2.10.0')}\n`);
    expect(await claudeCodeInfo()).toMatchObject({ path: config.claudeExecutable, version: '2.10.0' });
  });

  it('compares part by part, as numbers', () => {
    expect(isNewer('2.1.330', '2.1.318')).toBe(true);
    expect(isNewer('2.10.0', '2.9.99')).toBe(true);
    expect(isNewer('3.0.0', '2.1.318')).toBe(true);
    expect(isNewer('2.1.318', '2.1.318')).toBe(false);
    expect(isNewer('2.1.316', '2.1.318')).toBe(false);
  });

  it('older than the one Pelican was tested with is said, with what to run, in the banner and About', async () => {
    const tested = sdkPackage().claudeCodeVersion!;
    expect(tested).toMatch(/^\d+\.\d+\.\d+$/);
    config.claudeExecutable = path.join(await claudeIn('older', answering('2.0.1')), 'claude');
    expect(await claudeCodeInfo()).toEqual({ path: config.claudeExecutable, version: '2.0.1', tested });
    expect(olderLine('2.0.1', tested)).toBe(`Claude Code 2.0.1 is older than ${tested}, which Pelican was tested with: run \`claude update\``);
    expect(await info()).toEqual({ version: '2.0.1', path: config.claudeExecutable, tested });
    // The same version, or a newer one: nothing to say.
    for (const version of [tested, '999.0.0']) {
      config.claudeExecutable = path.join(await claudeIn(`at-${version}`, answering(version)), 'claude');
      expect(await claudeCodeInfo()).toEqual({ path: config.claudeExecutable, version });
      expect(await info()).toEqual({ version, path: config.claudeExecutable });
    }
  });

  it('is not asked in the demo, which runs nothing: its sessions were written by the Claude Code Pelican was tested with', async () => {
    const ran = path.join(dir, 'ran');
    config.claudeExecutable = path.join(await claudeIn('demo', `echo ran > '${ran}'\n${answering('2.1.300')}`), 'claude');
    config.demo = true;
    expect(await claudeCodeInfo()).toEqual({ version: sdkPackage().claudeCodeVersion });
    await expect(access(ran)).rejects.toThrow();
  });
}, 20_000);

describe('no Claude Code', () => {
  it('says how to install it, or to name one, in the banner, About and `pelican login`', async () => {
    nowhere();
    expect(await claudeCodeInfo()).toEqual({ missing: true });
    expect(claudeCodeLine({ missing: true }, undefined, 'pelican login')).toBe(notFoundLine());
    expect(notFoundLine()).toBe(`Claude Code not found: install it with \`${INSTALL_COMMAND}\`, or set PELICAN_CLAUDE_PATH to it`);
    expect(INSTALL_COMMAND).toBe(process.platform === 'win32' ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash');
    expect(await info()).toEqual({ missing: true, install: INSTALL_COMMAND });
    const { claudeLogin } = await import('../src/server/claude-code');
    await expect(claudeLogin()).rejects.toThrow(`${notFoundLine()}.`);
  });

  it('where PELICAN_CLAUDE_PATH names one that is not there, says so', async () => {
    config.claudeExecutable = path.join(dir, 'missing');
    expect(await claudeCodeInfo()).toEqual({ path: config.claudeExecutable, missing: true });
    expect(claudeCodeLine({ path: '/nope', missing: true }, undefined, 'pelican login')).toBe('Claude Code not found at /nope (PELICAN_CLAUDE_PATH)');
    expect(await info()).toEqual({ path: config.claudeExecutable, missing: true });
    const { claudeLogin } = await import('../src/server/claude-code');
    await expect(claudeLogin()).rejects.toThrow(`Claude Code not found at ${config.claudeExecutable} (PELICAN_CLAUDE_PATH).`);
  });

  it('is what the first message says, on the page, with how to install it', async () => {
    nowhere();
    await expect(claudeToRun()).rejects.toThrow(`Claude Code is not installed on ${config.machine}, or not where Pelican looks. Install it there with\n${INSTALL_COMMAND}\nor set PELICAN_CLAUDE_PATH to the claude program.`);
    const cwd = await mkdtemp(path.join(dir, 'project-'));
    const response = await app.request('/api/sessions', {
      method: 'POST',
      headers: { host: 'localhost:7860', 'x-pelican': '1', 'content-type': 'application/json', authorization: `Bearer ${accessToken()}` },
      body: JSON.stringify({ cwd, text: 'Fix the login test', trust: 'trusted' }),
    });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toContain(INSTALL_COMMAND);
  });
}, 20_000);

describe('whether Claude Code is signed in', () => {
  it('as `claude auth status` says, signed out included (it exits 1 then)', async () => {
    config.claudeExecutable = path.join(await claudeIn('out', answering('2.1.316', { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }, 1)), 'claude');
    expect(await claudeSignIn()).toEqual({ loggedIn: false });
    config.claudeExecutable = path.join(await claudeIn('in', answering('2.1.316', { loggedIn: true, authMethod: 'claude.ai', email: 'ada@example.com' }, 0)), 'claude');
    expect(await claudeSignIn()).toEqual({ loggedIn: true, email: 'ada@example.com' });
    config.claudeExecutable = path.join(dir, 'missing');
    expect(await claudeSignIn()).toBeUndefined();
    nowhere();
    expect(await claudeSignIn()).toBeUndefined();
  });

  it('in one banner line, with which claude and what to do when it is not', () => {
    expect(claudeCodeLine({ version: '2.1.318' }, { loggedIn: true, email: 'ada@example.com' }, 'pelican login')).toBe('Claude Code 2.1.318 · signed in as ada@example.com');
    expect(claudeCodeLine({ version: '2.1.318' }, { loggedIn: false }, 'pelican login')).toBe('Claude Code 2.1.318 · not signed in: run `pelican login`');
    expect(claudeCodeLine({ version: '2.1.316', path: '/usr/local/bin/claude' }, undefined, 'pelican login')).toBe('Claude Code 2.1.316 (/usr/local/bin/claude)');
    expect(claudeCodeLine({ version: '2.1.318', path: path.join(os.homedir(), '.local', 'bin', 'claude') }, { loggedIn: true }, 'pelican login')).toBe('Claude Code 2.1.318 (~/.local/bin/claude) · signed in');
  });
}, 20_000);
