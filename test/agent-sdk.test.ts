// Loading Anthropic's Agent SDK (src/server/agent-sdk.ts): where npm installed it beside Pelican,
// else Pelican's own copy, which a stand-in npm here "fetches": it writes down how it was run and
// writes a stand-in package where it was asked to. Nothing goes to the network.
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  fetchCommand, findNpm, isAbortError, loadSdkSoon, npmInstall, SDK_PACKAGE, SDK_VERSION, sdk, sdkFolder, sdkPackage, sdkTiming, useSdkContext,
} from '../src/server/agent-sdk';
import { config } from '../src/server/config';

const saved = { ...config };
const timing = { ...sdkTiming };
let dir: string;
let npmScript: string;
const npmLog = () => path.join(dir, 'npm.log');
let said: string[] = [];

/** npm, standing in: notes how it was run, then writes a stand-in SDK where --prefix says, or fails as npm does offline. */
const STAND_IN_NPM = `
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.STANDIN_NPM_LOG, JSON.stringify({ args, cwd: process.cwd(), leftovers: Object.keys(process.env).filter((name) => /^npm_(lifecycle|package)_/.test(name)) }) + '\\n');
if (process.env.STANDIN_NPM_FAIL) {
  console.error([
    'npm error code ENOTFOUND', 'npm error syscall getaddrinfo', 'npm error errno ENOTFOUND',
    'npm error network request to https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org',
    'npm error network This is a problem related to network connectivity.',
    'npm error A complete log of this run can be found in: /tmp/npm-cache/_logs/debug-0.log',
  ].join('\\n'));
  process.exit(1);
}
const prefix = args[args.indexOf('--prefix') + 1];
const version = /^@anthropic-ai\\/claude-agent-sdk@(.+)$/.exec(args.at(-1))[1];
const write = (root, by) => {
  const folder = path.join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version, main: 'sdk.mjs', type: 'module', claudeCodeVersion: '2.1.999' }));
  writeFileSync(path.join(folder, 'sdk.mjs'), 'export const fetchedBy = ' + JSON.stringify(by) + ';\\nexport class AbortError extends Error {}\\n');
};
// Another Pelican, starting at the same time, put its own copy in place first.
if (process.env.STANDIN_NPM_RACE) write(path.join(path.dirname(prefix), version), 'another Pelican');
write(prefix, 'this Pelican');
console.log('added 104 packages in 3s');
`;

/** How the stand-in npm was run, each time, since the last look. */
async function npmRuns(): Promise<Array<{ args: string[]; cwd: string; leftovers: string[] }>> {
  const text = await readFile(npmLog(), 'utf8').catch(() => '');
  await writeFile(npmLog(), '');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as { args: string[]; cwd: string; leftovers: string[] });
}

/** As where npm installed nothing beside Pelican: from npm, Pelican's package brings no SDK. */
const notInstalled = () => Promise.reject(Object.assign(new Error(`Cannot find package '${SDK_PACKAGE}'`), { code: 'ERR_MODULE_NOT_FOUND' }));
const standInNpm = () => ({ file: process.execPath, args: [npmScript] });
/** The SDK as loaded: the stand-in's module says who fetched it. */
const fetchedBy = async () => ((await sdk()) as unknown as { fetchedBy?: string }).fetchedBy;
const copy = () => path.join(sdkFolder(), SDK_VERSION);
/** A path as Pelican says it: under the home folder as ~/… */
const shown = (file: string) => (file.startsWith(`${os.homedir()}${path.sep}`) ? `~${file.slice(os.homedir().length)}` : file);

beforeAll(async () => {
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pelican-sdk-')));
  npmScript = path.join(dir, 'npm.mjs');
  await writeFile(npmScript, STAND_IN_NPM);
  process.env.STANDIN_NPM_LOG = npmLog();
});
beforeEach(async () => {
  // A state folder of each test's own: Node keeps each module it loaded by its path.
  config.stateDir = await mkdtemp(path.join(dir, 'state-'));
  said = [];
  useSdkContext({ installed: notInstalled, npm: standInNpm, say: (line) => said.push(line) });
  await npmRuns();
});
afterEach(() => {
  Object.assign(config, saved);
  Object.assign(sdkTiming, timing);
  delete process.env.STANDIN_NPM_FAIL;
  delete process.env.STANDIN_NPM_RACE;
});
afterAll(async () => {
  useSdkContext();
  delete process.env.STANDIN_NPM_LOG;
  await rm(dir, { recursive: true, force: true });
});

describe('the Agent SDK', () => {
  it('is the one npm installed beside Pelican, where it did, as in development and the tests: no npm runs', async () => {
    useSdkContext({ npm: standInNpm, say: (line) => said.push(line) });
    const loaded = await sdk();
    expect(typeof loaded.query).toBe('function');
    expect(sdkPackage()).toMatchObject({ version: SDK_VERSION, claudeCodeVersion: expect.stringMatching(/^\d+\.\d+\.\d+$/) });
    expect(isAbortError(new loaded.AbortError('stopped'))).toBe(true);
    expect(isAbortError(new Error('stopped'))).toBe(false);
    expect(await npmRuns()).toEqual([]);
    expect(said).toEqual([]);
    expect(existsSync(sdkFolder())).toBe(false);
  });

  it('else is fetched from npm, exactly the version pinned, its JavaScript alone, into a folder beside its place, then put there whole', async () => {
    expect(await fetchedBy()).toBe('this Pelican');
    const [run, ...more] = await npmRuns();
    expect(more).toEqual([]);
    const fetchedIn = run!.args[2]!;
    expect(run!.args).toEqual([
      'install', '--prefix', fetchedIn, '--no-save', '--no-package-lock', '--omit=optional', '--omit=peer', '--ignore-scripts', '--no-audit', '--no-fund', `@anthropic-ai/claude-agent-sdk@${SDK_VERSION}`,
    ]);
    expect(npmInstall(fetchedIn)).toEqual(run!.args);
    // In a folder of its own beside where it goes, where no project's .npmrc is, and run from there.
    expect(path.dirname(fetchedIn)).toBe(sdkFolder());
    expect(path.basename(fetchedIn)).toMatch(new RegExp(`^\\.${SDK_VERSION.replace(/\./g, '\\.')}-`));
    expect(run!.cwd).toBe(fetchedIn);
    expect(existsSync(fetchedIn)).toBe(false);
    expect(await readdir(sdkFolder())).toEqual([SDK_VERSION]);
    expect(existsSync(path.join(copy(), 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs'))).toBe(true);
    // Its package.json is the one said: the copy loaded, wherever it came from.
    expect(sdkPackage()).toMatchObject({ version: SDK_VERSION, claudeCodeVersion: '2.1.999' });
    expect(said).toEqual([`pelican: Fetching Anthropic's Agent SDK ${SDK_VERSION} from npm (@anthropic-ai/claude-agent-sdk), once for this version: about 5 MB, into ${shown(sdkFolder())}`]);

    // Loaded once; and on the next start, from the copy, with no npm at all.
    expect(await fetchedBy()).toBe('this Pelican');
    useSdkContext({ installed: notInstalled, npm: () => undefined, say: (line) => said.push(line) });
    expect(await fetchedBy()).toBe('this Pelican');
    expect(await npmRuns()).toEqual([]);
  });

  it('is fetched by npm with nothing an earlier npm left in the environment (npx, npm start)', async () => {
    process.env.npm_lifecycle_event = 'start';
    process.env.npm_package_name = 'pelican-cc';
    try {
      await sdk();
    } finally {
      delete process.env.npm_lifecycle_event;
      delete process.env.npm_package_name;
    }
    expect((await npmRuns()).map((run) => run.leftovers)).toEqual([[]]);
  });

  it('two Pelicans fetching at once: the copy put in place first stays, the other goes', async () => {
    process.env.STANDIN_NPM_RACE = '1';
    expect(await fetchedBy()).toBe('another Pelican');
    expect(await readdir(sdkFolder())).toEqual([SDK_VERSION]);
  });

  it('a copy that does not load, left by a fetch by hand that stopped half way, makes way for a whole one', async () => {
    await mkdir(path.join(copy(), 'node_modules', '@anthropic-ai', 'claude-agent-sdk'), { recursive: true });
    expect(await fetchedBy()).toBe('this Pelican');
    expect(await readdir(sdkFolder())).toEqual([SDK_VERSION]);
  });

  it('once in place, the copies of other versions go, and what fetches that stopped left, but not one under way', async () => {
    const root = sdkFolder();
    await mkdir(path.join(root, '0.3.300', 'node_modules'), { recursive: true });
    await mkdir(path.join(root, '.0.3.300-stopped'), { recursive: true });
    const old = new Date(Date.now() - 2 * 3600_000);
    await utimes(path.join(root, '.0.3.300-stopped'), old, old);
    await mkdir(path.join(root, `.${SDK_VERSION}-under-way`), { recursive: true });
    await sdk();
    expect((await readdir(root)).sort()).toEqual([`.${SDK_VERSION}-under-way`, SDK_VERSION]);
  });

  it('that npm could not fetch says what npm said and the command to run by hand, and is tried again when next needed', async () => {
    process.env.STANDIN_NPM_FAIL = '1';
    const why = `Pelican could not fetch Anthropic's Agent SDK ${SDK_VERSION} from npm: npm said ENOTFOUND: network request to https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org. It tries again when it next needs it; to fetch it yourself, run:\n`
      + `npm install --prefix ${shown(copy())} --no-save --no-package-lock --omit=optional --omit=peer --ignore-scripts --no-audit --no-fund @anthropic-ai/claude-agent-sdk@${SDK_VERSION}`;
    expect(fetchCommand()).toBe(why.split('\n')[1]);
    await expect(sdk()).rejects.toThrow(why);
    expect(said).toEqual([expect.stringMatching(/^pelican: Fetching /), `pelican: ${why}`]);
    // Nothing half done is left.
    expect(await readdir(sdkFolder())).toEqual([]);
    expect(await npmRuns()).toHaveLength(1);
    // Asked again at once: said again, not fetched again, nor said twice in the terminal.
    await expect(sdk()).rejects.toThrow(why);
    expect(await npmRuns()).toEqual([]);
    expect(said).toHaveLength(2);

    // Later, once npm can, it is fetched; the terminal says so.
    delete process.env.STANDIN_NPM_FAIL;
    sdkTiming.retryMs = 0;
    expect(await fetchedBy()).toBe('this Pelican');
    expect(await npmRuns()).toHaveLength(1);
    expect(said.at(-1)).toBe(`pelican: Anthropic's Agent SDK ${SDK_VERSION} is in ${shown(copy())} now.`);
  });

  it('fetched by hand with that command after a failure, is found at once', async () => {
    process.env.STANDIN_NPM_FAIL = '1';
    await expect(sdk()).rejects.toThrow(/could not fetch/);
    delete process.env.STANDIN_NPM_FAIL;
    // As the command run by hand puts it: straight where it goes.
    const { execFileSync } = await import('node:child_process');
    execFileSync(process.execPath, [npmScript, ...npmInstall(copy())], { cwd: dir });
    await npmRuns();
    expect(await fetchedBy()).toBe('this Pelican');
    expect(await npmRuns()).toEqual([]);
  });

  it('with no npm to fetch it, says so, with the command', async () => {
    useSdkContext({ installed: notInstalled, npm: () => undefined, say: (line) => said.push(line) });
    await expect(sdk()).rejects.toThrow(new RegExp(`^Pelican could not fetch Anthropic's Agent SDK ${SDK_VERSION.replace(/\./g, '\\.')} from npm: there is no npm beside the Node running Pelican \\(.+\\), nor on PATH\\. .*run:\\nnpm install --prefix `));
  });

  it('is never loaded nor fetched in the demo, which runs nothing', async () => {
    let asked = 0;
    useSdkContext({ installed: () => { asked += 1; return notInstalled(); }, npm: standInNpm, say: (line) => said.push(line) });
    config.demo = true;
    loadSdkSoon();
    await expect(sdk()).rejects.toThrow('This is the demo: nothing runs.');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(asked).toBe(0);
    expect(await npmRuns()).toEqual([]);
    expect(said).toEqual([]);
    expect(existsSync(sdkFolder())).toBe(false);
    // Outside the demo, loading starts as Pelican does, before anything asks for it.
    config.demo = false;
    loadSdkSoon();
    await expect.poll(() => asked).toBe(1);
    expect(await fetchedBy()).toBe('this Pelican');
  });
}, 30_000);

describe('an Agent SDK npm could not fetch', () => {
  it('is what the session list and the first message say, with the command to fetch it by hand', async () => {
    process.env.STANDIN_NPM_FAIL = '1';
    const { app } = await import('../src/server/app');
    const { accessToken, loadAuth } = await import('../src/server/auth');
    await loadAuth();
    const headers = { host: 'localhost:7860', 'x-pelican': '1', authorization: `Bearer ${accessToken()}`, 'content-type': 'application/json' };
    const list = await app.request('/api/sessions', { headers });
    expect(list.status).toBe(503);
    expect(((await list.json()) as { error: string }).error).toMatch(new RegExp(`^Pelican could not fetch .*\\n${fetchCommand().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 's'));
    const cwd = await mkdtemp(path.join(dir, 'project-'));
    const sent = await app.request('/api/sessions', { method: 'POST', headers, body: JSON.stringify({ cwd, text: 'Fix the login test', trust: 'trusted' }) });
    expect(sent.status).toBe(503);
    expect(((await sent.json()) as { error: string }).error).toContain(fetchCommand());
    // npm ran once, for the list; the message was told what it found.
    expect(await npmRuns()).toHaveLength(1);
  });
}, 30_000);

describe('the npm that fetches it', () => {
  it('is the one beside the Node running Pelican, else the first on PATH, run with this Node where it is npm’s own script', async () => {
    const node = path.join(dir, 'node', 'bin', 'node');
    const cli = path.join(dir, 'node', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    await mkdir(path.dirname(cli), { recursive: true });
    await writeFile(cli, '');
    expect(findNpm(node, '', 'linux')).toEqual({ file: node, args: [cli] });
    // Not beside it: npm on PATH, its script run with this Node, in absolute folders only.
    const elsewhere = path.join(dir, 'elsewhere', 'bin', 'node');
    expect(findNpm(elsewhere, ['relative', path.join(dir, 'empty'), path.join(dir, 'node', 'bin')].join(path.delimiter), 'linux')).toEqual({ file: elsewhere, args: [cli] });
    // A program named npm, run as it is.
    const bin = path.join(dir, 'npm-bin');
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, 'npm'), '#!/bin/sh\n');
    await chmod(path.join(bin, 'npm'), 0o755);
    expect(findNpm(elsewhere, bin, 'linux')).toEqual({ file: path.join(bin, 'npm'), args: [] });
    expect(findNpm(elsewhere, path.join(dir, 'empty'), 'linux')).toBeUndefined();
  });
});
